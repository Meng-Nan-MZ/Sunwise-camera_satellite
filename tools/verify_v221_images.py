"""Independent, read-only native PNG / GLB geometry audit of a finished benchmark.

Usage: python tools/verify_v221_images.py var/verification/v2.2.1-benchmark/report.json
Only comparison images and image-audit.json are written, inside report['output'].
No application geometry code is imported. Requires Pillow and NumPy.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
P = np.array([[1., 0., 0.], [0., 0., 1.], [0., 1., 0.]])
CAM = {"W": .5, "X": .5, "Y": -.5, "Z": .5}
TOLERANCE = 1e-4


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def qarray(q):
    a = np.array([q[k] for k in ("W", "X", "Y", "Z")], dtype=float)
    if not np.all(np.isfinite(a)) or abs(np.linalg.norm(a) - 1) > 1e-8:
        raise ValueError("Non-unit or non-finite quaternion")
    return a


def rotation(q):
    w, x, y, z = qarray(q)
    return np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                     [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                     [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])


def same_quat(a, b):
    return abs(float(qarray(a) @ qarray(b))) > 1-1e-9


def interpolate(a, b, t):
    a, b = qarray(a), qarray(b)
    dot = float(a @ b)
    if dot < 0:
        b, dot = -b, -dot
    dot = min(1., max(-1., dot))
    if dot > .9995:
        q = a + t*(b-a)
    else:
        angle = math.acos(dot)
        q = (math.sin((1-t)*angle)*a + math.sin(t*angle)*b)/math.sin(angle)
    q /= np.linalg.norm(q)
    return dict(zip(("W", "X", "Y", "Z"), q.tolist()))


def glb_vertices(path):
    """Decode indexed geometry in the active GLB scene, including node ancestry.

    Intentionally narrow: GLB 2, embedded buffers, float POSITION, triangle lists,
    ordinary integer indices, affine matrix/TRS. Unsupported geometry fails loud.
    Material-only KHR extensions are irrelevant to this geometric calculation.
    """
    raw = Path(path).read_bytes()
    if len(raw) < 20:
        raise ValueError("Truncated GLB")
    magic, version, length = struct.unpack_from("<4sII", raw)
    if magic != b"glTF" or version != 2 or length != len(raw):
        raise ValueError("Unsupported GLB header/version/length")
    chunks, offset = {}, 12
    while offset < length:
        size, kind = struct.unpack_from("<II", raw, offset)
        offset += 8
        if size % 4 or offset+size > length or kind in chunks:
            raise ValueError("Invalid GLB chunk")
        chunks[kind] = raw[offset:offset+size]
        offset += size
    if set(chunks) != {0x4E4F534A, 0x004E4942}:
        raise ValueError("Unsupported GLB chunks")
    doc = json.loads(chunks[0x4E4F534A])
    blob = chunks[0x004E4942]
    if doc.get("asset", {}).get("version") != "2.0":
        raise ValueError("Unsupported glTF asset version")
    allowed = {"KHR_materials_clearcoat", "KHR_materials_specular", "KHR_materials_ior",
               "KHR_materials_transmission", "KHR_materials_emissive_strength",
               "KHR_materials_unlit", "KHR_texture_transform", "KHR_materials_sheen",
               "EXT_texture_webp"}
    unknown = set(doc.get("extensionsUsed", [])) | set(doc.get("extensionsRequired", []))
    if unknown - allowed:
        raise ValueError(f"Unsupported extensions: {sorted(unknown-allowed)}")
    if doc.get("skins") or doc.get("animations"):
        raise ValueError("Skins / animated geometry are unsupported")
    buffers = doc.get("buffers", [])
    if len(buffers) != 1 or "uri" in buffers[0] or not 0 <= len(blob)-buffers[0]["byteLength"] <= 3:
        raise ValueError("Only a single embedded GLB buffer is supported")

    def accessor(index, position=False):
        a = doc["accessors"][index]
        if "sparse" in a or a.get("normalized") or "extensions" in a:
            raise ValueError("Sparse / normalized / extended accessors unsupported")
        if position:
            if a["type"] != "VEC3" or a["componentType"] != 5126:
                raise ValueError("POSITION must be float32 VEC3")
            dtype, width = np.dtype("<f4"), 3
        else:
            if a["type"] != "SCALAR" or a["componentType"] not in (5121, 5123, 5125):
                raise ValueError("Index accessor must be unsigned scalar")
            dtype, width = np.dtype({5121: "u1", 5123: "<u2", 5125: "<u4"}[a["componentType"]]), 1
        view = doc["bufferViews"][a["bufferView"]]
        if view["buffer"] != 0 or view.get("extensions"):
            raise ValueError("Unsupported buffer view")
        stride = view.get("byteStride", dtype.itemsize*width)
        start = view.get("byteOffset", 0) + a.get("byteOffset", 0)
        count = a["count"]
        end = start + max(0, count-1)*stride + dtype.itemsize*width
        if count < 1 or stride < width*dtype.itemsize or end > view.get("byteOffset", 0)+view["byteLength"] or end > buffers[0]["byteLength"]:
            raise ValueError("Accessor outside buffer bounds")
        result = np.ndarray((count, width), dtype=dtype, buffer=blob, offset=start,
                            strides=(stride, dtype.itemsize)).copy()
        if not np.all(np.isfinite(result)):
            raise ValueError("Non-finite geometry")
        return result

    vertices, primitive_count, visited = [], 0, set()

    def visit(index, parent, ancestors):
        nonlocal primitive_count
        if index in ancestors:
            raise ValueError("Cyclic node hierarchy")
        node = doc["nodes"][index]
        if "skin" in node or node.get("weights") or node.get("extensions"):
            raise ValueError("Unsupported node geometry extension / skin / morph")
        if "matrix" in node:
            if any(k in node for k in ("translation", "rotation", "scale")):
                raise ValueError("Node cannot combine matrix and TRS")
            local = np.array(node["matrix"], dtype=float).reshape(4, 4, order="F")
        else:
            x, y, z, w = node.get("rotation", [0, 0, 0, 1])
            local = np.eye(4)
            local[:3, :3] = rotation(dict(W=w, X=x, Y=y, Z=z)) @ np.diag(node.get("scale", [1, 1, 1]))
            local[:3, 3] = node.get("translation", [0, 0, 0])
        if not np.all(np.isfinite(local)) or not np.allclose(local[3], [0, 0, 0, 1], atol=1e-12):
            raise ValueError("Only finite affine node transforms supported")
        world = parent @ local
        visited.add(index)
        if "mesh" in node:
            mesh = doc["meshes"][node["mesh"]]
            if mesh.get("weights"):
                raise ValueError("Morph weights unsupported")
            for primitive in mesh["primitives"]:
                if primitive.get("mode", 4) != 4 or primitive.get("targets") or primitive.get("extensions"):
                    raise ValueError("Only ordinary triangle primitives supported")
                attrs = primitive["attributes"]
                if any(k.startswith(("JOINTS_", "WEIGHTS_")) for k in attrs):
                    raise ValueError("Skinned attributes unsupported")
                xyz = accessor(attrs["POSITION"], position=True).astype(float)
                if "indices" in primitive:
                    indices = accessor(primitive["indices"]).reshape(-1)
                    if len(indices) % 3 or indices.max() >= len(xyz):
                        raise ValueError("Invalid triangle indices")
                    xyz = xyz[np.unique(indices)]
                elif len(xyz) % 3:
                    raise ValueError("Invalid non-indexed triangles")
                vertices.append(xyz @ world[:3, :3].T + world[:3, 3])
                primitive_count += 1
        for child in node.get("children", []):
            visit(child, world, ancestors | {index})

    scene = doc["scenes"][doc.get("scene", 0)]
    for index in scene.get("nodes", []):
        visit(index, np.eye(4), set())
    if not vertices:
        raise ValueError("No mesh geometry in active scene")
    return np.concatenate(vertices), {"sha256": sha(path), "glb_version": version,
        "extensions_used": doc.get("extensionsUsed", []), "active_nodes": len(visited),
        "primitives": primitive_count, "referenced_vertices": sum(map(len, vertices))}


def reference_bounds(vertices, expected, distance, radius):
    # Fixed model framing at 10 km, 80% sphere coverage. Derive f independently.
    f = 1024*.8*math.sqrt(10000**2-radius**2)/(2*radius)
    rotated = vertices @ (P @ rotation(expected) @ P.T).T
    depth = distance-rotated[:, 2]
    if np.any(depth <= 0):
        raise ValueError("Reference geometry crosses camera plane; clipping unsupported")
    xy = np.column_stack((512+f*rotated[:, 0]/depth, 512-f*rotated[:, 1]/depth))
    return np.concatenate((xy.min(axis=0), xy.max(axis=0)))


def inspect_frame(job, frame, expected, models, geometry):
    from PIL import Image
    directory = Path(job["output_directory"])
    pose_path = directory/"poses"/f"{frame:06d}.json"
    pose = read_json(pose_path)
    image_path = directory/pose["files"]["clean"]
    scene = job["request"]["scene"]
    model = models[scene["model_id"]]
    vertices = geometry[model["id"]][0]
    reference = reference_bounds(vertices, expected, scene["distance_m"], model["radius_m"])
    errors = []
    if not same_quat(pose["Location"]["SatQuat"], expected):
        errors.append("SatQuat differs from expected frozen request / trajectory")
    if not same_quat(pose["Location"]["CamQuat"], CAM):
        errors.append("CamQuat differs from expected observation camera")
    if pose["distance_m"] != scene["distance_m"] or pose["model_id"] != model["id"]:
        errors.append("Distance or model differs from request")
    if pose["resolution"] != [1024, 1024]:
        errors.append("Pose resolution differs")
    if job["backend"] == "threejs":
        actual_asset_hash = geometry[model["id"]][1]["sha256"]
        if actual_asset_hash != model["preview_sha256"] or pose.get("model_sha256") != actual_asset_hash or pose.get("renderer", {}).get("asset_sha256") != actual_asset_hash:
            errors.append("GLB hash differs from model index / saved renderer asset")
    for key in ("noise", "lighting"):
        if pose.get("scene", {}).get(key) != scene.get(key):
            errors.append(f"Saved scene {key} differs from frozen request")
    bbox_error = float(np.max(np.abs(np.asarray(pose["bbox_xyxy"])-reference)))
    tolerance = TOLERANCE if job["backend"] == "threejs" else .1
    if bbox_error > tolerance:
        errors.append(f"Geometry bbox error {bbox_error:.9g}px exceeds {tolerance}px")
    with Image.open(image_path) as image:
        if image.format != "PNG" or image.mode != "L" or image.size != (1024, 1024):
            errors.append(f"Expected native PNG L 1024x1024; got {image.format} {image.mode} {image.size}")
        pixels = np.array(image.convert("L"))
    mask = pixels > 0
    if not mask.any():
        errors.append("All-black image")
    nonzero = pixels[mask]
    ys, xs = np.nonzero(mask)
    return {"model": model["id"], "case": job.get("case", "batch"), "backend": job["backend"],
        "frame": frame, "job_id": job["job_id"], "image_path": str(image_path),
        "png_sha256": sha(image_path), "pose_sha256": sha(pose_path),
        "expected_sat_quat": expected, "expected_cam_quat": CAM, "distance_m": scene["distance_m"],
        "reference_bbox_xyxy": reference.tolist(), "pose_bbox_xyxy": pose["bbox_xyxy"],
        "geometry_bbox_max_abs_error_px": bbox_error, "geometry_tolerance_px": tolerance,
        "nonblack_bbox_xyxy_pixel_edges": [int(xs.min()), int(ys.min()), int(xs.max()+1), int(ys.max()+1)] if mask.any() else None,
        "statistics": {"nonblack_pixels": int(mask.sum()), "mean_all": float(pixels.mean()),
            "mean_nonblack": float(nonzero.mean()) if len(nonzero) else 0,
            "nonblack_percentiles_5_50_95": np.percentile(nonzero, [5, 50, 95]).tolist() if len(nonzero) else [],
            "unique_levels": int(len(np.unique(pixels))), "saturated_pixels": int((pixels == 255).sum())},
        "seconds_job_full_save": job["seconds"], "renderer_render_ms": pose.get("renderer", {}).get("render_ms"),
        "errors": errors}


def font(size):
    from PIL import ImageFont
    path = Path("C:/Windows/Fonts/msyh.ttc")
    return ImageFont.truetype(str(path), size) if path.exists() else ImageFont.load_default()


def sheets(samples, output):
    from PIL import Image, ImageDraw
    files = []
    for model in dict.fromkeys(s["model"] for s in samples):
        selected = {}
        for s in samples:
            if s["model"] == model and s["case"] != "batch":
                selected.setdefault((s["case"], s["backend"]), s)
        cases = [c for c in ("identity", "X90", "XYZ25_40_15") if (c, "blender") in selected and (c, "threejs") in selected]
        if not cases:
            continue
        # Native images are pasted 1:1, without annotations over the user pixels.
        canvas = Image.new("RGB", (2048, len(cases)*1096), "#24282e")
        detail = Image.new("RGB", (1024, len(cases)*584), "#24282e")
        for row, case in enumerate(cases):
            for col, backend in enumerate(("blender", "threejs")):
                s = selected[case, backend]
                label = f"{model} | {case} | {s['distance_m']/1000:g} km | {backend} | full save {s['seconds_job_full_save']:.3f} s"
                with Image.open(s["image_path"]) as image:
                    canvas.paste(image, (col*1024, row*1096+72))
                    # Same centered 256px region on both sides; 2x nearest-neighbor.
                    crop = image.crop((384, 384, 640, 640)).resize((512, 512), Image.Resampling.NEAREST)
                    detail.paste(crop, (col*512, row*584+72))
                ImageDraw.Draw(canvas).text((col*1024+12, row*1096+20), label, fill="white", font=font(22))
                ImageDraw.Draw(detail).text((col*512+10, row*584+10), f"{model} | {case} | {backend}", fill="white", font=font(18))
                ImageDraw.Draw(detail).text((col*512+10, row*584+37), "center 256x256; 2x nearest; unchanged intensity", fill="white", font=font(15))
        for suffix, sheet in (("native", canvas), ("center-detail", detail)):
            path = output/f"comparison-{model}-{suffix}.png"
            sheet.save(path)
            files.append(str(path))
    return files


def run(report_path):
    report = read_json(report_path)
    if not report.get("passed"):
        raise ValueError("Benchmark report is not a finished PASS; audit refused")
    output = Path(report["output"])
    models = {m["id"]: m for m in read_json(ROOT/"assets/models/index.json")}
    geometry = {key: glb_vertices(ROOT/m["preview_file"]) for key, m in models.items()}
    results, failures = [], []
    jobs = [(s, 1) for s in report["samples"]] + [(b, b["frames"]) for b in report["batches"]]
    for job, frames in jobs:
        for frame in range(1, frames+1):
            try:
                scene = job["request"]["scene"]
                trajectory = job["request"].get("trajectory")
                expected = interpolate(trajectory["start_quat"], trajectory["end_quat"], (frame-1)/(frames-1)) if trajectory else scene["sat_quat"]
                value = inspect_frame(job, frame, expected, models, geometry)
                results.append(value)
                failures.extend({"job_id": job["job_id"], "frame": frame, "error": e} for e in value["errors"])
            except Exception as exc:
                failures.append({"job_id": job["job_id"], "frame": frame, "error": f"{type(exc).__name__}: {exc}"})
    timing = {}
    for backend in ("threejs", "blender"):
        values = [s["seconds"] for s in report["samples"] if s["backend"] == backend]
        batches = [b for b in report["batches"] if b["backend"] == backend]
        timing[backend] = {"first_sample_full_save_s": values[0], "later_sample_full_save_s": values[1:],
            "later_sample_median_s": float(np.median(values[1:])),
            "explicit_pre_batch_warmup_full_save_s": next((s["seconds"] for s in report["samples"][36:38] if s["backend"] == backend), None),
            "batches": [{"frames": b["frames"], "full_save_s": b["seconds"],
                "seconds_per_frame": b["seconds"]/b["frames"], "fps": b["frames"]/b["seconds"],
                "job_id": b["job_id"]} for b in batches]}
    summary = {"passed": not failures, "benchmark_report": str(report_path.resolve()),
        "benchmark_report_sha256": sha(report_path), "samples_and_batch_frames_audited": len(results),
        "models": {key: value[1] for key, value in geometry.items()}, "failures": failures,
        "timing_informational": timing, "images": results, "comparison_sheets": sheets(results, output),
        "limits": ["PNG luminance statistics are descriptive, not visual quality acceptance.",
            "Blender and Three.js use different material/light pipelines; SSIM is not an acceptance test.",
            "Geometry reference uses actual GLB vertices and request quaternion, never reported bbox.",
            "Reference camera assumes benchmark default camera, fixed model FOV, no clipping.",
            "Timing includes polling, output publication and save; hardware and first/warm state affect it.",
            "First sample is the first timed API sample; UI capture can precede it. Later singles mix model loads and warm captures; explicit pre-batch warmups are separate.",
            "All PNGs and poses are read-only; sheets use unchanged pixel intensities."]}
    (output/"image-audit.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"passed": summary["passed"], "frames": len(results), "failures": failures,
                      "output": str(output), "sheets": summary["comparison_sheets"]}, indent=2))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    raise SystemExit(run(parser.parse_args().report))
