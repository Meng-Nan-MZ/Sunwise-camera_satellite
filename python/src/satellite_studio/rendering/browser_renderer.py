"""Strict browser evidence validation and canonical frame metadata."""
from __future__ import annotations

import base64
import binascii
import io
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

from satellite_studio.domain.camera import fixed_fov_y, camera_parameters
from satellite_studio.datasets.export import bbox_to_yolo

# Production profile intentionally independent of the verification fixture.
PROFILE = {
    'profile_id':'threejs-detail-v1', 'three_revision':'180',
    'internal_resolution':2048,'output_resolution':1024,'supersampling':2,
    'output_color_space':'srgb','tone_mapping':'ACESFilmic','exposure':1.2,
    'grayscale':'output_rec709','environment':'RoomEnvironment','environment_intensity':0.35,
    'fill_intensity':0.6,'fill_position_radius':[-3,2,3],
    'shadow_type':'PCFSoftShadowMap','shadow_map_size':2048,'shadow_extent_radius':1.2,
    'shadow_distance_radius':5,'shadow_far_radius':12,'shadow_bias':-0.0001,
    'shadow_normal_bias_radius':0.0005,'downsample':'Lanczos',
}
MAX_PNG = 8 * 1024 * 1024
MAX_METADATA = 65536


def validate_result(body: dict, frame: dict, model: dict) -> tuple[bytes, dict]:
    metadata = body.get('metadata')
    if not isinstance(metadata, dict):
        raise ValueError('metadata 必须为对象')
    if len(json.dumps(metadata, allow_nan=False).encode('utf-8')) > MAX_METADATA:
        raise ValueError('metadata 超过 64 KiB')
    required = {'bbox_xyxy','camera_world','projection_matrix','asset_sha256','three_revision','profile_id','settings','render_ms'}
    if set(metadata) != required:
        raise ValueError('metadata 字段不匹配')
    settings=metadata['settings']
    if not isinstance(settings,dict) or type(settings.get('actual_antialias')) is not bool or set(settings) != set(PROFILE) | {'actual_antialias'}:
        raise ValueError('网页渲染设置不完整')
    # JSON comparison also distinguishes booleans from numeric profile constants.
    expected=dict(PROFILE, actual_antialias=settings['actual_antialias'])
    if json.dumps(settings,sort_keys=True) != json.dumps(expected,sort_keys=True):
        raise ValueError('网页渲染设置不匹配')
    if metadata['profile_id'] != PROFILE['profile_id'] or metadata['three_revision'] != PROFILE['three_revision']:
        raise ValueError('网页配置或引擎版本不匹配')
    if metadata['asset_sha256'] != model['preview_sha256']:
        raise ValueError('网页资产 SHA256 不匹配')
    render_ms=metadata['render_ms']
    if isinstance(render_ms,bool) or not isinstance(render_ms,(int,float)) or not math.isfinite(render_ms) or render_ms < 0:
        raise ValueError('render_ms 无效')
    bbox_to_yolo(metadata['bbox_xyxy'],1024)
    d=frame['distance_m']; r=model['radius_m']; fov=fixed_fov_y(r)
    camera=np.eye(4); camera[2,3]=d
    near=max(.001,d-2*r); far=d+2*r+1; f=1/math.tan(fov/2)
    projection=np.array([[f,0,0,0],[0,f,0,0],[0,0,-(far+near)/(far-near),-2*far*near/(far-near)],[0,0,-1,0]])
    for key, expected_matrix in [('camera_world',camera),('projection_matrix',projection)]:
        matrix=np.asarray(metadata[key],dtype=float)
        if matrix.shape != (4,4) or not np.isfinite(matrix).all() or not np.allclose(matrix,expected_matrix,rtol=1e-10,atol=1e-9):
            raise ValueError(f'{key} 与冻结相机不匹配')
    encoded=body.get('png_base64')
    if not isinstance(encoded,str) or len(encoded) > 4*((MAX_PNG+2)//3):
        raise ValueError('PNG 长度超出限制')
    try:
        raw=base64.b64decode(encoded,validate=True)
    except (binascii.Error,ValueError) as exc:
        raise ValueError('PNG base64 无效') from exc
    if len(raw)>MAX_PNG or not raw.startswith(b'\x89PNG\r\n\x1a\n') or not raw.endswith(b'\x00\x00\x00\x00IEND\xaeB`\x82'):
        raise ValueError('PNG 类型或大小无效')
    try:
        with Image.open(io.BytesIO(raw)) as check:
            check.verify()
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != 'PNG' or image.size != (2048,2048) or image.mode not in ('RGB','RGBA') or getattr(image,'n_frames',1) != 1:
                raise ValueError('网页 PNG 必须为 2048x2048 RGB/RGBA')
            image.load()
            pixels=np.asarray(image)
            if not np.array_equal(pixels[:,:,0],pixels[:,:,1]) or not np.array_equal(pixels[:,:,0],pixels[:,:,2]) or (image.mode=='RGBA' and not np.all(pixels[:,:,3]==255)):
                raise ValueError('网页 PNG 必须为不透明灰度')
            output=io.BytesIO()
            image.resize((1024,1024),Image.Resampling.LANCZOS).convert('L').save(output,format='PNG')
    except (OSError,SyntaxError) as exc:
        raise ValueError('PNG 无法完整解码') from exc
    canonical={
        'bbox_xyxy':metadata['bbox_xyxy'],'radius_m':r,'fov_y_rad':fov,
        'model_sha256':model['preview_sha256'],'source_to_body':model['source_to_body'],
        'observer_camera':camera_parameters(d,1024,fov,camera),
        'renderer':{'name':'Three.js','version':metadata['three_revision'],
            'profile_id':metadata['profile_id'],'settings':settings,'render_ms':render_ms,
            'asset_role':'preview_glb','asset_sha256':model['preview_sha256'],
            'camera_world':metadata['camera_world'],'projection_matrix':metadata['projection_matrix']},
    }
    return output.getvalue(),canonical


class BrowserRenderer:
    def __init__(self, bridge, catalog):
        self.bridge=bridge
        self.catalog=catalog

    def render(self, frame: dict, output_directory: Path) -> dict:
        frozen=dict(frame)
        job_id=frozen.pop('_job_id')
        model=self.catalog.require_web_asset(frozen['model_id'])
        png,metadata=self.bridge.render(frozen,model,job_id)
        (Path(output_directory)/'clean.png').write_bytes(png)
        return metadata

    def close(self) -> None:
        self.bridge.close()
