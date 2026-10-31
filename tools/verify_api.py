"""Real API/renderer acceptance: single, coverage and continuous captures."""
import argparse
import json
from pathlib import Path
import time
import urllib.request
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python/src"))
from satellite_studio import SCHEMA_VERSION, COORDINATE_CONVENTION_ID, COORDINATE_INFO, CAMERA_COORD_INFO


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--report", type=Path, default=Path(__file__).resolve().parents[1] / "var/verification/api-report.json")
    args = parser.parse_args()

    def request(path, data=None):
        body = None if data is None else json.dumps(data).encode()
        req = urllib.request.Request(args.url + path, body, {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.load(response)

    health = request("/api/health")
    assert health["renderer_available"]
    assert health["schema_version"] == SCHEMA_VERSION
    models = request("/api/models")
    assert len(models) == 6
    scene = {"model_id": "insat_3b", "sat_quat": {"W": 0.9659258263, "X": 0.2588190451, "Y": 0, "Z": 0},
             "distance_m": 10000, "resolution": 1024, "seed": 20260919,
             "noise": {"enabled": True, "gaussian_sigma": .012, "poisson_peak": 96},
             "lighting": {"azimuth_deg": 35, "elevation_deg": 28, "energy": 4}}
    jobs = []
    for mode, count, model_id in [("single", 1, "insat_3b"), ("coverage", 3, "hubble"), ("sequence", 3, "sputnik_1")]:
        scene["model_id"] = model_id
        job = request("/api/jobs", {"mode": mode, "count": count, "scene": scene})
        print(f"Submitted {mode}: {job['id']}", flush=True)
        jobs.append(job)
    started = time.monotonic()
    while time.monotonic() - started < 300:
        updated = [request(f"/api/jobs/{job['id']}") for job in jobs]
        if all(job["status"] in ("completed", "failed", "canceled", "interrupted") for job in updated):
            break
        time.sleep(1)
    else:
        raise AssertionError("Capture API timed out")
    assert all(job["status"] == "completed" for job in updated), updated
    for job in updated:
        assert job["completed_frames"] == job["total_frames"]
        with urllib.request.urlopen(args.url + job["latest_image_url"]) as response:
            assert response.read(8) == b"\x89PNG\r\n\x1a\n"
        for frame_index in range(1, job["total_frames"] + 1):
            pose = request(f"/data/{job['id']}/poses/{frame_index:06d}.json")
            assert pose["schema_version"] == SCHEMA_VERSION
            assert pose["coordinate_convention_id"] == COORDINATE_CONVENTION_ID
            assert pose["CoordinateInfo"] == COORDINATE_INFO and pose["CameraCoordInfo"] == CAMERA_COORD_INFO
            assert pose["Location"]["SatQuat"] == pose["scene"]["sat_quat"]
            assert "quaternion_xyzw" not in json.dumps(pose)
            assert pose["observer_camera"]["K_basis"] == "CV: +X right, +Y down, +Z forward"
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(updated, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": True, "frames": sum(job["completed_frames"] for job in updated)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
