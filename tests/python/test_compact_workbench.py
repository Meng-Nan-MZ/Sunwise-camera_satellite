import json
from pathlib import Path
import unittest

from satellite_studio.domain.parameters import JobRequest
from satellite_studio.domain.sampling import sample_frames
from test_domain import scene_dict
import test_service


def request_body(mode, **overrides):
    value = dict(mode=mode, count=1 if mode == 'single' else 3, scene=scene_dict(distance_m=23000), renderer_backend='threejs')
    if mode == 'custom_sequence':
        value['trajectory'] = dict(start_quat=dict(W=1, X=0, Y=0, Z=0), end_quat=dict(W=0, X=1, Y=0, Z=0))
    value.update(overrides)
    return value


class DistancePolicyTests(unittest.TestCase):
    def test_fixed_distance_all_modes_preserves_historical_orientation_seed_and_timing(self):
        for mode in ('single', 'coverage', 'sequence', 'custom_sequence'):
            with self.subTest(mode=mode):
                legacy = list(sample_frames(JobRequest.from_dict(request_body(mode)), 'same'))
                fixed = list(sample_frames(JobRequest.from_dict(request_body(mode, distance_policy='fixed')), 'same'))
                self.assertEqual([f['distance_m'] for f in fixed], [23000] * len(fixed))
                for old, new in zip(legacy, fixed):
                    self.assertEqual({k:v for k,v in old.items() if k != 'distance_m'},
                                     {k:v for k,v in new.items() if k != 'distance_m'})

    def test_explicit_policy_round_trip_and_omitted_policy_retains_old_snapshot(self):
        for mode in ('single', 'coverage', 'sequence', 'custom_sequence'):
            old = JobRequest.from_dict(request_body(mode))
            self.assertNotIn('distance_policy', old.to_dict())
            self.assertEqual(JobRequest.from_dict(old.to_dict()), old)
            fixed = JobRequest.from_dict(request_body(mode, distance_policy='fixed'))
            self.assertIn('distance_policy', fixed.to_dict())
            self.assertEqual(fixed.to_dict()['distance_policy'], 'fixed')
            self.assertEqual(JobRequest.from_dict(fixed.to_dict()), fixed)
        for mode in ('coverage', 'sequence'):
            automatic = JobRequest.from_dict(request_body(mode, distance_policy='automatic'))
            self.assertEqual(automatic.to_dict()['distance_policy'], 'automatic')
            self.assertEqual(list(sample_frames(automatic, 'same')),
                             list(sample_frames(JobRequest.from_dict(request_body(mode)), 'same')))

    def test_policy_validation_rejects_unknown_null_and_automatic_fixed_only_modes(self):
        for mode in ('single', 'coverage', 'sequence', 'custom_sequence'):
            for policy in (None, '', True, [], {}, 'random', 1):
                with self.subTest(mode=mode, policy=policy), self.assertRaises(ValueError):
                    JobRequest.from_dict(request_body(mode, distance_policy=policy))
        for mode in ('single', 'custom_sequence'):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                JobRequest.from_dict(request_body(mode, distance_policy='automatic'))


