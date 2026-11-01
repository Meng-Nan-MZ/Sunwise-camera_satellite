"""GLB-only application asset validation."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from satellite_studio.server.models import ModelCatalog


class AssetIntegrityTests(unittest.TestCase):
    def catalog(self, root, preview_file):
        assets = root / 'assets/models'
        assets.mkdir(parents=True)
        model = dict(id='demo', radius_m=8, source_to_body=[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
                     preview_file=preview_file, preview_sha256=hashlib.sha256(b'abc').hexdigest())
        (assets / 'index.json').write_text(json.dumps([model]), encoding='utf-8')
        return ModelCatalog(root)

    def test_loaded_glb_must_match_registered_hash_without_blend(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            catalog = self.catalog(root, 'assets/models/preview.glb')
            asset = root / 'assets/models/preview.glb'
            asset.write_bytes(b'abc')
            self.assertEqual(catalog.require_web_asset('demo')['id'], 'demo')
            asset.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'SHA256'):
                catalog.require_web_asset('demo')

    def test_asset_path_stays_in_registered_model_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            catalog = self.catalog(root, 'outside.glb')
            (root / 'outside.glb').write_bytes(b'abc')
            with self.assertRaises(ValueError):
                catalog.require_web_asset('demo')
