"""One-frame noise export. Source files stay in place and are never opened for writing."""
from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
import PIL
import numpy as np
from PIL import Image
from satellite_studio.datasets.export import apply_noise, read_grayscale_png, validate_frame_paths, write_json
from satellite_studio.domain.sampling import frame_seed
from satellite_studio.jobs.noise_sources import published_source_paths, snapshot_digest


def sha256(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def prepare_noise_frame(store, request, job_id: str, frame_id: str, stage: Path) -> dict:
    paths = published_source_paths(store, request.source_job_id, frame_id)
    before = {key:sha256(path) for key,path in paths.items()}
    raw_pose = json.loads(paths['pose'].read_text(encoding='utf-8'))
    pose = validate_frame_paths(paths, frame_id, source_only=True)
    seed = frame_seed(request.seed, pose['model_id'], frame_id)
    pixels = read_grayscale_png(paths['clean'])
    Image.fromarray(apply_noise(pixels, asdict(request.noise), seed)).save(stage / 'noisy.png')
    metadata = {'schema_version':'satellite-noise-1.0', 'job_id':job_id, 'frame_id':frame_id,
                'source_job_id':request.source_job_id, 'source_frame_id':frame_id,
                'noise':asdict(request.noise), 'master_seed':request.seed, 'noise_seed':seed,
                'noise_model':'pixel_domain_poisson_then_gaussian',
                'implementation':{'name':'satellite_studio','version':'2.2.0','numpy':np.__version__,'pillow':PIL.__version__},
                'source_files':{key:{'path':f'../{request.source_job_id}/{raw_pose["files"][key]}','sha256':before[key]} for key in before},
                'output_sha256':sha256(stage/'noisy.png'),
                'files':{'noisy':f'images_noisy/{frame_id}.png','metadata':f'noise_meta/{frame_id}.json'}}
    write_json(stage/'metadata.json',metadata)
    validate_noise_frame(store,request,job_id,frame_id,stage)
    return metadata


def validate_noise_frame(store, request, job_id: str, frame_id: str, stage: Path) -> dict:
    meta = json.loads((stage/'metadata.json').read_text(encoding='utf-8'))
    read_grayscale_png(stage/'noisy.png')
    expected_files = {'noisy':f'images_noisy/{frame_id}.png','metadata':f'noise_meta/{frame_id}.json'}
    expected_keys = {'schema_version','job_id','frame_id','source_job_id','source_frame_id','noise','master_seed','noise_seed','noise_model','implementation','source_files','output_sha256','files'}
    implementation = {'name':'satellite_studio','version':'2.2.0','numpy':np.__version__,'pillow':PIL.__version__}
    if (set(meta) != expected_keys or meta['implementation'] != implementation or meta['schema_version'] != 'satellite-noise-1.0' or meta['job_id'] != job_id or
        meta['frame_id'] != frame_id or meta['source_frame_id'] != frame_id or
        meta['source_job_id'] != request.source_job_id or meta['noise'] != asdict(request.noise) or
        meta['master_seed'] != request.seed or meta['files'] != expected_files or
        meta['noise_model'] != 'pixel_domain_poisson_then_gaussian' or
        meta['output_sha256'] != sha256(stage/'noisy.png')):
        raise ValueError('噪声元数据或输出摘要不匹配')
    paths = published_source_paths(store,request.source_job_id,frame_id)
    if set(meta['source_files']) != set(paths):
        raise ValueError('来源文件集合不匹配')
    for key,path in paths.items():
        expected = f'../{request.source_job_id}/{path.parent.name}/{path.name}'
        if meta['source_files'][key] != {'path':expected,'sha256':sha256(path)}:
            raise ValueError('来源内容已改变或引用不匹配')
    pose = json.loads(paths['pose'].read_text(encoding='utf-8'))
    if meta['noise_seed'] != frame_seed(request.seed,pose['model_id'],frame_id):
        raise ValueError('逐帧噪声种子不匹配')
    with store._lock:
        row = store._db.execute('SELECT snapshot,status FROM jobs WHERE id=?',(request.source_job_id,)).fetchone()
        if row is None or row['status'] != 'completed' or snapshot_digest(row['snapshot']) != request.source_snapshot_sha256:
            raise ValueError('来源任务快照已改变')
    return meta


def commit_noise_frame(store, request, job_id: str, frame_id: str, stage: Path, output: Path) -> list[str]:
    meta = validate_noise_frame(store,request,job_id,frame_id,stage)
    pairs = [('noisy.png',meta['files']['noisy']),('metadata.json',meta['files']['metadata'])]
    if any((output/relative).exists() for _,relative in pairs):
        raise ValueError('噪声帧产物已存在，拒绝覆写')
    for name,relative in pairs:
        target = output/relative
        target.parent.mkdir(parents=True,exist_ok=True)
        os.replace(stage/name,target)
    return [relative for _,relative in pairs]
