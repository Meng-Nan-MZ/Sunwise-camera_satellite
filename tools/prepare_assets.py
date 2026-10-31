"""Build canonical assets. Run with Blender --background --disable-autoexec.

Only imports geometry/material datablocks from the known legacy sources.
The exported GLB and render.blend use exactly the same numeric body coordinates.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

import bpy
from mathutils import Matrix, Vector


MODELS = (
    ("insat_3b", "INSAT-3B 通信卫星", "Hubble.glb", None, 0.01, "double_panel"),
    ("hubble", "Hubble 空间望远镜", "Hubble_original.glb", None, 1.0, "double_panel"),
    ("sputnik_1", "Sputnik-1 人造卫星", "Sputnik.glb", "Sputnik", 1.0, "no_panel"),
    ("gps", "GPS 导航卫星", "GPS.glb", "GPS", 1.0, "double_panel"),
    ("galileo", "Galileo 导航卫星", "Galileo.glb", "Galileo", 1.0, "double_panel"),
    ("glonass", "GLONASS 导航卫星", "GLONASS.glb", "GLONASS", 1.0, "double_panel"),
)


def build_model(source: Path, destination: Path, spec: tuple) -> dict:
    model_id, name, filename, collection_name, scale, configuration = spec
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)
    bpy.data.orphans_purge(do_recursive=True)
    if collection_name:
        source_file = source / "blend_sources" / f"{collection_name}.blend"
        with bpy.data.libraries.load(str(source_file), link=False) as (_, target):
            target.collections = [collection_name]
        collection = target.collections[0]
        if collection is None:
            raise ValueError(f"Missing collection {collection_name}")
        bpy.context.scene.collection.children.link(collection)
        originals = [o for o in collection.all_objects if o.type == "MESH" and not o.hide_render]
    else:
        source_file = source / filename
        bpy.ops.import_scene.gltf(filepath=str(source_file))
        originals = [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.hide_render]

    bpy.context.view_layer.update()
    # Freeze evaluated geometry once, retaining material graphs. This eliminates
    # live constraints, shape generators and hierarchy differences between engines.
    depsgraph = bpy.context.evaluated_depsgraph_get()
    frozen = []
    for obj in originals:
        mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph), depsgraph=depsgraph)
        mesh.transform(obj.matrix_world)
        frozen.append((obj.name, mesh))
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    points = [vertex.co.copy() for _, mesh in frozen for vertex in mesh.vertices]
    if not points:
        raise ValueError(f"No geometry in {source_file}")
    lower = Vector([min(p[a] for p in points) for a in range(3)])
    upper = Vector([max(p[a] for p in points) for a in range(3)])
    center = (lower + upper) / 2
    # Body axes are the source scene's right-handed axes after Blender import;
    # this is a registered simulation frame, not manufacturer calibration.
    transform = Matrix.Diagonal((scale, scale, scale, 1.0)) @ Matrix.Translation(-center)
    root = bpy.data.objects.new("SatelliteBody", None)
    bpy.context.scene.collection.objects.link(root)
    for name_in_source, mesh in frozen:
        mesh.transform(transform)
        obj = bpy.data.objects.new(name_in_source, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.parent = root
    bpy.context.view_layer.update()
    radius = max(v.co.length for _, mesh in frozen for v in mesh.vertices)
    if not 0 < radius < 10000:
        raise ValueError(f"Invalid physical bounding sphere: {radius}")
    for image in bpy.data.images:
        if image.source == "FILE" and not image.packed_file:
            image.pack()
    folder = destination / model_id
    folder.mkdir(parents=True, exist_ok=True)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(folder / "render.blend"), compress=True)
    # No coordinate conversion: GLTFLoader consumes exactly our body coordinates.
    bpy.ops.export_scene.gltf(filepath=str(folder / "preview.glb"), export_format="GLB",
                             export_yup=False, export_cameras=False, export_lights=False)
    sha = hashlib.sha256((folder / "render.blend").read_bytes()).hexdigest()
    return {
        "id": model_id, "name": name, "configuration": configuration,
        "radius_m": radius, "sha256": sha,
        "preview_sha256": hashlib.sha256((folder / "preview.glb").read_bytes()).hexdigest(),
        "preview_url": f"/assets/models/{model_id}/preview.glb",
        "preview_file": f"assets/models/{model_id}/preview.glb",
        "blend_file": f"assets/models/{model_id}/render.blend",
        "source_file": source_file.name,
        "source_sha256": hashlib.sha256(source_file.read_bytes()).hexdigest(),
        "source_to_body": [list(row) for row in transform],
        "source_coordinate_system": "Blender imported source scene, right handed",
        "body_axes_source": "simulation_source_axes",
        "installation_source": "simulation_default",
        "preview_material_note": "PBR preview; procedural Blender materials can differ",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-assets", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    # Blender file operations may change its process working directory.
    args.source_assets = args.source_assets.resolve()
    args.destination = args.destination.resolve()
    result = [build_model(args.source_assets, args.destination, spec) for spec in MODELS]
    (args.destination / "index.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Prepared {len(result)} registered model assets")


if __name__ == "__main__":
    main()
