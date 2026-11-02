"""Model replacements must change the preview URL without changing model identity."""

from contextlib import contextmanager
import hashlib
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

from satellite_studio.server.app import create_server
from satellite_studio.server.models import ModelCatalog


class ModelVersionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.model_dir = self.root / "assets/models/demo"
        self.model_dir.mkdir(parents=True)
        self.manifest = self.model_dir.parent / "index.json"
        self.model = {
            "id": "demo",
            "name": "Demo",
            "configuration": "test",
            "radius_m": 8,
            "preview_file": "assets/models/demo/preview.glb",
            "sha256": "a" * 64,
            "preview_sha256": "b" * 64,
            "source_to_body": [
                [1, 0, 0, 0],
                [0, 1, 0, 0],
                [0, 0, 1, 0],
                [0, 0, 0, 1],
            ],
            "installation_source": "simulation_default",
        }
        self.write_manifest()

    def write_manifest(self):
        self.manifest.write_text(json.dumps([self.model]), encoding="utf-8")

    def registered_asset(self):
        path = self.model_dir / 'preview.glb'
        content = b'original model bytes'
        path.write_bytes(content)
        self.model['preview_sha256'] = hashlib.sha256(content).hexdigest()
        self.write_manifest()
        catalog = ModelCatalog(self.root)
        self.assertEqual(catalog.require_web_asset('demo')['id'], 'demo')
        return catalog, path, content, path.stat()

    def test_same_size_in_place_edit_with_restored_mtime_is_rejected(self):
        catalog, path, original, stamp = self.registered_asset()
        path.write_bytes(b'x' * len(original))
        os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.assertEqual(path.stat().st_size, stamp.st_size)
        self.assertEqual(path.stat().st_mtime_ns, stamp.st_mtime_ns)
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            catalog.require_web_asset('demo')
        # Repairing the asset permits capture again without a service restart.
        path.write_bytes(original)
        os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.assertEqual(catalog.require_web_asset('demo')['id'], 'demo')

    def test_replacement_file_with_same_size_and_mtime_is_rejected(self):
        catalog, path, original, stamp = self.registered_asset()
        replacement = path.with_name('replacement.glb')
        replacement.write_bytes(b'y' * len(original))
        os.utime(replacement, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        os.replace(replacement, path)
        self.assertEqual(path.stat().st_size, stamp.st_size)
        self.assertEqual(path.stat().st_mtime_ns, stamp.st_mtime_ns)
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            catalog.require_web_asset('demo')

    @contextmanager
    def serve(self):
        server = create_server(self.root, self.root / "workspace", 0)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
        try:
            yield connection
        finally:
            connection.close()
            server.shutdown()
            worker.join(5)
            server.server_close()

    def get(self, connection, path):
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        self.assertEqual(response.status, 200, body)
        return body

    def test_http_catalog_versions_same_model_path_and_serves_query_url(self):
        (self.model_dir / "preview.glb").write_bytes(b"old model bytes")
        with self.serve() as connection:
            first = json.loads(self.get(connection, "/api/models"))[0]
            self.assertEqual(first.get("preview_sha256"), "b" * 64)
            self.assertEqual(
                first["preview_url"], "/assets/models/demo/preview.glb?v=" + "b" * 64
            )
            self.assertEqual(self.get(connection, first["preview_url"]), b"old model bytes")

        # Asset replacement is loaded by the next server/catalog lifetime.
        self.model["preview_sha256"] = "c" * 64
        self.write_manifest()
        (self.model_dir / "preview.glb").write_bytes(b"replacement model bytes")
        with self.serve() as connection:
            second = json.loads(self.get(connection, "/api/models"))[0]
            self.assertEqual(second["id"], first["id"])
            self.assertEqual(second["preview_sha256"], "c" * 64)
            self.assertEqual(
                second["preview_url"], "/assets/models/demo/preview.glb?v=" + "c" * 64
            )
            self.assertNotEqual(second["preview_url"], first["preview_url"])
            self.assertEqual(
                self.get(connection, second["preview_url"]), b"replacement model bytes"
            )

    def test_missing_preview_hash_falls_back_to_validated_model_hash(self):
        del self.model["preview_sha256"]
        self.model["sha256"] = "A" * 64
        self.write_manifest()
        public = ModelCatalog(self.root).public()[0]
        self.assertEqual(public.get("preview_sha256"), "a" * 64)
        self.assertEqual(public["preview_url"], "/assets/models/demo/preview.glb?v=" + "a" * 64)

    def test_invalid_hash_cannot_be_inserted_into_preview_query(self):
        for field in ("preview_sha256", "sha256"):
            for invalid in (
                "abc&redirect=evil", "?v=1#fragment", "g" * 64, "a" * 63, "", None, 42
            ):
                with self.subTest(field=field, invalid=invalid):
                    self.model["sha256"] = "a" * 64
                    self.model.pop("preview_sha256", None)
                    self.model[field] = invalid
                    self.write_manifest()
                    with self.assertRaisesRegex(ValueError, "SHA-256"):
                        ModelCatalog(self.root)


if __name__ == "__main__":
    unittest.main()
