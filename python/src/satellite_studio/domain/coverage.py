"""Coverage diagnostics use alpha and cos(beta), never uniform beta bins."""
from __future__ import annotations

import math

import numpy as np

from .rotation import quaternion_to_matrix, six_angles


class CoverageAccumulator:
    def __init__(self):
        self._alpha: list[list[float]] = [[], [], []]
        self._cos_beta: list[list[float]] = [[], [], []]
        self._distances: list[float] = []

    def add(self, quaternion_xyzw: list[float], distance_m: float) -> None:
        angles = six_angles(quaternion_xyzw)
        cos_beta = quaternion_to_matrix(quaternion_xyzw)[1]
        for axis in range(3):
            if angles["alpha_valid"][axis]:
                self._alpha[axis].append(angles["alpha_rad"][axis])
            self._cos_beta[axis].append(float(np.clip(cos_beta[axis], -1, 1)))
        self._distances.append(distance_m)

    def to_dict(self) -> dict:
        gaps = []
        for values in self._alpha:
            if not values:
                gaps.append(2 * math.pi)
            else:
                ordered = sorted(values)
                gaps.append(float(np.diff([*ordered, ordered[0] + 2 * math.pi]).max()))
        return {"sampling_measure": "Haar SO(3); per-axis marginal alpha and cos(beta)",
                "completed_frames": len(self._distances), "axis_order": ["x", "y", "z"],
                "alpha_bin_edges_rad": np.linspace(0, 2 * math.pi, 37).tolist(),
                "alpha_histogram": [np.histogram(values, bins=36, range=(0, 2 * math.pi))[0].tolist() for values in self._alpha],
                "alpha_undefined_count": [len(self._distances) - len(values) for values in self._alpha],
                "alpha_max_gap_rad": gaps,
                "cos_beta_bin_edges": np.linspace(-1, 1, 21).tolist(),
                "cos_beta_histogram": [np.histogram(values, bins=20, range=(-1, 1))[0].tolist() for values in self._cos_beta],
                "cos_beta_max_gap": [float(np.diff([-1., *sorted(values), 1.]).max()) for values in self._cos_beta],
                "distance_bin_edges_m": np.linspace(10000, 30000, 21).tolist(),
                "distance_histogram": np.histogram(self._distances, bins=20, range=(10000, 30000))[0].tolist(),
                "interpretation": "Marginal diagnostics, not a guarantee of complete joint SO(3) coverage."}
