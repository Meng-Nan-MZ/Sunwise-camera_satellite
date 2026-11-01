"""Read-only GLB/PNG/YOLO audit including native typed-distance UI captures."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from verify_v24_images import run


def audit(report_path: Path) -> int:
    report = json.loads(report_path.read_text(encoding="utf-8-sig"))
    if not report.get("passed"):
        raise ValueError("Native acceptance must pass before image audit")
    for item in report.get("ui_acceptance", {}).get("jobs", []):
        request = item["request"]
        if "scene" not in request:
            continue
        job = item["job"]
        record = {"model": request["scene"]["model_id"], "case": "native-ui",
                  "backend": "threejs", "job_id": job["id"],
                  "output_directory": job["output_directory"], "seconds": 0,
                  "request": request, "frames": job["total_frames"]}
        target = ("samples" if request["mode"] == "single" else
                  "batches" if request["mode"] == "custom_sequence" else "mode_runs")
        report[target].append(record)
    destination = Path(report["output"]) / "image-audit-input.json"
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return run(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    raise SystemExit(audit(parser.parse_args().report))
