"""Hamilton active local-to-world rotations in the V2 client LH basis.

Internal math uses xyzw arrays; public protocol uses named WXYZ objects.
"""
from __future__ import annotations

import math
from typing import Sequence

import numpy as np

CLIENT_TO_ENGINE = np.array([[1., 0., 0.], [0., 0., 1.], [0., 1., 0.]])


def quaternion_object(values: Sequence[float]) -> dict:
    x, y, z, w = normalize_quaternion(values)
    return dict(W=float(w), X=float(x), Y=float(y), Z=float(z))


def quaternion_array(value: dict) -> np.ndarray:
    if not isinstance(value, dict) or set(value) != {"W", "X", "Y", "Z"}:
        raise ValueError("sat_quat 必须包含 W,X,Y,Z")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in value.values()):
        raise ValueError("四元数分量必须为有限数值")
    return normalize_quaternion([value[k] for k in ("X", "Y", "Z", "W")])


def client_to_engine_quaternion(values: Sequence[float]) -> np.ndarray:
    x, y, z, w = normalize_quaternion(values)
    return np.array([-x, -z, -y, w])


def normalize_quaternion(values: Sequence[float], *, canonical: bool = False) -> np.ndarray:
    q = np.asarray(values, dtype=float)
    if q.shape != (4,) or not np.isfinite(q).all():
        raise ValueError("quaternion_xyzw 必须包含四个有限数值")
    scale = float(np.max(np.abs(q)))
    if scale == 0:
        raise ValueError("四元数不能为零")
    q = q / scale
    q /= np.linalg.norm(q)
    if canonical and q[3] < 0:
        q = -q
    return q


def quaternion_to_matrix(values: Sequence[float]) -> np.ndarray:
    x, y, z, w = normalize_quaternion(values)
    return np.array([
        [1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)],
        [2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w)],
        [2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y)],
    ])


def validate_rotation(matrix: Sequence[Sequence[float]]) -> np.ndarray:
    result = np.asarray(matrix, dtype=float)
    if result.shape != (3, 3) or not np.isfinite(result).all():
        raise ValueError("旋转矩阵必须为有限数值 3×3 矩阵")
    if not np.allclose(result.T @ result, np.eye(3), atol=1e-8, rtol=0) or not math.isclose(float(np.linalg.det(result)), 1, abs_tol=1e-8):
        raise ValueError("旋转矩阵必须正交且行列式为 +1")
    return result


def matrix_to_quaternion(matrix: Sequence[Sequence[float]]) -> np.ndarray:
    m = validate_rotation(matrix)
    trace = float(np.trace(m))
    if trace > 0:
        s = math.sqrt(trace + 1) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, s / 4]
    else:
        i = int(np.argmax(np.diag(m)))
        j, k = (i + 1) % 3, (i + 2) % 3
        s = math.sqrt(1 + m[i, i] - m[j, j] - m[k, k]) * 2
        q = [0., 0., 0., (m[k, j] - m[j, k]) / s]
        q[i], q[j], q[k] = s / 4, (m[j, i] + m[i, j]) / s, (m[k, i] + m[i, k]) / s
    return normalize_quaternion(q, canonical=True)


def multiply_quaternions(left: Sequence[float], right: Sequence[float]) -> np.ndarray:
    a, b = normalize_quaternion(left), normalize_quaternion(right)
    vector = a[3] * b[:3] + b[3] * a[:3] + np.cross(a[:3], b[:3])
    return normalize_quaternion([*vector, a[3] * b[3] - np.dot(a[:3], b[:3])])


def six_angles(quaternion_xyzw: Sequence[float], image_to_world: Sequence[Sequence[float]] | None = None) -> dict:
    """Angles from columns of R_IB; undefined azimuths carry an explicit mask."""
    matrix = quaternion_to_matrix(quaternion_xyzw)
    if image_to_world is not None:
        matrix = validate_rotation(image_to_world).T @ matrix
    valid = np.hypot(matrix[0], matrix[2]) >= 1e-8
    alpha = np.where(valid, np.mod(np.arctan2(matrix[2], matrix[0]), 2 * math.pi), 0)
    beta = np.arccos(np.clip(matrix[1], -1, 1))
    return {"alpha_rad": alpha.tolist(), "beta_rad": beta.tolist(), "alpha_valid": valid.tolist()}


def align_quaternion_endpoint(start: Sequence[float], end: Sequence[float]) -> np.ndarray:
    """Shortest arc; at pi choose the largest relative axis component positive."""
    a, b = normalize_quaternion(start), normalize_quaternion(end)
    dot = float(np.dot(a, b))
    if abs(dot) <= 1e-15:
        relative = multiply_quaternions([-a[0], -a[1], -a[2], a[3]], b)
        if relative[int(np.argmax(np.abs(relative[:3])))] < 0:
            b = -b
    elif dot < 0:
        b = -b
    return b


def slerp_quaternions(start: Sequence[float], end: Sequence[float], t: float) -> np.ndarray:
    """Unit Hamilton xyzw interpolation with inclusive exact normalized endpoints."""
    if isinstance(t, bool) or not math.isfinite(t) or not 0 <= t <= 1:
        raise ValueError("SLERP t must be finite and in [0, 1]")
    a = normalize_quaternion(start)
    b = align_quaternion_endpoint(a, end)
    if t == 0:
        return a
    if t == 1:
        return b
    dot = float(np.clip(np.dot(a, b), -1, 1))
    if dot > 1 - 1e-8:
        return normalize_quaternion((1-t)*a + t*b)
    angle = math.acos(dot)
    return normalize_quaternion((math.sin((1-t)*angle)*a + math.sin(t*angle)*b) / math.sin(angle))
