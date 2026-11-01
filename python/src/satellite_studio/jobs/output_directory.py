"""Existing-folder validation. Filesystem probes never run under the store lock."""
import os
from pathlib import Path
import tempfile


def resolve_directory(value: str) -> Path:
    if not isinstance(value, str) or not value.strip() or '\0' in value:
        raise ValueError('数据集保存位置必须是非空的绝对文件夹路径')
    path = Path(value)
    if not path.is_absolute():
        raise ValueError('数据集保存位置必须是绝对文件夹路径')
    return path.resolve(strict=True)


def probe_directory(path: Path) -> None:
    if not path.is_dir():
        raise ValueError(f'数据集保存位置不是现有文件夹：{path}')
    # Actual create/write/fsync/unlink checks permissions and lost drives, rather
    # than trusting os.access (especially on Windows ACLs and network shares).
    with tempfile.NamedTemporaryFile(prefix='.satellite-write-', dir=path) as stream:
        stream.write(b'satellite-studio')
        stream.flush()
        os.fsync(stream.fileno())
