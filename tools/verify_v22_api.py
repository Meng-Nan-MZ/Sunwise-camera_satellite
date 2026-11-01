"""Real V2.2 acceptance: render clean once, then generate noise without Blender."""
from __future__ import annotations

if __name__ == "__main__":
    raise SystemExit("Retired historical Blender QA. Use its original version checkout; V2.4 uses tools/verify_v24_workbench.cjs and tools/verify_v24_images.py. See tools/OFFLINE-AUTHORING.md.")

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python/src"))
from satellite_studio.domain.sampling import frame_seed
from satellite_studio.server.app import create_server


def hashes(directory: Path) -> dict[str, str]:
    return {str(file.relative_to(directory)).replace("\\", "/"): hashlib.sha256(file.read_bytes()).hexdigest()
            for file in sorted(directory.rglob("*")) if file.is_file()}


class Session:
    def __init__(self, workspace: Path, blender: Path | None):
        self.server = create_server(ROOT, workspace, blender, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"

    def request(self, path: str, value: dict | None = None):
        body = None if value is None else json.dumps(value, allow_nan=False).encode("utf-8")
        request = urllib.request.Request(self.origin + path, body, {"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def wait(self, job: dict) -> dict:
        for _ in range(400):
            current = self.request("/api/jobs/" + job["id"])
            if current["status"] == "completed":
                return current
            if current["status"] not in ("queued", "running"):
                raise AssertionError(current)
            time.sleep(.1)
        raise AssertionError("Task timed out")

    def close(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--blender", type=Path, required=True)
    parser.add_argument("--legacy-workspace", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "var/verification/v2.2-api")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError("Choose an empty acceptance directory")
    output.mkdir(parents=True, exist_ok=True)
    workspace = output / "workspace"
    if args.legacy_workspace:
        shutil.copytree(args.legacy_workspace.resolve(), workspace)
    report = {"passed": False, "output": str(output), "variants": []}
    service = None
    try:
        service = Session(workspace, args.blender.resolve())
        assert service.request("/api/health")["renderer_available"]
        legacy = None
        for job in service.request("/api/jobs"):
            if job["status"] == "completed" and job["latest_images"]["noisy"] and not job["noise"]["enabled"]:
                legacy = job
                break
        start = {"W": 1, "X": 0, "Y": 0, "Z": 0}
        end = {"W": float(np.sqrt(.5)), "X": float(np.sqrt(.5)), "Y": 0, "Z": 0}
        scene = {"model_id": "insat_3b", "sat_quat": start, "distance_m": 11380.885731179125,
                 "resolution": 1024, "seed": 20261101, "noise": {"enabled": False},
                 "lighting": {"azimuth_deg": 35, "elevation_deg": 28, "energy": 4}}
        source = service.wait(service.request("/api/jobs", {
            "mode": "custom_sequence", "count": 3, "scene": scene,
            "trajectory": {"start_quat": start, "end_quat": end, "time_step_s": .25}}))
        source_dir = Path(source["output_directory"])
        assert source["latest_images"]["noisy"] is None
        assert not (source_dir / "images_noisy").exists()
        assert len(list((source_dir / "images_clean").glob("*.png"))) == 3
        for file in (source_dir / "poses").glob("*.json"):
            assert "noisy" not in json.loads(file.read_text(encoding="utf-8"))["files"]
        report["source"] = source
        report["other_render_modes"] = []
        for mode in ("single", "coverage", "sequence"):
            job = service.wait(service.request("/api/jobs", {"mode": mode, "count": 1, "scene": scene}))
            assert job["latest_images"]["noisy"] is None
            assert not (Path(job["output_directory"]) / "images_noisy").exists()
            report["other_render_modes"].append(job["id"])
        before = hashes(source_dir)
        legacy_before = hashes(Path(legacy["output_directory"])) if legacy else None
        service.close()
        service = Session(workspace, None)
        assert not service.request("/api/health")["renderer_available"]
        params_a = {"noise": {"enabled": True, "gaussian_sigma": .005, "poisson_peak": 300}, "seed": 7}
        params_b = {"noise": {"enabled": True, "gaussian_sigma": .03, "poisson_peak": 30}, "seed": 8}

        def variant(selected: str, params: dict):
            job = service.wait(service.request(f"/api/jobs/{selected}/noise-variants", params))
            assert job["mode"] == "noise_variant" and job["source_job_id"] == source["id"]
            assert job["noise"] == params["noise"] and job["seed"] == params["seed"]
            folder = Path(job["output_directory"])
            assert not any((folder / name).exists() for name in ("images_clean", "labels", "poses"))
            digest = []
            for index in range(3):
                frame = f"{index + 1:06d}"
                file = folder / "images_noisy" / (frame + ".png")
                with Image.open(file) as image:
                    image.load()
                    assert image.mode == "L" and image.size == (1024, 1024)
                digest.append(hashlib.sha256(file.read_bytes()).hexdigest())
                meta = json.loads((folder / "noise_meta" / (frame + ".json")).read_text(encoding="utf-8"))
                assert meta["schema_version"] == "satellite-noise-1.0"
                assert meta["source_job_id"] == source["id"] and meta["source_frame_id"] == frame
                assert meta["noise"] == params["noise"] and meta["master_seed"] == params["seed"]
                assert meta["noise_seed"] == frame_seed(params["seed"], "insat_3b", frame)
                assert meta["output_sha256"] == digest[-1]
                for key, relative in (("clean", f"images_clean/{frame}.png"),
                                      ("label", f"labels/{frame}.txt"), ("pose", f"poses/{frame}.json")):
                    reference = meta["source_files"][key]
                    assert (folder / reference["path"]).resolve() == (source_dir / relative).resolve()
                    assert reference["sha256"] == before[relative]
            assert job["latest_images"]["clean"] == f"/data/{source['id']}/images_clean/000003.png"
            assert job["latest_images"]["noisy"] == f"/data/{job['id']}/images_noisy/000003.png"
            report["variants"].append({"id": job["id"], "sha256": digest, "parameters": params})
            return job, digest

        first, first_hashes = variant(source["id"], params_a)
        _, different_hashes = variant(first["id"], params_b)
        _, repeated_hashes = variant(source["id"], params_a)
        assert first_hashes == repeated_hashes and first_hashes != different_hashes
        assert hashes(source_dir) == before, "Source bytes or directory entries changed"
        if args.legacy_workspace:
            assert legacy is not None, "Legacy paired noise-off fixture was not found"
            derived = service.wait(service.request(f"/api/jobs/{legacy['id']}/noise-variants", params_a))
            assert derived["source_job_id"] == legacy["id"]
            assert hashes(Path(legacy["output_directory"])) == legacy_before
            report["legacy"] = {"id": legacy["id"], "variant": derived["id"], "source_unchanged": True}
        canceled = service.request(f"/api/jobs/{source['id']}/noise-variants", params_b)
        service.request(f"/api/jobs/{canceled['id']}/cancel", {})
        for _ in range(100):
            canceled = service.request(f"/api/jobs/{canceled['id']}")
            if canceled["status"] in ("canceled", "completed"):
                break
            time.sleep(.05)
        assert canceled["status"] == "canceled", canceled
        report["cancel"] = {"id": canceled["id"], "completed_frames": canceled["completed_frames"]}
        report["source_sha256"] = before
        report["renderer_unavailable"] = True
        report["passed"] = True
        print(json.dumps({"passed": True, "rendered_clean_frames": 6, "variants": len(report["variants"]),
                          "source_unchanged": True, "no_blender": True, "legacy": legacy is not None}))
    finally:
        if service:
            service.close()
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
