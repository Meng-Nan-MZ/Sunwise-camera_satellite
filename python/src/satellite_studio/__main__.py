"""CLI entry point; stdout carries only the machine-readable ready event."""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
import signal
import threading

from satellite_studio.server.app import create_server


def main() -> int:
    parser = argparse.ArgumentParser(description="Satellite Dataset Studio loopback service")
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--blender", type=Path)
    parser.add_argument("--port", type=int, default=8765)
    options = parser.parse_args()
    if not 0 <= options.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    project = options.project_root.resolve()
    workspace = options.workspace or project / "var/workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    logs = workspace / "logs"
    logs.mkdir(exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s",
                        handlers=[logging.StreamHandler(), logging.FileHandler(logs / "service.log", encoding="utf-8")])
    try:
        server = create_server(project, workspace, options.blender, options.port)
    except Exception as exc:
        logging.error("Service startup failed: %s", exc)
        return 1
    # shutdown() must run on another thread, never inside serve_forever's own thread.
    def stop(signum, frame):
        threading.Thread(target=server.shutdown, name="service-shutdown", daemon=True).start()
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    port = server.server_address[1]
    print(json.dumps({"event": "ready", "port": port, "url": f"http://127.0.0.1:{port}"}), flush=True)
    try:
        server.serve_forever(poll_interval=.25)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
