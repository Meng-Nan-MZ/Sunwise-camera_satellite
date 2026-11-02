"""A failed registration may clean up only the directory it created."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from satellite_studio.domain.parameters import JobRequest
from satellite_studio.jobs import deletion
from satellite_studio.jobs.store import JobStore
from test_domain import scene_dict


@unittest.skipUnless(os.name == 'nt', 'Windows directory ownership protection')
class CreationRollbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = JobStore(self.root / 'workspace')
        self.request = JobRequest.from_dict(dict(renderer_backend='threejs', mode='single', scene=scene_dict()))

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def reject_insert(self, before_failure=lambda job_id: None):
        def mutate(job_id):
            before_failure(job_id)
            return 0
        self.store._db.create_function('before_failure', 1, mutate)
        self.store._db.execute("""CREATE TRIGGER reject_job BEFORE INSERT ON jobs BEGIN
            SELECT before_failure(NEW.id);
            SELECT RAISE(ABORT, 'fixture registration failure');
        END;""")

    def assert_registration_failed(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'fixture registration failure'):
            self.store.create(self.request)
        self.assertEqual(self.store.list(), [])
        self.assertEqual(self.store._db.execute('SELECT COUNT(*) FROM job_output_ownership').fetchone()[0], 0)

    def test_insert_failure_removes_only_its_owned_directory(self):
        sibling = self.store.jobs_directory / 'unrelated'
        sibling.mkdir()
        marker = sibling / 'keep.txt'
        marker.write_text('KEEP')
        self.reject_insert()
        self.assert_registration_failed()
        self.assertEqual(list(self.store.jobs_directory.iterdir()), [sibling])
        self.assertEqual(marker.read_text(), 'KEEP')

    def test_replaced_job_with_copied_ownership_files_is_preserved(self):
        saved = self.root / 'original-job'
        replacements = []
        def replace(job_id):
            directory = self.store.jobs_directory / job_id
            directory.rename(saved)
            shutil.copytree(saved, directory)
            marker = directory / 'unrelated.txt'
            marker.write_text('KEEP')
            replacements.append(marker)
        self.reject_insert(replace)
        self.assert_registration_failed()
        self.assertTrue(replacements[0].is_file(), 'Rollback removed the replacement directory')
        self.assertEqual(replacements[0].read_text(), 'KEEP')
        self.assertTrue((saved / 'job.json').exists())

    def test_replaced_parent_with_copied_job_is_preserved(self):
        saved = self.root / 'original-jobs-root'
        replacements = []
        def replace(job_id):
            root = self.store.jobs_directory
            root.rename(saved)
            shutil.copytree(saved, root)
            marker = root / job_id / 'unrelated.txt'
            marker.write_text('KEEP')
            replacements.append(marker)
        self.reject_insert(replace)
        self.assert_registration_failed()
        self.assertTrue(replacements[0].is_file(), 'Rollback followed a replaced parent directory')
        self.assertEqual(replacements[0].read_text(), 'KEEP')
        self.assertTrue(any(saved.glob('*/job.json')))

    def test_changed_ownership_marker_is_preserved(self):
        markers = []
        def change_owner(job_id):
            marker = self.store.jobs_directory / job_id / '.satellite-owner.json'
            marker.write_text(json.dumps({'job_id': job_id, 'token': 'another-owner'}))
            markers.append(marker)
        self.reject_insert(change_owner)
        self.assert_registration_failed()
        self.assertTrue(markers[0].is_file(), 'Rollback removed a directory with a different owner')
        self.assertEqual(json.loads(markers[0].read_text())['token'], 'another-owner')

    def test_replacement_between_validation_and_removal_is_preserved(self):
        self.reject_insert()
        saved = self.root / 'original-job'
        markers = []
        original_remove = deletion._remove_windows
        def replace_then_remove(directory, identity):
            directory.rename(saved)
            shutil.copytree(saved, directory)
            marker = directory / 'unrelated.txt'
            marker.write_text('KEEP')
            markers.append(marker)
            return original_remove(directory, identity)
        with patch.object(deletion, '_remove_windows', side_effect=replace_then_remove):
            self.assert_registration_failed()
        self.assertEqual(len(markers), 1, 'Rollback must use the pinned identity-aware remover')
        self.assertEqual(markers[0].read_text(), 'KEEP')
        self.assertTrue((saved / 'job.json').exists())

    def test_cleanup_failure_keeps_files_and_original_database_error(self):
        self.reject_insert()
        with patch('os.unlink', side_effect=PermissionError('fixture file locked')):
            self.assert_registration_failed()
        self.assertEqual(len(list(self.store.jobs_directory.glob('*/job.json'))), 1)


if __name__ == '__main__':
    unittest.main()
