"""Validate and install the four reviewed models, backing up the current set."""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct

UPDATED_IDS = {"sputnik_1", "gps", "galileo", "glonass"}
ROOT = Path(__file__).resolve().parents[1]


def validated_models(staging: Path) -> list[dict]:
    models = json.loads((staging / "assets/models/index.json").read_text(encoding="utf-8"))
    if len(models) != 4 or {item["id"] for item in models} != UPDATED_IDS:
        raise ValueError("Update must contain exactly Sputnik, GPS, Galileo and GLONASS")
    for model in models:
        for key, filename, digest_key in [("blend_file", "render.blend", "sha256"),
                                           ("preview_file", "preview.glb", "preview_sha256")]:
            expected = f"assets/models/{model['id']}/{filename}"
            if model[key] != expected:
                raise ValueError(f"Unexpected asset path: {model[key]}")
            data = (staging / expected).read_bytes()
            if hashlib.sha256(data).hexdigest() != model[digest_key]:
                raise ValueError(f"Asset changed after build: {expected}")
            if filename.endswith(".glb"):
                magic, version, length, json_length, chunk_type = struct.unpack_from("<5I", data)
                if magic != 0x46546C67 or version != 2 or length != len(data) or chunk_type != 0x4E4F534A:
                    raise ValueError(f"Invalid GLB: {expected}")
                document = json.loads(data[20:20 + json_length])
                images = document.get("images", [])
                if not images or any("bufferView" not in image for image in images):
                    raise ValueError(f"Textures must be embedded for offline use: {expected}")
    return models


def publish(staging: Path, project_root: Path) -> Path:
    models = validated_models(staging)
    index = project_root / "assets/models/index.json"
    original = index.read_bytes()
    current = json.loads(original)
    if not UPDATED_IDS.issubset({item["id"] for item in current}):
        raise ValueError("Target catalog does not contain the four models to replace")
    updated = {item["id"]: item for item in models}
    merged = [updated.get(item["id"], item) for item in current]
    backup = project_root / "var/model-update/backups" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup.mkdir(parents=True, exist_ok=False)
    (backup / "index.json").write_bytes(original)
    paths = [Path(item[key]) for item in models for key in ("blend_file", "preview_file")]
    for relative in paths:
        saved = backup / relative
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(project_root / relative, saved)
    try:
        for relative in paths:
            destination = project_root / relative
            pending = destination.with_suffix(destination.suffix + ".pending")
            shutil.copy2(staging / relative, pending)
            os.replace(pending, destination)
        pending_index = index.with_suffix(".json.pending")
        pending_index.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(pending_index, index)
    except Exception:
        for relative in paths:
            shutil.copy2(backup / relative, project_root / relative)
        index.write_bytes(original)
        raise
    return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--project-root", type=Path, default=ROOT)
    args = parser.parse_args()
    print(f"Installed four models. Backup: {publish(args.staging.resolve(), args.project_root.resolve())}")


if __name__ == "__main__":
    main()
