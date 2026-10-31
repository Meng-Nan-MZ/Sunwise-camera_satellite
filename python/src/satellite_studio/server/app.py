"""Small offline API. Never use a source-tree directory as a static document root."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import mimetypes
from pathlib import Path
import re
import shutil
import time
from typing import Callable
from urllib.parse import unquote, urlsplit

from satellite_studio import SCHEMA_VERSION
from satellite_studio.domain.parameters import JobRequest
from satellite_studio.jobs.runner import JobRunner, Renderer
from satellite_studio.jobs.store import JobStore, validate_workspace_protocol
from .models import ModelCatalog
from .workspace import WorkspaceLock

LOGGER = logging.getLogger(__name__)
MAX_BODY = 65536
STATIC_EXTENSIONS = frozenset((".html", ".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".ico", ".woff", ".woff2"))
JOB_ID = re.compile(r"^[a-f0-9]{32}$")


class Application:
    def __init__(self, project_root: Path, workspace: Path, blender_path: Path | None,
                 renderer_factory: Callable[[], Renderer] | None = None):
        self.project_root = project_root.resolve()
        self.workspace = workspace.resolve()
        validate_workspace_protocol(self.workspace)
        self._lock = WorkspaceLock(self.workspace)
        try:
            self.catalog = ModelCatalog(self.project_root)
            self.store = JobStore(self.workspace)
            self.renderer_available = renderer_factory is not None or (blender_path is not None and blender_path.is_file())

            def factory() -> Renderer:
                if blender_path is None or not blender_path.is_file():
                    raise RuntimeError("未找到 Blender。请通过 --blender 指定 Blender 可执行文件；三维预览仍可使用。")
                from satellite_studio.rendering.client import BlenderRenderer
                return BlenderRenderer(self.project_root, blender_path, self.workspace / "logs")

            self.runner = JobRunner(self.store, renderer_factory or factory)
            self.runner.start()
        except Exception:
            if hasattr(self, "store"):
                self.store.close()
            self._lock.close()
            raise

    def close(self) -> None:
        try:
            self.runner.close()
            self.store.close()
        finally:
            self._lock.close()


class LocalServer(ThreadingHTTPServer):
    # Let active HTTP handlers finish before closing their SQLite connection.
    daemon_threads = False
    block_on_close = True

    def __init__(self, app: Application, port: int):
        self.app = app
        self._closed = False
        super().__init__(("127.0.0.1", port), Handler)

    def server_close(self) -> None:
        if self._closed:
            return
        self._closed = True
        super().server_close()
        self.app.close()


class Handler(BaseHTTPRequestHandler):
    server: LocalServer
    server_version = "SatelliteStudio/0.1"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(15)
        self._body_read = 0

    def handle(self) -> None:
        try:
            super().handle()
        except (ConnectionError, TimeoutError):
            # Browser navigation/closing can reset a normal socket at any point.
            # Keep real application exceptions visible through the normal logger.
            pass

    def log_message(self, format: str, *args) -> None:
        LOGGER.debug("HTTP %s: %s", self.client_address[0], format % args)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'")
        super().end_headers()

    def _json(self, status: int, value: dict | list) -> None:
        data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _error(self, status: int, message: str) -> None:
        self._discard_rejected_body()
        self._json(status, {"error": message})

    def _discard_rejected_body(self) -> None:
        """Avoid a Windows TCP reset hiding an early 4xx response from the client.

        Rejected data is discarded in bounded chunks, never parsed. Limit both
        bytes and elapsed time so an oversized/slow sender cannot block shutdown.
        """
        if self.command != "POST":
            return
        try:
            remaining = min(max(int(self.headers.get("Content-Length", "0")) - self._body_read, 0), 1024 * 1024)
        except ValueError:
            return
        old_timeout = self.connection.gettimeout()
        deadline = time.monotonic() + .25
        try:
            self.connection.settimeout(.1)
            while remaining > 0 and time.monotonic() < deadline:
                chunk = self.rfile.read1(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                self._body_read += len(chunk)
        except (ConnectionError, TimeoutError):
            pass
        finally:
            self.connection.settimeout(old_timeout)

    def _check_origin(self) -> bool:
        port = self.server.server_address[1]
        allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        hosts = self.headers.get_all("Host", [])
        if len(hosts) != 1 or hosts[0] not in allowed_hosts:
            self._error(403, "仅允许本机服务地址")
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin != f"http://{hosts[0]}":
            self._error(403, "拒绝跨来源请求")
            return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            self._error(403, "拒绝跨站点请求")
            return False
        return True

    def _path(self) -> str:
        parsed = urlsplit(self.path)
        if parsed.scheme or parsed.netloc or not parsed.path.startswith("/"):
            raise ValueError("无效请求路径")
        path = unquote(parsed.path, errors="strict")
        if any(char in path for char in ("\\", "\0", ":")) or any(part in (".", "..") for part in path.split("/")):
            raise ValueError("拒绝路径穿越")
        return path

    def _send_file(self, path: Path) -> None:
        mime = "model/gltf-binary" if path.suffix == ".glb" else mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if path.suffix == ".js":
            mime = "text/javascript"
        with path.open("rb") as stream:
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(path.stat().st_size))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if self.command != "HEAD":
                shutil.copyfileobj(stream, self.wfile, length=1024 * 1024)

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        if not self._check_origin():
            return
        try:
            path = self._path()
            app = self.server.app
            if path == "/api/health":
                self._json(200, {"status": "ok", "renderer_available": app.renderer_available, "schema_version": SCHEMA_VERSION})
                return
            if path == "/api/models":
                self._json(200, app.catalog.public())
                return
            if path == "/api/jobs":
                self._json(200, app.store.list())
                return
            parts = path.strip("/").split("/")
            if len(parts) == 3 and parts[:2] == ["api", "jobs"] and JOB_ID.fullmatch(parts[2]):
                self._json(200, app.store.get(parts[2]))
                return
            file = None
            if len(parts) == 4 and parts[:2] == ["assets", "models"] and parts[3] == "preview.glb":
                file = app.catalog.preview(parts[2])
            elif len(parts) == 4 and parts[0] == "data" and JOB_ID.fullmatch(parts[1]):
                file = app.store.published_file(parts[1], "/".join(parts[2:]))
            elif not path.startswith(("/api/", "/data/", "/assets/models/")):
                dist = (app.project_root / "apps/ui/dist").resolve()
                candidate = (dist / ("index.html" if path == "/" else path.lstrip("/"))).resolve()
                if candidate.is_relative_to(dist) and candidate.suffix.lower() in STATIC_EXTENSIONS and candidate.is_file():
                    file = candidate
            if file is None:
                self._error(404, "资源不存在；请确认界面已构建且请求的是完整帧产物。")
            else:
                self._send_file(file)
        except KeyError:
            self._error(404, "任务不存在")
        except (ValueError, UnicodeError) as exc:
            self._error(400, str(exc))
        except (ConnectionError, TimeoutError):
            pass
        except Exception:
            LOGGER.exception("GET failed")
            self._error(500, "服务内部错误，请查看服务日志")

    def _read_json(self) -> dict:
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("不接受分块请求")
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise ValueError("请求 Content-Type 必须为 application/json")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise ValueError("请求缺少 Content-Length")
        length = int(raw_length)
        if length < 0:
            raise ValueError("请求长度无效")
        if length > MAX_BODY:
            raise OverflowError("请求超过 64 KiB 限制")
        raw = self.rfile.read(length)
        self._body_read += len(raw)
        if len(raw) != length:
            raise ValueError("请求内容不完整")
        def invalid_constant(value: str):
            raise ValueError(f"JSON 不能包含 {value}")
        return json.loads(raw.decode("utf-8"), parse_constant=invalid_constant)

    def do_POST(self) -> None:
        if not self._check_origin():
            return
        try:
            path = self._path()
            app = self.server.app
            if path == "/api/jobs":
                request = JobRequest.from_dict(self._read_json())
                app.catalog.require_render_asset(request.scene.model_id)
                job = app.store.create(request)
                app.runner.wake()
                self._json(202, job)
                return
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ["api", "jobs"] and JOB_ID.fullmatch(parts[2]) and parts[3] == "cancel":
                self._json(200, app.store.cancel(parts[2]))
                return
            self._error(404, "接口不存在")
        except OverflowError as exc:
            self._error(413, str(exc))
        except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
            self._error(400, str(exc))
        except KeyError:
            self._error(404, "任务不存在")
        except (ConnectionError, TimeoutError):
            pass
        except Exception:
            LOGGER.exception("POST failed")
            self._error(500, "服务内部错误，请查看服务日志")

    def do_OPTIONS(self) -> None:
        self._error(405, "不支持跨域访问")


def create_server(project_root: Path, workspace: Path, blender_path: Path | None, port: int = 8765,
                  *, renderer_factory: Callable[[], Renderer] | None = None) -> LocalServer:
    app = Application(Path(project_root), Path(workspace), Path(blender_path) if blender_path else None, renderer_factory)
    try:
        return LocalServer(app, port)
    except Exception:
        app.close()
        raise
