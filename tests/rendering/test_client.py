"""Web renderer lifecycle requires no local rendering executable."""
from pathlib import Path
import tempfile
import threading
import unittest
from satellite_studio.rendering.browser_bridge import BrowserBridge
from satellite_studio.rendering.browser_renderer import BrowserRenderer


class RendererLifecycleTests(unittest.TestCase):
    def test_closed_bridge_cannot_accept_worker(self):
        bridge = BrowserBridge()
        renderer = BrowserRenderer(bridge, None)
        renderer.close()
        renderer.close()
        with self.assertRaises(Exception):
            bridge.register()

    def test_root_lost_during_capture_is_not_recreated(self):
        class Catalog:
            def require_web_asset(self, model_id):
                return {'id': model_id}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'selected'
            stage = root / 'job' / '.staging' / '000001'
            stage.mkdir(parents=True)
            class Bridge:
                def render(self, *args):
                    root.rename(Path(folder) / 'offline')
                    return b'png', {}
            renderer = BrowserRenderer(Bridge(), Catalog())
            with self.assertRaises(OSError):
                renderer.render({'_job_id': 'job', 'model_id': 'demo'}, stage)
            self.assertFalse(root.exists())
