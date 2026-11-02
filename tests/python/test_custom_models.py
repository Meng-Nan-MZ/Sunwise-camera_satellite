"""Custom-asset material preservation and source identity regression checks."""
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from import_custom_models import COLLECTION_ID, MODELS, assert_materials_preserved, merge_catalog
from import_curated_models import glb_info
from verify_v221_images import glb_vertices
from satellite_studio.server.models import ModelCatalog


def material_glb(path, roughness=0.25, image=b"original-image", texture_index=0):
    document = dict(materials=[dict(name="solar", pbrMetallicRoughness=dict(
        roughnessFactor=roughness, baseColorTexture=dict(index=texture_index)))],
        images=[dict(bufferView=0)], bufferViews=[dict(byteLength=len(image))],
        textures=[dict(source=0), dict(source=0)])
    raw = json.dumps(document).encode()
    raw += b" " * (-len(raw) % 4)
    binary = image + b"\0" * (-len(image) % 4)
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, 28 + len(raw) + len(binary)) +
                     struct.pack("<I4s", len(raw), b"JSON") + raw +
                     struct.pack("<I4s", len(binary), b"BIN\0") + binary)


class CustomAssetTests(unittest.TestCase):
    def test_material_audit_detects_parameter_and_image_loss_but_allows_reindexed_textures(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source.glb", Path(directory) / "target.glb"
            material_glb(source)
            material_glb(target, texture_index=1)
            self.assertTrue(assert_materials_preserved(source, target)["referenced_texture_bytes_preserved"])
            material_glb(target, roughness=0.75)
            with self.assertRaisesRegex(ValueError, "changed material"):
                assert_materials_preserved(source, target)
            material_glb(target, image=b"replaced-image")
            with self.assertRaisesRegex(ValueError, "changed material"):
                assert_materials_preserved(source, target)

    def test_merge_preserves_existing_records_and_rejects_unrelated_collision(self):
        historical = dict(id="hubble_textured", selectable=False)
        new = dict(id="sar_radar", collection_id=COLLECTION_ID)
        merged = merge_catalog([historical], [new])
        self.assertEqual(merged, [historical, new])
        self.assertEqual(merge_catalog(merged, [new]), merged)
        with self.assertRaisesRegex(ValueError, "established"):
            merge_catalog([dict(id="sar_radar")], [new])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            merge_catalog([], [new, new])

    def test_real_models_have_preserved_materials_center_bounds_and_source_provenance(self):
        catalog = ModelCatalog(ROOT)
        for model_id, name, filename, source_hash in MODELS:
            with self.subTest(model=model_id):
                model = catalog.get(model_id)
                self.assertEqual(model["name"], name)
                self.assertEqual(model["source_file"], filename)
                self.assertEqual(model["source_sha256"], source_hash)
                self.assertEqual(model["collection_id"], COLLECTION_ID)
                self.assertEqual(model["source_provider"], "用户自制")
                self.assertFalse(model["source_page"])
                self.assertFalse(model["license_url"])
                self.assertIs(model["physical_scale_calibrated"], False)
                folder = ROOT / "assets/models" / model_id
                audit = json.loads((folder / "asset-audit.json").read_text(encoding="utf-8"))
                self.assertTrue(audit["checks"]["source_materials_preserved"])
                self.assertEqual(audit["source"]["embedded_images"], 0)
                self.assertEqual(audit["source"]["materials"], audit["prepared"]["materials"])
                path = folder / "preview.glb"
                if not path.is_file():
                    self.skipTest("Local GLBs are intentionally excluded from Git")
                self.assertEqual(glb_info(path)["sha256"], model["preview_sha256"])
                vertices, _ = glb_vertices(path)
                self.assertTrue(np.isfinite(vertices).all())
                np.testing.assert_allclose((vertices.max(axis=0) + vertices.min(axis=0)) / 2, 0, atol=2e-5)
                self.assertGreaterEqual(model["radius_m"], float(np.linalg.norm(vertices, axis=1).max()))
                self.assertLess(model["radius_m"] / float(np.linalg.norm(vertices, axis=1).max()), 1.00001)


if __name__ == "__main__":
    unittest.main()
