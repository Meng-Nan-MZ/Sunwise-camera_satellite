"""Prepare the two user-authored GLBs offline, preserving source materials.

Run in Blender with --background --factory-startup --disable-autoexec --python
tools/import_custom_models.py -- --source-directory PATH --project-root PATH.
This is an asset preparation tool; the application still uses GLB/Three.js only.
Original files are read-only. All new assets pass geometry and material checks
before the catalog is published. Repeat runs reuse verified prepared assets.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_curated_models import build, glb_info, read_json, sha, write_json

COLLECTION_ID = "user-spacecraft-2026-11-02"
IMPORTER_VERSION = "custom-glb-v1"
MODELS = (
    ("original_remote_sensing", "原创遥感卫星", "原创遥感卫星.glb",
     "a3743ff9cd29c8fd6e81803191f6c2adb05a632e136eeeacb767de4a5f32e054"),
    ("sar_radar", "SAR 雷达卫星", "SAR雷达卫星.glb",
     "a645f4134cc29c9f3dd33bace1679c34aee992e8bde8b96778601445cf1fec04"),
)


def materials(path: Path) -> dict:
    """Compare actual material values and texture bytes, not shifting indices."""
    data = path.read_bytes()
    size = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20:20 + size])
    binary = data[28 + size:]
    image_hashes = []
    for image in document.get("images", []):
        if "bufferView" not in image:
            raise ValueError("Material audit requires embedded image bufferViews")
        view = document["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        image_hashes.append(hashlib.sha256(binary[start:start + view["byteLength"]]).hexdigest())

    def normalize(value, key=""):
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if not isinstance(value, dict):
            return value
        result = {name: normalize(item, name) for name, item in value.items()}
        if key.endswith("Texture") and "index" in value:
            texture = document["textures"][value["index"]]
            result["index"] = image_hashes[texture["source"]]
            result["sampler"] = document.get("samplers", [])[texture["sampler"]] if "sampler" in texture else {}
        return result

    result = {}
    for material in document.get("materials", []):
        name = material.get("name")
        if not name or name in result:
            raise ValueError("Material audit requires unique named source materials")
        result[name] = normalize(material)
    return result


def assert_materials_preserved(source: Path, prepared: Path) -> dict:
    before, after = materials(source), materials(prepared)
    if before.keys() != after.keys():
        raise ValueError("Prepared asset lost or renamed a source material")

    def equivalent(a, b):
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            return abs(a - b) <= 2e-6
        if type(a) is not type(b):
            return False
        if isinstance(a, dict):
            return a.keys() == b.keys() and all(equivalent(a[key], b[key]) for key in a)
        if isinstance(a, list):
            return len(a) == len(b) and all(equivalent(x, y) for x, y in zip(a, b))
        return a == b

    changed = [name for name in before if not equivalent(before[name], after[name])]
    if changed:
        raise ValueError(f"Prepared asset changed material/texture values: {changed}")
    return dict(material_count=len(before), material_names=sorted(before),
                material_parameters_preserved=True, referenced_texture_bytes_preserved=True,
                numeric_tolerance=2e-6)


def merge_catalog(existing: list[dict], additions: list[dict]) -> list[dict]:
    old_ids, new_ids = [m["id"] for m in existing], [m["id"] for m in additions]
    if len(set(old_ids)) != len(old_ids) or len(set(new_ids)) != len(new_ids):
        raise ValueError("Duplicate catalog model ID")
    incoming = {model["id"]: model for model in additions}
    for model in existing:
        if model["id"] in incoming and model.get("collection_id") != COLLECTION_ID:
            raise ValueError(f"Refusing to replace established model: {model['id']}")
    return [incoming.pop(model["id"], model) for model in existing] + list(incoming.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-directory", type=Path, required=True)
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else None)
    source_directory, project = args.source_directory.resolve(), args.project_root.resolve()
    assets = project / "assets/models"
    manifest = assets / "index.json"
    existing = read_json(manifest)
    merge_catalog(existing, [dict(id=model_id) for model_id, *_ in MODELS])
    for _, _, filename, expected_hash in MODELS:
        path = source_directory / filename
        if sha(path) != expected_hash:
            raise ValueError(f"Source identity changed: {filename}")
        glb_info(path)
    work = project / "var/model-import"
    work.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="custom-", dir=work))
    library = stage / "source-copies"
    library.mkdir()
    old = {model["id"]: model for model in existing}
    additions = []
    for model_id, name, filename, expected_hash in MODELS:
        original = source_directory / filename
        folder = assets / model_id
        previous = old.get(model_id)
        reusable = previous and previous.get("importer_version") == IMPORTER_VERSION and previous.get("source_sha256") == expected_hash
        if not args.rebuild and reusable and all((folder / f).is_file() for f in ("preview.glb", "asset-audit.json", "provenance.json", "ATTRIBUTION.txt")) and sha(folder / "preview.glb") == previous["preview_sha256"]:
            assert_materials_preserved(original, folder / "preview.glb")
            additions.append(previous)
            print(f"REUSE {model_id}", flush=True)
            continue
        # Reuse the audited geometry preparation on task-local copies. No source
        # metadata or converted files are written into the user's source folder.
        source_folder = library / model_id
        source_folder.mkdir()
        shutil.copyfile(original, source_folder / filename)
        source = dict(id=model_id, name=name, glb=f"{model_id}/{filename}",
                      glb_sha256=expected_hash, triangles=glb_info(original)["triangles"],
                      provider="用户自制", source_page="", license_url="",
                      license="用户提供的自制模型；未声明公开再分发许可。",
                      grade="用户自制模型", note="由用户提供 GLB；保留原有几何和 PBR 材质。")
        write_json(source_folder / "source.json", source)
        (source_folder / "ATTRIBUTION.txt").write_text(
            f"{name}\n来源：用户提供的自制模型 {filename}\n"
            "未声明公开再分发许可。原始文件保持不变。\n", encoding="utf-8")
        model = build(source, (model_id, model_id, name, "double_panel"), library, stage)
        prepared = stage / model_id
        check = assert_materials_preserved(original, prepared / "preview.glb")
        model.update(collection_id=COLLECTION_ID, importer_version=IMPORTER_VERSION)
        model["preview_material_note"] = "保留用户 GLB 的原有 PBR 材质；预览及正式出图共用同一 GLB。"
        provenance = read_json(prepared / "provenance.json")
        provenance.update(collection_id=COLLECTION_ID, importer_version=IMPORTER_VERSION)
        provenance["changes"][0] = "Imported original GLB retaining PBR materials"
        provenance["material_preservation"] = check
        provenance["source_embedded_images"] = glb_info(original)["embedded_images"]
        provenance["source_material_note"] = "原文件没有图像贴图；外观由几何细节与 PBR 材质参数组成。"
        audit = read_json(prepared / "asset-audit.json")
        audit["material_preservation"] = check
        audit["checks"]["source_materials_preserved"] = True
        write_json(prepared / "provenance.json", provenance)
        write_json(prepared / "asset-audit.json", audit)
        write_json(prepared / "model.json", model)
        additions.append(model)
    # Verify sources did not change, and re-read the catalog so an unrelated
    # catalog edit during offline preparation is preserved.
    for _, _, filename, expected_hash in MODELS:
        if sha(source_directory / filename) != expected_hash:
            raise ValueError(f"Source changed during preparation: {filename}")
    current = read_json(manifest)
    merged = merge_catalog(current, additions)
    for model in additions:
        prepared = stage / model["id"]
        if prepared.is_dir():
            destination = assets / model["id"]
            destination.mkdir(exist_ok=True)
            for source_file in prepared.iterdir():
                if source_file.name != "model.json":
                    temporary = destination / (source_file.name + ".importing")
                    shutil.copyfile(source_file, temporary)
                    temporary.replace(destination / source_file.name)
    temporary = assets / "index.custom-importing.json"
    write_json(temporary, merged)
    temporary.replace(manifest)
    write_json(work / "latest-custom-report.json", dict(passed=True, collection_id=COLLECTION_ID,
               imported_ids=[m["id"] for m in additions], catalog_count=len(merged),
               prepared_directory=str(stage), source_files_unchanged=True,
               unrelated_models_preserved=all(m in merged for m in current if m.get("collection_id") != COLLECTION_ID)))
    print(f"READY: {len(additions)} custom models; {len(merged)} catalog records", flush=True)


if __name__ == "__main__":
    main()
