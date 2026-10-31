import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

from satellite_studio.datasets.export import prepare_frame, validate_frame, commit_frame
from satellite_studio.domain.camera import fixed_fov_y
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

    def make_frame(self):
        frame = next(sample_frames(self.request, "testjob"))
        stage = self.root / "stage"
        stage.mkdir()
        Image.fromarray(np.full((1024, 1024), 128, dtype=np.uint8)).save(stage / "clean.png")
        metadata = {"bbox_xyxy": [200, 220, 824, 804], "radius_m": 8, "fov_y_rad": fixed_fov_y(8),
                    "model_sha256": "a" * 64, "source_to_body": np.eye(4).tolist(),
                    "renderer": {"name": "test", "version": "1"}}
        prepare_frame(stage, frame, metadata, self.request.scene)
        return stage, frame

    def test_export_pairs_labels_pose_and_commit(self):
        stage, frame = self.make_frame()
        pose = validate_frame(stage, frame["frame_id"])
        self.assertEqual(pose["schema_version"], "satellite-pose-3.0")
        self.assertEqual(pose["six_angles"]["alpha_valid"], [True, True, False])
        self.assertEqual(len((stage / "label.txt").read_text().split()), 5)
        committed = commit_frame(stage, self.root / "output", frame["frame_id"])
        self.assertEqual(len(committed), 4)
        self.assertTrue(all((self.root / "output" / item).is_file() for item in committed))

    def test_noise_reproducible_and_off_is_identical(self):
        stage, frame = self.make_frame()
        noisy = (stage / "noisy.png").read_bytes()
        pose = json.loads((stage / "pose.json").read_text())
        metadata = {key: pose[key] for key in ("bbox_xyxy", "radius_m", "fov_y_rad", "model_sha256", "source_to_body", "renderer")}
        prepare_frame(stage, frame, metadata, self.request.scene)
        self.assertEqual(noisy, (stage / "noisy.png").read_bytes())
        frame["noise"]["enabled"] = False
        prepare_frame(stage, frame, metadata, self.request.scene)
        np.testing.assert_array_equal(np.asarray(Image.open(stage / "clean.png")), np.asarray(Image.open(stage / "noisy.png")))

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


if __name__ == "__main__":
    unittest.main()
