"""Formal engine scene; the only V2 client-to-Blender adapter boundary."""

import json
import math
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector
from satellite_studio.domain.camera import fixed_fov_y
from satellite_studio.domain.camera import camera_parameters
from satellite_studio.domain.rotation import client_to_engine_quaternion, quaternion_array, CLIENT_TO_ENGINE
import numpy as np
from satellite_studio.rendering.assets import verified_model_path


class SceneRenderer:
    def __init__(self, project_root: Path):
        self.project_root = project_root.resolve()
        manifests = json.loads((self.project_root / "assets/models/index.json").read_text(encoding="utf-8"))
        self.models = {model["id"]: model for model in manifests}
        self.model_id = None

    def _load(self, model_id: str) -> dict:
        model = self.models[model_id]
        if model_id != self.model_id:
            bpy.ops.wm.open_mainfile(filepath=str(verified_model_path(self.project_root, model)),
                                     load_ui=False, use_scripts=False)
            self.model_id = model_id
        return model

    @staticmethod
    def _object(name: str, kind: str):
        obj = bpy.data.objects.get(name)
        if obj:
            return obj
        data = bpy.data.cameras.new(name) if kind == "CAMERA" else bpy.data.lights.new(name, "SUN")
        obj = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(obj)
        return obj

    def render(self, frame: dict, output: Path) -> dict:
        model = self._load(frame["model_id"])
        root = bpy.data.objects["SatelliteBody"]
        x, y, z, w = client_to_engine_quaternion(quaternion_array(frame["sat_quat"]))
        root.rotation_mode = "QUATERNION"
        root.rotation_quaternion = Quaternion((w, x, y, z))
        scene = bpy.context.scene
        scene.render.engine = "BLENDER_EEVEE"
        resolution = frame["resolution"]
        scene.render.resolution_x = scene.render.resolution_y = resolution
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "BW"
        scene.render.image_settings.color_depth = "8"
        # Keep the clean background exactly zero; sensor noise is applied later
        # with a recorded per-frame seed, not Blender's unlabelled dithering.
        scene.render.dither_intensity = 0
        scene.render.film_transparent = False
        scene.render.use_compositing = False
        scene.render.use_sequencer = False
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
        scene.view_settings.exposure = 2
        scene.view_settings.gamma = 1
        world = bpy.data.worlds.get("BlackSpace") or bpy.data.worlds.new("BlackSpace")
        world.use_nodes = True
        world.node_tree.nodes.get("Background").inputs["Strength"].default_value = 0
        scene.world = world
        radius = model["radius_m"]
        fov = fixed_fov_y(radius)
        tangent = math.tan(fov / 2)
        camera = self._object("CaptureCamera", "CAMERA")
        distance = frame["distance_m"]
        camera.location = (0, 0, distance)
        camera.rotation_euler = (0, 0, 0)
        camera.data.type = "PERSP"
        camera.data.sensor_fit = "HORIZONTAL"
        camera.data.sensor_width = 1
        camera.data.lens = 0.5 / tangent
        if not math.isclose(camera.data.lens, 0.5 / tangent, rel_tol=1e-5):
            raise ValueError("Camera lens exceeded Blender's range")
        camera.data.clip_start = max(0.1, distance - 2 * radius)
        camera.data.clip_end = distance + 2 * radius
        scene.camera = camera
        sunlight = self._object("CaptureSun", "SUN")
        light = frame["lighting"]
        azimuth, elevation = math.radians(light["azimuth_deg"]), math.radians(light["elevation_deg"])
        direction = Vector((math.cos(elevation) * math.sin(azimuth), math.sin(elevation),
                            math.cos(elevation) * math.cos(azimuth)))
        sunlight.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
        sunlight.data.energy = light["energy"]
        sunlight.data.angle = math.radians(0.53)
        bpy.context.view_layer.update()
        bbox = self._project_bounds(distance, resolution, resolution / (2 * tangent))
        if not (0 <= bbox[0] < bbox[2] <= resolution and 0 <= bbox[1] < bbox[3] <= resolution):
            raise ValueError(f"Capture geometry is outside the frame: {bbox}")
        scene.render.filepath = str(output / "clean.png")
        bpy.ops.render.render(write_still=True)
        basis = np.eye(4)
        basis[:3, :3] = CLIENT_TO_ENGINE
        return {"bbox_xyxy": bbox, "radius_m": radius, "fov_y_rad": fov,
                "observer_camera": camera_parameters(distance, resolution, fov, [list(row) for row in camera.matrix_world]),
                "model_sha256": model["sha256"], "source_to_body": (basis @ np.array(model["source_to_body"])).tolist(),
                "renderer": {"name": "Blender EEVEE", "version": bpy.app.version_string,
                             "view_transform": "Standard", "exposure_ev": 2, "dither": 0}}

    @staticmethod
    def _project_bounds(distance: float, resolution: int, focal: float) -> list[float]:
        bounds = [math.inf, math.inf, -math.inf, -math.inf]
        graph = bpy.context.evaluated_depsgraph_get()
        for obj in bpy.context.scene.objects:
            if obj.type != "MESH" or obj.hide_render:
                continue
            evaluated = obj.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            try:
                for vertex in mesh.vertices:
                    p = evaluated.matrix_world @ vertex.co
                    depth = distance - p.z
                    if depth <= 0:
                        raise ValueError("Geometry behind observation camera")
                    px, py = resolution / 2 + focal * p.x / depth, resolution / 2 - focal * p.y / depth
                    bounds = [min(bounds[0], px), min(bounds[1], py), max(bounds[2], px), max(bounds[3], py)]
            finally:
                evaluated.to_mesh_clear()
        return bounds
