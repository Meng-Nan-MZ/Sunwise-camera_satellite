"""Noise provenance must describe the shipped source, not the Python environment."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[2]


class SourceVersionTests(unittest.TestCase):
    def test_source_only_payload_reports_version_without_distribution_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            payload = Path(temporary)
            package = payload / 'satellite_studio'
            shutil.copytree(ROOT / 'python/src/satellite_studio', package,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '*.egg-info'))
            env = {**os.environ, 'PYTHONPATH': str(payload), 'PYTHONUTF8': '1'}
            command = [sys.executable, '-c',
                       'import json, satellite_studio; '
                       'from satellite_studio.datasets.noise import implementation_metadata; '
                       'print(json.dumps({"source":satellite_studio.__file__, '
                       '"implementation":implementation_metadata()}))']
            for unrelated_distribution in (False, True):
                with self.subTest(unrelated_distribution=unrelated_distribution):
                    if unrelated_distribution:
                        info = payload / 'satellite_studio-99.0.0.dist-info'
                        info.mkdir()
                        (info / 'METADATA').write_text(
                            'Metadata-Version: 2.1\nName: satellite_studio\nVersion: 99.0.0\n',
                            encoding='utf-8')
                    result = subprocess.run(command, cwd=payload, env=env,
                                            capture_output=True, text=True, encoding='utf-8', timeout=30)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    metadata = json.loads(result.stdout)
                    self.assertEqual(Path(metadata['source']).resolve(), (package / '__init__.py').resolve())
                    self.assertEqual(metadata['implementation']['version'], '3.0.0')

    def test_source_version_matches_python_distribution(self):
        import satellite_studio
        declared = tomllib.loads((ROOT / 'python/pyproject.toml').read_text(encoding='utf-8'))
        self.assertEqual(getattr(satellite_studio, '__version__', None), declared['project']['version'])


if __name__ == '__main__':
    unittest.main()