class GalleryApiTests(unittest.TestCase):
    setUp = test_service.ServiceTests.setUp
    tearDown = test_service.ServiceTests.tearDown
    call = test_service.ServiceTests.call

    def submit(self, mode='single', **overrides):
        overrides.setdefault('scene', scene_dict())
        status, _, body = self.call('POST', '/api/jobs', json.dumps(request_body(mode, **overrides)), {'Content-Type':'application/json'})
        self.assertEqual(status, 202, body)
        submitted = json.loads(body)
        self.assertNotIn('parameters', submitted)
        job = test_service.wait_job(self.server.app.store, submitted['id'])
        self.assertEqual(job['status'], 'completed', job)
        return job

    def get_json(self, url):
        status, _, body = self.call('GET', url)
        self.assertEqual(status, 200, body)
        return json.loads(body)

    def test_frames_pagination_download_and_frozen_detail_without_expanding_list_or_post(self):
        job = self.submit('sequence', distance_policy='fixed')
        url = f"/api/jobs/{job['id']}"
        page = self.get_json(url + '/frames?offset=1&limit=1')
        self.assertEqual(page['total'], 3)
        self.assertEqual([f['frame_id'] for f in page['frames']], ['000002'])
        self.assertEqual(set(page['frames'][0]), {'frame_id', 'images'})
        for image in page['frames'][0]['images'].values():
            self.assertEqual(self.call('GET', image)[0], 200)
        self.assertEqual(self.get_json(url + '/frames?offset=3&limit=100'), {'frames':[], 'total':3})
        detail = self.get_json(url)
        frozen = (Path(job['output_directory']) / 'job.json').read_bytes()
        self.assertEqual(detail['parameters'], json.loads(frozen))
        self.assertEqual(detail['parameters']['distance_policy'], 'fixed')
        self.assertIsNone(detail['source_parameters'])
        self.assertNotIn('parameters', self.get_json('/api/jobs')[0])
        self.assertEqual((Path(job['output_directory']) / 'job.json').read_bytes(), frozen)

    def test_noise_gallery_original_clean_urls_and_source_raw_snapshot(self):
        source = self.submit(scene=scene_dict(noise={'enabled':False}))
        status, _, body = self.call('POST', f"/api/jobs/{source['id']}/noise-variants", json.dumps({'noise':{'enabled':True}, 'seed':4}), {'Content-Type':'application/json'})
        self.assertEqual(status, 202, body)
        variant = test_service.wait_job(self.server.app.store, json.loads(body)['id'])
        url = f"/api/jobs/{variant['id']}"
        page = self.get_json(url + '/frames')
        self.assertEqual(page['total'], 1)
        images = page['frames'][0]['images']
        self.assertEqual(images['clean'], source['latest_images']['clean'])
        self.assertEqual(images['noisy'], variant['latest_images']['noisy'])
        self.assertEqual(self.call('GET', images['clean'])[0], 200)
        detail = self.get_json(url)
        self.assertEqual(detail['source_parameters'], self.get_json(f"/api/jobs/{source['id']}")['parameters'])
        self.assertEqual(detail['parameters']['mode'], 'noise_variant')

    def test_gallery_uses_publication_marker_and_file_allowlist_even_after_cancel(self):
        self.server.app.runner.close()
        store = self.server.app.store
        job = store.create(JobRequest.from_dict(request_body('sequence')))
        store.claim_next()
        output = Path(job['output_directory'])
        for relative in ('images_clean/000001.png', 'images_noisy/000001.png', 'images_clean/000002.png', '.staging/000003.png'):
            file = output / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'not exposed without allowlist')
        store.mark_frame(job['id'], '000001', ['images_clean/000001.png'])
        store.cancel(job['id'])
        store.finish(job['id'], 'canceled')
        result = self.get_json(f"/api/jobs/{job['id']}/frames")
        self.assertEqual(result, {'total':1, 'frames':[{'frame_id':'000001', 'images':{'clean':f"/data/{job['id']}/images_clean/000001.png", 'noisy':None}}]})
        self.assertEqual(self.call('GET', f"/data/{job['id']}/images_clean/000002.png")[0], 404)

    def test_strict_frame_query_validation_and_unknown_job(self):
        job = self.submit()
        url = f"/api/jobs/{job['id']}/frames"
        for query in ('offset=-1', 'offset=100000', 'limit=0', 'limit=101', 'limit=1.0', 'offset=+1',
                      'offset=', 'limit=true', 'other=1', 'limit=1&limit=2', 'offset=1e1', 'offset=%EF%BC%91',
                      'limit=1&other', 'limit', 'offset=%201'):
            with self.subTest(query=query):
                self.assertEqual(self.call('GET', url + '?' + query)[0], 400)
        self.assertEqual(self.call('GET', '/api/jobs/' + '0'*32 + '/frames')[0], 404)
        self.assertEqual(self.get_json(url + '?offset=99999&limit=100'), {'frames':[], 'total':1})

    def test_history_pagination_strict_validation_and_compact_contract(self):
        first = self.submit()
        second = self.submit()
        self.assertEqual([j['id'] for j in self.get_json('/api/jobs?offset=1&limit=1')], [first['id']])
        self.assertEqual([j['id'] for j in self.get_json('/api/jobs?limit=1')], [second['id']])
        self.assertEqual(self.get_json('/api/jobs?offset=1000000'), [])
        for query in ('offset=-1', 'offset=1000001', 'limit=0', 'limit=101', 'limit=1.1', 'unknown=1', 'offset=0&offset=1'):
            with self.subTest(query=query):
                self.assertEqual(self.call('GET', '/api/jobs?' + query)[0], 400)
