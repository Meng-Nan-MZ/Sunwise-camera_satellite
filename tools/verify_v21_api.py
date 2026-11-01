"""Real Blender acceptance for V2.1 frozen custom pose sequences."""
from __future__ import annotations

if __name__ == "__main__":
    raise SystemExit("Retired historical Blender QA. Use its original version checkout; V2.4 uses tools/verify_v24_workbench.cjs and tools/verify_v24_images.py. See tools/OFFLINE-AUTHORING.md.")

import argparse
import json
from pathlib import Path
import sys
import threading
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python/src"))
from satellite_studio.server.app import create_server
from satellite_studio.domain.rotation import quaternion_array, quaternion_to_matrix


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--blender", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "var/verification/v2.1-api")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError("Use a fresh acceptance output directory")
    output.mkdir(parents=True, exist_ok=True)
    server = create_server(ROOT, output / "workspace", args.blender.resolve(), 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    report = {"passed": False, "jobs": []}

    def request(path, value=None):
        body = None if value is None else json.dumps(value).encode("utf-8")
        req = urllib.request.Request(origin + path, body, {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    def wait(job):
        for _ in range(240):
            current = request("/api/jobs/" + job["id"])
            if current["status"] == "completed":
                return current
            if current["status"] not in ("queued", "running"):
                raise AssertionError(current)
            time.sleep(.25)
        raise AssertionError("Custom job timed out")

    start = {"W": 1, "X": 0, "Y": 0, "Z": 0}
    end = {"W": float(np.sqrt(.5)), "X": float(np.sqrt(.5)), "Y": 0, "Z": 0}
    scene = {"model_id": "insat_3b", "sat_quat": start, "distance_m": 11380.885731179125,
             "resolution": 1024, "seed": 20261101, "noise": {"enabled": False},
             "lighting": {"azimuth_deg": 35, "elevation_deg": 28, "energy": 4}}
    payload = {"mode": "custom_sequence", "count": 3, "scene": scene,
               "trajectory": {"start_quat": start, "end_quat": end, "time_step_s": .25}}
    try:
        job = wait(request("/api/jobs", payload))
        poses = []
        hashes = []
        for index, degrees in enumerate((0, 45, 90)):
            frame_id = f"{index + 1:06d}"
            pose = request(f"/data/{job['id']}/poses/{frame_id}.json")
            q = quaternion_array(pose["Location"]["SatQuat"])
            angle = np.deg2rad(degrees)
            expected_matrix = np.array([[1, 0, 0], [0, np.cos(angle), -np.sin(angle)],
                                        [0, np.sin(angle), np.cos(angle)]])
            np.testing.assert_allclose(quaternion_to_matrix(q), expected_matrix, atol=1e-10)
            assert pose["frame_index"] == index and pose["timestamp_s"] == index * .25
            assert pose["distance_m"] == scene["distance_m"]
            assert pose["scene"]["lighting"] == scene["lighting"]
            assert pose["trajectory"]["type"] == "shortest_path_slerp"
            assert pose["trajectory"]["count"] == 3 and pose["trajectory"]["t"] == index / 2
            np.testing.assert_allclose(list(pose["Location"]["CamQuat"].values()), [.5, .5, -.5, .5])
            file = Path(job["output_directory"]) / "images_clean" / (frame_id + ".png")
            with Image.open(file) as image:
                image.load()
                assert image.mode == "L" and image.size == (1024, 1024)
                assert image.getextrema()[1] > 0
            poses.append(pose)
            hashes.append(__import__("hashlib").sha256(file.read_bytes()).hexdigest())
        assert len({pose["sequence_id"] for pose in poses}) == 1
        assert len(set(hashes)) > 1, "Different controlled poses produced identical images"
        np.testing.assert_allclose(poses[0]["observer_camera"]["K"], poses[-1]["observer_camera"]["K"])
        report["jobs"].append({"id": job["id"], "mode": job["mode"], "frames": 3,
                               "Location": [pose["Location"] for pose in poses]})
        # Queue and cancel a custom request while retaining already completed data.
        canceled = request("/api/jobs", {**payload, "count": 100000})
        result = request(f"/api/jobs/{canceled['id']}/cancel", {})
        for _ in range(240):
            result = request(f"/api/jobs/{canceled['id']}")
            if result["status"] == "canceled":
                break
            time.sleep(.05)
        assert result["status"] == "canceled", result
        report["cancel"] = {"id": canceled["id"], "completed_frames": result["completed_frames"]}
        for mode in ("single", "coverage", "sequence"):
            old = wait(request("/api/jobs", {"mode": mode, "count": 1, "scene": scene}))
            report["jobs"].append({"id": old["id"], "mode": mode, "frames": 1})
        # Existing V2 snapshots can still be reopened alongside a custom request.
        report["passed"] = True
        print(json.dumps({"passed": True, "custom_frames": 3, "existing_modes": 3, "canceled": True}))
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
