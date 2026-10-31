"""Assemble a curated, relocatable offline release. Never deletes an existing directory."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil

MODEL_IDS = {"insat_3b", "hubble", "sputnik_1", "gps", "galileo", "glonass"}


def long_path(path: Path) -> Path:
    """Access bundled vendor files without changing the machine's long-path policy."""
    absolute = str(path.resolve())
    if os.name != "nt" or absolute.startswith("\\\\?\\"):
        return Path(absolute)
    if absolute.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + absolute[2:])
    return Path("\\\\?\\" + absolute)


def sha256(file: Path) -> str:
    with long_path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked_path(root: Path, relative: str) -> Path:
    if "\\" in relative or ":" in relative or any(p in ("..", ".") for p in relative.split("/")):
        raise ValueError(f"Unsafe path: {relative}")
    result = (root / relative).resolve()
    if not result.is_relative_to(root.resolve()):
        raise ValueError(f"Path outside root: {relative}")
    return result


def model_files(root: Path) -> list[Path]:
    index = root / "assets/models/index.json"
    rows = json.loads(index.read_text(encoding="utf-8-sig"))
    if len(rows) != 6 or {row["id"] for row in rows} != MODEL_IDS:
        raise ValueError("Release must contain exactly the six registered models")
    files = [index]
    for row in rows:
        for field, filename, digest in (("preview_file", "preview.glb", "preview_sha256"),
                                        ("blend_file", "render.blend", "sha256")):
            expected = f"assets/models/{row['id']}/{filename}"
            if row[field] != expected:
                raise ValueError(f"Unexpected model path: {row[field]}")
            file = checked_path(root, row[field])
            if not file.is_file() or sha256(file) != row[digest]:
                raise ValueError(f"Missing model or hash mismatch: {row[field]}")
            files.append(file)
    return files


def prepare_output(root: Path, output: Path) -> None:
    staging = (root / "var/packaging/staging").resolve()
    output = output.resolve()
    if not output.is_relative_to(staging) or output == staging:
        raise ValueError("Output must be a child of var/packaging/staging")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output must be empty; choose a new staging directory")
    output.mkdir(parents=True, exist_ok=True)


