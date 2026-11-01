import type { NativeFolderBridge } from './outputDirectory.ts';
export function openOutputFolder(
  bridge: NativeFolderBridge | undefined,
  jobId: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (!bridge) return Promise.reject(new Error('打开文件夹仅在桌面应用中可用。'));
  if (jobId !== undefined && !/^[a-f0-9]{32}$/.test(jobId))
    return Promise.reject(new Error('任务编号无效。'));
  if (signal.aborted) return Promise.reject(new Error('操作已取消。'));
  const request_id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      bridge.removeEventListener('message', message);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error('操作已取消。'));
    };
    const message = (event: { data: unknown }) => {
      const d = event.data;
      if (!d || typeof d !== 'object' || Array.isArray(d)) return;
      const v = d as Record<string, unknown>;
      if (
        v.type !== 'satellite.output-directory-opened' ||
        v.request_id !== request_id ||
        !Object.hasOwn(v, 'error') ||
        (v.error !== null && typeof v.error !== 'string') ||
        Object.keys(v).some((k) => !['type', 'request_id', 'error'].includes(k))
      )
        return;
      cleanup();
      if (v.error) reject(new Error(String(v.error)));
      else resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('打开文件夹超时，请重试。'));
    }, 15000);
    bridge.addEventListener('message', message);
    signal.addEventListener('abort', abort, { once: true });
    try {
      bridge.postMessage({
        type: 'satellite.open-output-directory',
        request_id,
        target: jobId ? 'job-output' : 'output-root',
        ...(jobId ? { job_id: jobId } : {}),
      });
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}
