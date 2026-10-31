"""Build a frame in staging, decode it, then publish files before the DB marker."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re

import numpy as np
from PIL import Image

from satellite_studio import COORDINATE_CONVENTION_ID, SCHEMA_VERSION
from satellite_studio.domain.camera import camera_parameters, fixed_fov_y, payload_world_transform
from satellite_studio.domain.parameters import Scene
from satellite_studio.domain.rotation import quaternion_to_matrix, six_angles

FRAME_ID = re.compile(r"^[0-9]{6}$")
SHA256 = re.compile(r"^[a-fA-F0-9]{64}$")


def read_grayscale_png(path: Path, resolution: int = 1024) -> np.ndarray:
    try:
        with Image.open(path) as image:
            if image.format != "PNG" or image.mode != "L" or image.size != (resolution, resolution):
                raise ValueError(f"{path.name} 必须为 {resolution}×{resolution} 的 8 位灰度 PNG")
            image.load()  # Decode every pixel, rather than only trusting the PNG header.
            return np.array(image, dtype=np.uint8)
    except (OSError, SyntaxError) as exc:
        raise ValueError(f"{path.name} 无法完整解码: {exc}") from exc


def bbox_to_yolo(bbox: list[float], resolution: int) -> list[float]:
    values = np.asarray(bbox, dtype=float)
    if values.shape != (4,) or not np.isfinite(values).all():
        raise ValueError("正式渲染器没有返回有效的像素边界框")
    xmin, ymin, xmax, ymax = values
    if not (0 <= xmin < xmax <= resolution and 0 <= ymin < ymax <= resolution):
        raise ValueError("目标几何超出图像边界或边界框为空，拒绝裁切标签")
    return [float((xmin+xmax)/(2*resolution)), float((ymin+ymax)/(2*resolution)),
            float((xmax-xmin)/resolution), float((ymax-ymin)/resolution)]


def write_json(path: Path, value: dict) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def prepare_frame(stage: Path, frame: dict, render_result: dict, scene: Scene) -> dict:
    frame_id = frame["frame_id"]
    if not FRAME_ID.fullmatch(frame_id):
        raise ValueError("内部帧标识无效")
    resolution = frame["resolution"]
    pixels = read_grayscale_png(stage / "clean.png", resolution)
    bbox = render_result["bbox_xyxy"]
    yolo = bbox_to_yolo(bbox, resolution)
    radius, fov = float(render_result["radius_m"]), float(render_result["fov_y_rad"])
    if not math.isclose(fov, fixed_fov_y(radius), rel_tol=1e-7, abs_tol=1e-12):
        raise ValueError("正式相机视场不匹配固定模型采集配置")
    model_hash = render_result.get("model_sha256", "")
    if not isinstance(model_hash, str) or not SHA256.fullmatch(model_hash):
        raise ValueError("正式模型 SHA256 缺失或无效")
    source_to_body = np.asarray(render_result["source_to_body"], dtype=float)
    if source_to_body.shape != (4, 4) or not np.isfinite(source_to_body).all():
        raise ValueError("模型坐标变换必须为有限 4×4 矩阵")
    renderer = render_result.get("renderer")
    if not isinstance(renderer, dict) or not renderer.get("name") or not renderer.get("version"):
        raise ValueError("渲染器版本信息缺失")
    noise = frame["noise"]
    if noise["enabled"]:
        rng = np.random.default_rng(frame["seed"])
        signal = pixels.astype(np.float64) / 255
        signal = rng.poisson(signal * noise["poisson_peak"]) / noise["poisson_peak"]
        signal += rng.normal(0, noise["gaussian_sigma"], signal.shape)
        noisy = np.rint(np.clip(signal, 0, 1) * 255).astype(np.uint8)
    else:
        noisy = pixels
    Image.fromarray(noisy).save(stage / "noisy.png")
    quaternion = frame["quaternion_xyzw"]
    actual_scene = dict(frame)
    pose = {"schema_version": SCHEMA_VERSION, "coordinate_convention_id": COORDINATE_CONVENTION_ID,
            "frame_id": frame_id, "model_id": frame["model_id"], "model_sha256": model_hash,
            "quaternion_xyzw": quaternion, "rotation_world_from_body": quaternion_to_matrix(quaternion).tolist(),
            "six_angles": six_angles(quaternion), "distance_m": frame["distance_m"],
            "resolution": [resolution, resolution], "bbox_xyxy": [float(x) for x in bbox],
            "bbox_yolo": yolo, "class_id": 0, "radius_m": radius, "fov_y_rad": fov,
            "source_to_body": source_to_body.tolist(), "observer_camera": camera_parameters(frame["distance_m"], resolution, fov),
            "payload_camera": {"body_from_camera": [list(row) for row in scene.payload_body_from_camera],
                               "world_from_camera": payload_world_transform(quaternion, scene.payload_body_from_camera).tolist(),
                               "installation_source": scene.installation_source},
            "sequence_id": frame["sequence_id"], "frame_index": frame["frame_index"], "timestamp_s": frame["timestamp_s"],
            "master_seed": scene.seed, "noise_seed": frame["seed"],
            "noise_model": "pixel_domain_poisson_then_gaussian", "scene": actual_scene,
            "renderer": renderer,
            "files": {"clean": f"images_clean/{frame_id}.png", "noisy": f"images_noisy/{frame_id}.png",
                      "label": f"labels/{frame_id}.txt", "pose": f"poses/{frame_id}.json"}}
    write_json(stage / "pose.json", pose)
    with (stage / "label.txt").open("w", encoding="ascii", newline="\n") as stream:
        stream.write("0 " + " ".join(f"{v:.12f}" for v in yolo) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    validate_frame(stage, frame_id)
    return pose


def validate_frame(stage: Path, expected_frame_id: str) -> dict:
    read_grayscale_png(stage / "clean.png")
    read_grayscale_png(stage / "noisy.png")
    try:
        pose = json.loads((stage / "pose.json").read_text(encoding="utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        json.dumps(pose, allow_nan=False)  # Also rejects overflowed exponent literals such as 1e309.
        if pose["frame_id"] != expected_frame_id or pose["schema_version"] != SCHEMA_VERSION:
            raise ValueError("姿态 JSON 的帧标识或协议版本不匹配")
        if pose["coordinate_convention_id"] != COORDINATE_CONVENTION_ID or pose["resolution"] != [1024, 1024]:
            raise ValueError("姿态 JSON 的坐标约定或分辨率不匹配")
        tokens = (stage / "label.txt").read_text(encoding="ascii").split()
        if len(tokens) != 5 or tokens[0] != "0":
            raise ValueError("YOLO 标签必须为 class xc yc w h 五列")
        label = np.asarray([float(token) for token in tokens[1:]])
        expected = bbox_to_yolo(pose["bbox_xyxy"], 1024)
        if not np.isfinite(label).all() or not np.allclose(label, expected, rtol=0, atol=1e-10) or not np.allclose(pose["bbox_yolo"], expected, rtol=0, atol=1e-10):
            raise ValueError("YOLO 与姿态 JSON 边界框不一致")
        q = pose["quaternion_xyzw"]
        if not math.isclose(float(np.linalg.norm(q)), 1, abs_tol=1e-8):
            raise ValueError("姿态四元数未归一化")
        matrix = quaternion_to_matrix(q)
        if not np.allclose(matrix, pose["rotation_world_from_body"], atol=1e-10, rtol=0):
            raise ValueError("姿态旋转矩阵与四元数不一致")
        actual_angles = six_angles(q)
        for field in ("alpha_rad", "beta_rad", "alpha_valid"):
            if not np.allclose(pose["six_angles"][field], actual_angles[field], rtol=0, atol=1e-10):
                raise ValueError("六角与四元数不一致")
        scene = Scene.from_dict(pose["scene"])
        if not np.allclose(scene.quaternion_xyzw, q, rtol=0, atol=1e-10) or scene.distance_m != pose["distance_m"] or scene.model_id != pose["model_id"]:
            raise ValueError("逐帧场景快照与姿态 JSON 不一致")
        if pose["scene"]["frame_id"] != expected_frame_id:
            raise ValueError("逐帧场景标识不一致")
        expected_camera = camera_parameters(scene.distance_m, scene.resolution, pose["fov_y_rad"])
        for field in ("K", "camera_to_world", "world_to_camera", "image_to_world_rotation"):
            if not np.allclose(pose["observer_camera"][field], expected_camera[field], rtol=0, atol=1e-8):
                raise ValueError("观察相机参数与实际帧参数不一致")
        payload = pose["payload_camera"]
        if not np.allclose(payload["body_from_camera"], scene.payload_body_from_camera, rtol=0, atol=1e-10) or not np.allclose(payload["world_from_camera"], payload_world_transform(q, scene.payload_body_from_camera), rtol=0, atol=1e-8):
            raise ValueError("载荷相机外参与姿态不一致")
        for key, relative in {"clean": f"images_clean/{expected_frame_id}.png", "noisy": f"images_noisy/{expected_frame_id}.png", "label": f"labels/{expected_frame_id}.txt", "pose": f"poses/{expected_frame_id}.json"}.items():
            if pose["files"][key] != relative:
                raise ValueError("逐帧文件标识不一致")
        return pose
    except (KeyError, TypeError, OSError, UnicodeError) as exc:
        raise ValueError(f"帧文件不完整或结构错误: {exc}") from exc


def commit_frame(stage: Path, output: Path, frame_id: str) -> list[str]:
    validate_frame(stage, frame_id)
    pairs = [("clean.png", f"images_clean/{frame_id}.png"), ("noisy.png", f"images_noisy/{frame_id}.png"),
             ("label.txt", f"labels/{frame_id}.txt"), ("pose.json", f"poses/{frame_id}.json")]
    if any((output / relative).exists() for _, relative in pairs):
        raise ValueError("帧产物已存在，拒绝覆写")
    for source, relative in pairs:
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(stage / source, target)
    return [relative for _, relative in pairs]
