import base64
import copy
import io
import json
import math
from pathlib import Path
import tempfile
import threading
import time
import unittest
import numpy as np
from PIL import Image
from satellite_studio.domain.parameters import JobRequest
from satellite_studio.domain.sampling import sample_frames
from test_domain import scene_dict


def png(mode='RGBA', size=2048, color=(128,128,128,255)):
    stream = io.BytesIO()
    Image.new(mode, (size,size), color).save(stream, format='PNG')
    return base64.b64encode(stream.getvalue()).decode('ascii')


class BackendTests(unittest.TestCase):
    def test_backend_default_roundtrip_and_invalid(self):
        request = JobRequest.from_dict({'scene': scene_dict()})
        self.assertEqual(getattr(request, 'renderer_backend', None), 'blender')
        self.assertEqual(request.to_dict()['renderer_backend'], 'blender')
        self.assertEqual(JobRequest.from_dict({'scene':scene_dict(), 'renderer_backend':'threejs'}).renderer_backend, 'threejs')
        with self.assertRaises(ValueError):
            JobRequest.from_dict({'scene':scene_dict(), 'renderer_backend':'other'})


class BridgeTests(unittest.TestCase):
    def setUp(self):
        from satellite_studio.rendering.browser_bridge import BrowserBridge
        self.now = 0.
        self.bridge = BrowserBridge(clock=lambda: self.now)
        self.token = self.bridge.register()['worker_token']
        self.model = {'id':'demo','radius_m':8,'preview_sha256':'a'*64,'source_to_body':np.eye(4).tolist(), 'preview_url':'/assets/models/demo/preview.glb'}
        self.frame = next(sample_frames(JobRequest.from_dict({'scene':scene_dict()}), 'job'))
        self.result = None
        self.failure = None
        self.thread = None
    def tearDown(self):
        self.bridge.close()
        if self.thread: self.thread.join(2)
    def start_task(self):
        def run():
            try: self.result = self.bridge.render(self.frame, self.model, 'job')
            except Exception as exc: self.failure = exc
        self.thread = threading.Thread(target=run)
        self.thread.start()
        task = None
        for _ in range(10):
            task = self.bridge.poll(self.token)['task']
            if task: break
        self.assertIsNotNone(task)
        return task
    def body(self, task):
        from satellite_studio.rendering.browser_renderer import PROFILE
        d = self.frame['distance_m']; r=8
        near=max(.001,d-2*r); far=d+2*r+1
        from satellite_studio.domain.camera import fixed_fov_y
        f=1/math.tan(fixed_fov_y(r)/2)
        camera=np.eye(4); camera[2,3]=d
        return dict(worker_token=self.token, task_id=task['task_id'], attempt_token=task['attempt_token'], png_base64=png(), metadata={
            'bbox_xyxy':[200,200,824,824], 'camera_world':camera.tolist(),
            'projection_matrix':[[f,0,0,0],[0,f,0,0],[0,0,-(far+near)/(far-near),-2*far*near/(far-near)],[0,0,-1,0]],
            'asset_sha256':'a'*64,'three_revision':'180','profile_id':'threejs-detail-v1','settings':dict(PROFILE, actual_antialias=True),'render_ms':1.2})
    def test_success_duplicate_and_private_paths(self):
        task=self.start_task()
        self.assertNotIn('_job_id',task['frame'])
        self.assertNotIn('output_directory',json.dumps(task))
        body=self.body(task)
        self.bridge.result(body)
        self.thread.join(2)
        self.assertIsNone(self.failure)
        self.assertIsNotNone(self.result)
        with self.assertRaises(Exception) as caught: self.bridge.result(body)
        self.assertEqual(caught.exception.status,409)
    def test_tokens_single_worker_and_cancel_stale(self):
        with self.assertRaises(Exception) as caught: self.bridge.register()
        self.assertEqual(caught.exception.status,409)
        task=self.start_task(); body=self.body(task)
        with self.assertRaises(Exception) as caught: self.bridge.poll('foreign')
        self.assertEqual(caught.exception.status,403)
        self.bridge.cancel('job'); self.thread.join(2)
        self.assertFalse(self.thread.is_alive())
        with self.assertRaises(Exception) as caught: self.bridge.result(body)
        self.assertEqual(caught.exception.status,409)
    def test_invalid_results_remain_unpublished(self):
        task=self.start_task(); original=self.body(task)
        bad=[]
        for field,value in [('asset_sha256','b'*64),('profile_id','bad'),('three_revision','bad'),('render_ms',float('inf')),('bbox_xyxy',[0,0,2000,20]),('camera_world',np.eye(4).tolist()),('projection_matrix',np.eye(4).tolist())]:
            body=copy.deepcopy(original); body['metadata'][field]=value; bad.append(body)
        body=copy.deepcopy(original); body['metadata']['settings']['exposure']=9; bad.append(body)
        for value in ['@@',png(size=1024),png(color=(1,2,3,255)),png(color=(1,1,1,20)),base64.b64encode(b'not png').decode()]:
            body=copy.deepcopy(original); body['png_base64']=value; bad.append(body)
        for body in bad:
            with self.subTest(metadata=body['metadata']):
                with self.assertRaises(ValueError): self.bridge.result(body)
        self.assertIsNone(self.result)
        self.bridge.result(original); self.thread.join(2)
        self.assertIsNone(self.failure)
    def test_lease_frame_timeout_release_and_close_wake(self):
        task=self.start_task()
        self.now=31
        self.assertFalse(self.bridge.available)
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())
        self.token=self.bridge.register()['worker_token']
        self.failure=None; self.start_task()
        self.now=122
        with self.assertRaises(Exception): self.bridge.heartbeat(self.token)
        self.thread.join(2); self.assertFalse(self.thread.is_alive())
    def test_profile_matches_fixture(self):
        from satellite_studio.rendering.browser_renderer import PROFILE
        expected=json.loads((Path(__file__).parents[1]/'fixtures/web-capture-profile.json').read_text(encoding='utf-8'))
        self.assertEqual(PROFILE,expected)

