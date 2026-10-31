"""Assemble a minimal Windows Python runtime from verified, local release files.

This script never downloads or installs packages with pip. Fetch the Python ZIP,
two wheels, and their official PyPI JSON metadata into --downloads first. Supply
the Python ZIP SHA-256 from the official release metadata with --python-sha256.
The output retains every wheel file, including DLLs and distribution licenses.
"""
from __future__ import annotations

import argparse
import base64
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit
import zipfile


PROJECT = Path(__file__).resolve().parents[2]
PYTHON_VERSION = "3.13.15"
PYTHON_ARCHIVE = f"python-{PYTHON_VERSION}-embed-amd64.zip"
PYTHON_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/{PYTHON_ARCHIVE}"
PACKAGES = {"numpy": "2.3.5", "pillow": "12.3.0"}
PTH_CONTENT = "python313.zip\n.\nLib/site-packages\n../../python/src\n"


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def require_hash(path: Path, expected: str) -> str:
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected):
        raise ValueError(f"Invalid expected SHA-256 for {path.name}")
    actual = sha256(path)
    if actual != expected.lower():
        raise ValueError(f"SHA-256 mismatch for {path.name}: {actual}")
    return actual


def verify_python_sbom(downloads: Path, archive_hash: str) -> dict | None:
    path = downloads / f"{PYTHON_ARCHIVE}.spdx.json"
    if not path.is_file():
        return None
    document = json.loads(path.read_text(encoding="utf-8"))
    matches = [
        package for package in document["packages"]
        if package.get("name") == "CPython"
        and package.get("versionInfo") == PYTHON_VERSION
        and package.get("downloadLocation") == PYTHON_URL
    ]
    if len(matches) != 1 or not any(
        checksum.get("algorithm") == "SHA256"
        and checksum.get("checksumValue") == archive_hash
        for checksum in matches[0].get("checksums", [])
    ):
        raise ValueError("Python archive does not match the official SPDX checksum")
    return {
        "filename": path.name,
        "url": PYTHON_URL + ".spdx.json",
        "sha256": sha256(path),
        "archive_hash_verified": True,
    }