def copy_source(source: Path, target: Path) -> None:
    shutil.copytree(long_path(source), long_path(target),
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", "*.pdb"))


def inventory(root: Path) -> list[dict]:
    root = long_path(root)
    result = []
    for file in sorted(root.rglob("*")):
        if file.is_file() and file != root / "release-manifest.json":
            if not file.resolve().is_relative_to(root.resolve()):
                raise ValueError(f"External file in payload: {file}")
            result.append({"path": file.relative_to(root).as_posix(), "size_bytes": file.stat().st_size,
                           "sha256": sha256(file)})
    return result


def verify_inventory(root: Path, files: list[dict]) -> None:
    root = long_path(root)
    for entry in files:
        file = checked_path(root, entry["path"])
        if not file.is_file() or file.stat().st_size != entry["size_bytes"]:
            raise ValueError(f"Missing file or size mismatch: {entry['path']}")
        if sha256(file) != entry["sha256"]:
            raise ValueError(f"File hash mismatch: {entry['path']}")


def copy_file(source: Path, target: Path) -> None:
    source, target = long_path(source), long_path(target)
    if not source.is_file():
        raise FileNotFoundError(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def copy_licenses(root: Path, output: Path, lock: dict) -> None:
    target = output / "licenses"
    for package in ("react", "react-dom", "three"):
        source = root / f"apps/ui/node_modules/{package}/LICENSE"
        copy_file(source, target / f"{package}-LICENSE.txt")
    scheduler = list((root / "apps/ui/node_modules/.pnpm").glob("scheduler@*/node_modules/scheduler/LICENSE"))
    if len(scheduler) != 1:
        raise ValueError("Ambiguous scheduler license; clean dependency install required")
    copy_file(scheduler[0], target / "scheduler-LICENSE.txt")
    nuget = root / "var/tools/nuget"
    for package, version in (("microsoft.web.webview2", lock["build_tools"]["webview2_sdk"]),
                             ("microsoft.netcore.app.runtime.win-x64", lock["runtime_versions"]["dotnet"]),
                             ("microsoft.windowsdesktop.app.runtime.win-x64", lock["runtime_versions"]["dotnet"])):
        source = nuget / package / version
        notices = [file for file in source.iterdir()
                   if file.is_file() and ("license" in file.name.lower() or "notice" in file.name.lower())]
        if not notices:
            raise ValueError(f"Missing third-party notices: {package}")
        for file in notices:
            copy_file(file, target / package / file.name)
    for filename in ("THIRD-PARTY-NOTICES.md", "WebView2-Runtime-LICENSE.txt"):
        copy_file(root / "packaging" / filename, target / filename)
    copy_file(root / "var/packaging/tools/inno/license.txt", target / "Inno-Setup-LICENSE.txt")


def build(args) -> dict:
    root, output = long_path(args.project_root), long_path(args.output)
    models = model_files(root)
    lock_file = root / "packaging/dependencies.lock.json"
    lock = json.loads(lock_file.read_text(encoding="utf-8"))
    for entry in lock["downloads"]:
        file = checked_path(root / "var/packaging/downloads", entry["file"])
        if not file.is_file() or sha256(file) != entry["sha256"]:
            raise ValueError(f"Locked dependency hash mismatch: {entry['file']}")
    prepare_output(root, output)
    copy_source(args.desktop, output / "_desktop")
    # Publish directly at the application root; no source-tree executable path.
    for file in (output / "_desktop").iterdir():
        file.rename(output / file.name)
    (output / "_desktop").rmdir()
    copy_source(root / "apps/ui/dist", output / "apps/ui/dist")
    copy_source(root / "python/src", output / "python/src")
    for file in models:
        copy_file(file, output / file.relative_to(root))
    for name, source in (("python", args.python_runtime), ("blender", args.blender_runtime),
                         ("webview2", args.webview_runtime)):
        shutil.copytree(long_path(source), output / "runtime" / name)
    for name in ("user-guide.md", "offline-installation.md", "model-materials.md"):
        copy_file(root / "docs" / name, output / "docs" / name)
    copy_file(root / "packaging/使用说明.html", output / "docs/使用说明.html")
    copy_file(lock_file, output / "licenses/dependencies.lock.json")
    copy_licenses(root, output, lock)
    required = ("SatelliteStudio.Desktop.exe", "SatelliteStudio.Desktop.runtimeconfig.json", "coreclr.dll",
                "hostfxr.dll", "Microsoft.Web.WebView2.Wpf.dll", "apps/ui/dist/index.html",
                "runtime/python/python.exe", "runtime/python/python313._pth", "runtime/blender/blender.exe",
                "runtime/webview2/msedgewebview2.exe")
    for name in required:
        if not (output / name).is_file():
            raise ValueError(f"Incomplete runtime: {name}")
    if not list(output.rglob("WebView2Loader.dll")):
        raise ValueError("Missing native WebView2Loader")
    config = json.loads((output / "SatelliteStudio.Desktop.runtimeconfig.json").read_text())
    if "includedFrameworks" not in config["runtimeOptions"] or "frameworks" in config["runtimeOptions"]:
        raise ValueError("Desktop publish is not self-contained")
    files = inventory(output)
    manifest = {"product": "Satellite Dataset Studio V2", "version": args.version, "platform": "windows-x64",
                "created_utc": datetime.now(timezone.utc).isoformat(),
                "runtime_versions": lock["runtime_versions"], "model_ids": sorted(MODEL_IDS),
                "file_count": len(files), "size_bytes": sum(f["size_bytes"] for f in files), "files": files}
    (output / "release-manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    return {key: value for key, value in manifest.items() if key != "files"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("project-root", "desktop", "python-runtime", "blender-runtime", "webview-runtime", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--version", default="2.1.0")
    print(json.dumps(build(parser.parse_args()), indent=2, ensure_ascii=False))
