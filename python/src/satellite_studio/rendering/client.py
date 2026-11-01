"""Lazy, persistent Blender child process with a private JSON socket."""

from __future__ import annotations

import json
from pathlib import Path
import secrets
import socket
import subprocess
import threading


class BlenderRenderer:
    def __init__(self, project_root: Path, blender_path: Path, log_dir: Path):
        self.project_root = Path(project_root).resolve()
        self.blender_path = Path(blender_path).resolve()
        self.log_dir = Path(log_dir).resolve()
        self._process = None
        self._socket = None
        self._stream = None
        self._log = None
        self._closed = False
        self._lock = threading.Lock()

    def _start(self) -> None:
        if not self.blender_path.is_file():
            raise FileNotFoundError(f"Blender executable not found: {self.blender_path}")
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._log = (self.log_dir / "blender-worker.log").open("ab", buffering=0)
        token = secrets.token_hex(32)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(1)
            worker = Path(__file__).with_name("worker.py")
            args = [str(self.blender_path), "--background", "--factory-startup",
                    "--disable-autoexec", "--python-exit-code", "1", "--python", str(worker),
                    "--", "--connect", str(listener.getsockname()[1]), "--token", token,
                    "--project-root", str(self.project_root)]
            self._process = subprocess.Popen(args, stdin=subprocess.DEVNULL,
                                             stdout=self._log, stderr=self._log,
                                             cwd=self.project_root,
                                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            for _ in range(90):
                if self._closed:
                    raise RuntimeError("Renderer closed during startup")
                if self._process.poll() is not None:
                    raise RuntimeError(f"Blender exited during startup; see {self.log_dir / 'blender-worker.log'}")
                try:
                    self._socket, _ = listener.accept()
                    break
                except socket.timeout:
                    continue
            else:
                raise TimeoutError("Blender startup timed out")
        self._socket.settimeout(900)
        self._stream = self._socket.makefile("rwb")
        if json.loads(self._stream.readline(4096)).get("token") != token:
            raise RuntimeError("Invalid Blender worker handshake")

    def render(self, frame: dict, output_directory: Path) -> dict:
        with self._lock:
            if self._closed:
                raise RuntimeError("Renderer is closed")
            try:
                if self._process is None or self._process.poll() is not None:
                    self._dispose()
                    self._start()
                output = Path(output_directory).resolve()
                if not output.is_dir():
                    raise FileNotFoundError(f'Render staging directory is unavailable: {output}')
                request = {"frame": frame, "output_directory": str(output)}
                self._stream.write(json.dumps(request, allow_nan=False).encode() + b"\n")
                self._stream.flush()
                line = self._stream.readline(1024 * 1024)
                if not line:
                    raise RuntimeError("Blender worker disconnected; see blender-worker.log")
                response = json.loads(line)
                if "error" in response:
                    raise RuntimeError(response["error"])
                return response["result"]
            except Exception:
                self._dispose()
                raise

    def _dispose(self) -> None:
        process, self._process = self._process, None
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if self._socket is not None:
            try:
                self._socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        for resource in (self._stream, self._socket, self._log):
            if resource is not None:
                resource.close()
        self._stream = self._socket = self._log = None

    def close(self) -> None:
        # Interrupt a blocked render before acquiring its serialization lock.
        self._closed = True
        process = self._process
        if process is not None and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass
        with self._lock:
            self._dispose()
