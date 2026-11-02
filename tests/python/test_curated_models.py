"""Identity, real asset integrity and detached-dataset scale provenance."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np

from satellite_studio.datasets.export import prepare_frame
from satellite_studio.domain.parameters import JobRequest
from satellite_studio.domain.sampling import sample_frames
from satellite_studio.rendering.browser_renderer import validate_result
from satellite_studio.server.models import ModelCatalog
import test_browser_render
from test_domain import scene_dict

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from import_curated_models import COLLECTION_ID, MODELS, SCALE_BASIS, SCALE_NOTE, glb_info, merge_catalog
from verify_v221_images import glb_vertices


class CuratedCatalogTests(unittest.TestCase):
    def test_collection_preserves_established_identities_and_provenance(self):
        catalog = ModelCatalog(ROOT)
        values = catalog.public()
        self.assertEqual(len(values), 20)
        self.assertEqual([value["id"] for value in values[:6]],
                         ["insat_3b", "hubble", "sputnik_1", "gps", "galileo", "glonass"])
        curated = [value for value in values if value.get("collection_id") == COLLECTION_ID]
        self.assertEqual([value["id"] for value in curated], [spec[1] for spec in MODELS])
        for value in curated:
            with self.subTest(model=value["id"]):
                self.assertEqual(value["collection_id"], COLLECTION_ID)
                self.assertIs(value["physical_scale_calibrated"], False)
                self.assertEqual(value["source_scale"], 1.0)
                self.assertEqual(value["source_scale_basis"], SCALE_BASIS)
                self.assertEqual(value["scale_note"], SCALE_NOTE)
                self.assertTrue(value["source_page"].startswith("https://"))
                self.assertNotIn("blend_file", value)
                self.assertNotIn("preview_file", value)
        self.assertEqual(catalog.get("hubble")["source_sha256"],
                         catalog.get("hubble_textured")["source_sha256"])
        self.assertNotEqual(catalog.get("hubble")["id"], catalog.get("hubble_textured")["id"])
        choices = [value for value in values if value.get("selectable", True)]
        self.assertEqual(len(choices), 19)
        self.assertEqual([value["id"] for value in choices if value["id"].startswith("hubble")], ["hubble"])
        self.assertIs(catalog.get("hubble_textured")["selectable"], False)

    def test_merge_refuses_existing_model_collision_and_is_idempotent(self):
        legacy = {"id": "hubble", "radius_m": 8.7, "source_to_body": [[1]]}
        addition = {"id": "hubble_textured", "source_model_id": "23_Hubble_Textured", "collection_id": COLLECTION_ID}
        original = copy.deepcopy(legacy)
        merged = merge_catalog([legacy], [addition])
        self.assertEqual(merged, [original, addition])
        self.assertEqual(merge_catalog(merged, [addition]), merged)
        with self.assertRaisesRegex(ValueError, "established"):
            merge_catalog([legacy], [dict(addition, id="hubble")])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            merge_catalog([], [addition, addition])

    def test_collection_reimport_preserves_retirement(self):
        old = {"id": "hubble_textured", "source_model_id": "23_Hubble_Textured",
               "collection_id": COLLECTION_ID, "selectable": False}
        prepared = {key: value for key, value in old.items() if key != "selectable"}
        self.assertIs(merge_catalog([old], [prepared])[0]["selectable"], False)

    def test_prepared_assets_match_hashes_center_radius_and_need_no_decoder(self):
        catalog = ModelCatalog(ROOT)
        for _, model_id, _, _ in MODELS:
            model = catalog.get(model_id)
            path = ROOT / model["preview_file"]
            if not path.is_file():
                self.skipTest("Local GLB binaries are intentionally excluded from Git")
            with self.subTest(model=model_id):
                self.assertEqual(catalog.require_web_asset(model_id)["id"], model_id)
                info = glb_info(path)
                self.assertEqual(info["sha256"], model["preview_sha256"])
                self.assertFalse(set(info["extensions_used"]) &
                                 {"KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"})
                vertices, _ = glb_vertices(path)
                self.assertTrue(np.isfinite(vertices).all())
                np.testing.assert_allclose((vertices.max(axis=0) + vertices.min(axis=0)) / 2, 0, atol=2e-5)
                self.assertGreaterEqual(model["radius_m"], float(np.linalg.norm(vertices, axis=1).max()))
                self.assertLess(model["radius_m"] / float(np.linalg.norm(vertices, axis=1).max()), 1.00001)
                audit = json.loads((path.parent / "asset-audit.json").read_text(encoding="utf-8"))
                self.assertTrue(audit["passed"])
                self.assertEqual(audit["prepared"]["sha256"], info["sha256"])
                self.assertFalse((path.parent / "render.blend").exists())


class ModelProvenanceTests(unittest.TestCase):
    def test_catalog_scale_caveat_survives_in_standalone_pose_and_worker_cannot_replace_it(self):
        request = JobRequest.from_dict({"scene": scene_dict(), "renderer_backend": "threejs"})
        frame = next(sample_frames(request, "provenance-test"))
        helper = test_browser_render.BridgeTests()
        helper.frame, helper.token = frame, "unused"
        body = helper.body({"task_id": "task", "attempt_token": "attempt"})
        model = dict(id="demo", radius_m=8, preview_sha256="a" * 64, source_to_body=np.eye(4).tolist(),
                     collection_id=COLLECTION_ID, source_model_id="11_GOESR", source_sha256="b" * 64,
                     source_scale=1.0, source_scale_basis=SCALE_BASIS,
                     physical_scale_calibrated=False, scale_note=SCALE_NOTE)
        png, canonical = validate_result(body, frame, model)
        self.assertIs(canonical["model_provenance"]["physical_scale_calibrated"], False)
        self.assertEqual(canonical["model_provenance"]["source_scale_basis"], SCALE_BASIS)
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            (stage / "clean.png").write_bytes(png)
            prepare_frame(stage, frame, canonical, request.scene)
            pose = json.loads((stage / "pose.json").read_text(encoding="utf-8"))
            self.assertEqual(pose["model_provenance"], canonical["model_provenance"])
            self.assertEqual(pose["model_provenance"]["scale_note"], SCALE_NOTE)
        forged = copy.deepcopy(body)
        forged["metadata"]["model_provenance"] = {"physical_scale_calibrated": True}
        with self.assertRaisesRegex(ValueError, "字段"):
            validate_result(forged, frame, model)
        legacy = {key: value for key, value in model.items() if key in
                  {"id", "radius_m", "preview_sha256", "source_to_body"}}
        _, legacy_result = validate_result(body, frame, legacy)
        self.assertNotIn("model_provenance", legacy_result)


if __name__ == "__main__":
    unittest.main()