class BrowserServiceTests(unittest.TestCase):
    def setUp(self):
        from test_service import ServiceTests
        self.service=ServiceTests()
        self.service.setUp()
        self.server=self.service.server
        import hashlib
        catalog=self.server.app.catalog
        catalog.get('demo')['preview_sha256']=hashlib.sha256(b'preview').hexdigest()
        (self.service.root/'assets/models/demo/render.blend').unlink()
        from satellite_studio.jobs.runner import JobRunner
        from satellite_studio.rendering.browser_renderer import BrowserRenderer
        self.server.app.runner.close()
        self.server.app.runner = JobRunner(self.server.app.store, lambda: BrowserRenderer(self.server.app.bridge, catalog))
        self.server.app.runner.start()
    def tearDown(self): self.service.tearDown()
    def call(self,path,value=None):
        status,_,raw=self.service.call('POST',path,json.dumps(value or {}),{'Content-Type':'application/json'})
        return status,json.loads(raw)
    def test_retired_model_is_listed_for_history_but_rejected_for_new_capture(self):
        self.server.app.catalog.get('demo')['selectable'] = False
        status, _, raw = self.service.call('GET', '/api/models')
        self.assertEqual(status, 200)
        self.assertIs(json.loads(raw)[0]['selectable'], False)
        status, body = self.call('/api/jobs', {'scene': scene_dict(), 'renderer_backend': 'threejs'})
        self.assertEqual(status, 400, body)
        self.assertIn('已从采集模型库移除', body['error'])
        self.assertEqual(self.server.app.store.list(), [])
        # Workers may still read the exact asset frozen in an existing queue.
        self.assertEqual(self.server.app.catalog.require_web_asset('demo')['id'], 'demo')
    def test_web_job_without_blend_publishes_and_noise_inherits_backend(self):
        status,registered=self.call('/api/render-worker/register')
        self.assertEqual(status,200)
        token=registered['worker_token']
        status,job=self.call('/api/jobs',{'scene':scene_dict(),'renderer_backend':'threejs'})
        self.assertEqual(status,202,job)
        # A later catalog retirement must not reinterpret/cancel a queued job or its noise variant.
        self.server.app.catalog.get('demo')['selectable'] = False
        task=None
        for _ in range(10):
            _,reply=self.call('/api/render-worker/poll',{'worker_token':token})
            task=reply['task']
            if task:break
        self.assertIsNotNone(task)
        bridge_test=BridgeTests();bridge_test.frame=task['frame'];bridge_test.token=token
        body=bridge_test.body(task);body['metadata']['asset_sha256']=task['model']['preview_sha256']
        for field,value in [('asset_sha256','b'*64),('profile_id','wrong'),('projection_matrix',np.eye(4).tolist())]:
            invalid=copy.deepcopy(body);invalid['metadata'][field]=value
            self.assertEqual(self.call('/api/render-worker/result',invalid)[0],400)
        invalid=copy.deepcopy(body);invalid['png_base64']='not base64'
        self.assertEqual(self.call('/api/render-worker/result',invalid)[0],400)
        self.assertEqual(self.call('/api/render-worker/result',body)[0],200)
        from test_service import wait_job
        completed=wait_job(self.server.app.store,job['id'])
        self.assertEqual(completed['status'],'completed',completed)
        self.assertEqual(completed['renderer_backend'],'threejs')
        path=self.server.app.store.published_file(job['id'],'poses/000001.json')
        pose=json.loads(path.read_text(encoding='utf-8'))
        self.assertNotIn('_job_id',pose['scene'])
        self.assertEqual(pose['model_sha256'],task['model']['preview_sha256'])
        with Image.open(self.server.app.store.published_file(job['id'],'images_clean/000001.png')) as image:
            self.assertEqual(image.size,(1024,1024));self.assertEqual(image.mode,'L')
        status,variant=self.call('/api/jobs/'+job['id']+'/noise-variants',{'noise':{'enabled':True},'seed':123})
        self.assertEqual(status,202,variant)
        variant=wait_job(self.server.app.store,variant['id'])
        self.assertEqual(variant['renderer_backend'],'threejs')
        self.assertEqual(variant['status'],'completed',variant)
    def test_stop_releases_web_wait_before_http_drain(self):
        _,registered=self.call('/api/render-worker/register');token=registered['worker_token']
        status,job=self.call('/api/jobs',{'scene':scene_dict(),'renderer_backend':'threejs'})
        self.assertEqual(status,202)
        task=None
        for _ in range(10):
            _,reply=self.call('/api/render-worker/poll',{'worker_token':token});task=reply['task']
            if task:break
        self.assertIsNotNone(task)
        self.server.app.stop()
        from test_service import wait_job
        stopped=wait_job(self.server.app.store,job['id'],('interrupted',))
        self.assertEqual(stopped['completed_frames'],0)
        self.assertEqual(self.call('/api/render-worker/result',dict(worker_token=token,task_id=task['task_id'],attempt_token=task['attempt_token'],error='late'))[0],409)
        self.assertEqual(self.call('/api/render-worker/poll',{'worker_token':token})[0],409)

    def test_worker_security_health_limits_cancel_and_stale(self):
        _,registered=self.call('/api/render-worker/register'); self.assertIn('worker_token',registered)
        token=registered['worker_token']
        self.assertEqual(self.call('/api/render-worker/register')[0],409)
        self.assertEqual(self.call('/api/render-worker/heartbeat',{'worker_token':'bad'})[0],403)
        status,_,raw=self.service.call('GET','/api/health')
        health=json.loads(raw)
        self.assertTrue(health['renderers']['threejs']['available'])
        self.assertNotIn(token,raw.decode())
        for path in ['/api/render-worker/heartbeat','/api/render-worker/result']:
            length=70000 if path.endswith('heartbeat') else 12*1024*1024+1
            status,_,_=self.service.call('POST',path,b' '*length,{'Content-Type':'application/json'})
            self.assertEqual(status,413)
        status,job=self.call('/api/jobs',{'scene':scene_dict(),'renderer_backend':'threejs'})
        self.assertEqual(status,202,job)
        task=None
        for _ in range(10):
            _,reply=self.call('/api/render-worker/poll',{'worker_token':token});task=reply['task']
            if task:break
        self.assertIsNotNone(task)
        self.assertEqual(self.call('/api/jobs/'+job['id']+'/cancel')[0],200)
        self.assertEqual(self.call('/api/render-worker/result',dict(worker_token=token,task_id=task['task_id'],attempt_token=task['attempt_token'],error='late'))[0],409)
        from test_service import wait_job
        canceled=wait_job(self.server.app.store,job['id'])
        self.assertEqual(canceled['status'],'canceled');self.assertEqual(canceled['completed_frames'],0)
        self.assertEqual(self.call('/api/render-worker/release',{'worker_token':token})[0],200)

