"""Build four PBR assets from the supplied OBJ files, into a staging directory.

Run with Blender --background --factory-startup --disable-autoexec --python.
Use tools/publish_model_update.py only after visual and rendering verification.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model_assets.materials import navigation_materials, planar_uv, sputnik_material
from model_assets.obj_geometry import read_obj

NAMES = {"sputnik_1": "Sputnik-1 人造卫星", "gps": "GPS 导航卫星", "galileo": "Galileo 导航卫星", "glonass": "GLONASS 导航卫星"}


def clean_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)
    bpy.data.orphans_purge(do_recursive=True)


def build(profile, sources: Path, textures: Path, recipes: Path, output: Path):
    clean_scene()
    model_id = profile["id"]
    source = sources / profile["source_obj"]
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != profile["source_sha256"]:
        raise ValueError(f"Source changed; recompute geometry registration: {model_id}")
    geometry = read_obj(source)
    transform = np.asarray(profile["source_to_body"])
    vertices = geometry.vertices @ transform[:3, :3].T + transform[:3, 3]
    if model_id == "sputnik_1":
        roles = np.zeros(len(geometry.faces), dtype=np.uint8)
        materials = [sputnik_material(source.parent / "textures")]
    else:
        with np.load(recipes / profile["face_roles_file"], allow_pickle=False) as mapping:
            roles = mapping["roles"]
            if str(mapping["source_sha256"].item()) != digest:
                raise ValueError("Material face mapping belongs to a different source")
        if roles.shape != (len(geometry.faces),) or roles.dtype != np.uint8 or np.any(roles > 3):
            raise ValueError("Material face mapping does not match source geometry")
        materials = navigation_materials(textures)

    # Max OBJ exports contain repeated corners and a few truly zero-area faces.
    # Sanitize them without dropping valid triangles that have repeated corners.
    faces, kept, corner_indices = [], [], []
    for index, face in enumerate(geometry.faces):
        corners = list(dict.fromkeys(face))
        if len(corners) < 3:
            continue
        points = vertices[corners]
        if np.linalg.norm(np.sum(np.cross(points, np.roll(points, -1, axis=0)), axis=0)) < 1e-12:
            continue
        faces.append(corners)
        kept.append(index)
        corner_indices.append([face.index(vertex) for vertex in corners])
    mesh = bpy.data.meshes.new(f"{model_id}_SourceGeometry")
    mesh.from_pydata(vertices.tolist(), [], faces)
    mesh.update()
    for material in materials:
        mesh.materials.append(material)
    for polygon, source_index in zip(mesh.polygons, kept):
        polygon.material_index = int(roles[source_index])
        polygon.use_smooth = True

    if model_id == "sputnik_1":
        uv = mesh.uv_layers.new(name="OriginalAtlasUV")
        for polygon, index, corners in zip(mesh.polygons, kept, corner_indices):
            for loop, corner in zip(polygon.loop_indices, corners):
                uv_index = geometry.face_uv[index][corner]
                if uv_index < 0:
                    raise ValueError("Sputnik atlas requires complete original UVs")
                uv.data[loop].uv = geometry.uv[uv_index]
    else:
        planar_uv(mesh)
    if geometry.normals and all(all(n >= 0 for n in geometry.face_normals[index]) for index in kept):
        normal_rotation = np.linalg.inv(transform[:3, :3]).T
        normals = np.asarray(geometry.normals) @ normal_rotation.T
        normals /= np.linalg.norm(normals, axis=1, keepdims=True).clip(1e-12)
        split = [normals[geometry.face_normals[index][corner]].tolist()
                 for index, corners in zip(kept, corner_indices) for corner in corners]
        mesh.normals_split_custom_set(split)
    body = bpy.data.objects.new("SatelliteBody", None)
    obj = bpy.data.objects.new(NAMES[model_id], mesh)
    bpy.context.scene.collection.objects.link(body)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = body
    bpy.context.view_layer.update()
    radius = float(np.linalg.norm(vertices, axis=1).max())
    folder = output / "assets/models" / model_id
    folder.mkdir(parents=True, exist_ok=True)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(folder / "render.blend"), compress=True)
    bpy.ops.export_scene.gltf(filepath=str(folder / "preview.glb"), export_format="GLB",
                             export_yup=False, export_cameras=False, export_lights=False)
    metadata = {
        "id": model_id, "name": NAMES[model_id], "configuration": "no_panel" if model_id == "sputnik_1" else "double_panel",
        "radius_m": radius, "sha256": hashlib.sha256((folder / "render.blend").read_bytes()).hexdigest(),
        "preview_sha256": hashlib.sha256((folder / "preview.glb").read_bytes()).hexdigest(),
        "preview_url": f"/assets/models/{model_id}/preview.glb",
        "preview_file": f"assets/models/{model_id}/preview.glb", "blend_file": f"assets/models/{model_id}/render.blend",
        "source_file": source.name, "source_archive": "02-四个卫星模型.zip", "source_sha256": digest,
        "source_to_body": transform.tolist(), "source_coordinate_system": "Original OBJ numeric coordinates",
        "body_axes_source": "registered_to_previous_simulation_body_frame",
        "installation_source": "simulation_default", "scale_note": profile["scale_note"],
        "material_workflow": "source_textures_to_pbr" if model_id == "sputnik_1" else "reconstructed_pbr",
        "material_recipe_version": "four-satellites-pbr-v1",
        "material_note": "Supplied diffuse/normal atlas; PBR response reconstructed" if model_id == "sputnik_1" else "Gold MLI, blue photovoltaic cells and aluminium hardware reconstructed; not recovered Max materials",
        "preview_material_note": "Shared glTF-compatible PBR maps in preview and formal asset; lighting differs",
        "source_face_count": len(geometry.faces), "render_face_count": len(faces),
        "material_faces": {mat.name: sum(p.material_index == i for p in mesh.polygons) for i, mat in enumerate(materials)},
    }
    print(json.dumps({"built": model_id, "radius_m": radius, "material_faces": metadata["material_faces"]}), flush=True)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("sources", "textures", "recipes", "output"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    sources, textures, recipes, output = (getattr(args, name).resolve() for name in ("sources", "textures", "recipes", "output"))
    profiles = json.loads((recipes / "profiles.json").read_text(encoding="utf-8"))
    result = [build(profile, sources, textures, recipes, output) for profile in profiles]
    (output / "assets/models/index.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
