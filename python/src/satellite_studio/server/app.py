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
from urllib.parse import parse_qsl, unquote, urlsplit

from satellite_studio import SCHEMA_VERSION
from satellite_studio.domain.parameters import JobRequest
from satellite_studio.jobs.runner import JobRunner, Renderer
from satellite_studio.jobs.store import JobStore, validate_workspace_protocol
from satellite_studio.jobs.deletion import DeletionError
from satellite_studio.rendering.browser_bridge import BrowserBridge, BridgeError
from satellite_studio.rendering.browser_renderer import BrowserRenderer
from .models import ModelCatalog
from .workspace import WorkspaceLock

LOGGER = logging.getLogger(__name__)
MAX_BODY = 65536
STATIC_EXTENSIONS = frozenset((".html", ".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".ico", ".woff", ".woff2"))
JOB_ID = re.compile(r"^[a-f0-9]{32}$")


class Application:
    def __init__(self, project_root: Path, workspace: Path,
                 renderer_factory: Callable[[], Renderer] | None = None):
        self.project_root = project_root.resolve()
        self.workspace = workspace.resolve()
        validate_workspace_protocol(self.workspace)
        self._lock = WorkspaceLock(self.workspace)
        try:
            self.catalog = ModelCatalog(self.project_root)
            self.store = JobStore(self.workspace)
            self.bridge = BrowserBridge(is_canceled=self.store.cancellation_requested)
            self.runner = JobRunner(self.store, renderer_factory or
                                    (lambda: BrowserRenderer(self.bridge, self.catalog)))
            self.runner.start()
        except Exception:
            if hasattr(self, "store"):
                self.store.close()
            self._lock.close()
            raise

    @property
    def renderer_available(self) -> bool:
        return self.bridge.available

    def stop(self) -> None:
        self.runner.stop()
        self.bridge.close()

    def close(self) -> None:
        self.stop()
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
        self.app.stop()
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

    def parse_request(self) -> bool:
        # setup() runs once per connection, but keep-alive connections carry
        # many requests; body accounting must restart with each request line.
        self._body_read = 0
        return super().parse_request()

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

    def _error(self, status: int, message: str, code: str | None = None) -> None:
        self._discard_rejected_body()
        self._json(status, {"error": message, **({'code': code} if code else {})})

    def _discard_rejected_body(self) -> None:
        """Avoid a Windows TCP reset hiding an early 4xx response from the client.

        Rejected data is discarded in bounded chunks, never parsed. Limit both
        bytes and elapsed time so an oversized/slow sender cannot block shutdown.
        """
        if self.command not in ("POST", "DELETE"):
            return
        try:
            remaining = min(max(int(self.headers.get("Content-Length", "0")) - self._body_read, 0), 16 * 1024 * 1024)
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

    def _page_query(self, *, default_limit: int, maximum_offset: int) -> tuple[int, int]:
        query = urlsplit(self.path).query
        pairs = parse_qsl(query, keep_blank_values=True, strict_parsing=True,
                          errors="strict", max_num_fields=2)
        values = {"offset": 0, "limit": default_limit}
        seen = set()
        for key, value in pairs:
            if key not in values or key in seen or not re.fullmatch(r"[0-9]{1,7}", value):
                raise ValueError("分页仅接受唯一的 offset 和 limit 整数参数")
            seen.add(key)
            number = int(value)
            if not (0 <= number <= maximum_offset if key == "offset" else 1 <= number <= 100):
                raise ValueError("分页参数超出允许范围")
            values[key] = number
        return values["offset"], values["limit"]

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        if not self._check_origin():
            return
        try:
            path = self._path()
            app = self.server.app
            if path == '/api/settings/appearance':
                self._json(200, app.store.appearance_settings())
                return
            if path == '/api/settings/output-directory':
                self._json(200, app.store.output_settings())
                return
            if path == "/api/health":
                self._json(200, {"status": "ok", "renderer_available": app.renderer_available, "schema_version": SCHEMA_VERSION,
                    "renderers": {"threejs": {"available": app.bridge.available,
                        "reason": "" if app.bridge.available else "请保持工作台打开，等待网页采集器连接"}}})
                return
            if path == "/api/models":
                self._json(200, app.catalog.public())
                return
            if path == "/api/jobs":
                offset, limit = self._page_query(default_limit=100, maximum_offset=1000000)
                self._json(200, app.store.list(limit=limit, offset=offset))
                return
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ['api', 'jobs'] and JOB_ID.fullmatch(parts[2]) and parts[3] == 'deletion-preview':
                if urlsplit(self.path).query:
                    raise ValueError('删除预览不接受查询参数')
                self._json(200, app.store.deletion_preview(parts[2]))
                return
            if len(parts) == 4 and parts[:2] == ["api", "jobs"] and JOB_ID.fullmatch(parts[2]) and parts[3] == "frames":
                offset, limit = self._page_query(default_limit=1, maximum_offset=99999)
                self._json(200, app.store.frames(parts[2], offset=offset, limit=limit))
                return
            if len(parts) == 3 and parts[:2] == ["api", "jobs"] and JOB_ID.fullmatch(parts[2]):
                self._json(200, app.store.detail(parts[2]))
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
        except DeletionError as exc:
            self._error(exc.status, str(exc), exc.code)
        except KeyError:
            self._error(404, "任务不存在")
        except (ValueError, UnicodeError) as exc:
            self._error(400, str(exc))
        except (ConnectionError, TimeoutError):
            pass
        except Exception:
            LOGGER.exception("GET failed")
            self._error(500, "服务内部错误，请查看服务日志")

    def _read_json(self, limit: int = MAX_BODY) -> dict:
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
        if length > limit:
            raise OverflowError(f"请求超过 {limit} 字节限制")
        raw = self.rfile.read(length)
        self._body_read += len(raw)
        if len(raw) != length:
            raise ValueError("请求内容不完整")
        def invalid_constant(value: str):
            raise ValueError(f"JSON 不能包含 {value}")
        value = json.loads(raw.decode("utf-8"), parse_constant=invalid_constant)
        json.dumps(value, allow_nan=False)
        if not isinstance(value, dict):
            raise ValueError("请求必须为 JSON 对象")
        return value

    def do_POST(self) -> None:
        if not self._check_origin():
            return
        try:
            path = self._path()
            app = self.server.app
            if path == '/api/settings/appearance':
                body = self._read_json()
                if set(body) != {'theme'}:
                    raise ValueError('请求仅接受 theme 字符串')
                self._json(200, app.store.set_appearance(body['theme']))
                return
            if path == '/api/settings/output-directory':
                body = self._read_json()
                if set(body) != {'output_directory'} or not isinstance(body['output_directory'], str):
                    raise ValueError('请求仅接受 output_directory 字符串')
                self._json(200, app.store.set_output_directory(body['output_directory']))
                return
            if path.startswith("/api/render-worker/"):
                action = path.removeprefix("/api/render-worker/")
                body = self._read_json(12 * 1024 * 1024 if action == "result" else MAX_BODY)
                if action == "register":
                    if body:
                        raise ValueError("register 请求必须为空对象")
                    result = app.bridge.register()
                elif action == "result":
                    result = app.bridge.result(body)
                elif action in ("heartbeat", "poll", "release"):
                    if set(body) != {"worker_token"}:
                        raise ValueError("请求仅接受 worker_token")
                    result = getattr(app.bridge, action)(body["worker_token"])
                else:
                    self._error(404, "接口不存在")
                    return
                self._json(200, result)
                return
            if path == "/api/jobs":
                # Historical parsing retains its Blender default. Only a new
                # HTTP submission is normalized to the supported web backend.
                body = self._read_json()
                body.setdefault("renderer_backend", "threejs")
                if body["renderer_backend"] != "threejs":
                    raise ValueError("新采集任务仅支持 Three.js；历史 Blender 任务仍可查看和生成噪声副本。")
                request = JobRequest.from_dict(body)
                if app.catalog.get(request.scene.model_id).get("selectable", True) is False:
                    raise ValueError("此模型已从采集模型库移除，请选择现有模型；历史任务仍可查看和追加噪声。")
                app.catalog.require_web_asset(request.scene.model_id)
                job = app.store.create(request)
                app.runner.wake()
                self._json(202, job)
                return
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ["api", "jobs"] and JOB_ID.fullmatch(parts[2]) and parts[3] == "noise-variants":
                job = app.store.create_noise_variant(parts[2], self._read_json())
                app.runner.wake()
                self._json(202, job)
                return
            if len(parts) == 4 and parts[:2] == ["api", "jobs"] and JOB_ID.fullmatch(parts[2]) and parts[3] == "cancel":
                job = app.store.cancel(parts[2])
                app.bridge.cancel(parts[2])
                self._json(200, job)
                return
            self._error(404, "接口不存在")
        except DeletionError as exc:
            self._error(exc.status, str(exc), exc.code)
        except BridgeError as exc:
            self._error(exc.status, str(exc))
        except OverflowError as exc:
            self._error(413, str(exc))
        except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
            self._error(400, str(exc))
        except KeyError:
            self._error(404, "任务不存在")
        except (ConnectionError, TimeoutError):
            pass
        except OSError as exc:
            self._error(400, f'数据集输出位置不可用或不可写：{exc}')
        except Exception:
            LOGGER.exception("POST failed")
            self._error(500, "服务内部错误，请查看服务日志")

    def do_DELETE(self) -> None:
        if not self._check_origin():
            return
        try:
            path = self._path()
            if urlsplit(self.path).query:
                raise ValueError('删除请求仅接受任务 ID，不接受查询参数')
            if self.headers.get('Transfer-Encoding'):
                raise ValueError('删除请求不接受分块内容')
            lengths = self.headers.get_all('Content-Length', [])
            if len(lengths) > 1 or (lengths and lengths[0] != '0'):
                raise ValueError('删除请求不接受请求体或文件夹路径')
            parts = path.strip('/').split('/')
            if len(parts) != 3 or parts[:2] != ['api', 'jobs'] or not JOB_ID.fullmatch(parts[2]):
                self._error(404, '接口不存在', 'JOB_NOT_FOUND')
                return
            matches = self.headers.get_all('If-Match', [])
            if len(matches) > 1:
                raise ValueError('删除确认标识必须唯一')
            self._json(200, self.server.app.store.delete(parts[2], matches[0] if matches else None))
        except DeletionError as exc:
            self._error(exc.status, str(exc), exc.code)
        except KeyError:
            self._error(404, '任务不存在', 'JOB_NOT_FOUND')
        except (ValueError, UnicodeError) as exc:
            self._error(400, str(exc), 'INVALID_DELETE_REQUEST')
        except (ConnectionError, TimeoutError):
            pass
        except Exception:
            LOGGER.exception('DELETE failed')
            self._error(500, '删除未完成，任务记录已保留，请查看服务日志。', 'DELETE_FAILED')

    def do_OPTIONS(self) -> None:
        self._error(405, "不支持跨域访问")


def create_server(project_root: Path, workspace: Path, port: int = 8765,
                  *, renderer_factory: Callable[[], Renderer] | None = None) -> LocalServer:
    app = Application(Path(project_root), Path(workspace), renderer_factory)
    try:
        return LocalServer(app, port)
    except Exception:
        app.close()
        raise
