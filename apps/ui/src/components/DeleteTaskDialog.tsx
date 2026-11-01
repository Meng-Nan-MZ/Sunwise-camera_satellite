import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../api';
import type { DeletionPreview, DeletionResult, ModelInfo } from '../types';
import { modeLabels, statusLabels } from '../workbench';
import Dialog from './Dialog';
import { reconcileDeletion } from '../deletionRecovery';

export default function DeleteTaskDialog({
  jobId,
  models,
  onClose,
  onDeleted,
  previousAttempt,
  onAttempt,
}: {
  jobId: string;
  models: ModelInfo[];
  onClose: () => void;
  onDeleted: (result: DeletionResult) => void;
  previousAttempt?: string[];
  onAttempt: (ids: string[]) => void;
}) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const action = useRef<AbortController | null>(null);
  const attemptedIds = useRef<string[]>(previousAttempt ?? []);
  useEffect(() => () => action.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setPreview(null);
    void api
      .deletionPreview(jobId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch(async (e) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 404 && attemptedIds.current.length) {
          const result = await reconcileDeletion(attemptedIds.current, (id) =>
            api.job(id, controller.signal),
          );
          if (controller.signal.aborted) return;
          if (result) {
            onDeleted(result);
            return;
          }
        }
        setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [jobId, retry]);
  async function remove() {
    if (!preview?.can_delete || busy || action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy(true);
    setError('');
    attemptedIds.current = preview.jobs.map((job) => job.id);
    onAttempt(attemptedIds.current);
    try {
      const result = await api.deleteJob(jobId, preview.fingerprint, controller.signal);
      if (!controller.signal.aborted) onDeleted(result);
    } catch (e) {
      if (!controller.signal.aborted) {
        const result = await reconcileDeletion(attemptedIds.current, (id) =>
          api.job(id, controller.signal),
        );
        if (controller.signal.aborted) return;
        if (result) {
          onDeleted(result);
          return;
        }
        setError(errorMessage(e));
        // Refresh the affected set, but require another explicit confirmation.
        if (e instanceof ApiError && e.status === 409) setRetry((v) => v + 1);
      }
    } finally {
      action.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <Dialog
      title="删除任务及本地文件"
      onClose={() => {
        if (!busy) onClose();
      }}
      busy={busy}
    >
      <div className="delete-task-dialog">
        <p>将永久删除下列任务及其本地文件夹，包含图片、标注和姿态文件。此操作无法撤销。</p>
        {loading && <p role="status">正在核对任务与关联版本…</p>}
        {preview && (
          <>
            {preview.jobs.length > 1 && (
              <p className="deletion-dependents">
                原图还有 {preview.jobs.length - 1} 个关联噪声版本，将一起删除。
              </p>
            )}
            <ul className="deletion-task-list">
              {preview.jobs.map((job) => (
                <li key={job.id}>
                  <strong>
                    {models.find((m) => m.id === job.model_id)?.name ?? job.model_id} ·{' '}
                    {modeLabels[job.mode]}
                  </strong>
                  <small>
                    {statusLabels[job.status]} · {job.total_frames} 张 ·{' '}
                    {new Date(job.created_at).toLocaleString('zh-CN')}
                  </small>
                  <code>{job.id}</code>
                  <span className="deletion-path">{job.output_directory}</span>
                </li>
              ))}
            </ul>
            {!preview.can_delete && (
              <p className="inline-error" role="alert">
                {preview.blocked_reason}
              </p>
            )}
          </>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {busy && <p role="status">正在删除，请保持窗口打开…</p>}
        <div className="dialog-actions">
          <button className="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          {!loading && (error || !preview?.can_delete) && (
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                setError('');
                setRetry((v) => v + 1);
              }}
            >
              重新核对
            </button>
          )}
          <button
            className="button danger"
            disabled={busy || loading || !preview?.can_delete}
            onClick={() => void remove()}
          >
            {busy ? '正在删除…' : `确认删除${preview ? ` ${preview.jobs.length} 个任务` : ''}`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
