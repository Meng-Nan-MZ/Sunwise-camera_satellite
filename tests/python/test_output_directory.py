import hashlib
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import shutil
import threading
import unittest
from unittest.mock import patch

from satellite_studio import SCHEMA_VERSION, COORDINATE_CONVENTION_ID
from satellite_studio.domain.parameters import JobRequest
from satellite_studio.jobs.store import JobStore
from satellite_studio.jobs.runner import JobRunner
from satellite_studio.server.app import create_server
from test_domain import scene_dict
from test_service import FakeRenderer, wait_job


class OutputDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.workspace = self.root / 'workspace'
        self.external = self.root / '中文 数据集'
        self.external.mkdir()
        self.store = JobStore(self.workspace)
        self.request = JobRequest.from_dict({"renderer_backend": "threejs", 'mode': 'single', 'scene': scene_dict()})

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_default_persistence_and_job_root_immutable(self):
        default = str(self.workspace / 'jobs')
        self.assertEqual(self.store.output_settings(), dict(output_directory=default, default_output_directory=default))
        old = self.store.create(self.request)
        self.store.set_output_directory(str(self.external))
        new = self.store.create(self.request)
        self.assertEqual(self.store.output_directory(old['id']), self.workspace / 'jobs' / old['id'])
        self.assertEqual(self.store.output_directory(new['id']), self.external / new['id'])
        self.assertEqual(json.loads((self.external / new['id'] / 'job.json').read_text('utf-8')), self.request.to_dict())
        with self.assertRaises(sqlite3.IntegrityError):
            self.store._db.execute('UPDATE jobs SET output_root=? WHERE id=?', (default, new['id']))
        self.store.close()
        self.store = JobStore(self.workspace)
        self.assertEqual(self.store.output_settings()['output_directory'], str(self.external))
        self.assertEqual(self.store.get(old['id'])['output_directory'], str(self.workspace / 'jobs' / old['id']))

    def test_invalid_setting_rollback_and_offline_get_create_no_fallback(self):
        self.store.set_output_directory(str(self.external))
        file = self.root / 'file'
        file.write_text('x')
        for value in ('', 'relative', str(file), str(self.root / 'absent'), '\x00', 1, None):
            with self.subTest(value=value), self.assertRaises((ValueError, TypeError)):
                self.store.set_output_directory(value)
            self.assertEqual(self.store.output_settings()['output_directory'], str(self.external))
        with patch('satellite_studio.jobs.output_directory.probe_directory', side_effect=PermissionError('read only')):
            with self.assertRaises((ValueError, OSError)):
                self.store.set_output_directory(str(self.workspace / 'jobs'))
        self.external.rmdir()
        self.assertEqual(self.store.output_settings()['output_directory'], str(self.external))
        with self.assertRaises((ValueError, OSError)):
            self.store.create(self.request)
        self.assertFalse(self.external.exists())
        self.assertEqual(list((self.workspace / 'jobs').iterdir()), [])
        self.assertEqual(self.store.list(), [])

    def test_create_freezes_root_before_probe_without_holding_lock(self):
        self.store.set_output_directory(str(self.external))
        started, release = threading.Event(), threading.Event()
        result, errors = [], []
        from satellite_studio.jobs.output_directory import probe_directory
        def blocked(path):
            if threading.current_thread().name == 'creating':
                started.set()
                if not release.wait(5):
                    raise AssertionError('probe held lock')
            return probe_directory(path)
        def create():
            try:
                result.append(self.store.create(self.request))
            except Exception as exc:
                errors.append(exc)
        with patch('satellite_studio.jobs.output_directory.probe_directory', side_effect=blocked):
            thread = threading.Thread(target=create, name='creating')
            thread.start()
            try:
                self.assertTrue(started.wait(2))
                self.assertEqual(self.store.list(), [])
                self.store.set_output_directory(str(self.workspace / 'jobs'))
            finally:
                release.set()
                thread.join(6)
        self.assertFalse(errors, errors)
        self.assertEqual(Path(result[0]['output_directory']).parent, self.external)
        future = self.store.create(self.request)
        self.assertEqual(Path(future['output_directory']).parent, self.workspace / 'jobs')

    def test_setting_probe_does_not_block_get_list_cancel(self):
        job = self.store.create(self.request)
        started, release = threading.Event(), threading.Event()
        errors = []
        def blocked(path):
            started.set()
            if not release.wait(5):
                raise AssertionError('probe held lock')
        def save():
            try:
                self.store.set_output_directory(str(self.external))
            except Exception as exc:
                errors.append(exc)
        with patch('satellite_studio.jobs.output_directory.probe_directory', side_effect=blocked):
            thread = threading.Thread(target=save)
            thread.start()
            try:
                self.assertTrue(started.wait(2))
                self.assertEqual(self.store.get(job['id'])['id'], job['id'])
                self.assertEqual(len(self.store.list()), 1)
                self.assertEqual(self.store.cancel(job['id'])['status'], 'canceled')
            finally:
                release.set()
                thread.join(6)
        self.assertFalse(errors, errors)

    def test_actual_legacy_schema_migration_preserves_snapshot_digest(self):
        self.store.close()
        database = self.workspace / 'jobs.sqlite3'
        database.unlink()
        snapshot = json.dumps(self.request.to_dict(), ensure_ascii=False)
        with sqlite3.connect(database) as db:
            db.executescript('CREATE TABLE protocol(schema_version TEXT,coordinate_id TEXT); CREATE TABLE jobs(id TEXT PRIMARY KEY,mode TEXT NOT NULL,status TEXT NOT NULL,total_frames INTEGER NOT NULL,completed_frames INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,error TEXT,snapshot TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,latest_frame TEXT); CREATE TABLE frames(job_id TEXT NOT NULL REFERENCES jobs(id),frame_id TEXT NOT NULL,files TEXT NOT NULL,PRIMARY KEY(job_id,frame_id)); CREATE TRIGGER snapshot_immutable BEFORE UPDATE OF snapshot ON jobs BEGIN SELECT RAISE(ABORT, "job snapshot is immutable"); END;')
            db.execute('INSERT INTO protocol VALUES (?,?)', (SCHEMA_VERSION, COORDINATE_CONVENTION_ID))
            db.execute('INSERT INTO jobs(id,mode,status,total_frames,created_at,snapshot) VALUES (?,?,?,?,?,?)', ('a'*32, 'single', 'queued', 1, 'old', snapshot))
        db.close()
        self.store = JobStore(self.workspace)
        row = self.store._db.execute('SELECT snapshot,output_root FROM jobs').fetchone()
        self.assertIsNone(row['output_root'])
        self.assertEqual(hashlib.sha256(row['snapshot'].encode()).digest(), hashlib.sha256(snapshot.encode()).digest())
        self.assertEqual(self.store.output_directory('a'*32), self.workspace / 'jobs' / ('a'*32))
        with self.assertRaises(sqlite3.IntegrityError):
            self.store._db.execute('UPDATE jobs SET output_root=?', (str(self.external),))

    def test_external_render_noise_of_variant_stays_canonical_sibling(self):
        self.store.set_output_directory(str(self.external))
        source = self.store.create(self.request)
        runner = JobRunner(self.store, FakeRenderer)
        runner.start()
        try:
            runner.wake()
            self.assertEqual(wait_job(self.store, source['id'])['status'], 'completed')
            before = self.store.published_file(source['id'], 'images_clean/000001.png').read_bytes()
            self.store.set_output_directory(str(self.workspace / 'jobs'))
            selected = source
            for unused in range(2):
                variant = self.store.create_noise_variant(selected['id'], {'noise': {'enabled': True}, 'seed': 3})
                self.assertEqual(Path(variant['output_directory']).parent, self.external)
                self.assertEqual(variant['source_job_id'], source['id'])
                runner.wake()
                selected = wait_job(self.store, variant['id'])
                self.assertEqual(selected['status'], 'completed', selected)
            self.assertEqual(before, self.store.published_file(source['id'], 'images_clean/000001.png').read_bytes())
            self.assertIsNone(self.store.published_file(source['id'], '../job.json'))
            self.assertIsNone(self.store.published_file(source['id'], 'job.json'))
            self.assertFalse((self.workspace / 'jobs' / source['id']).exists())
        finally:
            runner.close()

    def test_lost_queued_root_fails_without_recreating_directory(self):
        self.store.set_output_directory(str(self.external))
        job = self.store.create(self.request)
        moved = self.root / 'temporarily unavailable'
        self.external.rename(moved)
        runner = JobRunner(self.store, FakeRenderer)
        runner.start()
        try:
            runner.wake()
            result = wait_job(self.store, job['id'])
            self.assertEqual(result['status'], 'failed', result)
            self.assertFalse(self.external.exists())
            self.assertFalse((self.workspace / 'jobs' / job['id']).exists())
            self.assertEqual(self.store.output_settings()['output_directory'], str(self.external))
        finally:
            runner.close()

    def test_capture_commit_root_lost_after_validation_is_not_recreated(self):
        from satellite_studio.datasets.export import commit_frame, validate_frame
        self.store.set_output_directory(str(self.external))
        job = self.store.create(self.request)
        runner = JobRunner(self.store, FakeRenderer)
        runner.start()
        try:
            runner.wake()
            self.assertEqual(wait_job(self.store, job['id'])['status'], 'completed')
        finally:
            runner.close()
        output = self.external / 'publication'
        stage = output / '.staging' / '000001'
        stage.mkdir(parents=True)
        original = Path(job['output_directory'])
        for folder, name in (('images_clean', 'clean.png'), ('images_noisy', 'noisy.png'), ('labels', 'label.txt'), ('poses', 'pose.json')):
            extension = Path(name).suffix
            shutil.copyfile(original / folder / ('000001' + extension), stage / name)
        def validated_then_offline(*args):
            result = validate_frame(*args)
            self.external.rename(self.root / 'offline')
            return result
        with patch('satellite_studio.datasets.export.validate_frame', side_effect=validated_then_offline):
            with self.assertRaises(OSError):
                commit_frame(stage, output, '000001')
        self.assertFalse(self.external.exists())

    def test_noise_commit_root_lost_after_validation_is_not_recreated(self):
        from satellite_studio.datasets.noise import prepare_noise_frame, commit_noise_frame, validate_noise_frame
        self.store.set_output_directory(str(self.external))
        source = self.store.create(self.request)
        runner = JobRunner(self.store, FakeRenderer)
        runner.start()
        try:
            runner.wake()
            self.assertEqual(wait_job(self.store, source['id'])['status'], 'completed')
        finally:
            runner.close()
        job = self.store.create_noise_variant(source['id'], {'noise': {'enabled': True}, 'seed': 4})
        request = self.store.request(job['id'])
        output = Path(job['output_directory'])
        stage = output / '.staging' / '000001'
        stage.mkdir(parents=True)
        prepare_noise_frame(self.store, request, job['id'], '000001', stage)
        def validated_then_offline(*args):
            result = validate_noise_frame(*args)
            self.external.rename(self.root / 'offline')
            return result
        with patch('satellite_studio.datasets.noise.validate_noise_frame', side_effect=validated_then_offline):
            with self.assertRaises(OSError):
                commit_noise_frame(self.store, request, job['id'], '000001', stage, output)
        self.assertFalse(self.external.exists())


