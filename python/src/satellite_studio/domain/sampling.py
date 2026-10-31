"""Uniform SO(3) coverage and sign-continuous constant world-axis sequences."""
from __future__ import annotations

import hashlib
import math
from typing import Iterator

import numpy as np

from .parameters import JobRequest
from .rotation import multiply_quaternions, normalize_quaternion


def frame_seed(master_seed: int, model_id: str, frame_id: str) -> int:
    encoded = f"satellite-pose-3.0\0{master_seed}\0{model_id}\0{frame_id}".encode("utf-8")
    return int.from_bytes(hashlib.sha256(encoded).digest()[:4], "big")


def sample_frames(request: JobRequest, job_id: str) -> Iterator[dict]:
    rng = np.random.default_rng(request.scene.seed)
    count = request.count
    if request.mode == "coverage":
        distances = 10000 + 20000 * (np.arange(count) + rng.random(count)) / count
        rng.shuffle(distances)
    elif request.mode == "sequence":
        settings = request.sequence
        distances = np.linspace(settings.start_distance_m, settings.end_distance_m, count)
        q = normalize_quaternion(rng.normal(size=4), canonical=True)
        axis = rng.normal(size=3)
        axis /= np.linalg.norm(axis)
        angle = math.radians(settings.angular_speed_deg_s) * settings.time_step_s
        step = np.concatenate((axis * math.sin(angle / 2), [math.cos(angle / 2)]))
    else:
        distances = [request.scene.distance_m]
    for index in range(count):
        if request.mode == "coverage":
            q = normalize_quaternion(rng.normal(size=4), canonical=True)
        elif request.mode == "single":
            q = normalize_quaternion(request.scene.quaternion_xyzw, canonical=True)
        elif index > 0:
            previous = q
            q = multiply_quaternions(step, previous)
            if np.dot(q, previous) < 0:
                q = -q
        frame_id = f"{index + 1:06d}"
        frame = request.scene.to_dict()
        frame.update(frame_id=frame_id, quaternion_xyzw=q.tolist(), distance_m=float(distances[index]),
                     seed=frame_seed(request.scene.seed, request.scene.model_id, frame_id), master_seed=request.scene.seed,
                     sequence_id=f"{job_id}-sequence" if request.mode == "sequence" else None,
                     frame_index=index, timestamp_s=index * request.sequence.time_step_s if request.mode == "sequence" else None)
        if request.mode == "sequence":
            frame["sequence_axis_world"] = axis.tolist()
            frame["angular_speed_deg_s"] = request.sequence.angular_speed_deg_s
        yield frame
