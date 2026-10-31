"""Fetch pinned build inputs, or verify an existing cache without networking."""
import argparse
import json
from pathlib import Path
import shutil
import urllib.request

from build_payload import checked_path, sha256


def main():
    project = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Only verify cached files")
    args = parser.parse_args()
    lock = json.loads((project / "packaging/dependencies.lock.json").read_text(encoding="utf-8"))
    cache = project / "var/packaging/downloads"
    for entry in lock["downloads"]:
        destination = checked_path(cache, entry["file"])
        if destination.exists():
            if sha256(destination) != entry["sha256"]:
                raise ValueError(f"Existing dependency hash mismatch: {entry['file']}")
        else:
            if args.offline:
                raise FileNotFoundError(f"Offline input missing: {entry['file']}")
            if not entry["url"].startswith("https://"):
                raise ValueError("Download requires HTTPS")
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(destination.name + ".part")
            request = urllib.request.Request(entry["url"], headers={"User-Agent": "SatelliteDatasetStudio-release-builder"})
            with urllib.request.urlopen(request, timeout=120) as source, temporary.open("wb") as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
            if sha256(temporary) != entry["sha256"]:
                raise ValueError(f"Downloaded dependency hash mismatch: {entry['file']}")
            temporary.replace(destination)
        print(f"Verified {entry['name']} {entry['version']}", flush=True)


if __name__ == "__main__":
    main()
