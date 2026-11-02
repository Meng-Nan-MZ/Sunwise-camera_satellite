"""Read-only canonical-source eligibility and published-file resolution."""
import hashlib
import json
from pathlib import Path
from satellite_studio.domain.noise_request import NoiseVariantRequest
from satellite_studio.domain.parameters import JobRequest


def snapshot_digest(snapshot: str) -> str:
    return hashlib.sha256(snapshot.encode('utf-8')).hexdigest()


def source_records(store, source_id: str, expected_digest: str | None = None) -> tuple[str, str, list[str]]:
    """Snapshot ordered IDs under a brief DB lock; resolve files per frame later."""
    with store.reading() as db:
        row = db.execute('SELECT * FROM jobs WHERE id=?',(source_id,)).fetchone()
        if row is None:
            raise ValueError('原始来源任务不存在')
        if row['status'] != 'completed' or row['mode'] == 'noise_variant':
            raise ValueError('来源必须是已完成的原始渲染任务')
        request = JobRequest.from_dict(json.loads(row['snapshot']))
        digest = snapshot_digest(row['snapshot'])
        if expected_digest is not None and digest != expected_digest:
            raise ValueError('来源快照摘要不匹配')
        records = db.execute('SELECT frame_id FROM frames WHERE job_id=? ORDER BY frame_id',(source_id,)).fetchall()
        if len(records) != row['total_frames'] or len(records) != row['completed_frames'] or len(records) != request.count:
            raise ValueError('来源完整帧数量与任务不匹配')
        return source_id, digest, [record['frame_id'] for record in records]


def published_source_paths(store, source_id: str, frame_id: str) -> dict[str, Path]:
    from satellite_studio.datasets.export import FRAME_ID
    if not isinstance(frame_id,str) or not FRAME_ID.fullmatch(frame_id):
        raise ValueError('来源帧标识错误')
    paths = {}
    # Only clean, label and pose are inputs; obsolete noisy outputs are independent.
    for kind, folder, ext in (('clean','images_clean','png'),('label','labels','txt'),('pose','poses','json')):
        path = store.published_file(source_id, f'{folder}/{frame_id}.{ext}')
        if path is None:
            raise ValueError(f'来源 {kind} 缺失或未发布')
        paths[kind] = path
    return paths


def canonical_reference(store, selected_id: str):
    """Header/count checks only: polling and POST never walk the file manifest."""
    with store.reading() as db:
        selected = db.execute('SELECT * FROM jobs WHERE id=?',(selected_id,)).fetchone()
        if selected is None:
            raise KeyError(selected_id)
        if selected['status'] != 'completed':
            raise ValueError('所选来源任务尚未完成')
        variant = selected['mode'] == 'noise_variant'
        request = NoiseVariantRequest.from_dict(json.loads(selected['snapshot'])) if variant else None
        source_id = request.source_job_id if variant else selected_id
        row = db.execute('SELECT * FROM jobs WHERE id=?',(source_id,)).fetchone()
        if row is None or row['status'] != 'completed' or row['mode'] == 'noise_variant':
            raise ValueError('原始来源必须是已完成的渲染任务')
        original = JobRequest.from_dict(json.loads(row['snapshot']))
        digest = snapshot_digest(row['snapshot'])
        count = db.execute('SELECT COUNT(*) FROM frames WHERE job_id=?',(source_id,)).fetchone()[0]
        if count != row['total_frames'] or count != row['completed_frames'] or count != original.count:
            raise ValueError('来源帧数量不匹配')
        if variant and (request.source_snapshot_sha256 != digest or request.count != count or selected['total_frames'] != count or selected['completed_frames'] != count):
            raise ValueError('来源版本快照摘要或帧数量不匹配')
        return source_id, digest, count
