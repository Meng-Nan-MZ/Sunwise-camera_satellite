"""A complete-frame DB row is the sole publication marker for frame artifacts."""
from __future__ import annotations

from datetime import datetime, timezone
from contextlib import closing, contextmanager
import json
from pathlib import Path
import shutil
import sqlite3
import threading
import uuid

from satellite_studio.datasets.export import write_json, commit_frame
from satellite_studio.domain.parameters import JobRequest
from satellite_studio.domain.noise_request import NoiseVariantRequest
from .noise_sources import canonical_reference
from . import output_directory as output_paths
from . import deletion
from satellite_studio import SCHEMA_VERSION, COORDINATE_CONVENTION_ID

TERMINAL = frozenset(("completed", "failed", "canceled", "interrupted"))


def validate_workspace_protocol(workspace: Path) -> None:
    """Inspect the persisted marker without creating locks, logs, WAL or SHM.

    V2 checkpoints its protocol marker at initialization. Immutable SQLite reads
    deliberately ignore journals: an unmarked legacy main DB is always rejected.
    """
    workspace = workspace.resolve()
    database = workspace / "jobs.sqlite3"
    if database.exists():
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True)) as check:
            try:
                version = check.execute("SELECT schema_version,coordinate_id FROM protocol").fetchall()
            except sqlite3.DatabaseError as exc:
                raise ValueError("V1 旧协议工作区不受支持；请选择独立 V2 工作区") from exc
            if version != [(SCHEMA_VERSION, COORDINATE_CONVENTION_ID)]:
                raise ValueError("V1 旧协议工作区不受支持；请选择独立 V2 工作区")
    elif (workspace / "jobs").exists() and any((workspace / "jobs").iterdir()):
        raise ValueError("V1 旧协议或未标识的工作区不受支持")


