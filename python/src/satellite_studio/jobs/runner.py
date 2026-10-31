"""One persistent renderer, one serial worker; UI and HTTP stay independent."""
from __future__ import annotations

import logging
from pathlib import Path
import shutil
import threading
from typing import Callable, Protocol

from satellite_studio.datasets.export import commit_frame, prepare_frame, write_json
from satellite_studio.domain.coverage import CoverageAccumulator
from satellite_studio.domain.sampling import sample_frames
from .store import JobStore

LOGGER = logging.getLogger(__name__)


class Renderer(Protocol):
    def render(self, frame: dict, output_directory: Path) -> dict: ...
    def close(self) -> None: ...


class JobRunner:
    def __init__(self, store: JobStore, renderer_factory: Callable[[], Renderer]):
        self.store = store
        self._factory = renderer_factory
        self._renderer: Renderer | None = None
        self._renderer_lock = threading.Lock()
        self._stopping = threading.Event()
        self._wake = threading.Event()
        self._thread = threading.Thread(target=self._run, name="satellite-job-worker", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def wake(self) -> None:
        self._wake.set()

    def _get_renderer(self) -> Renderer:
        with self._renderer_lock:
            if self._stopping.is_set():
                raise RuntimeError("服务正在关闭")
            if self._renderer is None:
                self._renderer = self._factory()
            return self._renderer

    def _run(self) -> None:
        while not self._stopping.is_set():
            self._wake.clear()
            job = self.store.claim_next()
            if job is None:
                self._wake.wait(.5)
                continue
            self._execute(job)

    def _execute(self, job: dict) -> None:
        job_id = job["id"]
        request = self.store.request(job_id)
        output = Path(job["output_directory"])
        staging_root = output / ".staging"
        coverage = CoverageAccumulator() if request.mode == "coverage" else None
        try:
            renderer = self._get_renderer()
            for frame in sample_frames(request, job_id):
                if self._stopping.is_set():
                    self.store.finish(job_id, "interrupted", "服务关闭；完整帧已保留。")
                    return
                if self.store.cancellation_requested(job_id):
                    self.store.finish(job_id, "canceled")
                    return
                stage = staging_root / frame["frame_id"]
                stage.mkdir(parents=True, exist_ok=False)
                metadata = renderer.render(frame, stage)
                # A cancel during Blender work must not publish that in-flight frame.
                if self._stopping.is_set():
                    self.store.finish(job_id, "interrupted", "服务关闭；完整帧已保留。")
                    return
                if self.store.cancellation_requested(job_id):
                    self.store.finish(job_id, "canceled")
                    return
                prepare_frame(stage, frame, metadata, request.scene)
                if self.store.cancellation_requested(job_id):
                    self.store.finish(job_id, "canceled")
                    return
                paths = commit_frame(stage, output, frame["frame_id"])
                self.store.mark_frame(job_id, frame["frame_id"], paths)
                if coverage is not None:
                    coverage.add(frame["quaternion_xyzw"], frame["distance_m"])
                if stage.is_dir() and stage.resolve().is_relative_to(staging_root.resolve()):
                    shutil.rmtree(stage)
            if coverage is not None:
                write_json(output / "coverage.json", coverage.to_dict())
            self.store.finish(job_id, "completed")
        except Exception as exc:
            if self._stopping.is_set():
                status, error = "interrupted", "服务关闭；完整帧已保留。"
            elif self.store.cancellation_requested(job_id):
                status, error = "canceled", None
            else:
                status, error = "failed", f"{type(exc).__name__}: {exc}"
                LOGGER.info("Job %s failed: %s", job_id, error)
            self.store.finish(job_id, status, error)

    def close(self) -> None:
        self._stopping.set()
        self._wake.set()
        with self._renderer_lock:
            if self._renderer is not None:
                self._renderer.close()
        if self._thread.is_alive():
            self._thread.join(timeout=15)
        if self._thread.is_alive():
            raise RuntimeError("渲染线程未能在关闭期限内退出")
        self.store.interrupt_running("服务关闭；完整帧已保留。")
