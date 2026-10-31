"""Render color inspection images; this does not change formal asset files."""
import argparse
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    root, output = args.project_root.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    models = json.loads((root / "assets/models/index.json").read_text(encoding="utf-8"))
    for model in models:
        bpy.ops.wm.open_mainfile(filepath=str(root / model["blend_file"]), use_scripts=False)
        scene = bpy.context.scene
        radius = model["radius_m"]
        scene.render.engine = "CYCLES"
        scene.cycles.samples = 24
        scene.cycles.use_denoising = True
        scene.render.resolution_x = scene.render.resolution_y = 720
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGBA"
        scene.render.film_transparent = True
        scene.view_settings.view_transform = "AgX"
        world = bpy.data.worlds.new("InspectionEnvironment")
        world.use_nodes = True
        world.node_tree.nodes["Background"].inputs[0].default_value = (.22, .26, .34, 1)
        world.node_tree.nodes["Background"].inputs[1].default_value = .5
        scene.world = world
        camera = bpy.data.objects.new("InspectionCamera", bpy.data.cameras.new("InspectionCamera"))
        scene.collection.objects.link(camera)
        camera.location = Vector((2.4, 1.6, 3.2)) * radius
        camera.rotation_euler = (-camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.data.type = "PERSP"
        camera.data.angle = math.radians(36)
        camera.data.clip_end = radius * 30
        scene.camera = camera
        for name, position, energy, size, color in [
            ("Key", (2, 3, 4), 550, 3, (1., .95, .88)),
            ("Fill", (-3, 1, 2), 260, 3, (.76, .86, 1.)),
            ("Rim", (0, 2, -3), 650, 2, (1., 1., 1.)),
        ]:
            light = bpy.data.objects.new(name, bpy.data.lights.new(name, "AREA"))
            light.location = Vector(position) * radius
            light.rotation_euler = (-light.location).to_track_quat("-Z", "Y").to_euler()
            light.data.energy = energy * radius ** 2
            light.data.shape = "DISK"
            light.data.size = size * radius
            light.data.color = color
            scene.collection.objects.link(light)
        scene.render.filepath = str(output / f"{model['id']}.png")
        bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
