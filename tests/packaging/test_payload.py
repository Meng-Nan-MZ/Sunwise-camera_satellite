"""Release checks must catch corrupt models and unsafe staging paths."""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("payload", ROOT / "tools/packaging/build_payload.py")
payload = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(payload)


class PayloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        if os.name == "nt":
            self.temp.name = "\\\\?\\" + self.temp.name
        self.addCleanup(self.temp.cleanup)

    def catalog(self):
        rows = []
        for name in payload.MODEL_IDS:
            row = {"id": name}
            for field, filename, hash_field in (("preview_file", "preview.glb", "preview_sha256"),
                                                 ("blend_file", "render.blend", "sha256")):
                relative = f"assets/models/{name}/{filename}"
                file = self.root / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(name.encode())
                row[field] = relative
                row[hash_field] = hashlib.sha256(file.read_bytes()).hexdigest()
            rows.append(row)
        self.write_catalog(rows)
        return rows

    def write_catalog(self, rows):
        (self.root / "assets/models/index.json").write_text(json.dumps(rows), encoding="utf-8")

    def test_six_registered_models_only(self):
        self.catalog()
        (self.root / "assets/models/purchased-secret.zip").write_bytes(b"not distributable")
        files = payload.model_files(self.root)
        self.assertEqual(len(files), 13)
        self.assertNotIn("purchased-secret.zip", " ".join(map(str, files)))

    def test_modified_model_blocks_release(self):
        rows = self.catalog()
        (self.root / rows[0]["blend_file"]).write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "hash"):
            payload.model_files(self.root)

    def test_catalog_cannot_copy_files_outside_model_directory(self):
        rows = self.catalog()
        rows[0]["blend_file"] = "assets/models/../../../user-private-file"
        self.write_catalog(rows)
        with self.assertRaisesRegex(ValueError, "path"):
            payload.model_files(self.root)

    def test_missing_model_blocks_release(self):
        rows = self.catalog()
        self.write_catalog(rows[:-1])
        with self.assertRaisesRegex(ValueError, "six"):
            payload.model_files(self.root)

    def test_staging_cannot_overwrite_project_or_existing_files(self):
        with self.assertRaisesRegex(ValueError, "staging"):
            payload.prepare_output(self.root, self.root)
        output = self.root / "var/packaging/staging/test"
        payload.prepare_output(self.root, output)
        (output / "keep.txt").write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "empty"):
            payload.prepare_output(self.root, output)
        self.assertEqual((output / "keep.txt").read_text(), "keep")

    def test_source_copy_excludes_developer_bytecode(self):
        source = self.root / "source"
        (source / "__pycache__").mkdir(parents=True)
        (source / "code.py").write_text("pass", encoding="utf-8")
        (source / "__pycache__/code.pyc").write_bytes(b"cache")
        payload.copy_source(source, self.root / "target")
        self.assertTrue((self.root / "target/code.py").is_file())
        self.assertFalse((self.root / "target/__pycache__").exists())

    @unittest.skipUnless(os.name == "nt", "Windows long-path deployment")
    def test_copy_includes_files_beyond_windows_legacy_path_limit(self):
        source = self.root / "long-source"
        relative = Path(*(["nested-package-directory"] * 12)) / "LICENSE.txt"
        original = Path("\\\\?\\" + str(source / relative))
        original.parent.mkdir(parents=True)
        original.write_text("required upstream notice", encoding="utf-8")
        payload.copy_source(source, self.root / "long-target")
        copied = Path("\\\\?\\" + str(self.root / "long-target" / relative))
        self.assertEqual(copied.read_text(), "required upstream notice")

    def test_inventory_detects_post_assembly_corruption(self):
        (self.root / "runtime.dll").write_bytes(b"original")
        manifest = payload.inventory(self.root)
        payload.verify_inventory(self.root, manifest)
        (self.root / "runtime.dll").write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "hash|size"):
            payload.verify_inventory(self.root, manifest)


if __name__ == "__main__":
    unittest.main()