class OutputDirectoryHTTPTests(unittest.TestCase):
    def test_settings_strict_body_origin_and_external_file_allowlist(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            external = root / '输出 有空格'
            external.mkdir()
            project = root / 'project'
            model = project / 'assets/models/demo'
            model.mkdir(parents=True)
            (model / 'preview.glb').write_bytes(b'preview')
            (model / 'render.blend').write_bytes(b'private source')
            (model.parent / 'index.json').write_text(json.dumps([{
                'id': 'demo', 'name': 'Demo', 'configuration': 'test', 'radius_m': 8,
                'preview_file': 'assets/models/demo/preview.glb', 'blend_file': 'assets/models/demo/render.blend',
                'preview_url': '/assets/models/demo/preview.glb', 'sha256': 'a' * 64,
                'preview_sha256': hashlib.sha256(b'preview').hexdigest(),
                'source_to_body': [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
                'installation_source': 'simulation_default'}]))
            server = create_server(project, root / 'workspace', 0, renderer_factory=FakeRenderer)
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            def call(method, path, body=None, extra=None):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
                headers = {'Content-Type': 'application/json', **(extra or {})}
                connection.request(method, path, None if body is None else json.dumps(body), headers)
                response = connection.getresponse()
                result = response.status, response.read()
                connection.close()
                return result
            route = '/api/settings/output-directory'
            try:
                status, raw = call('GET', route)
                self.assertEqual(status, 200)
                self.assertEqual(set(json.loads(raw)), {'output_directory', 'default_output_directory'})
                for body in ({}, {'output_directory': str(external), 'extra': 1}, {'output_directory': None}, {'output_directory': ''}, {'output_directory': 'relative'}):
                    self.assertEqual(call('POST', route, body)[0], 400, body)
                for method in ('GET', 'POST'):
                    self.assertEqual(call(method, route, {'output_directory': str(external)}, {'Origin': 'https://evil.example'})[0], 403)
                self.assertEqual(call('POST', route, {'output_directory': str(external)})[0], 200)
                status, raw = call('POST', '/api/jobs', {'mode': 'single', 'scene': scene_dict()})
                self.assertEqual(status, 202, raw)
                job = json.loads(raw)
                self.assertEqual(wait_job(server.app.store, job['id'])['status'], 'completed')
                image_route = f"/data/{job['id']}/images_clean/000001.png"
                status, png = call('GET', image_route)
                self.assertEqual(status, 200)
                self.assertTrue(png.startswith(b'\x89PNG'))
                self.assertEqual(call('GET', f"/data/{job['id']}/poses/../job.json")[0], 400)
                self.assertEqual(call('GET', f"/data/{job['id']}/job.json")[0], 404)
                self.assertEqual(call('GET', f"/data/{job['id']}/images_clean/unpublished.png")[0], 404)
                with patch('satellite_studio.jobs.output_directory.probe_directory', side_effect=PermissionError('offline')):
                    self.assertEqual(call('POST', route, {'output_directory': str(external)})[0], 400)
                    self.assertEqual(call('POST', '/api/jobs', {'mode': 'single', 'scene': scene_dict()})[0], 400)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(10)
