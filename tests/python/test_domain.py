import math
import unittest

import numpy as np

from satellite_studio.domain.camera import camera_parameters, fixed_fov_y, payload_world_transform
from satellite_studio.domain.parameters import JobRequest, Scene
from satellite_studio.domain.rotation import matrix_to_quaternion, quaternion_to_matrix, six_angles
from satellite_studio.domain.sampling import sample_frames
from satellite_studio.domain.coverage import CoverageAccumulator


def scene_dict(**changes):
    scene = {"model_id": "demo", "quaternion_xyzw": [0, 0, 0, 1], "distance_m": 20000,
             "resolution": 1024, "seed": 20260919,
             "noise": {"enabled": True, "gaussian_sigma": .012, "poisson_peak": 96},
             "lighting": {"azimuth_deg": 35, "elevation_deg": 28, "energy": 4}}
    scene.update(changes)
    return scene


class DomainTests(unittest.TestCase):
    def test_identity_six_angles_and_standard_rotation(self):
        angles = six_angles([0, 0, 0, 1])
        np.testing.assert_allclose(angles["alpha_rad"], [0, math.pi / 2, 0])
        np.testing.assert_allclose(angles["beta_rad"], [math.pi / 2, math.pi / 2, 0])
        self.assertEqual(angles["alpha_valid"], [True, True, False])
        rotation = quaternion_to_matrix([0, 0, math.sin(math.pi / 4), math.cos(math.pi / 4)])
        np.testing.assert_allclose(rotation @ [1, 0, 0], [0, 1, 0], atol=1e-12)

    def test_random_quaternion_matrix_roundtrip(self):
        for q in np.random.default_rng(42).normal(size=(100, 4)):
            q /= np.linalg.norm(q)
            matrix = quaternion_to_matrix(q)
            np.testing.assert_allclose(matrix.T @ matrix, np.eye(3), atol=1e-12)
            self.assertAlmostEqual(np.linalg.det(matrix), 1)
            self.assertAlmostEqual(abs(np.dot(q, matrix_to_quaternion(matrix))), 1)

    def test_scene_rejects_nonfinite_invalid_and_bool_numbers(self):
        for changes in ({"distance_m": 9999}, {"distance_m": float("nan")},
                        {"resolution": 512}, {"quaternion_xyzw": [0, 0, 0, 0]},
                        {"quaternion_xyzw": [0, float("inf"), 0, 1]}, {"seed": True},
                        {"seed": 2**32}, {"model_id": "../raw"},
                        {"noise": {"enabled": True, "gaussian_sigma": -1, "poisson_peak": 96}},
                        {"lighting": {"energy": float("inf")}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                Scene.from_dict(scene_dict(**changes))

    def test_scene_snapshot_is_independent_and_normalized(self):
        raw = scene_dict(quaternion_xyzw=[0, 0, 0, 2])
        scene = Scene.from_dict(raw)
        raw["quaternion_xyzw"][0] = 8
        raw["noise"]["gaussian_sigma"] = 1
        self.assertEqual(scene.to_dict()["quaternion_xyzw"], [0, 0, 0, 1])
        self.assertEqual(scene.to_dict()["noise"]["gaussian_sigma"], .012)

    def test_coverage_is_reproducible_stratified_and_uniform(self):
        request = JobRequest.from_dict({"mode": "coverage", "count": 4000, "scene": scene_dict()})
        frames = list(sample_frames(request, "job"))
        self.assertEqual(frames, list(sample_frames(request, "job")))
        z_axes = np.array([quaternion_to_matrix(f["quaternion_xyzw"])[:, 2] for f in frames])
        np.testing.assert_allclose(z_axes.mean(axis=0), np.zeros(3), atol=.04)
        np.testing.assert_allclose((z_axes**2).mean(axis=0), np.full(3, 1 / 3), atol=.025)
        bins = {int((f["distance_m"] - 10000) / 20000 * 4000) for f in frames}
        self.assertEqual(len(bins), 4000)

    def test_sequence_crosses_180_without_sign_jump(self):
        request = JobRequest.from_dict({"mode": "sequence", "count": 400, "scene": scene_dict()})
        frames = list(sample_frames(request, "job"))
        self.assertTrue(all(np.dot(a["quaternion_xyzw"], b["quaternion_xyzw"]) >= 0
                            for a, b in zip(frames, frames[1:])))
        for a, b in zip(frames, frames[1:]):
            self.assertAlmostEqual(np.dot(a["quaternion_xyzw"], b["quaternion_xyzw"]), math.cos(math.pi / 360))
        self.assertEqual(frames[0]["distance_m"], 30000)
        self.assertEqual(frames[-1]["distance_m"], 10000)
        self.assertEqual(frames[-1]["timestamp_s"], 399)
        self.assertTrue(any(f["quaternion_xyzw"][3] < 0 for f in frames))

    def test_sequence_configuration_and_invalid_step(self):
        request = JobRequest.from_dict({"mode": "sequence", "count": 3, "scene": scene_dict(),
                                       "sequence": {"start_distance_m": 25000, "end_distance_m": 15000,
                                                    "time_step_s": 2, "angular_speed_deg_s": 3}})
        frames = list(sample_frames(request, "job"))
        self.assertEqual([f["distance_m"] for f in frames], [25000, 20000, 15000])
        self.assertEqual([f["timestamp_s"] for f in frames], [0, 2, 4])
        with self.assertRaises(ValueError):
            JobRequest.from_dict({"mode": "sequence", "scene": scene_dict(), "sequence": {"angular_speed_deg_s": 180}})

    def test_coverage_report_masks_undefined_alpha(self):
        report = CoverageAccumulator()
        report.add([0, 0, 0, 1], 20000)
        result = report.to_dict()
        self.assertEqual(result["completed_frames"], 1)
        self.assertEqual(sum(result["alpha_histogram"][0]), 1)
        self.assertEqual(sum(result["alpha_histogram"][2]), 0)
        self.assertEqual(result["alpha_undefined_count"], [0, 0, 1])
        self.assertAlmostEqual(result["alpha_max_gap_rad"][0], 2 * math.pi)

    def test_camera_projection_and_fixed_sphere_bound(self):
        fov = fixed_fov_y(8)
        self.assertGreaterEqual(math.tan(fov / 2), 8 / (.8 * math.sqrt(10000**2 - 8**2)))
        camera = camera_parameters(20000, 1024, fov)
        point = np.array(camera["world_to_camera"]) @ [1, 2, 3, 1]
        np.testing.assert_allclose(point, [1, -2, 19997, 1])
        np.testing.assert_allclose(payload_world_transform([0, 0, 0, 1], np.eye(4)), np.eye(4))


if __name__ == "__main__":
    unittest.main()
