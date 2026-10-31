import json
from contextlib import closing
import math
from pathlib import Path
import sqlite3
import tempfile
import unittest
import hashlib
import subprocess
import sys

import numpy as np

from satellite_studio.domain import rotation
from satellite_studio.domain.camera import camera_parameters
from satellite_studio.domain.parameters import Scene
from satellite_studio.jobs.store import JobStore, validate_workspace_protocol
from satellite_studio.server.app import Application


class ClientCoordinateTests(unittest.TestCase):
    def test_scene_public_wxyz_and_old_protocol_rejection(self):
        scene = Scene.from_dict({'model_id': 'demo', 'sat_quat': {'W': 2, 'X': 0, 'Y': 0, 'Z': 0}})
        self.assertEqual(scene.to_dict().get('sat_quat'), {'W': 1, 'X': 0, 'Y': 0, 'Z': 0})
        self.assertNotIn('quaternion_xyzw', scene.to_dict())
        with self.assertRaises(ValueError):
            Scene.from_dict({'model_id': 'demo', 'quaternion_xyzw': [0, 0, 0, 1]})

    def test_identity_new_six_angles(self):
        angles = rotation.six_angles([0, 0, 0, 1])
        np.testing.assert_allclose(angles['alpha_rad'], [0, 0, math.pi / 2])
        np.testing.assert_allclose(angles['beta_rad'], [math.pi / 2, 0, math.pi / 2])
        self.assertEqual(angles['alpha_valid'], [True, False, True])

    def test_axis_rotations_and_nontrivial_engine_roundtrip(self):
        self.assertTrue(hasattr(rotation, 'client_to_engine_quaternion'))
        p = np.array([[1, 0, 0], [0, 0, 1], [0, 1, 0]])
        values = [np.array([.2, -.3, .4, .7])]
        for axis in range(3):
            for sign in (-1, 1):
                q = np.zeros(4)
                q[axis], q[3] = sign / math.sqrt(2), 1 / math.sqrt(2)
                values.append(q)
        for q in values:
            q = q / np.linalg.norm(q)
            engine = rotation.client_to_engine_quaternion(q)
            np.testing.assert_allclose(engine, [-q[0], -q[2], -q[1], q[3]])
            np.testing.assert_allclose(rotation.quaternion_to_matrix(engine), p @ rotation.quaternion_to_matrix(q) @ p.T, atol=1e-12)
            np.testing.assert_allclose(rotation.client_to_engine_quaternion(engine), q, atol=1e-12)
            np.testing.assert_allclose(rotation.quaternion_to_matrix(-q), rotation.quaternion_to_matrix(q))

    def test_camera_default_actual_matrix_and_projection(self):
        camera = camera_parameters(20000, 1024, .01)
        self.assertIn('camera_to_cv_rotation', camera)
        np.testing.assert_allclose(camera['image_basis_to_world'], [[1, 0, 0], [0, 0, 1], [0, 1, 0]])
        self.assertNotIn('image_to_world_rotation', camera)
        expected = rotation.quaternion_to_matrix([.5, -.5, .5, .5])
        np.testing.assert_allclose(np.array(camera['camera_to_world'])[:3, :3], expected)
        np.testing.assert_allclose(np.array(camera['camera_to_world'])[:3, 3], [0, 20000, 0])
        point = np.array([1, 3, 2, 1])
        client_camera = np.array(camera['world_to_camera']) @ point
        cv = np.array(camera['camera_to_cv_rotation']) @ client_camera[:3]
        np.testing.assert_allclose(cv, [1, -2, 19997])
        projected = np.array(camera['projection_world_to_pixel']) @ point
        expected_pixel = np.array(camera['K']) @ cv
        np.testing.assert_allclose(projected / projected[2], expected_pixel / expected_pixel[2])
        actual = np.eye(4)
        actual[:3, :3] = rotation.quaternion_to_matrix([.1, .2, -.3, .8])
        actual[:3, 3] = [0, 0, 20000]
        changed = camera_parameters(20000, 1024, .01, actual)
        self.assertFalse(np.allclose(changed['camera_to_world'], camera['camera_to_world']))

    def test_old_database_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'jobs.sqlite3'
            with closing(sqlite3.connect(path)) as db:
                db.execute('CREATE TABLE jobs (id TEXT PRIMARY KEY, mode TEXT, status TEXT, total_frames INTEGER, completed_frames INTEGER DEFAULT 0, created_at TEXT, error TEXT, snapshot TEXT, cancel_requested INTEGER DEFAULT 0, latest_frame TEXT)')
                db.execute('INSERT INTO jobs (snapshot) VALUES (?)', (json.dumps({'scene': {'quaternion_xyzw': [0, 0, 0, 1]}}),))
                db.commit()
            before = path.read_bytes()
            with self.assertRaisesRegex(ValueError, 'V1|旧协议'):
                JobStore(Path(temporary))
            self.assertEqual(path.read_bytes(), before)

    def test_application_and_cli_reject_old_workspace_without_writing_files(self):
        def inventory(root):
            return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
                    for p in root.rglob('*')}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with closing(sqlite3.connect(root / 'jobs.sqlite3')) as db:
                db.execute('CREATE TABLE jobs (snapshot TEXT)')
                db.commit()
            before = inventory(root)
            with self.assertRaisesRegex(ValueError, 'V1'):
                Application(root, root, None)
            self.assertEqual(inventory(root), before)
            result = subprocess.run([sys.executable, '-m', 'satellite_studio', '--project-root', str(root),
                                     '--workspace', str(root), '--port', '0'], capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 1)
            self.assertIn(b'V1', result.stderr)
            self.assertEqual(result.stdout, b'')
            self.assertEqual(inventory(root), before)

    def test_old_wal_workspace_rejected_without_creating_shared_memory(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / 'old'
            root.mkdir()
            with closing(sqlite3.connect(base / 'writer.sqlite3')) as writer:
                writer.execute('PRAGMA journal_mode=WAL')
                writer.execute('CREATE TABLE jobs (snapshot TEXT)')
                writer.execute('INSERT INTO jobs VALUES (?)', ('old request',))
                writer.commit()
                (root / 'jobs.sqlite3').write_bytes((base / 'writer.sqlite3').read_bytes())
                (root / 'jobs.sqlite3-wal').write_bytes((base / 'writer.sqlite3-wal').read_bytes())
                before = {p.name: p.read_bytes() for p in root.iterdir()}
                for action in (validate_workspace_protocol, JobStore, lambda p: Application(base, p, None)):
                    with self.assertRaisesRegex(ValueError, 'V1'):
                        action(root)
                    self.assertEqual({p.name: p.read_bytes() for p in root.iterdir()}, before)
            result = subprocess.run([sys.executable, '-m', 'satellite_studio', '--project-root', str(root),
                                     '--workspace', str(root), '--port', '0'], capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 1)
            self.assertIn(b'V1', result.stderr)
            self.assertEqual(result.stdout, b'')
            self.assertEqual({p.name: p.read_bytes() for p in root.iterdir()}, before)
