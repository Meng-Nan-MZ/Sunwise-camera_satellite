"""Validate the model manifest and expose only public preview metadata."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

import numpy as np

from satellite_studio.domain.camera import fixed_fov_y
from satellite_studio.domain.parameters import IDENTIFIER, number
from satellite_studio.domain.rotation import CLIENT_TO_ENGINE
from satellite_studio import COORDINATE_CONVENTION_ID


SHA256 = re.compile(r"[0-9a-fA-F]{64}")


class ModelCatalog:
    def __init__(self, project_root: Path):
        self.root = project_root.resolve()
        manifest = self.root / "assets/models/index.json"
        self._models: dict[str, dict] = {}
        if not manifest.is_file():
            return
        values = json.loads(manifest.read_text(encoding="utf-8-sig"))
        if not isinstance(values, list):
            raise ValueError("模型清单必须为 JSON 数组")
        for value in values:
            model_id = value.get("id")
            if not isinstance(model_id, str) or not IDENTIFIER.fullmatch(model_id) or model_id in self._models:
                raise ValueError("模型清单包含无效或重复的 ID")
            if "selectable" in value and not isinstance(value["selectable"], bool):
                raise ValueError(f"模型 {model_id} 的 selectable 必须为布尔值")
            fixed_fov_y(number(value.get("radius_m"), "radius_m", 1e-12, 9999))
            transform = np.asarray(value.get("source_to_body"), dtype=float)
            if transform.shape != (4, 4) or not np.isfinite(transform).all():
                raise ValueError(f"模型 {model_id} 坐标变换无效")
            preview_hash = value.get("preview_sha256", value.get("sha256"))
            if not isinstance(preview_hash, str) or not SHA256.fullmatch(preview_hash):
                raise ValueError(f"模型 {model_id} 的预览版本必须为有效 SHA-256")
            model = dict(value)
            model["preview_sha256"] = preview_hash.lower()
            self._models[model_id] = model

    def get(self, model_id: str) -> dict:
        if model_id not in self._models:
            raise ValueError(f"模型不存在: {model_id}")
        return self._models[model_id]

    def require_web_asset(self, model_id: str) -> dict:
        path = self.preview(model_id)
        model = self.get(model_id)
        if path is None:
            raise ValueError(f"模型 {model_id} 的 GLB 资产缺失")
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != model["preview_sha256"]:
            raise ValueError(f"模型 {model_id} 的 GLB SHA256 不匹配")
        return next(item for item in self.public() if item["id"] == model_id)

    def public(self) -> list[dict]:
        fields = (
            "id", "name", "selectable", "configuration", "radius_m", "sha256", "preview_sha256",
            "source_to_body", "installation_source", "preview_material_note",
            "source_coordinate_system", "body_axes_source",
            "source_scale", "source_scale_basis", "physical_scale_calibrated", "scale_note",
            "source_provider", "source_page", "license", "license_url",
            "source_model_id", "source_sha256", "collection_id", "source_grade", "source_note",
        )
        result = []
        for model in self._models.values():
            item = {key: model[key] for key in fields if key in model}
            basis = np.eye(4)
            basis[:3, :3] = CLIENT_TO_ENGINE
            item["source_to_body"] = (basis @ np.array(model["source_to_body"])).tolist()
            item["coordinate_convention_id"] = COORDINATE_CONVENTION_ID
            item["preview_url"] = f"/assets/models/{model['id']}/preview.glb?v={model['preview_sha256']}"
            result.append(item)
        return result

    def preview(self, model_id: str) -> Path | None:
        try:
            model = self.get(model_id)
        except ValueError:
            return None
        path = (self.root / model.get("preview_file", "")).resolve()
        assets_root = (self.root / "assets/models").resolve()
        return path if path.is_relative_to(assets_root) and path.is_file() and path.suffix == ".glb" else None
