"""Validate once at ingress, then retain immutable task parameter snapshots."""
from __future__ import annotations

from dataclasses import asdict, dataclass
import math
import re
from typing import Any

from .camera import validate_installation
from .rotation import normalize_quaternion, quaternion_array, quaternion_object

IDENTIFIER = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$")
IDENTITY = ((1., 0., 0., 0.), (0., 1., 0., 0.), (0., 0., 1., 0.), (0., 0., 0., 1.))


def number(value: Any, name: str, minimum: float | None = None, maximum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} 必须是有限数值")
    try:
        value = float(value)
    except OverflowError as exc:
        raise ValueError(f"{name} 数值过大") from exc
    if not math.isfinite(value) or (minimum is not None and value < minimum) or (maximum is not None and value > maximum):
        raise ValueError(f"{name} 超出允许范围")
    return value


def integer(value: Any, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{name} 必须为 {minimum}–{maximum} 范围的整数")
    return value


def mapping(value: Any, name: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{name} 必须为 JSON 对象")
    return value


@dataclass(frozen=True)
class Noise:
    enabled: bool = True
    gaussian_sigma: float = .012
    poisson_peak: float = 96.

    @classmethod
    def from_dict(cls, values: dict) -> Noise:
        values = mapping(values, "noise")
        enabled = values.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError("noise.enabled 必须是布尔值")
        return cls(enabled, number(values.get("gaussian_sigma", .012), "gaussian_sigma", 0, 1),
                   number(values.get("poisson_peak", 96), "poisson_peak", 1, 1e7))


@dataclass(frozen=True)
class Lighting:
    azimuth_deg: float = 35.
    elevation_deg: float = 28.
    energy: float = 4.

    @classmethod
    def from_dict(cls, values: dict) -> Lighting:
        values = mapping(values, "lighting")
        return cls(number(values.get("azimuth_deg", 35), "azimuth_deg", -360, 360),
                   number(values.get("elevation_deg", 28), "elevation_deg", -90, 90),
                   number(values.get("energy", 4), "energy", 0, 100))


@dataclass(frozen=True)
class Scene:
    model_id: str
    quaternion_xyzw: tuple[float, float, float, float]
    distance_m: float
    resolution: int
    seed: int
    noise: Noise
    lighting: Lighting
    payload_body_from_camera: tuple[tuple[float, ...], ...] = IDENTITY
    installation_source: str = "simulation_default"

    @classmethod
    def from_dict(cls, values: dict) -> Scene:
        values = mapping(values, "scene")
        model_id = values.get("model_id")
        if not isinstance(model_id, str) or not IDENTIFIER.fullmatch(model_id):
            raise ValueError("model_id 无效")
        if "quaternion_xyzw" in values:
            raise ValueError("V1 quaternion_xyzw 旧协议不受支持；请使用 sat_quat WXYZ")
        q = quaternion_array(values.get("sat_quat"))
        transform = validate_installation(values.get("payload_body_from_camera", IDENTITY))
        default_install = "simulation_default" if "payload_body_from_camera" not in values else "user_defined"
        source = values.get("installation_source", default_install)
        if source not in ("simulation_default", "user_defined", "calibrated"):
            raise ValueError("installation_source 无效")
        return cls(model_id, tuple(q.tolist()), number(values.get("distance_m", 20000), "distance_m", 10000, 30000),
                   integer(values.get("resolution", 1024), "resolution", 1024, 1024),
                   integer(values.get("seed", 20260919), "seed", 0, 2**32 - 1),
                   Noise.from_dict(values.get("noise", {})), Lighting.from_dict(values.get("lighting", {})),
                   tuple(tuple(row) for row in transform.tolist()), source)

    def to_dict(self) -> dict:
        result = asdict(self)
        result.pop("quaternion_xyzw")
        result["sat_quat"] = quaternion_object(self.quaternion_xyzw)
        result["payload_body_from_camera"] = [list(row) for row in self.payload_body_from_camera]
        return result


@dataclass(frozen=True)
class SequenceSettings:
    start_distance_m: float = 30000.
    end_distance_m: float = 10000.
    time_step_s: float = 1.
    angular_speed_deg_s: float = 1.

    @classmethod
    def from_dict(cls, values: dict) -> SequenceSettings:
        values = mapping(values, "sequence")
        result = cls(number(values.get("start_distance_m", 30000), "start_distance_m", 10000, 30000),
                     number(values.get("end_distance_m", 10000), "end_distance_m", 10000, 30000),
                     number(values.get("time_step_s", 1), "time_step_s", 1e-6, 3600),
                     number(values.get("angular_speed_deg_s", 1), "angular_speed_deg_s", 0, 179.999999))
        if result.time_step_s * result.angular_speed_deg_s >= 180:
            raise ValueError("连续序列单步旋转必须小于 180°")
        return result


@dataclass(frozen=True)
class TrajectorySettings:
    start_quaternion_xyzw: tuple[float, float, float, float]
    end_quaternion_xyzw: tuple[float, float, float, float]
    time_step_s: float = 1.

    @classmethod
    def from_dict(cls, values: dict) -> TrajectorySettings:
        values = mapping(values, "trajectory")
        return cls(tuple(quaternion_array(values.get("start_quat"))),
                   tuple(quaternion_array(values.get("end_quat"))),
                   number(values.get("time_step_s", 1), "trajectory.time_step_s", 1e-6, 3600))

    def to_dict(self) -> dict:
        return {"start_quat": quaternion_object(self.start_quaternion_xyzw),
                "end_quat": quaternion_object(self.end_quaternion_xyzw), "time_step_s": self.time_step_s}


@dataclass(frozen=True)
class JobRequest:
    mode: str
    count: int
    scene: Scene
    sequence: SequenceSettings
    trajectory: TrajectorySettings | None = None
    renderer_backend: str = "blender"
    distance_policy: str | None = None

    @classmethod
    def from_dict(cls, values: dict) -> JobRequest:
        values = mapping(values, "job")
        mode = values.get("mode", "single")
        if mode not in ("single", "coverage", "sequence", "custom_sequence"):
            raise ValueError("mode 必须为 single、coverage、sequence 或 custom_sequence")
        if mode != "custom_sequence" and "trajectory" in values:
            raise ValueError("trajectory 仅用于 custom_sequence")
        if mode == "custom_sequence" and "sequence" in values:
            raise ValueError("custom_sequence 不接受 sequence 参数")
        policy = values.get("distance_policy")
        if "distance_policy" in values and policy not in ("fixed", "automatic"):
            raise ValueError("distance_policy 必须为 fixed 或 automatic")
        if policy == "automatic" and mode not in ("coverage", "sequence"):
            raise ValueError("automatic 拍摄距离仅适用于 coverage 或 sequence")
        count = integer(values.get("count", {"single": 1, "coverage": 1000, "sequence": 120, "custom_sequence": 120}[mode]),
                        "count", 2 if mode == "custom_sequence" else 1, 100000)
        if mode == "single" and count != 1:
            raise ValueError("单张采集 count 必须为 1")
        trajectory = TrajectorySettings.from_dict(values.get("trajectory")) if mode == "custom_sequence" else None
        backend = values.get("renderer_backend", "blender")
        if backend not in ("blender", "threejs"):
            raise ValueError("renderer_backend 必须为 blender 或 threejs")
        return cls(mode, count, Scene.from_dict(values.get("scene", {})),
                   SequenceSettings.from_dict(values.get("sequence", {})), trajectory, backend, policy)

    def to_dict(self) -> dict:
        result = {"mode": self.mode, "count": self.count, "scene": self.scene.to_dict(), "renderer_backend": self.renderer_backend}
        if self.distance_policy is not None:
            result["distance_policy"] = self.distance_policy
        if self.mode == "custom_sequence":
            result["trajectory"] = self.trajectory.to_dict()
        else:
            result["sequence"] = asdict(self.sequence)
        return result
