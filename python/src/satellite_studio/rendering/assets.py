"""Verify registered asset identity before loading renderable scene data."""
import hashlib
from pathlib import Path


def verified_model_path(project_root: Path, model: dict) -> Path:
    root = project_root.resolve()
    path = (root / model["blend_file"]).resolve()
    if not path.is_relative_to(root / "assets/models") or path.suffix != ".blend":
        raise ValueError("Render asset must be a .blend within assets/models")
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != model["sha256"]:
        raise ValueError(f"Model SHA256 mismatch: {path.name}. Rebuild registered assets before capture.")
    return path
