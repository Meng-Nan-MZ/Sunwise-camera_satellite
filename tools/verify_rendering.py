"""Render each registered model once and make a contact sheet for visual QA."""
import argparse
import json
from pathlib import Path
import sys
import time

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python/src"))
from satellite_studio.rendering.client import BlenderRenderer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--blender", type=Path, required=True)
    parser.add_argument("--project-root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, default=ROOT / "var/verification/rendering")
    args = parser.parse_args()
    project_root = args.project_root.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    models = json.loads((project_root / "assets/models/index.json").read_text(encoding="utf-8"))
    renderer = BlenderRenderer(project_root, args.blender, output / "logs")
    report = []
    sheet = Image.new("RGB", (3 * 420, ((len(models) + 2) // 3) * 460), (18, 24, 33))
    draw = ImageDraw.Draw(sheet)
    try:
        for index, model in enumerate(models):
            frame = {"frame_id": "000001", "model_id": model["id"],
                     "sat_quat": {"W": 1, "X": 0, "Y": 0, "Z": 0}, "distance_m": 10000,
                     "resolution": 1024, "seed": 20260919,
                     "lighting": {"azimuth_deg": 35, "elevation_deg": 28, "energy": 4},
                     "noise": {"enabled": True, "gaussian_sigma": .012, "poisson_peak": 96},
                     "sequence_id": None, "frame_index": 0, "timestamp_s": 0}
            started = time.monotonic()
            result = renderer.render(frame, output / model["id"])
            with Image.open(output / model["id"] / "clean.png") as image:
                image.load()
                assert image.size == (1024, 1024) and image.mode == "L", (image.size, image.mode)
                assert image.getextrema()[1] > 0, "Completely black image"
                actual = image.getbbox()
                expected = result["bbox_xyxy"]
                # Dark surfaces and self-occlusion need not reach every geometric
                # extremum; visible pixels must stay inside it (+ antialiasing).
                assert actual and actual[0] >= expected[0] - 2 and actual[1] >= expected[1] - 2, (actual, expected)
                assert actual[2] <= expected[2] + 2 and actual[3] <= expected[3] + 2, (actual, expected)
                sheet.paste(image.resize((420, 420)), ((index % 3) * 420, (index // 3) * 460))
            draw.text(((index % 3) * 420 + 12, (index // 3) * 460 + 432), model["id"], fill="white")
            report.append({"model": model["id"], "seconds": round(time.monotonic() - started, 2), **result})
            print(json.dumps(report[-1]), flush=True)
    finally:
        renderer.close()
    sheet.save(output / "contact-sheet.png")
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
