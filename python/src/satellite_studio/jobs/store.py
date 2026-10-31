"""A complete-frame DB row is the sole publication marker for frame artifacts."""
from __future__ import annotations

from datetime import datetime, timezone
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import threading
import uuid

from satellite_studio.datasets.export import write_json
from satellite_studio.domain.parameters import JobRequest
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
            CREATE TRIGGER IF NOT EXISTS snapshot_immutable BEFORE UPDATE OF snapshot ON jobs
            BEGIN SELECT RAISE(ABORT, 'job snapshot is immutable'); END;
        """)
        with self._db:
            self._db.execute("INSERT INTO protocol SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM protocol)",
                             (SCHEMA_VERSION, COORDINATE_CONVENTION_ID))
        # Persist marker in the main DB so preflight needs no WAL/SHM access.
        self._db.execute("PRAGMA wal_checkpoint(FULL)")
        self.interrupt_running("上次运行中断；完整帧已保留，可重新提交任务。")

    def _public(self, row: sqlite3.Row) -> dict:
        frame = row["latest_frame"]
        return {"id": row["id"], "mode": row["mode"], "status": row["status"],
                "completed_frames": row["completed_frames"], "total_frames": row["total_frames"],
                "created_at": row["created_at"], "error": row["error"],
                "latest_image_url": f"/data/{row['id']}/images_clean/{frame}.png" if frame else None,
                "output_directory": str(self.jobs_directory / row["id"]),
                "cancel_requested": bool(row["cancel_requested"])}

    def create(self, request: JobRequest) -> dict:
        job_id = uuid.uuid4().hex
        snapshot = request.to_dict()
        directory = self.jobs_directory / job_id
        directory.mkdir()
        write_json(directory / "job.json", snapshot)
        with self._lock, self._db:
            self._db.execute("INSERT INTO jobs (id,mode,status,total_frames,created_at,snapshot) VALUES (?,?,?,?,?,?)",
                             (job_id, request.mode, "queued", request.count, datetime.now(timezone.utc).isoformat(),
                              json.dumps(snapshot, allow_nan=False, ensure_ascii=False)))
            return self.get(job_id)

    def get(self, job_id: str) -> dict:
        with self._lock:
            row = self._db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            return self._public(row)

    def list(self, limit: int = 100) -> list[dict]:
        with self._lock:
            return [self._public(row) for row in self._db.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,))]

    def request(self, job_id: str) -> JobRequest:
        with self._lock:
            row = self._db.execute("SELECT snapshot FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            return JobRequest.from_dict(json.loads(row[0]))

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
        root = (self.jobs_directory / job_id).resolve()
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            return None
        return path

    def close(self) -> None:
        with self._lock:
            self._db.close()
