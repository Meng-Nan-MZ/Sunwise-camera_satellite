"""The V2 installer must coexist with an already installed V1."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class VersionIsolationTests(unittest.TestCase):
    def test_installer_has_independent_registration_and_entries(self):
        definition = (ROOT / 'packaging/installer/SatelliteDatasetStudio.iss').read_text(encoding='utf-8')
        self.assertNotIn('6E3F9E47-82F0-49A6-B615-710171B61BBF', definition)
        self.assertIn('DefaultDirName={localappdata}\\Programs\\SatelliteDatasetStudioV2', definition)
        self.assertIn('DefaultGroupName=Satellite Dataset Studio V2', definition)
        self.assertIn('UninstallDisplayName=Satellite Dataset Studio V2', definition)
        self.assertIn('{userdesktop}\\Satellite Dataset Studio V2', definition)
        self.assertNotIn('[UninstallDelete]', '\n'.join(line for line in definition.splitlines() if not line.lstrip().startswith((';', '//'))))


if __name__ == '__main__':
    unittest.main()
