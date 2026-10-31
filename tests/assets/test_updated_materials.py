"""Asset acceptance checks. Run after local assets are installed."""
import hashlib
import json
from pathlib import Path
import struct
import unittest

ROOT = Path(__file__).resolve().parents[2]
UPDATED = ("sputnik_1", "gps", "galileo", "glonass")


class UpdatedMaterialTests(unittest.TestCase):
    def test_four_assets_have_traceable_textured_pbr(self):
        models = json.loads((ROOT / "assets/models/index.json").read_text(encoding="utf-8"))
        for model in models:
            if model["id"] not in UPDATED:
                continue
            with self.subTest(model=model["id"]):
                self.assertEqual(model.get("source_archive"), "02-四个卫星模型.zip")
                self.assertIn(model.get("material_workflow"), ("source_textures_to_pbr", "reconstructed_pbr"))
                data = (ROOT / model["preview_file"]).read_bytes()
                length, kind = struct.unpack_from("<II", data, 12)
                self.assertEqual(kind, 0x4E4F534A)
                document = json.loads(data[20:20 + length])
                self.assertTrue(document.get("images"), "Preview lost its material textures")
                self.assertTrue(all("bufferView" in image for image in document["images"]))
                for material in document["materials"]:
                    self.assertIn("pbrMetallicRoughness", material)
                if model["id"] != "sputnik_1":
                    names = {material["name"] for material in document["materials"]}
                    self.assertTrue(any("Solar" in name for name in names))
                    self.assertTrue(any("MLI" in name for name in names))
                    self.assertTrue(any("Aluminium" in name for name in names))
                self.assertEqual(hashlib.sha256(data).hexdigest(), model["preview_sha256"])

    def test_protected_models_still_match_the_original_registered_assets(self):
        expected = {
            "insat_3b": ("52a052feb494c7b4e7df461c97d750152c5a4c5ace9aa02326834ee97c84439d", "2498d63fced0583122edb2f6574433d6405fbd9b44eaa887f66fb0b606aa9c6f"),
            "hubble": ("711bc9e70033fe43c91ac4fa5d6ea6dc25394c4fd5ba8d8921b84f8dcecd5fd0", "05fbc5142336b9e7e01662ab6fd6782b1f8749c5d5b8027186e1bf1115a06995"),
        }
        for model_id, hashes in expected.items():
            for filename, expected_hash in zip(("render.blend", "preview.glb"), hashes):
                with self.subTest(model=model_id, file=filename):
                    actual = hashlib.sha256((ROOT / "assets/models" / model_id / filename).read_bytes()).hexdigest()
                    self.assertEqual(actual, expected_hash)