class BridgeLifecycleTests(BridgeTests):
    def test_close_and_release_wake_renderer(self):
        for action in ('release','close'):
            with self.subTest(action=action):
                if action=='close': self.token=self.bridge.register()['worker_token']
                self.start_task()
                if action=='release':self.bridge.release(self.token)
                else:self.bridge.close()
                self.thread.join(2)
                self.assertFalse(self.thread.is_alive());self.assertIsNotNone(self.failure)
    def test_frame_deadline_with_live_heartbeat(self):
        self.start_task()
        for now in (20,40,60,80):
            self.now=now;self.bridge.heartbeat(self.token)
        self.now=91
        self.bridge.heartbeat(self.token)
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive());self.assertIn('90',str(self.failure))
        self.assertTrue(self.bridge.available)
    def test_strict_png_end_and_decoded_limits(self):
        task=self.start_task();body=self.body(task)
        raw=base64.b64decode(body['png_base64'])
        for bad in (raw[:-12],b'\x89PNG\r\n\x1a\n'+b'x'*(8*1024*1024)):
            body['png_base64']=base64.b64encode(bad).decode()
            with self.assertRaises(ValueError):self.bridge.result(body)
    def test_metadata_limit_and_poll_bound(self):
        started=time.monotonic();self.assertIsNone(self.bridge.poll(self.token)['task'])
        self.assertLess(time.monotonic()-started,.45)
        task=self.start_task();body=self.body(task)
        body['metadata']['extra']='a'*65536
        with self.assertRaises(ValueError):self.bridge.result(body)
    def test_changed_attempt_token_and_task_id_are_stale(self):
        task=self.start_task();body=self.body(task)
        for field in ('task_id','attempt_token'):
            changed=dict(body);changed[field]='foreign'
            with self.assertRaises(Exception) as caught:self.bridge.result(changed)
            self.assertEqual(caught.exception.status,409)


