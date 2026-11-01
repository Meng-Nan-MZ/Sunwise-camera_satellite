import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import shutil
from types import SimpleNamespace
from unittest.mock import patch

from satellite_studio.domain.parameters import JobRequest
from satellite_studio.jobs.store import JobStore
from satellite_studio.jobs.runner import JobRunner
from test_domain import scene_dict
import test_service
from test_service import FakeRenderer, wait_job


class JobDeletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.workspace = self.root / '工作区'
        self.store = JobStore(self.workspace)
        self.runner = JobRunner(self.store, FakeRenderer)
        self.request = JobRequest.from_dict(dict(renderer_backend='threejs', mode='single', scene=scene_dict()))

    def tearDown(self):
        self.runner.close()
        self.store.close()
        self.temp.cleanup()

    def source(self):
        job = self.store.create(self.request)
        self.runner._execute(self.store.claim_next())
        self.assertEqual(self.store.get(job['id'])['status'], 'completed')
        return self.store.get(job['id'])

    def variant(self, source, complete=True):
        job = self.store.create_noise_variant(source['id'], {'noise': {'enabled': True}, 'seed': 3})
        if complete:
            self.runner._execute(self.store.claim_next())
        return self.store.get(job['id'])

    def delete(self, job):
        preview = self.store.deletion_preview(job['id'])
        return self.store.delete(job['id'], preview['fingerprint'])

    def assert_code(self, code, operation):
        with self.assertRaises(Exception) as caught:
            operation()
        self.assertEqual(getattr(caught.exception, 'code', None), code, repr(caught.exception))

    def test_cascade_removes_all_versions_frames_and_folders_but_keeps_sibling(self):
        source = self.source()
        first = self.variant(source)
        second = self.variant(first)
        sibling = self.source()
        preview = self.store.deletion_preview(source['id'])
        self.assertTrue(preview['can_delete'])
        self.assertEqual({j['id'] for j in preview['jobs']}, {source['id'], first['id'], second['id']})
        result = self.store.delete(source['id'], preview['fingerprint'])
        self.assertEqual(set(result['deleted_job_ids']), {source['id'], first['id'], second['id']})
        self.assertEqual(result['deleted_count'], 3)
        for job in (source, first, second):
            self.assertFalse(Path(job['output_directory']).exists())
            with self.assertRaises(KeyError):
                self.store.get(job['id'])
        self.assertEqual([j['id'] for j in self.store.list()], [sibling['id']])
        self.assertTrue(Path(sibling['output_directory']).is_dir())
        self.assertEqual(self.store._db.execute('SELECT COUNT(*) FROM frames').fetchone()[0], 1)

    def test_unsupported_platform_refuses_before_intent_or_file_changes(self):
        source = self.source()
        before = (Path(source['output_directory']) / 'job.json').read_bytes()
        from satellite_studio.jobs import deletion
        with patch.object(deletion, 'os', SimpleNamespace(name='posix')):
            self.assert_code('UNSUPPORTED_DELETE_PLATFORM', lambda: self.delete(source))
        self.assertEqual((Path(source['output_directory']) / 'job.json').read_bytes(), before)
        self.assertEqual(self.store.get(source['id'])['id'], source['id'])
        self.assertEqual(self.store._db.execute('SELECT COUNT(*) FROM deletion_intents').fetchone()[0], 0)

    def test_deleting_variant_preserves_its_original_and_other_variants(self):
        source = self.source()
        first = self.variant(source)
        sibling = self.variant(first)
        self.delete(first)
        self.assertEqual({j['id'] for j in self.store.list()}, {source['id'], sibling['id']})
        self.assertTrue(self.store.get(sibling['id'])['can_generate_noise'])

    def test_active_root_or_dependent_blocks_entire_group_without_mutation(self):
        queued = self.store.create(self.request)
        preview = self.store.deletion_preview(queued['id'])
        self.assertFalse(preview['can_delete'])
        self.assert_code('JOB_ACTIVE', lambda: self.store.delete(queued['id'], preview['fingerprint']))
        claimed = self.store.claim_next()
        self.store.cancel(queued['id'])
        self.assert_code('JOB_ACTIVE', lambda: self.delete(queued))
        self.runner._execute(claimed)
        self.delete(queued)
        source = self.source()
        child = self.variant(source, complete=False)
        before = (Path(source['output_directory']) / 'job.json').read_bytes()
        self.assert_code('JOB_ACTIVE', lambda: self.delete(source))
        self.assertEqual((Path(source['output_directory']) / 'job.json').read_bytes(), before)
        self.assertEqual(self.store.get(child['id'])['status'], 'queued')

    def test_preview_change_requires_confirmation_again(self):
        source = self.source()
        preview = self.store.deletion_preview(source['id'])
        child = self.variant(source)
        self.assert_code('DELETE_PLAN_CHANGED', lambda: self.store.delete(source['id'], preview['fingerprint']))
        self.assertTrue(Path(child['output_directory']).is_dir())
        self.assert_code('DELETE_PREVIEW_REQUIRED', lambda: self.store.delete(source['id'], None))

    def test_frozen_external_root_and_legacy_null_root_are_used(self):
        old = self.source()
        with self.store._db:
            self.store._db.execute('DROP TRIGGER output_root_immutable')
            self.store._db.execute('UPDATE jobs SET output_root=NULL WHERE id=?', (old['id'],))
            self.store._db.execute('DELETE FROM job_output_ownership WHERE job_id=?', (old['id'],))
        (Path(old['output_directory']) / '.satellite-owner.json').unlink()
        external = self.root / '导出 有空格'
        external.mkdir()
        self.store.set_output_directory(str(external))
        new = self.source()
        self.store.set_output_directory(str(self.workspace / 'jobs'))
        sentinel = external / 'keep.txt'
        sentinel.write_text('keep')
        self.delete(old)
        self.delete(new)
        self.assertEqual(sentinel.read_text(), 'keep')

    def test_modified_job_manifest_prevents_any_group_file_deletion(self):
        source = self.source()
        child = self.variant(source)
        (Path(child['output_directory']) / 'job.json').write_text('{}')
        self.assert_code('UNSAFE_OUTPUT_DIRECTORY', lambda: self.delete(source))
        self.assertTrue((Path(source['output_directory']) / 'images_clean/000001.png').exists())
        self.assertEqual(len(self.store.list()), 2)

    def test_partial_filesystem_failure_retains_records_and_retries_after_restart(self):
        source = self.source()
        child = self.variant(source)
        from satellite_studio.jobs import deletion
        actual = deletion.remove_owned_directory
        def partial(directory, identity):
            if directory.name == source['id']:
                (directory / 'job.json').unlink()
                raise PermissionError('fixture file locked')
            return actual(directory, identity)
        with patch.object(deletion, 'remove_owned_directory', side_effect=partial):
            self.assert_code('DELETE_FAILED', lambda: self.delete(source))
        self.assertEqual({j['id'] for j in self.store.list()}, {source['id'], child['id']})
        self.assertFalse(self.store.get(source['id'])['can_generate_noise'])
        self.assert_code('DELETE_IN_PROGRESS', lambda: self.variant(source))
        self.runner.close()
        self.store.close()
        self.store = JobStore(self.workspace)
        self.runner = JobRunner(self.store, FakeRenderer)
        self.delete(source)
        self.assertEqual(self.store.list(), [])

    def test_lost_root_is_not_mistaken_for_already_deleted_directory(self):
        external = self.root / 'external'
        external.mkdir()
        self.store.set_output_directory(str(external))
        source = self.source()
        moved = self.root / 'offline'
        external.rename(moved)
        self.assert_code('DELETE_FAILED', lambda: self.delete(source))
        self.assertEqual(self.store.get(source['id'])['id'], source['id'])
        moved.rename(external)

    def test_symlink_or_junction_is_rejected_without_touching_target(self):
        source = self.source()
        outside = self.root / 'unrelated'
        outside.mkdir()
        sentinel = outside / 'keep.txt'
        sentinel.write_text('KEEP')
        link = Path(source['output_directory']) / 'linked'
        if os.name == 'nt':
            import subprocess
            result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(outside)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            link.symlink_to(outside, target_is_directory=True)
        try:
            self.assert_code('UNSAFE_OUTPUT_DIRECTORY', lambda: self.delete(source))
            self.assertEqual(sentinel.read_text(), 'KEEP')
        finally:
            if os.name == 'nt':
                link.rmdir()
            else:
                link.unlink()

    def test_noise_creation_and_delete_are_serialized_without_blocking_reads(self):
        source = self.source()
        preview = self.store.deletion_preview(source['id'])
        started, release = threading.Event(), threading.Event()
        from satellite_studio.jobs.output_directory import probe_directory
        def blocked(path):
            if threading.current_thread().name == 'creating-noise':
                started.set()
                self.assertTrue(release.wait(5))
            return probe_directory(path)
        outcomes = []
        def create():
            outcomes.append(self.variant(source, complete=False))
        errors = []
        def delete():
            try:
                self.store.delete(source['id'], preview['fingerprint'])
            except Exception as exc:
                errors.append(exc)
        with patch('satellite_studio.jobs.output_directory.probe_directory', side_effect=blocked):
            creator = threading.Thread(target=create, name='creating-noise')
            creator.start()
            self.assertTrue(started.wait(2))
            remover = threading.Thread(target=delete)
            remover.start()
            self.assertEqual(self.store.get(source['id'])['id'], source['id'])
            release.set()
            creator.join(6)
            remover.join(6)
        self.assertFalse(creator.is_alive())
        self.assertFalse(remover.is_alive())
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(len(errors), 1)
        self.assertEqual(getattr(errors[0], 'code', None), 'DELETE_PLAN_CHANGED')
        self.assertTrue(Path(source['output_directory']).exists())

    def test_replaced_directory_with_copied_manifest_and_marker_is_refused(self):
        source = self.source()
        directory = Path(source['output_directory'])
        original = directory.with_name('original')
        directory.rename(original)
        shutil.copytree(original, directory)
        self.assert_code('UNSAFE_OUTPUT_DIRECTORY', lambda: self.delete(source))
        self.assertTrue((directory / 'images_clean/000001.png').exists())
        self.assertTrue((original / 'images_clean/000001.png').exists())

    def test_root_or_job_junction_is_refused_without_following_target(self):
        source = self.source()
        outside = self.root / 'unrelated-root'
        outside.mkdir()
        sentinel = outside / 'keep.txt'
        sentinel.write_text('KEEP')
        for link in (Path(source['output_directory']), Path(source['output_directory']).parent):
            with self.subTest(path=link):
                original = link.with_name(link.name + '-original')
                link.rename(original)
                if os.name == 'nt':
                    import subprocess
                    result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(outside)], capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    link.symlink_to(outside, target_is_directory=True)
                try:
                    self.assert_code('UNSAFE_OUTPUT_DIRECTORY', lambda: self.delete(source))
                    self.assertEqual(sentinel.read_text(), 'KEEP')
                finally:
                    if os.name == 'nt':
                        link.rmdir()
                    else:
                        link.unlink()
                    original.rename(link)

    @unittest.skipUnless(os.name == 'nt', 'Windows directory pin regression')
    def test_replacement_at_removal_entry_is_rejected_under_pinned_identity(self):
        source = self.source()
        directory = Path(source['output_directory'])
        original = directory.with_name('saved-original')
        from satellite_studio.jobs import deletion
        actual = deletion._remove_windows
        def replace_then_remove(path, *args):
            if path == directory:
                directory.rename(original)
                directory.mkdir()
                (directory / 'unrelated.txt').write_text('DO NOT DELETE')
            return actual(path, *args)
        with patch.object(deletion, '_remove_windows', side_effect=replace_then_remove):
            self.assert_code('UNSAFE_OUTPUT_DIRECTORY', lambda: self.delete(source))
        self.assertEqual((directory / 'unrelated.txt').read_text(), 'DO NOT DELETE')
        self.assertTrue((original / 'images_clean/000001.png').is_file())
        self.assertEqual(self.store.get(source['id'])['id'], source['id'])

    def test_nested_unrelated_job_directory_is_not_removed(self):
        source = self.source()
        self.store.set_output_directory(source['output_directory'])
        nested = self.source()
        self.assert_code('UNSAFE_OUTPUT_DIRECTORY', lambda: self.delete(source))
        self.assertTrue((Path(nested['output_directory']) / 'images_clean/000001.png').exists())
        self.delete(nested)
        self.delete(source)

    def test_db_delete_failure_keeps_all_rows_and_can_retry_without_files(self):
        source = self.source()
        child = self.variant(source)
        self.store._db.execute("CREATE TRIGGER fail_delete BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'fixture database failure'); END;")
        self.assert_code('DELETE_FAILED', lambda: self.delete(source))
        self.assertEqual({j['id'] for j in self.store.list()}, {source['id'], child['id']})
        self.assertFalse(Path(source['output_directory']).exists())
        self.store._db.execute('DROP TRIGGER fail_delete')
        self.delete(source)
        self.assertEqual(self.store.list(), [])

    def test_delete_wins_creation_race_and_unrelated_controls_stay_responsive(self):
        source = self.source()
        other = self.store.create(self.request)
        started, release, creator_started = threading.Event(), threading.Event(), threading.Event()
        from satellite_studio.jobs import deletion
        actual = deletion.remove_owned_directory
        def blocked(directory, identity):
            started.set()
            self.assertTrue(release.wait(5))
            return actual(directory, identity)
        failures = []
        def create():
            creator_started.set()
            try:
                self.variant(source, complete=False)
            except Exception as exc:
                failures.append(exc)
        removed = []
        with patch.object(deletion, 'remove_owned_directory', side_effect=blocked):
            remover = threading.Thread(target=lambda: removed.append(self.delete(source)))
            remover.start()
            self.assertTrue(started.wait(2))
            creator = threading.Thread(target=create)
            creator.start()
            self.assertTrue(creator_started.wait(2))
            self.assertEqual(len(self.store.list()), 2)
            self.assertEqual(self.store.cancel(other['id'])['status'], 'canceled')
            release.set()
            remover.join(6)
            creator.join(6)
        self.assertFalse(remover.is_alive())
        self.assertFalse(creator.is_alive())
        self.assertEqual(len(removed), 1)
        self.assertEqual(len(failures), 1)
        self.assertIsInstance(failures[0], KeyError)
        self.assertEqual([j['id'] for j in self.store.list()], [other['id']])


