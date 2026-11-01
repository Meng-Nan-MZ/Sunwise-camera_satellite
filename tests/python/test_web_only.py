"""V2.4 new submissions and historical snapshots have separate contracts."""
import json
from pathlib import Path
import tempfile
import unittest

from satellite_studio.domain.parameters import JobRequest
from satellite_studio.jobs.runner import JobRunner
from satellite_studio.jobs.store import JobStore
from test_domain import scene_dict
import test_service
from test_service import FakeRenderer, wait_job


class WebOnlyHTTPTests(unittest.TestCase):
    setUp = test_service.ServiceTests.setUp
    tearDown = test_service.ServiceTests.tearDown
    call = test_service.ServiceTests.call

    def test_missing_backend_is_new_web_capture(self):
        status, _, raw = self.call('POST', '/api/jobs', json.dumps({'scene': scene_dict()}), {'Content-Type': 'application/json'})
        self.assertEqual(status, 202, raw)
        job = json.loads(raw)
        self.assertEqual(job['renderer_backend'], 'threejs')
        self.assertEqual(job['model_id'], 'demo')
        self.assertEqual(self.server.app.store.request(job['id']).renderer_backend, 'threejs')

    def test_explicit_blender_rejected_before_job_creation(self):
        status, _, raw = self.call('POST', '/api/jobs', json.dumps({'scene': scene_dict(), 'renderer_backend': 'blender'}), {'Content-Type': 'application/json'})
        self.assertEqual(status, 400, raw)
        self.assertIn('Three.js', json.loads(raw)['error'])
        self.assertEqual(self.server.app.store.list(), [])

    def test_health_reports_only_live_web_bridge(self):
        def health():
            return json.loads(self.call('GET', '/api/health')[2])
        before = health()
        self.assertEqual(set(before['renderers']), {'threejs'})
        self.assertFalse(before['renderer_available'])
        token = self.server.app.bridge.register()['worker_token']
        self.assertTrue(health()['renderer_available'])
        self.server.app.bridge.release(token)
        self.assertFalse(health()['renderer_available'])


class LegacyQueueTests(unittest.TestCase):
    def test_legacy_fails_without_factory_then_web_queue_continues(self):
        with tempfile.TemporaryDirectory() as directory:
            store = JobStore(Path(directory))
            renderer = FakeRenderer()
            runner = JobRunner(store, lambda: renderer)
            legacy = store.create(JobRequest.from_dict({'scene': scene_dict()}))
            web = store.create(JobRequest.from_dict({'scene': scene_dict(), 'renderer_backend': 'threejs'}))
            original = (Path(legacy['output_directory']) / 'job.json').read_bytes()
            runner.start()
            try:
                failed = wait_job(store, legacy['id'])
                self.assertEqual(failed['status'], 'failed', failed)
                self.assertIn('Blender', failed['error'])
                completed = wait_job(store, web['id'])
                self.assertEqual(completed['status'], 'completed', completed)
                self.assertEqual(renderer.calls, 1)
                self.assertEqual(store.request(legacy['id']).renderer_backend, 'blender')
                self.assertEqual((Path(legacy['output_directory']) / 'job.json').read_bytes(), original)
            finally:
                runner.close()
                store.close()