class BackendResolverTests(unittest.TestCase):
    def test_three_factory_never_calls_legacy_and_caches_and_closes(self):
        from satellite_studio.jobs.runner import JobRunner
        from satellite_studio.jobs.store import JobStore
        from test_service import FakeRenderer
        with tempfile.TemporaryDirectory() as directory:
            store=JobStore(Path(directory));created=[];renderer=FakeRenderer()
            runner=JobRunner(store,lambda:created.append('threejs') or renderer)
            try:
                self.assertIs(runner._get_renderer('threejs'),renderer)
                self.assertIs(runner._get_renderer('threejs'),renderer)
                self.assertEqual(created,['threejs'])
            finally:runner.close();store.close()
            self.assertTrue(renderer.closed)
    def test_hash_mismatch_rejected_without_blend(self):
        from satellite_studio.server.models import ModelCatalog
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);assets=root/'assets/models';assets.mkdir(parents=True)
            (assets/'preview.glb').write_bytes(b'changed')
            (assets/'index.json').write_text(json.dumps([dict(id='demo',radius_m=8,source_to_body=np.eye(4).tolist(),preview_sha256=hashlib.sha256(b'expected').hexdigest(),preview_file='assets/models/preview.glb')]),encoding='utf-8')
            with self.assertRaises(ValueError):ModelCatalog(root).require_web_asset('demo')
    def test_cancel_before_enqueue_uses_store_state(self):
        from satellite_studio.rendering.browser_bridge import BrowserBridge
        bridge=BrowserBridge(is_canceled=lambda job_id:True)
        bridge.register()
        try:
            with self.assertRaises(RuntimeError):bridge.render({}, {}, 'already-canceled')
        finally:bridge.close()

class PublicationBoundaryTests(unittest.TestCase):
    def test_canceled_job_cannot_publish_staged_frame(self):
        from satellite_studio.jobs.store import JobStore
        with tempfile.TemporaryDirectory() as directory:
            store=JobStore(Path(directory))
            try:
                job=store.create(JobRequest.from_dict({'scene':scene_dict()}));store.claim_next()
                store.cancel(job['id'])
                self.assertTrue(hasattr(store,'publish_frame'),'atomic cancel/publication boundary missing')
                self.assertFalse(store.publish_frame(job['id'],Path(directory)/'stage','000001'))
                self.assertEqual(store.get(job['id'])['completed_frames'],0)
            finally:store.close()

