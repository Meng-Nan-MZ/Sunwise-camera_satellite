"""Blender-only socket entrypoint. Never imported by the UI service."""

import sys

# Installed application sources are read-only; Blender may ignore Python env vars.
sys.dont_write_bytecode = True

import argparse
import json
from pathlib import Path
import socket
import traceback


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--connect", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--project-root", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from satellite_studio.rendering.scene import SceneRenderer

    renderer = SceneRenderer(args.project_root)
    with socket.create_connection(("127.0.0.1", args.connect), timeout=60) as connection:
        connection.settimeout(None)
        with connection.makefile("rwb") as stream:
            stream.write(json.dumps({"token": args.token}).encode() + b"\n")
            stream.flush()
            while line := stream.readline(1024 * 1024):
                try:
                    request = json.loads(line)
                    result = renderer.render(request["frame"], Path(request["output_directory"]))
                    response = {"result": result}
                except Exception as exc:
                    traceback.print_exc()
                    response = {"error": f"{type(exc).__name__}: {exc}"}
                stream.write(json.dumps(response, allow_nan=False).encode() + b"\n")
                stream.flush()


if __name__ == "__main__":
    main()
