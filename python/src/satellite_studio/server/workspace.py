"""An OS file lock prevents two services from interrupting each other's jobs."""
from __future__ import annotations

import os
from pathlib import Path


class WorkspaceLock:
    def __init__(self, workspace: Path):
        workspace.mkdir(parents=True, exist_ok=True)
        self.stream = (workspace / "service.lock").open("a+b")
        try:
            if self.stream.seek(0, 2) == 0:
                self.stream.write(b"0")
                self.stream.flush()
            self.stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.stream.close()
            raise RuntimeError("此工作目录已有服务运行，请关闭原服务或选择其他工作目录。") from exc

    def close(self) -> None:
        if self.stream.closed:
            return
        self.stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
        self.stream.close()
