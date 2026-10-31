import importlib
from pathlib import Path
import tempfile
import unittest


class AssetIntegrityTests(unittest.TestCase):
    def test_loaded_asset_must_match_registered_hash(self):
        try:
            verify = importlib.import_module("satellite_studio.rendering.assets").verified_model_path
        except ImportError:
            self.fail("Model digest verification missing")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            asset = root / "assets/models/sample/render.blend"
            asset.parent.mkdir(parents=True)
            asset.write_bytes(b"abc")
            model = {"blend_file": "assets/models/sample/render.blend",
                     "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}
            self.assertEqual(verify(root, model), asset)
            asset.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "SHA256"):
                verify(root, model)

    def test_asset_path_stays_in_registered_model_directory(self):
        try:
            verify = importlib.import_module("satellite_studio.rendering.assets").verified_model_path
        except ImportError:
            self.fail("Model digest verification missing")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "outside.blend").write_bytes(b"abc")
            with self.assertRaisesRegex(ValueError, "assets/models"):
                verify(root, {"blend_file": "outside.blend", "sha256": "0" * 64})
