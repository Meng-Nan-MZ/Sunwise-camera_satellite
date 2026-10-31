"""Renderer lifecycle tests without starting Blender."""
import importlib
from pathlib import Path
import tempfile
import unittest


class RendererLifecycleTests(unittest.TestCase):
    def renderer_type(self):
        try:
            return importlib.import_module("satellite_studio.rendering.client").BlenderRenderer
        except ImportError:
            self.fail("Renderer client not implemented")

    def test_startup_is_lazy_even_when_blender_is_missing(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            renderer = self.renderer_type()(path, path / "missing.exe", path / "logs")
            self.assertFalse((path / "logs").exists())
            renderer.close()

    def test_missing_executable_fails_capture_with_actionable_error(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            renderer = self.renderer_type()(path, path / "missing.exe", path / "logs")
            with self.assertRaisesRegex(FileNotFoundError, "Blender"):
                renderer.render({}, path / "output")
            renderer.close()

    def test_closed_renderer_cannot_resurrect_a_worker(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            renderer = self.renderer_type()(path, path / "missing.exe", path / "logs")
            renderer.close()
            renderer.close()
            with self.assertRaisesRegex(RuntimeError, "closed"):
                renderer.render({}, path)


if __name__ == "__main__":
    unittest.main()
