"""Read supplied OBJ meshes without losing material-face correspondence."""
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class ObjGeometry:
    vertices: np.ndarray
    uv: list[tuple[float, float]]
    normals: list[tuple[float, float, float]]
    faces: list[list[int]]
    face_uv: list[list[int]]
    face_normals: list[list[int]]


def read_obj(path: Path) -> ObjGeometry:
    vertices, uv, normals, faces, face_uv, face_normals = [], [], [], [], [], []
    with path.open(encoding="utf-8", errors="replace") as stream:
        for line in stream:
            tokens = line.split()
            if not tokens:
                continue
            if tokens[0] == "v":
                vertices.append([float(value) for value in tokens[1:4]])
            elif tokens[0] == "vt":
                uv.append(tuple(float(value) for value in tokens[1:3]))
            elif tokens[0] == "vn":
                normals.append(tuple(float(value) for value in tokens[1:4]))
            elif tokens[0] == "f":
                corners = [token.split("/") for token in tokens[1:]]

                def indices(column, count):
                    values = []
                    for corner in corners:
                        if len(corner) <= column or not corner[column]:
                            values.append(-1)
                            continue
                        index = int(corner[column])
                        values.append(index - 1 if index > 0 else count + index)
                    return values

                faces.append(indices(0, len(vertices)))
                face_uv.append(indices(1, len(uv)))
                face_normals.append(indices(2, len(normals)))
    return ObjGeometry(np.asarray(vertices), uv, normals, faces, face_uv, face_normals)