def checked_members(archive: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    """Reject ambiguous or escaping Windows paths before writing any ZIP entry."""
    members = archive.infolist()
    seen: set[str] = set()
    for member in members:
        name = member.filename
        parts = PurePosixPath(name).parts
        key = name.rstrip("/").casefold()
        if (
            not parts
            or name.startswith("/")
            or "\\" in name
            or ":" in name
            or any(part in {".", ".."} for part in parts)
            or key in seen
            or (member.external_attr >> 16) & 0o170000 == 0o120000
        ):
            raise ValueError(f"Unsafe or duplicate archive entry: {name}")
        seen.add(key)
    return members


def verify_wheel(archive: zipfile.ZipFile) -> int:
    """Check every wheel member against its SHA-256 RECORD before extraction."""
    members = checked_members(archive)
    files = {member.filename for member in members if not member.is_dir()}
    records = [name for name in files if name.endswith(".dist-info/RECORD")]
    if len(records) != 1:
        raise ValueError("Wheel must contain exactly one RECORD")
    record = records[0]
    rows = csv.reader(io.StringIO(archive.read(record).decode("utf-8")))
    covered: set[str] = set()
    for name, digest, size in rows:
        if name not in files or name in covered:
            raise ValueError(f"Invalid wheel RECORD entry: {name}")
        covered.add(name)
        if name == record:
            if digest or size:
                raise ValueError("RECORD must not hash itself")
            continue
        data = archive.read(name)
        expected = "sha256=" + base64.urlsafe_b64encode(
            hashlib.sha256(data).digest()
        ).rstrip(b"=").decode("ascii")
        if digest != expected or size != str(len(data)):
            raise ValueError(f"Wheel RECORD mismatch: {name}")
    if files != covered:
        raise ValueError(f"Wheel contains files absent from RECORD: {files - covered}")
    return len(covered) - 1


def wheel_metadata(downloads: Path, name: str, version: str) -> dict:
    metadata_path = downloads / f"{name}-{version}.json"
    if not metadata_path.is_file():
        metadata_path = downloads / f"{name}-metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata["info"]["version"] != version:
        raise ValueError(f"Unexpected PyPI version in {metadata_path}")
    filename = f"{name}-{version}-cp313-cp313-win_amd64.whl"
    matches = [entry for entry in metadata["urls"] if entry["filename"] == filename]
    if len(matches) != 1:
        raise ValueError(f"Expected one PyPI wheel: {filename}")
    entry = matches[0]
    parsed = urlsplit(entry["url"])
    if parsed.scheme != "https" or parsed.hostname != "files.pythonhosted.org":
        raise ValueError(f"Unexpected PyPI download origin: {entry['url']}")
    if entry.get("yanked"):
        raise ValueError(f"Refusing yanked wheel: {filename}")
    path = downloads / filename
    digest = require_hash(path, entry["digests"]["sha256"])
    if path.stat().st_size != entry["size"]:
        raise ValueError(f"PyPI size mismatch: {filename}")
    return {
        "name": name,
        "version": version,
        "filename": filename,
        "url": entry["url"],
        "sha256": digest,
        "size_bytes": path.stat().st_size,
        "metadata_url": f"https://pypi.org/pypi/{name}/{version}/json",
        "metadata_sha256": sha256(metadata_path),
    }


def extract_wheel(path: Path, destination: Path) -> int:
    with zipfile.ZipFile(path) as archive:
        count = verify_wheel(archive)
        for member in archive.infolist():
            if member.is_dir():
                continue
            parts = PurePosixPath(member.filename).parts
            if parts[0].endswith(".data"):
                if len(parts) < 3 or parts[1] not in {"purelib", "platlib"}:
                    raise ValueError(f"Unsupported wheel install scheme: {member.filename}")
                parts = parts[2:]
            target = destination.joinpath(*parts)
            if target.exists():
                raise ValueError(f"Wheel would overwrite an existing file: {target}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
    return count


def verify_python_signatures(runtime: Path) -> list[dict]:
    names = ["python.exe", "pythonw.exe", "python313.dll", "python3.dll"]
    environment = os.environ.copy()
    # PowerShell 7's modules cannot be imported by Windows PowerShell 5.1.
    windows_powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0"
    environment["PSModulePath"] = str(windows_powershell / "Modules")
    environment["SATELLITE_SIGNATURE_FILES"] = json.dumps(
        [str(runtime / name) for name in names]
    )
    command = """
$ErrorActionPreference = 'Stop'
$files = $env:SATELLITE_SIGNATURE_FILES | ConvertFrom-Json
$rows = foreach ($file in $files) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    [ordered]@{
        filename = [IO.Path]::GetFileName($file)
        status = [string]$signature.Status
        signer = $signature.SignerCertificate.Subject
        thumbprint = $signature.SignerCertificate.Thumbprint
    }
}
ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress
"""
    result = subprocess.run(
        [str(windows_powershell / "powershell.exe"), "-NoProfile", "-NonInteractive", "-Command", command],
        env=environment,
        check=False,
        text=True,
        capture_output=True,
        timeout=120,
    )
    if result.returncode:
        raise RuntimeError(f"Authenticode inspection failed: {result.stderr.strip()}")
    signatures = json.loads(result.stdout)
    for signature in signatures:
        if signature["status"] != "Valid" or "Python Software Foundation" not in signature["signer"]:
            raise ValueError(f"Python Authenticode verification failed: {signature}")
    return signatures


def smoke_test(runtime: Path) -> dict:
    """Exercise native extensions with site and inherited Python paths disabled."""
    code = r'''
import importlib.util, io, json, pathlib, sqlite3, ssl, sys
import numpy as np
from PIL import Image, __version__ as pillow_version
assert sys.flags.isolated and sys.flags.ignore_environment and sys.flags.no_site
assert 'site' not in sys.modules
assert importlib.util.find_spec('pip') is None
np.testing.assert_allclose(np.linalg.solve([[3., 1.], [1., 2.]], [9., 8.]), [2., 3.])
image = Image.fromarray(np.arange(256, dtype=np.uint8).reshape(16, 16))
buffer = io.BytesIO()
image.save(buffer, format='PNG')
buffer.seek(0)
decoded = Image.open(buffer)
assert decoded.mode == 'L' and decoded.size == (16, 16)
assert np.array_equal(np.asarray(decoded), np.arange(256, dtype=np.uint8).reshape(16, 16))
with sqlite3.connect(':memory:') as db:
    db.execute('CREATE TABLE frames (frame_id INTEGER PRIMARY KEY, value TEXT)')
    db.execute('INSERT INTO frames VALUES (1, ?)', ('offline-runtime',))
    assert db.execute('SELECT value FROM frames').fetchone()[0] == 'offline-runtime'
# The assembly directory is outside the final payload layout. Insert only the
# known project sources for this smoke test; installed launches use python313._pth.
sys.path.insert(0, sys.argv[1])
from satellite_studio.domain.rotation import quaternion_to_matrix
from satellite_studio.server.app import create_server
np.testing.assert_allclose(quaternion_to_matrix([0, 0, 0, 1]), np.eye(3))
print(json.dumps({
    'python': sys.version, 'numpy': np.__version__, 'pillow': pillow_version,
    'sqlite': sqlite3.sqlite_version, 'openssl': ssl.OPENSSL_VERSION,
    'isolated': bool(sys.flags.isolated), 'site_enabled': not bool(sys.flags.no_site),
    'pip_present': False, 'numpy_linalg': True, 'png_roundtrip': True,
    'sqlite_roundtrip': True, 'service_import': True,
    'sys_path': sys.path,
}))
'''
    environment = {key: value for key, value in os.environ.items() if not key.upper().startswith("PYTHON")}
    result = subprocess.run(
        [str(runtime / "python.exe"), "-I", "-c", code, str(PROJECT / "python" / "src")],
        cwd=runtime,
        env=environment,
        check=True,
        text=True,
        capture_output=True,
        timeout=60,
    )
    return json.loads(result.stdout)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--downloads", type=Path, default=PROJECT / "var/packaging/downloads/python")
    parser.add_argument("--output", type=Path, default=PROJECT / "var/packaging/runtimes/python")
    parser.add_argument("--python-sha256", required=True)
    args = parser.parse_args()
    downloads, output = args.downloads.resolve(), args.output.resolve()
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite an existing runtime: {output}")
    python_archive = downloads / PYTHON_ARCHIVE
    python_hash = require_hash(python_archive, args.python_sha256)
    sbom = verify_python_sbom(downloads, python_hash)
    wheels = [wheel_metadata(downloads, name, version) for name, version in PACKAGES.items()]
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="python-assembly-", dir=output.parent) as temporary:
        staging = Path(temporary)
        with zipfile.ZipFile(python_archive) as archive:
            checked_members(archive)
            archive.extractall(staging)
        signatures = verify_python_signatures(staging)
        (staging / "python313._pth").write_text(PTH_CONTENT, encoding="utf-8")
        site_packages = staging / "Lib/site-packages"
        for wheel in wheels:
            wheel["record_files_verified"] = extract_wheel(downloads / wheel["filename"], site_packages)
        smoke = smoke_test(staging)
        files = [path for path in staging.rglob("*") if path.is_file()]
        metadata = {
            "schema_version": 1,
            "prepared_at": datetime.now(timezone.utc).isoformat(),
            "runtime_relative_path": "runtime/python",
            "python": {
                "name": "CPython embeddable",
                "version": PYTHON_VERSION,
                "architecture": "win_amd64",
                "url": PYTHON_URL,
                "filename": PYTHON_ARCHIVE,
                "sha256": python_hash,
                "size_bytes": python_archive.stat().st_size,
                "authenticode": signatures,
                "sbom": sbom,
            },
            "wheels": wheels,
            "python_pth": PTH_CONTENT.splitlines(),
            "file_count": len(files),
            "size_bytes": sum(path.stat().st_size for path in files),
            "smoke_test": smoke,
        }
        shutil.copytree(staging, output)
    metadata_path = downloads / "runtime-lock.json"
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"runtime": str(output), "metadata": str(metadata_path), "smoke_test": smoke}, indent=2))


if __name__ == "__main__":
    main()
