"""Deterministic PBR maps made from supplied foil detail and a solar-cell pattern."""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def normal_from_height(height: np.ndarray, strength: float) -> np.ndarray:
    dy, dx = np.gradient(height)
    normal = np.stack((-dx * strength, dy * strength, np.ones_like(height)), axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    return np.rint((normal * .5 + .5) * 255).astype(np.uint8)


def prepare_textures(source_root: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    foil_path = source_root / "satellite-gps/native/tin foil bump.jpg"
    with Image.open(foil_path) as image:
        height = np.asarray(image.convert("L").resize((1024, 1024)).filter(ImageFilter.GaussianBlur(.7)), dtype=float) / 255
    # Small albedo variation; geometric wrinkles belong in the normal map.
    gold = np.array([197., 140., 50.]) * (.94 + .06 * height[..., None])
    Image.fromarray(np.rint(gold).astype(np.uint8)).save(destination / "mli_gold_color.png")
    Image.fromarray(normal_from_height(height, 5)).save(destination / "mli_normal.png")
    Image.fromarray(np.rint(108 + 24 * height).astype(np.uint8)).save(destination / "mli_roughness.png")

    size = 1024
    y, x = np.mgrid[:size, :size]
    cell_x, cell_y = x % 128, y % 128
    variation = 1 + .04 * np.sin((x // 128) * 2.7 + (y // 128) * 4.2)
    color = np.array([16., 40., 84.])[None, None, :] * variation[..., None]
    border = (cell_x < 4) | (cell_y < 4)
    traces = (cell_y % 16 < 1) & ~border
    busbars = ((cell_x >= 37) & (cell_x <= 39)) | ((cell_x >= 89) & (cell_x <= 91))
    color[traces] = [34, 58, 95]
    color[busbars & ~border] = [122, 142, 170]
    color[border] = [5, 10, 20]
    Image.fromarray(np.rint(color).astype(np.uint8)).save(destination / "solar_cells_color.png")
    relief = np.where(border, 0., .15).astype(float)
    Image.fromarray(normal_from_height(relief, .7)).save(destination / "solar_cells_normal.png")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare_textures(args.sources.resolve(), args.output.resolve())
