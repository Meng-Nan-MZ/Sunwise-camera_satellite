"""Read-only independent GLB geometry and published artifact audit for V2.4 native QA."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from verify_v221_images import glb_vertices, inspect_frame, interpolate, read_json, sha, sheets

ROOT = Path(__file__).resolve().parents[1]


def run(report_path: Path) -> int:
    report = read_json(report_path)
    if not report.get("passed"):
        raise ValueError("Native acceptance report must pass before artifact audit")
    output = Path(report["output"])
    models = {m["id"]: m for m in read_json(ROOT / "assets/models/index.json")}
    geometry = {key: glb_vertices(ROOT / model["preview_file"]) for key, model in models.items()}
    results, failures = [], []
    for job in report["samples"] + report["batches"] + report["mode_runs"]:
        frames = job.get("frames", 1)
        for frame in range(1, frames + 1):
            try:
                request = job["request"]
                pose = read_json(Path(job["output_directory"]) / "poses" / f"{frame:06d}.json")
                trajectory = request.get("trajectory")
                audit_job = job
                if request["mode"] in ("coverage", "sequence"):
                    # Random-path generation is covered by domain tests. Here validate
                    # the saved pose independently against the actual GLB projection.
                    request = dict(request, scene=dict(request["scene"],
                                   distance_m=pose["distance_m"], sat_quat=pose["Location"]["SatQuat"]))
                    audit_job = dict(job, request=request)
                expected = (interpolate(trajectory["start_quat"], trajectory["end_quat"],
                                        (frame - 1) / (frames - 1))
                            if trajectory else request["scene"]["sat_quat"])
                result = inspect_frame(audit_job, frame, expected, models, geometry)
                directory = Path(job["output_directory"])
                label = directory / "labels" / f"{frame:06d}.txt"
                values = label.read_text(encoding="utf-8").split()
                if len(values) != 5 or values[0] != "0":
                    result["errors"].append("Invalid five-column YOLO label")
                else:
                    x0, y0, x1, y1 = result["reference_bbox_xyxy"]
                    expected_label = np.array([(x0+x1)/2048, (y0+y1)/2048,
                                               (x1-x0)/1024, (y1-y0)/1024])
                    if not np.allclose(np.array(values[1:], dtype=float), expected_label, atol=1e-6, rtol=0):
                        result["errors"].append("YOLO differs from independent GLB projection")
                result["label_sha256"] = sha(label)
                if pose["renderer"].get("profile_id") != "threejs-detail-v1":
                    result["errors"].append("Formal image profile changed")
                if not request["scene"]["noise"]["enabled"] and "noisy" in pose["files"]:
                    result["errors"].append("Noise-off duplicate declared")
                results.append(result)
                failures.extend({"job_id": job["job_id"], "frame": frame, "error": error}
                                for error in result["errors"])
            except Exception as exc:
                failures.append({"job_id": job["job_id"], "frame": frame, "error": str(exc)})
    summary = {"passed": not failures, "report": str(report_path.resolve()),
               "report_sha256": sha(report_path), "frames": len(results), "failures": failures,
               "images": results, "comparison_sheets": sheets(results, output),
               "limits": ["Random-mode paths checked by domain tests; image audit projects their saved pose.",
                          "Image statistics are descriptive; screenshots and PNGs need visual inspection."]}
    (output / "image-audit.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": summary["passed"], "frames": len(results), "failures": failures,
                      "output": str(output)}, ensure_ascii=False))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    raise SystemExit(run(parser.parse_args().report))