class JobDeletionHTTPTests(unittest.TestCase):
    setUp = test_service.ServiceTests.setUp
    tearDown = test_service.ServiceTests.tearDown
    call = test_service.ServiceTests.call

    def test_id_only_origin_guard_preview_and_delete(self):
        store = self.server.app.store
        job = store.create(JobRequest.from_dict(dict(renderer_backend='threejs', mode='single', scene=scene_dict())))
        self.server.app.runner.wake()
        self.assertEqual(wait_job(store, job['id'])['status'], 'completed')
        route = '/api/jobs/' + job['id']
        status, _, body = self.call('GET', route + '/deletion-preview')
        self.assertEqual(status, 200)
        preview = json.loads(body)
        self.assertEqual(self.call('DELETE', route)[0], 428)
        headers = {'If-Match': preview['fingerprint']}
        for bad in ({'Origin': 'https://evil.example'}, {'Host': 'evil.example'}, {'Sec-Fetch-Site': 'cross-site'}):
            self.assertEqual(self.call('DELETE', route, headers={**headers, **bad})[0], 403)
        self.assertEqual(self.call('DELETE', route + '?path=elsewhere', headers=headers)[0], 400)
        self.assertEqual(self.call('DELETE', route, body='{}', headers=headers)[0], 400)
        self.assertEqual(self.call('DELETE', '/api/jobs/%2e%2e', headers=headers)[0], 400)
        status, _, body = self.call('DELETE', route, headers=headers)
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)['deleted_job_ids'], [job['id']])
        self.assertEqual(self.call('GET', route)[0], 404)
        self.assertEqual(self.call('DELETE', route, headers=headers)[0], 404)
        self.assertEqual(self.call('GET', f'/data/{job["id"]}/images_clean/000001.png')[0], 404)
