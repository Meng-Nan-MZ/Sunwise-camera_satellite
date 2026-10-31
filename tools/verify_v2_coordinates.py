"""Real Blender acceptance for client axes, exported metadata and pixel projection."""
import argparse
import json
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python/src"))
from satellite_studio.datasets.export import prepare_frame, validate_frame, commit_frame, read_grayscale_png
from satellite_studio.domain.parameters import JobRequest
from satellite_studio.domain.rotation import CLIENT_TO_ENGINE, quaternion_object, quaternion_array, quaternion_to_matrix
from satellite_studio.domain.sampling import sample_frames
from satellite_studio.rendering.client import BlenderRenderer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--blender", type=Path, required=True)
    parser.add_argument("--project-root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, default=ROOT / "var/verification/v2-coordinates")
    parser.add_argument("--model", default="insat_3b")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cases = [("identity", [0, 0, 0, 1]), ("asymmetric", [.2, -.3, .4, .7])]
    for axis in range(3):
        for sign in (-1, 1):
            q = np.zeros(4)
            q[axis], q[3] = sign / np.sqrt(2), 1 / np.sqrt(2)
            cases.append((f"{'XYZ'[axis]}_{sign * 90:+d}", q))
    report = []
    renderer = BlenderRenderer(args.project_root.resolve(), args.blender, output / "logs")
    try:
        for index, (name, q) in enumerate(cases, 1):
            request = JobRequest.from_dict({"scene": {"model_id": args.model, "sat_quat": quaternion_object(q),
                                                     "distance_m": 10000, "noise": {"enabled": False}}})
            frame = next(sample_frames(request, name))
            frame["frame_id"] = f"{index:06d}"
            stage = output / ".staging" / name
            result = renderer.render(frame, stage)
            pose = prepare_frame(stage, frame, result, request.scene)
            validate_frame(stage, frame["frame_id"])
            assert read_grayscale_png(stage / "clean.png").max() > 0
            np.testing.assert_allclose(quaternion_to_matrix(quaternion_array(pose["Location"]["SatQuat"])),
                                       quaternion_to_matrix(q), atol=1e-12)
            np.testing.assert_allclose(list(pose["Location"]["CamQuat"].values()), [.5, .5, -.5, .5], atol=1e-10)
            # Independent Blender default camera/CV projection of client body points.
            k = np.array(pose["observer_camera"]["K"])
            projection = np.array(pose["observer_camera"]["projection_world_to_pixel"])
            for body_point in ([1., 2., 3.], [-2., .5, 1.], [0., 0., 0.]):
                world = quaternion_to_matrix(q) @ body_point
                engine = CLIENT_TO_ENGINE @ world
                expected = k @ [engine[0], -engine[1], 10000 - engine[2]]
                actual = projection @ [*world, 1]
                np.testing.assert_allclose(actual / actual[2], expected / expected[2], atol=1e-8)
            paths = commit_frame(stage, output, frame["frame_id"])
            report.append({"case": name, "frame_id": frame["frame_id"], "Location": pose["Location"],
                           "bbox_xyxy": pose["bbox_xyxy"], "files": paths})
            print(f"PASS {name} {frame['frame_id']}", flush=True)
    finally:
        renderer.close()
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
