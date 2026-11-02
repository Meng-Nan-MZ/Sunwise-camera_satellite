import json
from pathlib import Path
import tempfile
import unittest

from satellite_studio.jobs.store import JobStore
import test_service


class AppearanceStoreTests(unittest.TestCase):
    def test_theme_defaults_and_persists_across_workspace_reopen(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JobStore(Path(temporary))
            try:
                self.assertTrue(hasattr(store, 'appearance_settings'), 'workspace appearance persistence is missing')
                self.assertEqual(store.appearance_settings(), {'theme':'light'})
                self.assertEqual(store.set_appearance('dark'), {'theme':'dark'})
            finally:
                store.close()
            store = JobStore(Path(temporary))
            try:
                self.assertEqual(store.appearance_settings(), {'theme':'dark'})
                self.assertEqual(store.set_appearance('light'), {'theme':'light'})
            finally:
                store.close()

    def test_invalid_theme_never_overwrites_saved_choice(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JobStore(Path(temporary))
            try:
                self.assertTrue(hasattr(store, 'set_appearance'), 'workspace appearance persistence is missing')
                store.set_appearance('light')
                for value in (None, True, 1, [], {}, '', 'Dark', 'system'):
                    with self.subTest(value=value), self.assertRaises(ValueError):
                        store.set_appearance(value)
                    self.assertEqual(store.appearance_settings(), {'theme':'light'})
            finally:
                store.close()


class AppearanceApiTests(unittest.TestCase):
    setUp = test_service.ServiceTests.setUp
    tearDown = test_service.ServiceTests.tearDown
    call = test_service.ServiceTests.call

    def test_appearance_http_contract_exact_payload_and_rollback(self):
        path = '/api/settings/appearance'
        status, _, body = self.call('GET', path)
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body), {'theme':'light'})
        for theme in ('light', 'dark', 'light'):
            status, _, body = self.call('POST', path, json.dumps({'theme':theme}), {'Content-Type':'application/json'})
            self.assertEqual(status, 200, body)
            self.assertEqual(json.loads(body), {'theme':theme})
        for value in ({}, {'theme':'system'}, {'theme':None}, {'theme':[]}, {'theme':'dark','extra':1}, {'extra':'dark'}):
            with self.subTest(value=value):
                self.assertEqual(self.call('POST', path, json.dumps(value), {'Content-Type':'application/json'})[0], 400)
                self.assertEqual(json.loads(self.call('GET', path)[2]), {'theme':'light'})
