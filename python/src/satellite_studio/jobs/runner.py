"""One persistent renderer, one serial worker; UI and HTTP stay independent."""
from __future__ import annotations

import logging
from pathlib import Path
import shutil
import threading
from typing import Callable, Protocol

from satellite_studio.datasets.export import prepare_frame, write_json
from satellite_studio.domain.coverage import CoverageAccumulator
from satellite_studio.domain.sampling import sample_frames
from satellite_studio.domain.rotation import quaternion_array
from .store import JobStore
from satellite_studio.domain.noise_request import NoiseVariantRequest
from satellite_studio.datasets.noise import prepare_noise_frame, commit_noise_frame
from .noise_sources import source_records

LOGGER = logging.getLogger(__name__)


class Renderer(Protocol):
    def render(self, frame: dict, output_directory: Path) -> dict: ...
    def close(self) -> None: ...


class JobRunner:
    def __init__(self, store: JobStore, renderer_factory: Callable[[], Renderer]):
        self.store = store
        self._factory = renderer_factory
        self._renderers: dict[str, Renderer] = {}
        self._renderer_lock = threading.Lock()
        self._stopping = threading.Event()
        self._wake = threading.Event()
        self._thread = threading.Thread(target=self._run, name="satellite-job-worker", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def wake(self) -> None:
        self._wake.set()

    def _get_renderer(self, backend: str = "threejs") -> Renderer:
        with self._renderer_lock:
            if self._stopping.is_set():
                raise RuntimeError("服务正在关闭")
            if backend != "threejs":
                raise RuntimeError("历史 Blender 排队采集不受支持；请在工作台重新提交 Three.js 任务。")
            if backend not in self._renderers:
                self._renderers[backend] = self._factory()
            return self._renderers[backend]

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
        output = Path(job["output_directory"])
        staging_root = output / ".staging"
        try:
            request = self.store.request(job_id)
            if isinstance(request, NoiseVariantRequest):
                self._execute_noise(job, request, staging_root)
                return
            coverage = CoverageAccumulator() if request.mode == "coverage" else None
            renderer = self._get_renderer(request.renderer_backend)
            for frame in sample_frames(request, job_id):
                if self._stopping.is_set():
                    self.store.finish(job_id, "interrupted", "服务关闭；完整帧已保留。")
                    return
                if self.store.cancellation_requested(job_id):
                    self.store.finish(job_id, "canceled")
                    return
                stage = staging_root / frame["frame_id"]
                staging_root.mkdir(exist_ok=True)
                stage.mkdir(exist_ok=False)
                render_frame = dict(frame, _job_id=job_id)
                metadata = renderer.render(render_frame, stage)
                # A cancel during capture must not publish that in-flight frame.
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
                if not self.store.publish_frame(job_id, stage, frame["frame_id"]):
                    self.store.finish(job_id, "canceled")
                    return
                if coverage is not None:
                    coverage.add(quaternion_array(frame["sat_quat"]), frame["distance_m"])
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

    def _execute_noise(self, job: dict, request: NoiseVariantRequest, staging_root: Path) -> None:
        if self._noise_stopped(job["id"]):
            return
        _, _, records = source_records(self.store, request.source_job_id, request.source_snapshot_sha256)
        if len(records) != request.count:
            raise ValueError("来源帧数量已改变")
        for frame_id in records:
            if self._noise_stopped(job["id"]):
                return
            stage = staging_root / frame_id
            staging_root.mkdir(exist_ok=True)
            stage.mkdir(exist_ok=False)
            prepare_noise_frame(self.store, request, job["id"], frame_id, stage)
            if self._noise_stopped(job["id"]):
                return
            paths = commit_noise_frame(self.store, request, job["id"], frame_id, stage, Path(job["output_directory"]))
            self.store.mark_frame(job["id"], frame_id, paths)
            if stage.is_dir() and stage.resolve().is_relative_to(staging_root.resolve()):
                shutil.rmtree(stage)
        self.store.finish(job["id"], "completed")

    def _noise_stopped(self, job_id: str) -> bool:
        if self._stopping.is_set():
            self.store.finish(job_id, "interrupted", "服务关闭；完整帧已保留。")
            return True
        if self.store.cancellation_requested(job_id):
            self.store.finish(job_id, "canceled")
            return True
        return False

    def stop(self) -> None:
        self._stopping.set()
        self._wake.set()

    def close(self) -> None:
        self._stopping.set()
        self._wake.set()
        with self._renderer_lock:
            for renderer in self._renderers.values():
                renderer.close()
        if self._thread.is_alive():
            self._thread.join(timeout=15)
        if self._thread.is_alive():
            raise RuntimeError("渲染线程未能在关闭期限内退出")
        self.store.interrupt_running("服务关闭；完整帧已保留。")
