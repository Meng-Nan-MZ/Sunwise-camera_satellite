import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

import numpy as np
from PIL import Image

from satellite_studio.domain.camera import fixed_fov_y
from satellite_studio.domain.parameters import JobRequest
from satellite_studio.jobs.runner import JobRunner
from satellite_studio.jobs.store import JobStore
from satellite_studio.server.app import create_server
from test_domain import scene_dict


class FakeRenderer:
    def __init__(self):
        self.closed = False
        self.calls = 0

    def render(self, frame, output_directory):
        self.calls += 1
        Image.fromarray(np.full((1024, 1024), 128, dtype=np.uint8)).save(output_directory / "clean.png")
        return {"bbox_xyxy": [200, 200, 824, 824], "radius_m": 8, "fov_y_rad": fixed_fov_y(8),
                "model_sha256": "a" * 64, "source_to_body": np.eye(4).tolist(),
                "renderer": {"name": "fake", "version": "test"}}

    def close(self):
        self.closed = True


def wait_job(store, job_id, statuses=("completed", "failed", "canceled")):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        job = store.get(job_id)
        if job["status"] in statuses:
            return job
        time.sleep(.02)
    raise AssertionError(store.get(job_id))


class RunnerTests(unittest.TestCase):
    def test_lazy_renderer_and_completed_publication(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JobStore(Path(temporary))
            renderer = FakeRenderer()
            created = []
            runner = JobRunner(store, lambda: created.append(True) or renderer)
            runner.start()
            try:
                self.assertEqual(created, [])
                job = store.create(JobRequest.from_dict({"mode": "single", "scene": scene_dict()}))
                runner.wake()
                completed = wait_job(store, job["id"])
                self.assertEqual(completed["status"], "completed", completed)
                self.assertEqual(completed["completed_frames"], 1)
                self.assertIsNotNone(store.published_file(job["id"], "images_clean/000001.png"))
                self.assertIsNone(store.published_file(job["id"], "job.json"))
            finally:
                runner.close()
                store.close()
            self.assertTrue(renderer.closed)

    def test_corrupt_render_does_not_publish(self):
        class CorruptRenderer(FakeRenderer):
            def render(self, frame, output_directory):
                result = super().render(frame, output_directory)
                (output_directory / "clean.png").write_bytes(b"broken")
                return result
        with tempfile.TemporaryDirectory() as temporary:
            store = JobStore(Path(temporary))
            runner = JobRunner(store, CorruptRenderer)
            runner.start()
            try:
                job = store.create(JobRequest.from_dict({"mode": "single", "scene": scene_dict()}))
                runner.wake()
                failed = wait_job(store, job["id"])
                self.assertEqual(failed["status"], "failed")
                self.assertEqual(failed["completed_frames"], 0)
                self.assertIsNone(store.published_file(job["id"], "images_clean/000001.png"))
            finally:
                runner.close()
                store.close()

    def test_running_cancel_discards_current_uncommitted_frame(self):
        started, release = threading.Event(), threading.Event()
        class BlockingRenderer(FakeRenderer):
            def render(self, frame, output_directory):
                started.set()
                release.wait(5)
                return super().render(frame, output_directory)
        with tempfile.TemporaryDirectory() as temporary:
            store = JobStore(Path(temporary))
            runner = JobRunner(store, BlockingRenderer)
            runner.start()
            try:
                job = store.create(JobRequest.from_dict({"mode": "sequence", "count": 2, "scene": scene_dict()}))
                runner.wake()
                self.assertTrue(started.wait(5))
                store.cancel(job["id"])
                release.set()
                canceled = wait_job(store, job["id"])
                self.assertEqual(canceled["status"], "canceled")
                self.assertEqual(canceled["completed_frames"], 0)
            finally:
                release.set()
                runner.close()
                store.close()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        model = self.root / "assets/models/demo"
        model.mkdir(parents=True)
        (model / "preview.glb").write_bytes(b"preview")
        (model / "render.blend").write_bytes(b"private source")
        (model.parent / "index.json").write_text(json.dumps([{
            "id": "demo", "name": "Demo", "configuration": "test", "radius_m": 8,
            "preview_file": "assets/models/demo/preview.glb", "blend_file": "assets/models/demo/render.blend",
            "preview_url": "/assets/models/demo/preview.glb", "sha256": "a" * 64,
            "source_to_body": np.eye(4).tolist(), "installation_source": "simulation_default"}]))
        dist = self.root / "apps/ui/dist"
        dist.mkdir(parents=True)
        (dist / "index.html").write_text("<html>Satellite test</html>")
        (self.root / "secret.py").write_text("PRIVATE")
        self.server = create_server(self.root, self.root / "workspace", None, 0, renderer_factory=FakeRenderer)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(5)
        self.server.server_close()
        self.temp.cleanup()

    def call(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=10)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_health_models_and_static_allowlist(self):
        status, headers, body = self.call("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["schema_version"], "satellite-pose-3.0")
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertIn("connect-src 'self' blob:", headers["Content-Security-Policy"])
        status, _, body = self.call("GET", "/api/models")
        self.assertEqual(json.loads(body)[0]["id"], "demo")
        self.assertNotIn("blend_file", json.loads(body)[0])
        self.assertEqual(self.call("GET", "/")[0], 200)
        self.assertEqual(self.call("GET", "/assets/models/demo/preview.glb")[0], 200)
        for path in ("/secret.py", "/assets/models/demo/render.blend", "/assets/models/index.json",
                     "/assets/../secret.py", "/%2e%2e/secret.py", "/assets/models/demo/..%5c..%5csecret.py"):
            with self.subTest(path=path):
                self.assertIn(self.call("GET", path)[0], (400, 404))

    def test_request_size_finite_values_cross_origin_and_host(self):
        for attempt in range(10):
            with self.subTest(attempt=attempt):
                self.assertEqual(self.call("POST", "/api/jobs", "x" * 70000, {"Content-Type": "application/json"})[0], 413)
        self.assertEqual(self.call("POST", "/api/jobs", '{"scene":{"distance_m":NaN}}', {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.call("POST", "/api/jobs", "{}", {"Content-Type": "application/json", "Origin": "https://evil.invalid"})[0], 403)
        self.assertEqual(self.call("GET", "/api/health", headers={"Host": "evil.invalid"})[0], 403)

    def test_second_service_cannot_open_same_workspace(self):
        with self.assertRaises(RuntimeError):
            create_server(self.root, self.root / "workspace", None, 0)

    def test_submit_poll_cancel_and_download(self):
        payload = json.dumps({"mode": "single", "scene": scene_dict()})
        status, _, body = self.call("POST", "/api/jobs", payload, {"Content-Type": "application/json"})
        self.assertEqual(status, 202, body)
        job_id = json.loads(body)["id"]
        job = wait_job(self.server.app.store, job_id)
        self.assertEqual(job["status"], "completed", job)
        self.assertEqual(self.call("GET", f"/api/jobs/{job_id}")[0], 200)
        status, headers, body = self.call("GET", job["latest_image_url"])
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertTrue(body.startswith(b"\x89PNG"))
        self.assertEqual(self.call("GET", f"/data/{job_id}/job.json")[0], 404)


if __name__ == "__main__":
    unittest.main()