class JobStore:
    def __init__(self, workspace: Path):
        self.workspace = workspace.resolve()
        validate_workspace_protocol(self.workspace)
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.jobs_directory = self.workspace / "jobs"
        self.jobs_directory.mkdir(exist_ok=True)
        self._lock = threading.RLock()
        # Always acquire lifecycle before _lock. Slow filesystem work may hold
        # lifecycle, but never _lock: polling and cancellation remain responsive.
        self._lifecycle_lock = threading.RLock()
        self._db = sqlite3.connect(self.workspace / "jobs.sqlite3", check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS protocol (schema_version TEXT NOT NULL, coordinate_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL,
                total_frames INTEGER NOT NULL, completed_frames INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, error TEXT, snapshot TEXT NOT NULL,
                cancel_requested INTEGER NOT NULL DEFAULT 0, latest_frame TEXT
            );
            CREATE TABLE IF NOT EXISTS frames (
                job_id TEXT NOT NULL REFERENCES jobs(id), frame_id TEXT NOT NULL,
                files TEXT NOT NULL, PRIMARY KEY(job_id, frame_id)
            );
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS job_output_ownership (
                job_id TEXT PRIMARY KEY REFERENCES jobs(id), identity TEXT NOT NULL, token TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS deletion_intents (
                job_id TEXT PRIMARY KEY REFERENCES jobs(id), identity TEXT NOT NULL
            );
            CREATE TRIGGER IF NOT EXISTS snapshot_immutable BEFORE UPDATE OF snapshot ON jobs
            BEGIN SELECT RAISE(ABORT, 'job snapshot is immutable'); END;
        """)
        if 'output_root' not in {row[1] for row in self._db.execute('PRAGMA table_info(jobs)')}:
            self._db.execute('ALTER TABLE jobs ADD COLUMN output_root TEXT')
        self._db.executescript("""
            CREATE TRIGGER IF NOT EXISTS output_root_immutable BEFORE UPDATE OF output_root ON jobs
            BEGIN SELECT RAISE(ABORT, 'job output root is immutable'); END;
        """)
        with self._db:
            self._db.execute("INSERT INTO protocol SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM protocol)",
                             (SCHEMA_VERSION, COORDINATE_CONVENTION_ID))
        # Persist marker in the main DB so preflight needs no WAL/SHM access.
        self._db.execute("PRAGMA wal_checkpoint(FULL)")
        self.interrupt_running("上次运行中断；完整帧已保留，可重新提交任务。")

    @contextmanager
    def reading(self):
        """Hold the store lock for a consistent multi-statement read-only query.

        Cross-module readers use this instead of touching _lock/_db directly,
        so lock-granularity changes stay inside JobStore. Never write here.
        """
        with self._lock:
            yield self._db

    def appearance_settings(self) -> dict:
        with self._lock:
            row = self._db.execute("SELECT value FROM settings WHERE key='theme'").fetchone()
            return {"theme": row[0] if row else "light"}

    def set_appearance(self, theme: str) -> dict:
        if not isinstance(theme, str) or theme not in ("dark", "light"):
            raise ValueError("theme 必须为 dark 或 light")
        with self._lock, self._db:
            self._db.execute("INSERT INTO settings(key,value) VALUES ('theme',?) "
                             "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (theme,))
            return self.appearance_settings()

    def output_settings(self) -> dict:
        with self._lock:
            row = self._db.execute("SELECT value FROM settings WHERE key='output_directory'").fetchone()
            return {'output_directory': row[0] if row else str(self.jobs_directory),
                    'default_output_directory': str(self.jobs_directory)}

    def set_output_directory(self, value: str) -> dict:
        try:
            root = output_paths.resolve_directory(value)
            output_paths.probe_directory(root)
        except OSError as exc:
            raise ValueError(f'数据集保存位置不可用或不可写：{value}（{exc}）') from exc
        with self._lock, self._db:
            self._db.execute("INSERT INTO settings(key,value) VALUES ('output_directory',?) "
                             "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(root),))
            return self.output_settings()

    def output_directory(self, job_id: str) -> Path:
        with self._lock:
            row = self._db.execute('SELECT output_root FROM jobs WHERE id=?', (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            return (Path(row[0]) if row[0] is not None else self.jobs_directory) / job_id

    def _public(self, row: sqlite3.Row) -> dict:
        frame = row["latest_frame"]
        snapshot = json.loads(row["snapshot"])
        variant = row["mode"] == "noise_variant"
        source_id = snapshot.get("source_job_id") if variant else None
        backend_snapshot = snapshot
        if variant:
            source_row = self._db.execute("SELECT snapshot FROM jobs WHERE id=?", (source_id,)).fetchone()
            backend_snapshot = json.loads(source_row["snapshot"]) if source_row else {}
        images = {"clean": None, "noisy": None}
        if frame:
            for kind, owner in (("clean", source_id if variant else row["id"]), ("noisy", row["id"])):
                relative = f"images_{kind}/{frame}.png"
                if owner and self.published_file(owner, relative) is not None:
                    images[kind] = f"/data/{owner}/{relative}"
        eligible = False
        if row["status"] == "completed":
            try:
                canonical_reference(self, row["id"])
                eligible = not self._db.execute('SELECT 1 FROM deletion_intents WHERE job_id IN (?,?)',
                                                 (row['id'], source_id)).fetchone()
            except (ValueError, KeyError, TypeError, OSError):
                pass
        return {"id": row["id"], "mode": row["mode"], "status": row["status"],
                "model_id": backend_snapshot.get("scene", {}).get("model_id"),
                "renderer_backend": backend_snapshot.get("renderer_backend", "blender"),
                "completed_frames": row["completed_frames"], "total_frames": row["total_frames"],
                "created_at": row["created_at"], "error": row["error"],
                "source_job_id": source_id, "noise": snapshot["noise"] if variant else snapshot["scene"]["noise"],
                "seed": snapshot["seed"] if variant else snapshot["scene"]["seed"],
                "can_generate_noise": eligible, "latest_images": images,
                "latest_image_url": images["noisy"] or images["clean"],
                "output_directory": str(self.output_directory(row["id"])),
                "cancel_requested": bool(row["cancel_requested"])}

    def create_noise_variant(self, source_job_id: str, body: dict) -> dict:
        noise, seed = NoiseVariantRequest.parse_body(body)
        with self._lifecycle_lock:
            self._ensure_not_deleting(source_job_id)
            source_id, digest, count = canonical_reference(self, source_job_id)
            return self.create(NoiseVariantRequest(source_id, count, noise, seed, digest))

    def _ensure_not_deleting(self, job_id: str) -> None:
        with self._lock:
            if self._db.execute('SELECT 1 FROM deletion_intents WHERE job_id=?', (job_id,)).fetchone():
                raise deletion.DeletionError('DELETE_IN_PROGRESS', '该任务正在删除或等待重试删除，无法生成噪声版本。')

    def deletion_preview(self, job_id: str) -> dict:
        return deletion.deletion_preview(self, job_id)

    def delete(self, job_id: str, fingerprint: str | None) -> dict:
        return deletion.delete_jobs(self, job_id, fingerprint)

    def create(self, request: JobRequest | NoiseVariantRequest) -> dict:
        with self._lifecycle_lock:
            if isinstance(request, NoiseVariantRequest):
                self._ensure_not_deleting(request.source_job_id)
                source_id, digest, count = canonical_reference(self, request.source_job_id)
                if (source_id, digest, count) != (request.source_job_id, request.source_snapshot_sha256, request.count):
                    raise ValueError('来源任务快照或帧数量不匹配')
            return self._create(request)

    def _create(self, request: JobRequest | NoiseVariantRequest) -> dict:
        job_id = uuid.uuid4().hex
        snapshot = request.to_dict()
        # Freeze selection before the first filesystem operation. A concurrent
        # preference save affects only later submissions, even during slow I/O.
        with self._lock:
            root = (self.output_directory(request.source_job_id).parent
                    if isinstance(request, NoiseVariantRequest)
                    else Path(self.output_settings()['output_directory']))
        output_paths.probe_directory(root)
        directory = root / job_id
        directory.mkdir()
        write_json(directory / "job.json", snapshot)
        token = uuid.uuid4().hex
        write_json(directory / '.satellite-owner.json', {'job_id': job_id, 'token': token})
        identity = deletion.directory_identity(root, directory)
        try:
            with self._lock, self._db:
                self._db.execute("INSERT INTO jobs (id,mode,status,total_frames,created_at,snapshot,output_root) VALUES (?,?,?,?,?,?,?)",
                                 (job_id, request.mode, "queued", request.count, datetime.now(timezone.utc).isoformat(),
                                  json.dumps(snapshot, allow_nan=False, ensure_ascii=False), str(root)))
                self._db.execute('INSERT INTO job_output_ownership(job_id,identity,token) VALUES (?,?,?)',
                                 (job_id, json.dumps(identity), token))
                return self.get(job_id)
        except BaseException:
            # The INSERT failed after the directory was created; roll it back
            # so no orphan task directory is left outside API reach. Only the
            # fresh uuid directory created above is removed.
            try:
                shutil.rmtree(directory)
            except OSError:
                pass
            raise

    def get(self, job_id: str) -> dict:
        with self._lock:
            row = self._db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            return self._public(row)

    def detail(self, job_id: str) -> dict:
        """Raw frozen metadata is available only on the single-job endpoint."""
        with self._lock:
            row = self._db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            result = self._public(row)
            snapshot = json.loads(row["snapshot"])
            source = None
            if row["mode"] == "noise_variant":
                source_row = self._db.execute("SELECT snapshot FROM jobs WHERE id=?", (snapshot["source_job_id"],)).fetchone()
                if source_row is not None:
                    source = json.loads(source_row[0])
            return {**result, "parameters": snapshot, "source_parameters": source}

    def frames(self, job_id: str, offset: int = 0, limit: int = 1) -> dict:
        """Enumerate complete-frame markers, never staging or unlisted files."""
        with self._lock:
            row = self._db.execute("SELECT mode,snapshot FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            source_id = (json.loads(row["snapshot"])["source_job_id"]
                         if row["mode"] == "noise_variant" else job_id)
            total = self._db.execute("SELECT COUNT(*) FROM frames WHERE job_id=?", (job_id,)).fetchone()[0]
            frames = []
            for frame in self._db.execute("SELECT frame_id FROM frames WHERE job_id=? ORDER BY frame_id LIMIT ? OFFSET ?",
                                          (job_id, limit, offset)).fetchall():
                frame_id = frame[0]
                images = {"clean": None, "noisy": None}
                for kind, owner in (("clean", source_id), ("noisy", job_id)):
                    relative = f"images_{kind}/{frame_id}.png"
                    if self.published_file(owner, relative) is not None:
                        images[kind] = f"/data/{owner}/{relative}"
                frames.append({"frame_id": frame_id, "images": images})
            return {"frames": frames, "total": total}

    def list(self, limit: int = 100, offset: int = 0) -> list[dict]:
        with self._lock:
            return [self._public(row) for row in self._db.execute("SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", (limit, offset))]

    def request(self, job_id: str) -> JobRequest | NoiseVariantRequest:
        with self._lock:
            row = self._db.execute("SELECT snapshot FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            values = json.loads(row[0])
            return (NoiseVariantRequest if values.get("mode") == "noise_variant" else JobRequest).from_dict(values)

    def claim_next(self) -> dict | None:
        with self._lock, self._db:
            row = self._db.execute("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1").fetchone()
            if row is None:
                return None
            self._db.execute("UPDATE jobs SET status='running' WHERE id=? AND status='queued'", (row[0],))
            return self.get(row[0])

    def cancel(self, job_id: str) -> dict:
        with self._lock, self._db:
            job = self.get(job_id)
            if job["status"] not in TERMINAL:
                self._db.execute("UPDATE jobs SET cancel_requested=1, status=CASE WHEN status='queued' THEN 'canceled' ELSE status END WHERE id=?", (job_id,))
            return self.get(job_id)

    def cancellation_requested(self, job_id: str) -> bool:
        with self._lock:
            row = self._db.execute("SELECT cancel_requested FROM jobs WHERE id=?", (job_id,)).fetchone()
            return row is None or bool(row[0])

    def publish_frame(self, job_id: str, stage: Path, frame_id: str) -> bool:
        """Serialize cancellation with the complete-frame publication boundary.

        Rendering/decoding never holds this lock; only validated local files and
        their final DB marker are committed together with respect to cancellation.
        """
        with self._lock:
            if self.cancellation_requested(job_id):
                return False
            output = self.output_directory(job_id)
            paths = commit_frame(stage, output, frame_id)
            self.mark_frame(job_id, frame_id, paths)
            return True

    def mark_frame(self, job_id: str, frame_id: str, files: list[str]) -> None:
        with self._lock, self._db:
            job = self.get(job_id)
            if job["status"] != "running" or job["completed_frames"] >= job["total_frames"]:
                raise ValueError("任务状态不允许提交更多帧")
            self._db.execute("INSERT INTO frames(job_id,frame_id,files) VALUES (?,?,?)", (job_id, frame_id, json.dumps(files)))
            self._db.execute("UPDATE jobs SET completed_frames=completed_frames+1, latest_frame=? WHERE id=?", (frame_id, job_id))

    def finish(self, job_id: str, status: str, error: str | None = None) -> None:
        if status not in TERMINAL:
            raise ValueError("无效的任务终止状态")
        with self._lock, self._db:
            job = self.get(job_id)
            if job["status"] in TERMINAL:
                return
            if status == "completed":
                if self.cancellation_requested(job_id):
                    status = "canceled"
                elif job["completed_frames"] != job["total_frames"]:
                    raise ValueError("任务尚有未完成帧")
            self._db.execute("UPDATE jobs SET status=?, error=? WHERE id=?", (status, error, job_id))

    def interrupt_running(self, reason: str) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE jobs SET status='interrupted', error=? WHERE status='running'", (reason,))

    def published_file(self, job_id: str, relative: str) -> Path | None:
        with self._lock:
            frame_id = Path(relative).stem
            row = self._db.execute("SELECT files FROM frames WHERE job_id=? AND frame_id=?", (job_id, frame_id)).fetchone()
            if row is None or relative not in json.loads(row[0]):
                return None
        root = self.output_directory(job_id).resolve()
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            return None
        return path

    def close(self) -> None:
        with self._lock:
            self._db.close()
