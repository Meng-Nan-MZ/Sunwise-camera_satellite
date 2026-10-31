import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

from satellite_studio.datasets.export import prepare_frame, validate_frame, commit_frame
from satellite_studio.domain.camera import fixed_fov_y, camera_parameters
from satellite_studio.domain.parameters import JobRequest
from satellite_studio.domain.sampling import sample_frames
from satellite_studio.jobs.store import JobStore
from test_domain import scene_dict


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.request = JobRequest.from_dict({"mode": "single", "scene": scene_dict()})

    def tearDown(self):
        self.temp.cleanup()

    def test_persistent_snapshot_and_recovery(self):
        store = JobStore(self.root)
        job = store.create(self.request)
        request = store.request(job["id"])
        self.assertEqual(request, self.request)
        claimed = store.claim_next()
        self.assertEqual(claimed["id"], job["id"])
        self.assertEqual(claimed["status"], "running")
        store.close()
        recovered = JobStore(self.root)
        self.assertEqual(recovered.get(job["id"])["status"], "interrupted")
        self.assertEqual(recovered.request(job["id"]), self.request)
        recovered.close()

    def test_queued_cancel_never_claimed(self):
        store = JobStore(self.root)
        job = store.create(self.request)
        self.assertEqual(store.cancel(job["id"])["status"], "canceled")
        self.assertIsNone(store.claim_next())
        store.close()

    def make_frame(self, metadata_override=None):
        frame = next(sample_frames(self.request, "testjob"))
        stage = self.root / "stage"
        stage.mkdir()
        Image.fromarray(np.full((1024, 1024), 128, dtype=np.uint8)).save(stage / "clean.png")
        metadata = {"bbox_xyxy": [200, 220, 824, 804], "radius_m": 8, "fov_y_rad": fixed_fov_y(8),
                    "model_sha256": "a" * 64, "source_to_body": np.eye(4).tolist(),
                    "observer_camera": camera_parameters(20000, 1024, fixed_fov_y(8)),
                    "renderer": {"name": "test", "version": "1"}}
        metadata.update(metadata_override or {})
        prepare_frame(stage, frame, metadata, self.request.scene)
        return stage, frame

    def test_float32_formal_camera_position_preserves_actual_projection(self):
        distance = 11380.885731179125
        actual = float(np.float32(distance))
        self.request = JobRequest.from_dict({"scene": scene_dict(distance_m=distance)})
        blender_matrix = np.eye(4)
        blender_matrix[2, 3] = actual
        observer = camera_parameters(distance, 1024, fixed_fov_y(8), blender_matrix)
        stage, frame = self.make_frame({"observer_camera": observer})
        pose = validate_frame(stage, frame["frame_id"])
        self.assertEqual(pose["observer_camera"]["camera_to_world"][1][3], actual)
        self.assertEqual(pose["observer_camera"]["actual_distance_m"], actual)
        self.assertEqual(pose["observer_camera"]["distance_m"], distance)
        projection = np.array(pose["observer_camera"]["projection_world_to_pixel"])
        expected = np.array(observer["K"]) @ np.array(observer["camera_to_cv_rotation"]) @ np.array(observer["world_to_camera"])[:3]
        np.testing.assert_allclose(projection, expected, rtol=0, atol=1e-8)

    def test_camera_position_beyond_nearest_float32_rejected(self):
        distance = 11380.885731179125
        self.request = JobRequest.from_dict({"scene": scene_dict(distance_m=distance)})
        matrix = np.eye(4)
        matrix[2, 3] = float(np.nextafter(np.float32(distance), np.float32(np.inf)))
        observer = camera_parameters(distance, 1024, fixed_fov_y(8), matrix)
        with self.assertRaisesRegex(ValueError, 'float32'):
            self.make_frame({"observer_camera": observer})

    def test_export_pairs_labels_pose_and_commit(self):
        stage, frame = self.make_frame()
        pose = validate_frame(stage, frame["frame_id"])
        self.assertEqual(pose["schema_version"], "satellite-pose-4.0")
        self.assertEqual(pose["Location"]["SatQuat"], dict(W=1, X=0, Y=0, Z=0))
        self.assertEqual(pose["Location"]["CamQuat"], dict(W=.5, X=.5, Y=-.5, Z=.5))
        self.assertEqual(list(pose["Location"]["CamQuat"]), ["W", "X", "Y", "Z"])
        self.assertEqual(pose["CoordinateInfo"], "left‑handed coordinates; Origin: target center; X:right,Z:up")
        self.assertEqual(pose["CameraCoordInfo"], "left‑handed coordinates; Z:optical axis, X:UP, Y:left")
        self.assertNotIn("quaternion_xyzw", json.dumps(pose))
        self.assertEqual(pose["six_angles"]["alpha_valid"], [True, False, True])
        self.assertEqual(len((stage / "label.txt").read_text().split()), 5)
        committed = commit_frame(stage, self.root / "output", frame["frame_id"])
        self.assertEqual(len(committed), 4)
        self.assertTrue(all((self.root / "output" / item).is_file() for item in committed))

    def test_nontrivial_pose_scene_quaternion_identical(self):
        self.request = JobRequest.from_dict({"scene": scene_dict(sat_quat=dict(W=.7, X=.2, Y=-.3, Z=.4))})
        stage, frame = self.make_frame()
        pose = validate_frame(stage, frame["frame_id"])
        self.assertEqual(pose["Location"]["SatQuat"], pose["scene"]["sat_quat"])

    def test_noise_reproducible_and_off_is_identical(self):
        stage, frame = self.make_frame()
        noisy = (stage / "noisy.png").read_bytes()
        pose = json.loads((stage / "pose.json").read_text())
        metadata = {key: pose[key] for key in ("bbox_xyxy", "radius_m", "fov_y_rad", "model_sha256", "source_to_body", "renderer", "observer_camera")}
        prepare_frame(stage, frame, metadata, self.request.scene)
        self.assertEqual(noisy, (stage / "noisy.png").read_bytes())
        frame["noise"]["enabled"] = False
        prepare_frame(stage, frame, metadata, self.request.scene)
        self.assertFalse((stage / "noisy.png").exists())
        self.assertNotIn("noisy", validate_frame(stage, frame["frame_id"])["files"])

    def test_corrupt_png_and_mismatched_labels_are_rejected(self):
        stage, frame = self.make_frame()
        (stage / "label.txt").write_text("0 0.5 0.5 0.9 0.9")
        with self.assertRaises(ValueError):
            validate_frame(stage, frame["frame_id"])
        (stage / "clean.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        with self.assertRaises(ValueError):
            validate_frame(stage, frame["frame_id"])

    def test_camera_or_frame_snapshot_mismatch_is_rejected(self):
        stage, frame = self.make_frame()
        pose = json.loads((stage / "pose.json").read_text())
        pose["observer_camera"]["world_to_camera"][2][3] = 1
        (stage / "pose.json").write_text(json.dumps(pose))
        with self.assertRaises(ValueError):
            validate_frame(stage, frame["frame_id"])

    def test_nonfinite_json_metadata_is_rejected(self):
        stage, frame = self.make_frame()
        pose = json.loads((stage / "pose.json").read_text())
        pose["scene"]["lighting"]["energy"] = 1e309
        (stage / "pose.json").write_text(json.dumps(pose).replace("Infinity", "1e309"))
        with self.assertRaises(ValueError):
            validate_frame(stage, frame["frame_id"])

    def test_tampered_v2_camera_quaternion_projection_and_old_protocol_rejected(self):
        stage, frame = self.make_frame()
        original = json.loads((stage / "pose.json").read_text(encoding="utf-8"))
        for field in ("cam_quat", "projection", "old_protocol", "description"):
            pose = json.loads(json.dumps(original))
            if field == "cam_quat":
                pose["Location"]["CamQuat"] = dict(W=1, X=0, Y=0, Z=0)
            elif field == "projection":
                pose["observer_camera"]["projection_world_to_pixel"][0][0] += 1
            elif field == "old_protocol":
                pose["scene"]["quaternion_xyzw"] = [0, 0, 0, 1]
            else:
                pose["CoordinateInfo"] = "right handed"
            (stage / "pose.json").write_text(json.dumps(pose), encoding="utf-8")
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_frame(stage, frame["frame_id"])


if __name__ == "__main__":
    unittest.main()
