"""Renderer lifecycle tests without starting Blender."""
import importlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch


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

    def test_root_lost_during_blender_startup_is_not_recreated(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            root = path / 'selected'
            stage = root / 'job' / '.staging' / '000001'
            stage.mkdir(parents=True)
            renderer = self.renderer_type()(path, path / 'blender.exe', path / 'logs')
            renderer._stream = Mock()
            renderer._stream.readline.return_value = b'{"result": {}}\n'
            with patch.object(renderer, '_start', side_effect=lambda: root.rename(path / 'offline')), patch.object(renderer, '_dispose'):
                with self.assertRaises(OSError):
                    renderer.render({}, stage)
            self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
