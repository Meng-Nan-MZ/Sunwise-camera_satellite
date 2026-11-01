import copy
from dataclasses import FrozenInstanceError
import itertools
import json
import math
from pathlib import Path
import tempfile
import threading
import unittest
import numpy as np
from satellite_studio.domain.parameters import JobRequest
from satellite_studio.domain.rotation import quaternion_array, quaternion_object
from satellite_studio.domain.sampling import sample_frames
from satellite_studio.jobs.store import JobStore
from satellite_studio.jobs.runner import JobRunner
from satellite_studio.datasets.export import validate_frame
from test_domain import scene_dict
from test_service import FakeRenderer, wait_job
import test_storage


def custom(**kwargs):
    result = dict(renderer_backend='threejs', mode='custom_sequence', count=3, scene=scene_dict(), trajectory=dict(
        start_quat=dict(W=1, X=0, Y=0, Z=0), end_quat=dict(W=2**-.5, X=2**-.5, Y=0, Z=0)))
    result.update(kwargs)
    return result


class CustomTrajectoryTests(unittest.TestCase):
    def test_shared_vectors_and_sign_equivalence(self):
        vectors = json.loads((Path(__file__).parents[1] / 'fixtures/custom-trajectory-vectors.json').read_text())
        for case in vectors['cases']:
            for sign in (1, -1):
                with self.subTest(case=case['name'], sign=sign):
                    request = JobRequest.from_dict(custom(trajectory=dict(start_quat=quaternion_object(case['start']),
                        end_quat=quaternion_object(np.array(case['end']) * sign))))
                    frames = list(sample_frames(request, 'vectors'))
                    np.testing.assert_allclose(quaternion_array(frames[1]['sat_quat']), case['mid'], atol=1e-12)
                    dots = [np.dot(quaternion_array(a['sat_quat']), quaternion_array(b['sat_quat'])) for a,b in zip(frames, frames[1:])]
                    self.assertTrue(all(d >= 0 for d in dots))

    def test_independent_axis_angles_timestamps_and_fixed_scene(self):
        request = JobRequest.from_dict(custom(trajectory=dict(start_quat=dict(W=1,X=0,Y=0,Z=0),
            end_quat=dict(W=0,X=-1,Y=0,Z=0),time_step_s=.25), count=5))
        frames = list(sample_frames(request, 'axis'))
        for i, frame in enumerate(frames):
            q = quaternion_array(frame['sat_quat'])
            self.assertAlmostEqual(math.degrees(2*math.atan2(q[0], q[3])), i*45)
            np.testing.assert_allclose(q[1:3], [0,0], atol=1e-15)
            self.assertEqual(frame['timestamp_s'], i*.25)
            self.assertEqual(frame['trajectory']['t'], i/4)
            self.assertEqual(frame['frame_index'], i)
            self.assertEqual(frame['sequence_id'], 'axis-sequence')
            for key in ('distance_m','lighting','noise','payload_body_from_camera','model_id','resolution'):
                self.assertEqual(frame[key], request.scene.to_dict()[key])
        frames[0]['trajectory']['start_quat']['W'] = 0
        self.assertEqual(frames[1]['trajectory']['start_quat']['W'], 1)

    def test_short_arc_angular_distance_independent_of_seed_and_start_sign(self):
        start = dict(W=math.cos(math.radians(85)), X=0,Y=0,Z=math.sin(math.radians(85)))
        end = dict(W=math.cos(math.radians(85)), X=0,Y=0,Z=-math.sin(math.radians(85)))
        for sign in (1,-1):
            value = custom(count=5, trajectory=dict(start_quat={k:sign*v for k,v in start.items()},end_quat=end))
            frames = list(sample_frames(JobRequest.from_dict(value), 'arc'))
            for i,frame in enumerate(frames):
                q = quaternion_array(frame['sat_quat'])
                distance = math.degrees(2*math.acos(min(1,abs(np.dot(q,quaternion_array(start))))))
                self.assertAlmostEqual(distance, i*5, places=10)
                self.assertAlmostEqual(q[0], 0); self.assertAlmostEqual(q[1], 0)
            value['scene']['seed'] += 1
            seeded = list(sample_frames(JobRequest.from_dict(value), 'arc'))
            self.assertEqual([f['sat_quat'] for f in frames], [f['sat_quat'] for f in seeded])
            self.assertNotEqual(frames[0]['seed'],seeded[0]['seed'])

    def test_pi_rule_uses_start_relative_axis_with_largest_component_ties(self):
        # Z180 -> Z180*X180. Positive local X chooses midpoint axis (0,1,1).
        # The world-relative axis is -X, so using it would select the other arc.
        from satellite_studio.domain.rotation import quaternion_to_matrix
        for sign in (1,-1):
            value = custom(trajectory=dict(start_quat=dict(W=0,X=0,Y=0,Z=1),
                end_quat=dict(W=0,X=0,Y=sign,Z=0)))
            mid = list(sample_frames(JobRequest.from_dict(value),'pi'))[1]
            q = quaternion_array(mid['sat_quat'])
            np.testing.assert_allclose(q,[0,2**-.5,2**-.5,0],atol=1e-12)
            np.testing.assert_allclose(quaternion_to_matrix(q) @ [0,0,1],[0,1,0],atol=1e-12)

    def test_near_equal_two_frames_and_maximum_lazy(self):
        value = custom(count=2, trajectory=dict(start_quat=dict(W=1,X=0,Y=0,Z=0),end_quat=dict(W=1,X=1e-10,Y=0,Z=0)))
        request = JobRequest.from_dict(value)
        frames = list(sample_frames(request,'two'))
        self.assertEqual(len(frames),2)
        self.assertEqual([f['trajectory']['t'] for f in frames], [0,1])
        self.assertAlmostEqual(frames[1]['sat_quat']['X'],1e-10)
        value['count'] = 100000
        generator = sample_frames(JobRequest.from_dict(value),'large')
        self.assertIs(iter(generator), generator)
        self.assertEqual(len(list(itertools.islice(generator,2))),2)
        value['count'] = 3
        mid = list(sample_frames(JobRequest.from_dict(value),'near'))[1]
        self.assertAlmostEqual(mid['sat_quat']['X'],5e-11, places=18)

    def test_invalid_trajectory_and_mode_combinations(self):
        invalid = [custom(count=x) for x in (1,100001,True,2.5)]
        invalid += [custom(trajectory=x) for x in (None,{},[],dict(start_quat=dict(W=1,X=0,Y=0,Z=0)))]
        for field in ('start_quat','end_quat'):
            for q in (dict(W=0,X=0,Y=0,Z=0),dict(W=True,X=0,Y=0,Z=0),dict(W=float('nan'),X=0,Y=0,Z=0),dict(W=1,X=0,Y=0),[1,0,0,0]):
                value=custom(); value['trajectory'][field]=q; invalid.append(value)
        for dt in (0,1e-7,3601,True,float('inf')):
            value=custom(); value['trajectory']['time_step_s']=dt; invalid.append(value)
        invalid += [custom(mode=m) for m in ('single','coverage','sequence')]
        invalid += [custom(sequence={})]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError): JobRequest.from_dict(value)

    def test_normalized_immutable_snapshot_and_old_jobs_reopen(self):
        value=custom(); value['trajectory']['start_quat']['W']=2
        request=JobRequest.from_dict(value)
        value['trajectory']['start_quat']['W']=0
        with self.assertRaises(FrozenInstanceError): request.trajectory.time_step_s=2
        snapshot=request.to_dict()
        self.assertNotIn('sequence',snapshot)
        self.assertEqual(snapshot['trajectory']['start_quat']['W'],1)
        self.assertEqual(JobRequest.from_dict(snapshot),request)
        snapshot['trajectory']['start_quat']['W']=0
        self.assertEqual(request.to_dict()['trajectory']['start_quat']['W'],1)
        with tempfile.TemporaryDirectory() as temp:
            store=JobStore(Path(temp))
            jobs=[(store.create(r)['id'],r) for r in [request]+[JobRequest.from_dict(dict(mode=m, scene=scene_dict(), count=1)) for m in ('single','coverage','sequence')]]
            store.claim_next(); store.close()
            store=JobStore(Path(temp))
            try:
                self.assertEqual(store.get(jobs[0][0])['status'],'interrupted')
                for jid,r in jobs: self.assertEqual(store.request(jid),r)
            finally: store.close()

    def test_real_custom_queue_publishes_consistent_pose(self):
        with tempfile.TemporaryDirectory() as temp:
            store=JobStore(Path(temp)); runner=JobRunner(store,FakeRenderer); runner.start()
            try:
                job=store.create(JobRequest.from_dict(custom())); runner.wake()
                self.assertEqual(wait_job(store,job['id'])['status'],'completed')
                for i in range(3):
                    pose=json.loads((Path(job['output_directory']) / f'poses/{i+1:06d}.json').read_text(encoding='utf-8'))
                    self.assertEqual(pose['trajectory'],pose['scene']['trajectory'])
                    self.assertEqual(pose['Location']['SatQuat'],pose['scene']['sat_quat'])
                    self.assertEqual(pose['timestamp_s'],i)
            finally: runner.close(); store.close()

    def test_cancel_running_custom_keeps_only_complete_frames(self):
        started,release=threading.Event(),threading.Event()
        class Blocking(FakeRenderer):
            def render(self,frame,output_directory):
                started.set(); release.wait(5)
                return super().render(frame,output_directory)
        with tempfile.TemporaryDirectory() as temp:
            store=JobStore(Path(temp)); runner=JobRunner(store,Blocking); runner.start()
            try:
                job=store.create(JobRequest.from_dict(custom())); runner.wake()
                self.assertTrue(started.wait(5)); store.cancel(job['id']); release.set()
                state=wait_job(store,job['id']); self.assertEqual(state['status'],'canceled'); self.assertEqual(state['completed_frames'],0)
                self.assertIsNone(store.published_file(job['id'],'images_clean/000001.png'))
            finally: release.set(); runner.close(); store.close()

    def test_pose_schema_coordinate_constants_match_runtime_and_export(self):
        from satellite_studio import COORDINATE_INFO, CAMERA_COORD_INFO
        schema_path = Path(__file__).parents[2] / 'schemas/pose.schema.json'
        schema = json.loads(schema_path.read_text(encoding='utf-8'))
        helper = test_storage.StorageTests()
        helper.setUp()
        try:
            stage, frame = helper.make_frame()
            pose = validate_frame(stage, frame['frame_id'])
            for field, value in (('CoordinateInfo', COORDINATE_INFO), ('CameraCoordInfo', CAMERA_COORD_INFO)):
                with self.subTest(field=field):
                    self.assertEqual(schema['properties'][field]['const'], value)
                    self.assertEqual(schema['properties'][field]['const'], pose[field])
        finally:
            helper.tearDown()

    def test_output_trajectory_requires_explicit_interval_in_both_copies(self):
        helper = test_storage.StorageTests()
        helper.setUp()
        try:
            helper.request = JobRequest.from_dict(custom())
            stage, frame = helper.make_frame()
            pose = json.loads((stage / 'pose.json').read_text(encoding='utf-8'))
            del pose['trajectory']['time_step_s']
            del pose['scene']['trajectory']['time_step_s']
            (stage / 'pose.json').write_text(json.dumps(pose), encoding='utf-8', newline='\n')
            with self.assertRaises(ValueError):
                validate_frame(stage, frame['frame_id'])
        finally:
            helper.tearDown()

    def test_metadata_tampering_is_rejected(self):
        helper=test_storage.StorageTests(); helper.setUp()
        try:
            helper.request=JobRequest.from_dict(custom())
            stage,frame=helper.make_frame()
            original=json.loads((stage/'pose.json').read_text(encoding='utf-8'))
            for change in ('t','count','time_step_s','start_quat','type','timestamp','index','missing','scene_only'):
                pose=copy.deepcopy(original)
                if change=='timestamp': pose['timestamp_s']=10
                elif change=='index': pose['frame_index']=2
                elif change=='missing': del pose['trajectory']
                elif change=='scene_only': pose['scene']['trajectory']['t']=.7
                else:
                    pose['trajectory'][change]={'t':.5,'count':1,'time_step_s':0,'start_quat':dict(W=0,X=1,Y=0,Z=0),'type':'other'}[change]
                    pose['scene']['trajectory']=copy.deepcopy(pose['trajectory'])
                (stage/'pose.json').write_text(json.dumps(pose),encoding='utf-8')
                with self.subTest(change=change), self.assertRaises(ValueError): validate_frame(stage,frame['frame_id'])
        finally: helper.tearDown()
