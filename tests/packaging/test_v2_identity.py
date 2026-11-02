"""V3 preserves the V2 upgrade identity and remains separate from V1."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class VersionIsolationTests(unittest.TestCase):
    def test_installer_has_independent_registration_and_entries(self):
        definition = (ROOT / 'packaging/installer/SatelliteDatasetStudio.iss').read_text(encoding='utf-8')
        self.assertNotIn('6E3F9E47-82F0-49A6-B615-710171B61BBF', definition)
        self.assertIn('AppId={{B46CE219-98FD-430C-AC12-A09EC62CC127}', definition)
        self.assertIn('DefaultDirName={localappdata}\\Programs\\SatelliteDatasetStudioV2', definition)
        self.assertIn('DefaultGroupName=Satellite Dataset Studio V3', definition)
        self.assertIn('UninstallDisplayName=Satellite Dataset Studio V3', definition)
        self.assertIn('{userdesktop}\\Satellite Dataset Studio V3', definition)
        self.assertNotIn('[UninstallDelete]', '\n'.join(line for line in definition.splitlines() if not line.lstrip().startswith((';', '//'))))


if __name__ == '__main__':
    unittest.main()
