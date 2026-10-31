"""Fixed acquisition camera and separate onboard payload camera transforms."""
from __future__ import annotations

import math
from typing import Sequence

import numpy as np

from .rotation import CLIENT_TO_ENGINE, quaternion_to_matrix, validate_rotation
from satellite_studio import CAMERA_COORD_INFO


def fixed_fov_y(radius_m: float, minimum_distance_m: float = 10000., safe_fraction: float = .8) -> float:
    if not all(math.isfinite(v) for v in (radius_m, minimum_distance_m, safe_fraction)):
        raise ValueError("视场参数必须有限")
    if not 0 < radius_m < minimum_distance_m or not 0 < safe_fraction <= 1:
        raise ValueError("模型半径必须小于最近距离，安全画幅比例必须在 (0,1]")
    return 2 * math.atan(radius_m / (safe_fraction * math.sqrt(minimum_distance_m**2 - radius_m**2)))


def camera_parameters(distance_m: float, resolution: int, fov_y_rad: float,
                      blender_matrix_world: Sequence[Sequence[float]] | None = None) -> dict:
    if not math.isfinite(distance_m) or distance_m <= 0 or not math.isfinite(fov_y_rad) or not 0 < fov_y_rad < math.pi:
        raise ValueError("无效的观察相机参数")
    focal = resolution / (2 * math.tan(fov_y_rad / 2))
    if blender_matrix_world is None:
        blender_matrix_world = np.eye(4)
        blender_matrix_world[2, 3] = distance_m
    actual = validate_installation(blender_matrix_world)
    # Blender local X:right,Y:up,Z:back; client camera X:up,Y:left,Z:forward.
    blender_from_camera = np.array([[0., -1., 0.], [1., 0., 0.], [0., 0., -1.]])
    camera_to_world = np.eye(4)
    camera_to_world[:3, :3] = CLIENT_TO_ENGINE @ actual[:3, :3] @ blender_from_camera
    camera_to_world[:3, 3] = CLIENT_TO_ENGINE @ actual[:3, 3]
    world_to_camera = np.linalg.inv(camera_to_world)
    camera_to_cv = np.array([[0., -1., 0.], [-1., 0., 0.], [0., 0., 1.]])
    k = np.array([[focal, 0, resolution / 2], [0, focal, resolution / 2], [0, 0, 1]])
    return {"coordinate_convention": CAMERA_COORD_INFO,
            "K_basis": "CV: +X right, +Y down, +Z forward",
            "camera_to_cv_rotation": camera_to_cv.tolist(),
            "projection_world_to_pixel": (k @ camera_to_cv @ world_to_camera[:3]).tolist(),
            "K": k.tolist(),
            "camera_to_world": camera_to_world.tolist(), "world_to_camera": world_to_camera.tolist(),
            "image_basis": "right-handed image basis: +X right, +Y up, +Z toward observer",
            "image_basis_to_world": (CLIENT_TO_ENGINE @ actual[:3, :3]).tolist(), "fov_y_rad": fov_y_rad,
            "width": resolution, "height": resolution, "distance_m": distance_m,
            "actual_distance_m": float(np.linalg.norm(camera_to_world[:3, 3])),
            "pixel_convention": "continuous image edges [0,width] x [0,height]"}


def validate_installation(values: Sequence[Sequence[float]]) -> np.ndarray:
    matrix = np.asarray(values, dtype=float)
    if matrix.shape != (4, 4) or not np.isfinite(matrix).all():
        raise ValueError("载荷安装矩阵必须为有限数值 4×4 矩阵")
    if not np.allclose(matrix[3], [0, 0, 0, 1], atol=1e-10, rtol=0):
        raise ValueError("载荷安装矩阵末行必须为 [0,0,0,1]")
    validate_rotation(matrix[:3, :3])
    return matrix


def payload_world_transform(quaternion_xyzw: Sequence[float], body_from_payload: Sequence[Sequence[float]]) -> np.ndarray:
    world_from_body = np.eye(4)
    world_from_body[:3, :3] = quaternion_to_matrix(quaternion_xyzw)
    return world_from_body @ validate_installation(body_from_payload)
