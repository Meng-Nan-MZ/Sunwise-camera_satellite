import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from satellite_studio.domain.parameters import JobRequest
from satellite_studio.jobs.store import JobStore
from satellite_studio.jobs.runner import JobRunner
from test_service import FakeRenderer, wait_job
from test_domain import scene_dict

class NoiseVariantsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = JobStore(Path(self.temp.name) / '中文工作区')
        self.runner = JobRunner(self.store, FakeRenderer)
        self.runner.start()
    def tearDown(self):
        self.runner.close()
        self.store.close()
        self.temp.cleanup()
    def source(self, **extra):
        job = self.store.create(JobRequest.from_dict(dict(mode='single', scene=scene_dict(noise={'enabled': False}), **extra)))
        self.runner.wake()
        self.assertEqual(wait_job(self.store, job['id'])['status'], 'completed')
        return self.store.get(job['id'])
    def variant(self, source, sigma=.012, seed=42):
        return self.store.create_noise_variant(source['id'], {'noise': {'enabled': True, 'gaussian_sigma': sigma}, 'seed': seed})
    def test_noise_off_only_publishes_three_files(self):
        source = self.source()
        self.assertIsNone(self.store.published_file(source['id'], 'images_noisy/000001.png'))
        self.assertFalse((Path(source['output_directory']) / 'images_noisy').exists())
        self.assertIsNone(source['latest_images']['noisy'])
        self.assertTrue(source['can_generate_noise'])
    def test_renderer_free_variants_reproduce_and_preserve_source(self):
        source = self.source()
        root = Path(source['output_directory'])
        before = {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
        self.runner.close()
        def forbidden():
            raise AssertionError('renderer called')
        self.runner = JobRunner(self.store, forbidden)
        self.runner.start()
        variants = [self.variant(source), self.variant(source), self.variant(source, .2)]
        self.runner.wake()
        for job in variants:
            self.assertEqual(wait_job(self.store, job['id'])['status'], 'completed')
        outputs = [self.store.published_file(j['id'], 'images_noisy/000001.png').read_bytes() for j in variants]
        self.assertEqual(outputs[0], outputs[1])
        self.assertNotEqual(outputs[0], outputs[2])
        for job in variants:
            published = self.store.get(job['id'])
            self.assertEqual(published['source_job_id'], source['id'])
            self.assertEqual(published['latest_images']['clean'], source['latest_images']['clean'])
            meta = json.loads(self.store.published_file(job['id'], 'noise_meta/000001.json').read_text(encoding='utf-8'))
            self.assertEqual(meta['schema_version'], 'satellite-noise-1.0')
            self.assertEqual(meta['output_sha256'], hashlib.sha256(self.store.published_file(job['id'], 'images_noisy/000001.png').read_bytes()).hexdigest())
            self.assertEqual(set(p.name for p in Path(job['output_directory']).iterdir() if not p.name.startswith('.')), {'job.json','images_noisy','noise_meta'})
        after = {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.store.published_file(variants[0]['id'], 'images_noisy/000001.png').unlink()
        canonical = self.variant(self.store.get(variants[0]['id']))
        self.assertEqual(canonical['source_job_id'], source['id'])
        self.runner.wake()
        self.assertEqual(wait_job(self.store, canonical['id'])['status'], 'completed')
    def test_invalid_requests_and_sources(self):
        source = self.source()
        for body in ({}, {'noise':{},'seed':1}, {'noise':{'enabled':False},'seed':1}, {'noise':{'enabled':True},'seed':True}, {'noise':{'enabled':True},'seed':-1}, {'noise':{'enabled':True},'seed':1,'scene':{}}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.store.create_noise_variant(source['id'], body)
        self.store.published_file(source['id'], 'labels/000001.txt').unlink()
        job = self.variant(source)
        self.runner.wake()
        self.assertEqual(wait_job(self.store,job['id'])['status'],'failed')
    def test_corruption_fails_worker_without_publication(self):
        source = self.source()
        job = self.variant(source)
        self.store.published_file(source['id'], 'images_clean/000001.png').write_bytes(b'broken')
        self.runner.wake()
        self.assertEqual(wait_job(self.store, job['id'])['status'], 'failed')
        self.assertIsNone(self.store.published_file(job['id'], 'images_noisy/000001.png'))
    def test_cancel_and_unpublished_files(self):
        source = self.source()
        job = self.variant(source)
        self.assertEqual(self.store.cancel(job['id'])['status'], 'canceled')
        root = Path(job['output_directory']) / 'images_noisy'
        root.mkdir()
        (root/'000001.png').write_bytes(b'not published')
        self.assertIsNone(self.store.published_file(job['id'],'images_noisy/000001.png'))
    def test_all_render_modes_clean_only(self):
        from satellite_studio.domain.camera import camera_parameters, fixed_fov_y
        class DynamicRenderer(FakeRenderer):
            def render(self, frame, stage):
                result = super().render(frame,stage)
                result['observer_camera'] = camera_parameters(frame['distance_m'],1024,fixed_fov_y(8))
                return result
        self.runner.close()
        self.runner = JobRunner(self.store,DynamicRenderer)
        self.runner.start()
        for mode in ('coverage','sequence','custom_sequence'):
            body = {'mode':mode,'count':2,'scene':scene_dict(noise={'enabled':False})}
            if mode == 'custom_sequence':
                body['trajectory'] = {'start_quat':dict(W=1,X=0,Y=0,Z=0),'end_quat':dict(W=.7,X=.7,Y=0,Z=0)}
            job = self.store.create(JobRequest.from_dict(body))
            self.runner.wake()
            self.assertEqual(wait_job(self.store,job['id'])['status'],'completed')
            for frame in ('000001','000002'):
                pose = json.loads(self.store.published_file(job['id'],f'poses/{frame}.json').read_text(encoding='utf-8'))
                self.assertEqual(set(pose['files']),{'clean','label','pose'})
    def test_legacy_noise_off_pair_remains_readable(self):
        from satellite_studio.datasets.export import validate_frame_paths, write_json
        source = self.source()
        root = Path(source['output_directory'])
        pose_path = root/'poses/000001.json'
        pose = json.loads(pose_path.read_text(encoding='utf-8'))
        noisy = root/'images_noisy/000001.png'
        noisy.parent.mkdir()
        noisy.write_bytes((root/'images_clean/000001.png').read_bytes())
        pose['files']['noisy'] = 'images_noisy/000001.png'
        write_json(pose_path,pose)
        with self.store._lock,self.store._db:
            self.store._db.execute('UPDATE frames SET files=? WHERE job_id=?',(json.dumps(list(pose['files'].values())),source['id']))
        paths = {key:root/relative for key,relative in pose['files'].items()}
        self.assertFalse(validate_frame_paths(paths,'000001')['scene']['noise']['enabled'])
        self.assertIsNotNone(self.store.get(source['id'])['latest_images']['noisy'])
        job = self.variant(source)
        self.runner.wake()
        self.assertEqual(wait_job(self.store,job['id'])['status'],'completed')
    def test_running_cancel_discards_prepared_noise(self):
        import threading
        import satellite_studio.jobs.runner as runner_module
        source = self.source()
        started,release = threading.Event(),threading.Event()
        original = runner_module.prepare_noise_frame
        def blocked(*args):
            value = original(*args)
            started.set()
            release.wait(5)
            return value
        with patch.object(runner_module,'prepare_noise_frame',blocked):
            job = self.variant(source)
            self.runner.wake()
            try:
                self.assertTrue(started.wait(5))
                self.store.cancel(job['id'])
            finally:
                release.set()
            self.assertEqual(wait_job(self.store,job['id'])['status'],'canceled')
            self.assertEqual(self.store.get(job['id'])['completed_frames'],0)
            self.assertIsNone(self.store.published_file(job['id'],'images_noisy/000001.png'))
    def test_recovery_marks_claimed_variant_interrupted(self):
        source = self.source()
        self.runner.close()
        job = self.variant(source)
        self.assertEqual(self.store.claim_next()['id'],job['id'])
        workspace = self.store.workspace
        self.store.close()
        self.store = JobStore(workspace)
        self.runner = JobRunner(self.store,FakeRenderer)
        self.assertEqual(self.store.get(job['id'])['status'],'interrupted')
        from satellite_studio.domain.noise_request import NoiseVariantRequest
        self.assertIsInstance(self.store.request(job['id']),NoiseVariantRequest)
    def test_source_record_count_and_whitelist_required(self):
        source = self.source()
        with self.store._lock,self.store._db:
            self.store._db.execute('DELETE FROM frames WHERE job_id=?',(source['id'],))
        with self.assertRaises(ValueError):
            self.variant(source)
    def test_source_change_during_prepare_and_output_tamper_rejected(self):
        from satellite_studio.datasets.noise import prepare_noise_frame, validate_noise_frame
        source = self.source()
        self.runner.close()
        job = self.variant(source)
        request = self.store.request(job['id'])
        stage = Path(job['output_directory'])/'.staging/000001'
        stage.mkdir(parents=True)
        prepare_noise_frame(self.store,request,job['id'],'000001',stage)
        (stage/'noisy.png').write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            validate_noise_frame(self.store,request,job['id'],'000001',stage)
        prepare_noise_frame(self.store,request,job['id'],'000001',stage)
        label = self.store.published_file(source['id'],'labels/000001.txt')
        label.write_text('0 0.5 0.5 0.1 0.1',encoding='utf-8')
        with self.assertRaises(ValueError):
            validate_noise_frame(self.store,request,job['id'],'000001',stage)
    def test_noise_metadata_implementation_tampering_is_rejected(self):
        from satellite_studio.datasets.noise import prepare_noise_frame, validate_noise_frame
        from satellite_studio.datasets.export import write_json
        source = self.source()
        self.runner.close()
        job = self.variant(source)
        request = self.store.request(job['id'])
        stage = Path(job['output_directory'])/'.staging/000001'
        stage.mkdir(parents=True)
        meta = prepare_noise_frame(self.store,request,job['id'],'000001',stage)
        meta['implementation']['version'] = 'tampered'
        write_json(stage/'metadata.json',meta)
        with self.assertRaises(ValueError):
            validate_noise_frame(self.store,request,job['id'],'000001',stage)
    def test_invalid_persisted_request_fails_without_killing_queue(self):
        from satellite_studio.domain.noise_request import NoiseVariantRequest
        from satellite_studio.domain.parameters import Noise
        # Seed corrupt persisted data directly: normal creation now requires a
        # resolvable source root before any output is written.
        bad = {'id': 'f' * 32}
        snapshot = json.dumps(NoiseVariantRequest('invalid',1,Noise(),1,'0'*64).to_dict())
        with self.store._lock, self.store._db:
            self.store._db.execute(
                'INSERT INTO jobs(id,mode,status,total_frames,created_at,snapshot) VALUES (?,?,?,?,?,?)',
                (bad['id'], 'noise_variant', 'queued', 1, 'old', snapshot))
        good = self.store.create(JobRequest.from_dict({'scene':scene_dict(noise={'enabled':False})}))
        self.runner.wake()
        self.assertEqual(wait_job(self.store,bad['id'])['status'],'failed')
        self.assertEqual(wait_job(self.store,good['id'])['status'],'completed')
    def test_public_poll_does_not_scan_source_files(self):
        import satellite_studio.jobs.noise_sources as sources
        source = self.source()
        with patch.object(sources,'published_source_paths',side_effect=AssertionError('full scan during polling')):
            self.assertTrue(self.store.get(source['id'])['can_generate_noise'])
            self.assertEqual(len(self.store.list()),1)
    def test_original_noise_can_be_regenerated_when_old_noisy_missing(self):
        job = self.store.create(JobRequest.from_dict({'scene':scene_dict()}))
        self.runner.wake()
        source = wait_job(self.store,job['id'])
        self.assertEqual(source['status'],'completed')
        self.store.published_file(source['id'],'images_noisy/000001.png').unlink()
        variant = self.variant(source)
        self.runner.wake()
        self.assertEqual(wait_job(self.store,variant['id'])['status'],'completed')
    def test_delayed_source_lookup_allows_poll_cancel_and_skips_remaining_frames(self):
        import threading
        source = self.store.create(JobRequest.from_dict({'mode':'sequence','count':3,
            'scene':scene_dict(noise={'enabled':False}),
            'sequence':{'start_distance_m':20000,'end_distance_m':20000}}))
        self.runner.wake()
        self.assertEqual(wait_job(self.store,source['id'])['status'],'completed')
        self.runner.close()
        self.runner = JobRunner(self.store,FakeRenderer)
        job = self.variant(source)
        claimed = self.store.claim_next()
        lookup_started, release_lookup, controls_returned = (threading.Event() for _ in range(3))
        looked_up = []
        failures = []
        original = self.store.published_file
        def delayed(owner, relative):
            if threading.current_thread().name == 'noise-regression-worker' and owner == source['id']:
                looked_up.append(Path(relative).stem)
                if relative == 'images_clean/000001.png' and not lookup_started.is_set():
                    lookup_started.set()
                    if not release_lookup.wait(5):
                        raise AssertionError('test lookup release timed out')
            return original(owner,relative)
        def controls():
            try:
                self.assertEqual(self.store.get(job['id'])['status'],'running')
                self.assertEqual(len(self.store.list()),2)
                self.store.cancel(job['id'])
                controls_returned.set()
            except BaseException as exc:
                failures.append(exc)
        worker = threading.Thread(target=self.runner._execute,args=(claimed,),name='noise-regression-worker')
        control = threading.Thread(target=controls,name='noise-regression-controls')
        with patch.object(self.store,'published_file',delayed):
            worker.start()
            try:
                self.assertTrue(lookup_started.wait(5))
                control.start()
                self.assertTrue(controls_returned.wait(1),'get/list/cancel blocked by source filesystem lookup')
            finally:
                release_lookup.set()
                worker.join(5)
                if control.ident is not None:
                    control.join(5)
        self.assertFalse(worker.is_alive())
        self.assertFalse(control.is_alive())
        self.assertEqual(failures,[])
        self.assertEqual(self.store.get(job['id'])['status'],'canceled')
        self.assertEqual(self.store.get(job['id'])['completed_frames'],0)
        self.assertEqual(set(looked_up),{'000001'},'cancel should avoid source lookups for remaining frames')
    def test_output_schema_requires_recorded_noise_parameters_but_ingress_defaults_remain_optional(self):
        root = Path(__file__).resolve().parents[2]
        output = json.loads((root/'schemas/noise.schema.json').read_text(encoding='utf-8'))
        ingress = json.loads((root/'schemas/noise-variant.schema.json').read_text(encoding='utf-8'))
        self.assertEqual(set(output['properties']['noise']['required']),{'enabled','gaussian_sigma','poisson_peak'})
        self.assertEqual(ingress['properties']['noise']['required'],['enabled'])
