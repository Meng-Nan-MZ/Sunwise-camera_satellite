"""Import the 12 collected spacecraft into the GLB-only application, offline.

Run with Blender as an asset preparation tool, never as a product dependency:
  blender --background --factory-startup --disable-autoexec --python \
    tools/import_curated_models.py -- --source-library PATH --project-root PATH

The source library is read-only. All assets are prepared and audited in var/
before publishing the catalog. Repeated imports reuse identical verified assets;
--rebuild explicitly regenerates this collection. Existing unrelated IDs cannot
be replaced. Original author dimensions are retained, not physically certified.
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

COLLECTION_ID = "public-spacecraft-2026-11-01"
IMPORTER_VERSION = "curated-glb-v1"
SCALE_NOTE = "保留原作者数值尺度，按仿真米制使用；未独立校准真实工程尺寸。"
SCALE_BASIS = "Multiplier relative to the original author numeric coordinates; not a physical calibration"
# Keep the collected variants distinct from the six established model identities.
MODELS = (
    ("11_GOESR", "goes_r", "GOES-R 地球同步气象卫星", "single_panel"),
    ("02_Sentinel6", "sentinel_6", "Sentinel-6 海洋测高卫星", "double_panel"),
    ("15_SWOT_New", "swot_new", "SWOT 水面与海洋地形卫星·新版", "double_panel"),
    ("16_EuropaClipper", "europa_clipper", "Europa Clipper 木卫二探测器", "double_panel"),
    ("23_Hubble_Textured", "hubble_textured", "Hubble 哈勃空间望远镜·贴图版", "double_panel"),
    ("14_PACE", "pace", "PACE 海洋生态与大气观测卫星", "single_panel"),
    ("03_Landsat5", "landsat_5", "Landsat 4-5 陆地遥感卫星", "single_panel"),
    ("24_JWST_Deployed", "jwst_deployed", "JWST 韦布空间望远镜·展开版", "single_panel"),
    ("13_NISAR", "nisar", "NISAR 合成孔径雷达卫星", "double_panel"),
    ("18_SMAP", "smap", "SMAP 土壤湿度观测卫星", "single_panel"),
    ("17_Landsat9", "landsat_9", "Landsat 9 陆地遥感卫星", "single_panel"),
    ("22_Chandra", "chandra", "Chandra 钱德拉 X 射线天文台", "double_panel"),
)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def sha(path: Path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def library_file(library: Path, relative: str) -> Path:
    result = (library / relative).resolve()
    if not result.is_relative_to(library) or not result.is_file():
        raise ValueError(f"Source file missing or outside library: {relative}")
    return result


def glb_info(path: Path) -> dict:
    """Inspect actual GLB containers, including required decoding extensions."""
    data = path.read_bytes()
    if len(data) < 20 or struct.unpack_from("<4sII", data) != (b"glTF", 2, len(data)):
        raise ValueError(f"Invalid GLB: {path}")
    chunks, offset = {}, 12
    while offset < len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        offset += 8
        if length % 4 or offset + length > len(data) or kind in chunks:
            raise ValueError(f"Invalid GLB chunk: {path}")
        chunks[kind] = data[offset:offset + length]
        offset += length
    if set(chunks) != {0x4E4F534A, 0x004E4942}:
        raise ValueError(f"Expected JSON and BIN chunks: {path}")
    doc = json.loads(chunks[0x4E4F534A])
    if any(item.get("uri") and not item["uri"].startswith("data:")
           for item in doc.get("buffers", []) + doc.get("images", [])):
        raise ValueError(f"GLB references an external resource: {path}")
    if doc.get("skins") or doc.get("animations"):
        raise ValueError(f"Animated/skinned geometry is outside this static import: {path}")
    primitive_count = triangle_count = 0
    visited = set()

    def visit(index, ancestors):
        nonlocal primitive_count, triangle_count
        if index in ancestors or index in visited:
            raise ValueError("Invalid shared/cyclic scene node")
        visited.add(index)
        node = doc["nodes"][index]
        if "mesh" in node:
            for primitive in doc["meshes"][node["mesh"]]["primitives"]:
                if primitive.get("mode", 4) != 4 or primitive.get("targets"):
                    raise ValueError("Only static triangle-list meshes can be imported")
                accessor = primitive.get("indices", primitive["attributes"]["POSITION"])
                count = doc["accessors"][accessor]["count"]
                if count % 3:
                    raise ValueError("Triangle list has incomplete indices")
                triangle_count += count // 3
                primitive_count += 1
        for child in node.get("children", []):
            visit(child, ancestors | {index})

    for index in doc["scenes"][doc.get("scene", 0)].get("nodes", []):
        visit(index, set())
    return dict(sha256=hashlib.sha256(data).hexdigest(), bytes=len(data),
                triangles=triangle_count, primitives=primitive_count,
                meshes=len(doc.get("meshes", [])), materials=len(doc.get("materials", [])),
                embedded_images=len(doc.get("images", [])), self_contained=True,
                extensions_used=doc.get("extensionsUsed", []),
                extensions_required=doc.get("extensionsRequired", []))


def merge_catalog(existing: list[dict], additions: list[dict]) -> list[dict]:
    old_ids = [model["id"] for model in existing]
    new_ids = [model["id"] for model in additions]
    if len(set(old_ids)) != len(old_ids) or len(set(new_ids)) != len(new_ids):
        raise ValueError("Duplicate catalog model ID")
    incoming = {model["id"]: model for model in additions}
    for model in existing:
        if model["id"] in incoming and (model.get("collection_id") != COLLECTION_ID or
                model.get("source_model_id") != incoming[model["id"]].get("source_model_id")):
            raise ValueError(f"Refusing to replace established model: {model['id']}")
        if model["id"] in incoming and "selectable" in model:
            # Re-preparing an asset must not restore a retired duplicate entry.
            incoming[model["id"]] = dict(incoming[model["id"]], selectable=model["selectable"])
    merged = [incoming.pop(model["id"], model) for model in existing]
    return merged + list(incoming.values())


def build(source: dict, spec: tuple, library: Path, stage: Path) -> dict:
    import bpy
    from mathutils import Matrix, Vector
    import numpy as np

    source_id, model_id, name, configuration = spec
    source_path = library_file(library, source["glb"])
    before = glb_info(source_path)
    if before["sha256"] != source["glb_sha256"].lower():
        raise ValueError(f"Source GLB hash mismatch: {source_id}")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.import_scene.gltf(filepath=str(source_path))
    bpy.context.view_layer.update()
    objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and not obj.hide_render]
    depsgraph = bpy.context.evaluated_depsgraph_get()
    frozen = []
    for obj in objects:
        mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph), depsgraph=depsgraph)
        mesh.transform(obj.matrix_world)
        frozen.append((obj.name, mesh))
    points = np.array([tuple(vertex.co) for _, mesh in frozen for vertex in mesh.vertices], dtype=float)
    if not len(points) or not np.isfinite(points).all():
        raise ValueError(f"No finite source geometry: {source_id}")
    center = (points.min(axis=0) + points.max(axis=0)) / 2
    transform = Matrix.Translation(-Vector(center))
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for original_name, mesh in frozen:
        mesh.transform(transform)
        obj = bpy.data.objects.new(original_name, mesh)
        bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.update()
    # Compute from the final float32 mesh values, not object bounding-box corners.
    vertices = np.array([tuple(vertex.co) for _, mesh in frozen for vertex in mesh.vertices], dtype=float)
    radius = float(np.linalg.norm(vertices, axis=1).max())
    if not 0 < radius < 9999:
        raise ValueError(f"Invalid simulation bounding sphere: {radius}")
    for image in bpy.data.images:
        if image.type not in {"RENDER_RESULT", "COMPOSITING"}:
            # glTF imports can keep valid packed textures lazily decoded.
            if min(image.size) == 0 or len(image.pixels) == 0:
                raise ValueError(f"Texture did not load: {image.name}")
            if image.source == "FILE" and not image.packed_file:
                image.pack()
    folder = stage / model_id
    folder.mkdir(parents=True)
    destination = folder / "preview.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(destination), export_format="GLB", export_yup=False,
        export_cameras=False, export_lights=False, export_animations=False,
        export_draco_mesh_compression_enable=False,
    )
    after = glb_info(destination)
    decoder_extensions = {"KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"}
    if decoder_extensions.intersection(after["extensions_required"] + after["extensions_used"]):
        raise ValueError("Prepared GLB still requires an external geometry/texture decoder")
    # Independently decode the output positions and hierarchy with the existing
    # geometric verifier; material-only extensions do not affect its geometry.
    from verify_v221_images import glb_vertices
    exported, _ = glb_vertices(destination)
    if not np.allclose(exported.min(axis=0), vertices.min(axis=0), atol=2e-5, rtol=1e-6) or not np.allclose(
            exported.max(axis=0), vertices.max(axis=0), atol=2e-5, rtol=1e-6):
        raise ValueError(f"Export changed model bounds: {source_id}")
    exported_radius = float(np.linalg.norm(exported, axis=1).max())
    if not np.isclose(exported_radius, radius, atol=2e-5, rtol=1e-6):
        raise ValueError(f"Export changed model radius: {source_id}")
    # Use the exact exported radius, conservatively including floating-point noise.
    radius = exported_radius * (1 + 1e-7)
    model = dict(
        id=model_id, name=name, configuration=configuration, radius_m=radius,
        sha256=after["sha256"], preview_sha256=after["sha256"],
        preview_url=f"/assets/models/{model_id}/preview.glb",
        preview_file=f"assets/models/{model_id}/preview.glb",
        source_file=source_path.name, source_sha256=before["sha256"],
        source_to_body=[list(row) for row in transform],
        source_coordinate_system="Blender imported source scene, right handed; glTF (x,y,z) becomes (x,-z,y)",
        body_axes_source="simulation_source_axes", installation_source="simulation_default",
        source_scale=1.0, source_scale_basis=SCALE_BASIS,
        physical_scale_calibrated=False, scale_note=SCALE_NOTE,
        preview_material_note="源 PBR 材质与贴图离线转换；预览及正式出图共用同一 GLB。",
        collection_id=COLLECTION_ID, source_model_id=source_id, importer_version=IMPORTER_VERSION,
        source_provider=source["provider"], source_page=source["source_page"],
        license=source["license"], license_url=source["license_url"],
        source_grade=source["grade"], source_note=source["note"],
    )
    provenance = dict(
        collection_id=COLLECTION_ID, importer_version=IMPORTER_VERSION,
        original_catalog_entry=source, original_source=read_json(library_file(library, f"{source_id}/source.json")),
        changes=["Imported original GLB with packed textures", "Baked source world transforms",
                 "Centered actual vertex bounds at origin", "Retained author numerical scale (1.0)",
                 "Exported uncompressed static GLB in application engine basis"],
        scale_note=SCALE_NOTE, physical_scale_calibrated=False,
        source_scale=1.0, source_scale_basis=SCALE_BASIS,
        gltf_to_imported_source=[[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]],
        source_to_body=model["source_to_body"],
        source_to_body_note="On-disk matrix maps Blender-imported source coordinates to engine asset geometry. API applies the existing client/engine basis conversion once. Runtime does not apply this metadata to the mesh again.",
    )
    audit = dict(model_id=model_id, source=before, prepared=after, passed=True,
                 source_center_imported=center.tolist(),
                 bounds_min=exported.min(axis=0).tolist(), bounds_max=exported.max(axis=0).tolist(),
                 radius_m=radius, physical_scale_calibrated=False,
                 source_report_triangles=source["triangles"],
                 source_triangle_note="Raw indexed triangle counts can include degenerate faces discarded by Blender import.",
                 checks={"source_hash": True, "self_contained": True, "uncompressed": True,
                         "finite_geometry": True, "exported_bounds": True, "exported_radius": True})
    write_json(folder / "provenance.json", provenance)
    write_json(folder / "asset-audit.json", audit)
    attribution = library_file(library, f"{source_id}/ATTRIBUTION.txt").read_text(encoding="utf-8-sig")
    (folder / "ATTRIBUTION.txt").write_text(attribution.rstrip() + "\n\nApplication preparation: centered static GLB, source materials retained; no endorsement implied.\n" + SCALE_NOTE + "\n", encoding="utf-8")
    write_json(folder / "model.json", model)
    print(json.dumps({"prepared": model_id, "radius_m": radius, "triangles": after["triangles"]}), flush=True)
    return model


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-library", type=Path, required=True)
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else None)
    library, project = args.source_library.resolve(), args.project_root.resolve()
    assets = project / "assets/models"
    manifest = assets / "index.json"
    existing = read_json(manifest)
    sources = read_json(library_file(library, "模型清单.json"))
    source_map = {item["id"]: item for item in sources}
    if len(sources) != len(MODELS) or set(source_map) != {spec[0] for spec in MODELS}:
        raise ValueError("Source manifest must contain exactly the selected 12 models")
    # Check identity collisions and every source before any preparation or publication.
    merge_catalog(existing, [dict(id=spec[1], source_model_id=spec[0]) for spec in MODELS])
    for source in sources:
        if sha(library_file(library, source["glb"])) != source["glb_sha256"].lower():
            raise ValueError(f"Source GLB hash mismatch: {source['id']}")
    work = project / "var/model-import"
    work.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="curated-", dir=work))
    old = {model["id"]: model for model in existing}
    additions = []
    for spec in MODELS:
        source, previous = source_map[spec[0]], old.get(spec[1])
        ready = previous and previous.get("importer_version") == IMPORTER_VERSION and previous.get("source_sha256") == source["glb_sha256"].lower()
        folder = assets / spec[1]
        if not args.rebuild and ready and all((folder / name).is_file() for name in ("preview.glb", "provenance.json", "asset-audit.json", "ATTRIBUTION.txt")) and sha(folder / "preview.glb") == previous["preview_sha256"]:
            additions.append(previous)
            print(f"REUSE {spec[1]}", flush=True)
        else:
            additions.append(build(source, spec, library, stage))
    merged = merge_catalog(existing, additions)
    # All twelve are ready. Publish assets first, then atomically replace the index.
    for model in additions:
        prepared = stage / model["id"]
        if prepared.is_dir():
            destination = assets / model["id"]
            destination.mkdir(exist_ok=True)
            for source in prepared.iterdir():
                if source.name != "model.json":
                    temporary = destination / (source.name + ".importing")
                    shutil.copyfile(source, temporary)
                    temporary.replace(destination / source.name)
    temporary = assets / "index.importing.json"
    write_json(temporary, merged)
    temporary.replace(manifest)
    write_json(work / "latest-report.json", dict(passed=True, collection_id=COLLECTION_ID,
               imported_ids=[model["id"] for model in additions], catalog_count=len(merged),
               source_library=str(library), prepared_directory=str(stage),
               original_models_preserved=all(model in merged for model in existing if model.get("collection_id") != COLLECTION_ID)))
    print(f"READY: {len(additions)} collected models; {len(merged)} total models", flush=True)


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