class ConcurrentBridgeTests(unittest.TestCase):
    setUp=BridgeTests.setUp
    tearDown=BridgeTests.tearDown
    start_task=BridgeTests.start_task
    body=BridgeTests.body
    def test_cancel_during_decode_keeps_heartbeat_independent_and_rejects_late_result(self):
        from unittest.mock import patch
        from satellite_studio.rendering.browser_renderer import validate_result
        entered=threading.Event();resume=threading.Event();failure=[]
        task=self.start_task();body=self.body(task)
        def blocked(*args):
            result=validate_result(*args)
            entered.set();resume.wait(3)
            return result
        def post():
            try:self.bridge.result(body)
            except Exception as exc:failure.append(exc)
        with patch('satellite_studio.rendering.browser_bridge.validate_result',blocked):
            submit=threading.Thread(target=post);submit.start()
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(self.bridge.heartbeat(self.token),{'ok':True})
                self.bridge.cancel('job');self.thread.join(1)
                self.assertFalse(self.thread.is_alive())
            finally:resume.set();submit.join(3)
        self.assertEqual(len(failure),1);self.assertEqual(failure[0].status,409)
        self.assertIsNone(self.result)
    def test_expired_attempt_not_revived_by_new_registration(self):
        task=self.start_task();body=self.body(task)
        self.now=31
        self.token=self.bridge.register()['worker_token'];body['worker_token']=self.token
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())
        with self.assertRaises(Exception) as caught:self.bridge.result(body)
        self.assertEqual(caught.exception.status,409)
        self.assertTrue(self.bridge.available)


class LegacySnapshotTests(unittest.TestCase):
    def test_legacy_missing_backend_can_generate_noise_without_renderer(self):
        from satellite_studio.jobs.store import JobStore
        from satellite_studio.jobs.runner import JobRunner
        from test_service import FakeRenderer, wait_job
        class LegacyRequest(JobRequest):
            def to_dict(self):
                snapshot=super().to_dict();snapshot.pop('renderer_backend');return snapshot
        with tempfile.TemporaryDirectory() as directory:
            store=JobStore(Path(directory));runner=JobRunner(store,FakeRenderer)
            try:
                job=store.create(LegacyRequest.from_dict({'scene':scene_dict()}))
                # Materialize a completed pre-upgrade fixture without executing a
                # legacy capture through the V2.4 runner.
                from satellite_studio.datasets.export import prepare_frame
                store.claim_next()
                stage=Path(job['output_directory'])/'.fixture';stage.mkdir()
                frame=next(sample_frames(store.request(job['id']),job['id']))
                metadata=FakeRenderer().render(frame,stage)
                prepare_frame(stage,frame,metadata,store.request(job['id']).scene)
                store.publish_frame(job['id'],stage,frame['frame_id'])
                store.finish(job['id'],'completed')
                before=(Path(job['output_directory'])/'job.json').read_bytes()
                self.assertEqual(wait_job(store,job['id'])['status'],'completed')
                self.assertEqual(store.request(job['id']).renderer_backend,'blender')
                self.assertEqual(store.get(job['id'])['renderer_backend'],'blender')
                runner.close()
                def forbidden():raise AssertionError('noise invoked renderer')
                runner=JobRunner(store,forbidden);runner.start()
                variant=store.create_noise_variant(job['id'],{'noise':{'enabled':True},'seed':10});runner.wake()
                completed=wait_job(store,variant['id'])
                self.assertEqual(completed['status'],'completed',completed)
                self.assertEqual(completed['renderer_backend'],'blender')
                self.assertEqual(completed['model_id'],'demo')
                self.assertEqual((Path(job['output_directory'])/'job.json').read_bytes(),before)
                with self.assertRaises(ValueError):
                    store.create_noise_variant(job['id'],{'noise':{'enabled':True},'seed':10,'renderer_backend':'threejs'})
            finally:runner.close();store.close()
