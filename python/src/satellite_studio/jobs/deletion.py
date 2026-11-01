"""Owned job-directory deletion, with durable retry evidence kept in SQLite.

Never accepts a client path. Windows directory handles deny rename/delete while
walking children; reparse points are rejected rather than traversed. Other
platforms are refused before any deletion intent or filesystem mutation.
"""
from contextlib import contextmanager, ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat


class DeletionError(ValueError):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.status = code, status


def unsafe(message: str):
    raise DeletionError('UNSAFE_OUTPUT_DIRECTORY', message)


def _lstat(path: Path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        unsafe(f'目录中存在符号链接或重解析点，未删除：{path}')
    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
        unsafe(f'目录中存在不支持的文件类型，未删除：{path}')
    return info


def _identity(info) -> list[int]:
    return [info.st_dev, info.st_ino]


def directory_identity(root: Path, directory: Path) -> list[int]:
    return _identity(_lstat(root)) + _identity(_lstat(directory))


@contextmanager
def _pinned_directory(path: Path):
    """Keep a Windows directory from being replaced between check and traversal."""
    before = _lstat(path)
    if not stat.S_ISDIR(before.st_mode):
        unsafe(f'任务输出位置不是文件夹：{path}')
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                       wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    # OPEN_REPARSE_POINT + BACKUP_SEMANTICS, share READ/WRITE but not DELETE.
    handle = create(str(path), 0, 3, None, 3, 0x02200000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        after = _lstat(path)
        if _identity(before) != _identity(after):
            unsafe(f'任务目录在检查期间发生变化：{path}')
        yield
    finally:
        close(handle)


@contextmanager
def pinned_root(root: Path):
    if not root.is_absolute() or '..' in root.parts or '.' in root.parts:
        unsafe('任务保存位置不是安全的绝对路径')
    with ExitStack() as stack:
        for ancestor in reversed((root, *root.parents)):
            stack.enter_context(_pinned_directory(ancestor))
        if root.resolve(strict=True) != root:
            unsafe('任务保存位置已被重定向')
        yield


def _check_tree(directory: Path):
    with _pinned_directory(directory):
        for child in directory.iterdir():
            info = _lstat(child)
            if stat.S_ISDIR(info.st_mode):
                _check_tree(child)


def validate_owned_directory(root: Path, directory: Path, snapshot: str,
                             ownership: dict | None, intent: dict | None):
    if directory.parent != root or not re.fullmatch('[a-f0-9]{32}', directory.name):
        unsafe('任务输出目录不属于该任务')
    try:
        info = _lstat(directory)
    except FileNotFoundError:
        # The caller already pinned/validated the parent. A missing drive/root
        # never reaches this branch. Missing job data can safely leave the list.
        return None
    if not stat.S_ISDIR(info.st_mode) or directory.resolve(strict=True).parent != root:
        unsafe('任务输出目录不属于已保存的数据集位置')
    identity = directory_identity(root, directory)
    expected = intent['identity'] if intent else ownership['identity'] if ownership else None
    if (intent is not None or ownership is not None) and expected != identity:
        unsafe('任务文件夹已被替换，不能确认目录归属')
    _check_tree(directory)
    if intent is None:
        try:
            if json.loads((directory / 'job.json').read_text('utf-8')) != json.loads(snapshot):
                unsafe('任务目录中的 job.json 与保存的任务快照不一致')
            if ownership is not None:
                marker = json.loads((directory / '.satellite-owner.json').read_text('utf-8'))
                if marker != {'job_id': directory.name, 'token': ownership['token']}:
                    unsafe('任务目录归属标记不匹配')
        except (FileNotFoundError, UnicodeError, json.JSONDecodeError) as exc:
            raise DeletionError('UNSAFE_OUTPUT_DIRECTORY', '无法验证任务目录归属；任务记录已保留') from exc
    return identity


def _remove_windows(directory: Path, expected_identity: list[int]):
    with _pinned_directory(directory):
        # Compare the DB-owned identity only after acquiring the no-delete-share
        # handle. A path replacement between preflight and pin cannot inherit
        # permission to delete merely by remaining stable during the pin call.
        if directory_identity(directory.parent, directory) != expected_identity:
            unsafe('任务文件夹在删除前被替换，已停止删除')
        # Keep the manifest and ownership marker until the end for diagnostics.
        children = sorted(directory.iterdir(), key=lambda p: p.name in ('job.json', '.satellite-owner.json'))
        for child in children:
            info = _lstat(child)
            if stat.S_ISDIR(info.st_mode):
                _remove_windows(child, _identity(_lstat(directory)) + _identity(info))
            else:
                child.unlink()
    # rmdir never recursively follows a replacement junction after handle close.
    directory.rmdir()


def remove_owned_directory(directory: Path, identity: list[int] | None):
    if os.name != 'nt':
        raise DeletionError('UNSUPPORTED_DELETE_PLATFORM', '当前仅支持在 Windows 中安全删除任务文件夹。')
    try:
        actual = directory_identity(directory.parent, directory)
    except FileNotFoundError:
        return
    if identity is None or actual != identity:
        unsafe('任务文件夹在删除前被替换，已停止删除')
    _remove_windows(directory, identity)


def deletion_preview(store, job_id: str) -> dict:
    with store._lock:
        rows = {row['id']: dict(row) for row in store._db.execute('SELECT * FROM jobs')}
        if job_id not in rows:
            raise KeyError(job_id)
        children = {}
        for row in rows.values():
            if row['mode'] == 'noise_variant':
                try:
                    parent = json.loads(row['snapshot'])['source_job_id']
                    if not isinstance(parent, str) or not re.fullmatch('[a-f0-9]{32}', parent):
                        raise ValueError('invalid source')
                except (ValueError, KeyError, TypeError) as exc:
                    raise DeletionError('DELETE_GRAPH_INVALID', '噪声依赖记录无效，不能安全确定删除范围') from exc
                children.setdefault(parent, []).append(row['id'])
        ids, seen = [job_id], {job_id}
        for current in ids:
            for child in sorted(children.get(current, [])):
                if child not in seen:
                    seen.add(child)
                    ids.append(child)
        jobs, frozen = [], []
        for selected in ids:
            row = rows[selected]
            snapshot = json.loads(row['snapshot'])
            source = rows.get(snapshot.get('source_job_id')) if row['mode'] == 'noise_variant' else row
            original = json.loads(source['snapshot']) if source else {}
            jobs.append({'id': selected, 'mode': row['mode'], 'status': row['status'],
                         'model_id': original.get('scene', {}).get('model_id'),
                         'created_at': row['created_at'], 'total_frames': row['total_frames'],
                         'output_directory': str(store.output_directory(selected))})
            frozen.append([selected, row['mode'], row['status'], row['snapshot'], row['output_root']])
        fingerprint = '"' + hashlib.sha256(json.dumps(frozen, ensure_ascii=False).encode()).hexdigest() + '"'
        active = any(job['status'] not in ('completed', 'failed', 'canceled', 'interrupted') for job in jobs)
        return {'job_id': job_id, 'jobs': jobs, 'can_delete': not active,
                'blocked_reason': '任务或关联噪声版本正在排队/运行，请先取消并等待结束。' if active else None,
                'fingerprint': fingerprint}


def delete_jobs(store, job_id: str, fingerprint: str | None) -> dict:
    if os.name != 'nt':
        raise DeletionError('UNSUPPORTED_DELETE_PLATFORM', '当前仅支持在 Windows 中安全删除任务文件夹。')
    # Lock order is lifecycle -> store._lock. File I/O never holds store._lock;
    # other jobs remain readable/cancelable while creation/deletion serialize.
    with store._lifecycle_lock:
        preview = deletion_preview(store, job_id)
        if not fingerprint:
            raise DeletionError('DELETE_PREVIEW_REQUIRED', '请先查看删除范围并确认。', 428)
        if fingerprint != preview['fingerprint']:
            raise DeletionError('DELETE_PLAN_CHANGED', '任务或关联噪声版本已变化，请重新确认删除范围。')
        if not preview['can_delete']:
            raise DeletionError('JOB_ACTIVE', preview['blocked_reason'])
        ids = [job['id'] for job in preview['jobs']]
        try:
            with store._lock:
                directories = {row[0]: store.output_directory(row[0])
                               for row in store._db.execute('SELECT id FROM jobs').fetchall()}
                for selected in ids:
                    for other, candidate in directories.items():
                        if other != selected and candidate.is_relative_to(directories[selected]):
                            unsafe('任务目录中嵌套了另一任务的输出文件夹，请先单独删除内层任务。')
            with ExitStack() as stack:
                plans, pinned = [], set()
                for selected in reversed(ids):
                    with store._lock:
                        row = store._db.execute('SELECT snapshot FROM jobs WHERE id=?', (selected,)).fetchone()
                        directory = store.output_directory(selected)
                        own = store._db.execute('SELECT identity,token FROM job_output_ownership WHERE job_id=?', (selected,)).fetchone()
                        pending = store._db.execute('SELECT identity FROM deletion_intents WHERE job_id=?', (selected,)).fetchone()
                    root = directory.parent
                    if root not in pinned:
                        stack.enter_context(pinned_root(root))
                        pinned.add(root)
                    ownership = {'identity': json.loads(own['identity']), 'token': own['token']} if own else None
                    intent = {'identity': json.loads(pending['identity'])} if pending else None
                    identity = validate_owned_directory(root, directory, row['snapshot'], ownership, intent)
                    plans.append((selected, directory, identity))
                # Persist verified directory identities before the first unlink.
                # A partial failure/crash leaves all jobs + frame markers intact.
                with store._lock, store._db:
                    for selected, _, identity in plans:
                        store._db.execute('INSERT INTO deletion_intents(job_id,identity) VALUES (?,?) '
                                          'ON CONFLICT(job_id) DO NOTHING', (selected, json.dumps(identity)))
                for _, directory, identity in plans:
                    remove_owned_directory(directory, identity)
                with store._lock, store._db:
                    for selected in ids:
                        for table in ('frames', 'job_output_ownership', 'deletion_intents'):
                            store._db.execute(f'DELETE FROM {table} WHERE job_id=?', (selected,))
                        store._db.execute('DELETE FROM jobs WHERE id=?', (selected,))
        except DeletionError:
            raise
        except (OSError, sqlite3.Error) as exc:
            raise DeletionError('DELETE_FAILED',
                                '文件夹删除未完成，任务记录已保留；请检查文件占用或保存位置后重试。', 500) from exc
        return {'deleted_job_ids': ids, 'deleted_count': len(ids)}
