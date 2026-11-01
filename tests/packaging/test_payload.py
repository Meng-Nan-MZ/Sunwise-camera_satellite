"""Release checks must catch corrupt models and unsafe staging paths."""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from types import SimpleNamespace

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
            for field, filename, hash_field in (("preview_file", "preview.glb", "preview_sha256"),):
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

    def test_eighteen_registered_models_only(self):
        self.catalog()
        (self.root / "assets/models/purchased-secret.zip").write_bytes(b"not distributable")
        files = payload.model_files(self.root)
        self.assertEqual(len(payload.MODEL_IDS), 18)
        self.assertEqual(len(files), 19)
        self.assertNotIn("purchased-secret.zip", " ".join(map(str, files)))

    def test_complete_glb_only_application_payload_without_blender(self):
        rows = self.catalog()
        # Preserve original authoring provenance without requiring source scenes.
        rows[0]["blend_file"] = "assets/models/" + rows[0]["id"] + "/render.blend"
        rows[0]["sha256"] = "original authoring source digest"
        self.write_catalog(rows)
        original_catalog = (self.root / "assets/models/index.json").read_bytes()
        def write(relative, content="fixture"):
            file = self.root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(content, encoding="utf-8")
        lock = {"downloads": [], "runtime_versions": {"dotnet": "8.0.31"},
                "build_tools": {"webview2_sdk": "1.0.4191.47"}}
        write("packaging/dependencies.lock.json", json.dumps(lock))
        for name in ("SatelliteStudio.Desktop.exe", "coreclr.dll", "hostfxr.dll",
                     "Microsoft.Web.WebView2.Wpf.dll", "WebView2Loader.dll"):
            write("desktop/" + name)
        write("desktop/SatelliteStudio.Desktop.runtimeconfig.json",
              json.dumps({"runtimeOptions": {"includedFrameworks": []}}))
        for name in ("apps/ui/dist/index.html", "python/src/satellite_studio/__main__.py",
                     "python-runtime/python.exe", "python-runtime/python313._pth",
                     "webview-runtime/msedgewebview2.exe", "docs/user-guide.md",
                     "docs/offline-installation.md", "docs/model-materials.md",
                     "packaging/使用说明.html", "packaging/THIRD-PARTY-NOTICES.md",
                     "packaging/WebView2-Runtime-LICENSE.txt", "var/packaging/tools/inno/license.txt"):
            write(name)
        for package in ("react", "react-dom", "three"):
            write(f"apps/ui/node_modules/{package}/LICENSE")
        write("apps/ui/node_modules/.pnpm/scheduler@0.28.0/node_modules/scheduler/LICENSE")
        for package, version in (("microsoft.web.webview2", "1.0.4191.47"),
                                 ("microsoft.netcore.app.runtime.win-x64", "8.0.31"),
                                 ("microsoft.windowsdesktop.app.runtime.win-x64", "8.0.31")):
            write(f"var/tools/nuget/{package}/{version}/LICENSE.txt")
        output = self.root / "var/packaging/staging/glb-only"
        report = payload.build(SimpleNamespace(project_root=self.root, output=output,
            desktop=self.root / "desktop", python_runtime=self.root / "python-runtime",
            webview_runtime=self.root / "webview-runtime", version="2.4.0"))
        manifest = json.loads((output / "release-manifest.json").read_text(encoding="utf-8"))
        payload.verify_inventory(output, manifest["files"])
        self.assertEqual(report["version"], "2.4.0")
        self.assertEqual((output / "assets/models/index.json").read_bytes(), original_catalog)
        self.assertEqual(len(list(output.rglob("*.glb"))), 18)
        self.assertFalse(list(output.rglob("*.blend")))
        self.assertFalse((output / "runtime/blender").exists())
        self.assertEqual((self.root / "assets/models/index.json").read_bytes(), original_catalog)

    def test_modified_model_blocks_release(self):
        rows = self.catalog()
        (self.root / rows[0]["preview_file"]).write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "hash"):
            payload.model_files(self.root)

    def test_catalog_cannot_copy_files_outside_model_directory(self):
        rows = self.catalog()
        rows[0]["preview_file"] = "assets/models/../../../user-private-file"
        self.write_catalog(rows)
        with self.assertRaisesRegex(ValueError, "path"):
            payload.model_files(self.root)

    def test_missing_model_blocks_release(self):
        rows = self.catalog()
        self.write_catalog(rows[:-1])
        with self.assertRaisesRegex(ValueError, "18"):
            payload.model_files(self.root)

    def test_collected_assets_keep_attribution_and_preparation_evidence(self):
        rows = self.catalog()
        model = next(row for row in rows if row['id'] == 'goes_r')
        model['collection_id'] = 'public-spacecraft-2026-11-01'
        self.write_catalog(rows)
        folder = self.root / 'assets/models/goes_r'
        with self.assertRaisesRegex(ValueError, 'provenance'):
            payload.model_files(self.root)
        for name in ('ATTRIBUTION.txt', 'provenance.json', 'asset-audit.json'):
            (folder / name).write_text('source evidence', encoding='utf-8')
        files = payload.model_files(self.root)
        self.assertEqual(len(files), 22)
        self.assertIn(folder / 'ATTRIBUTION.txt', files)

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
