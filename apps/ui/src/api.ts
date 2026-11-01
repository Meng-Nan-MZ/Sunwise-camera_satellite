import type { Health, Job, JobSubmission, ModelInfo, NoiseVariantSubmission } from './types';

async function request<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
  const response = await fetch(path, {
    signal,
    cache: 'no-store',
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      data && typeof data === 'object' && 'error' in data
        ? String(data.error)
        : `请求失败（HTTP ${response.status}）`;
    throw new Error(detail);
  }
  if (data === null) throw new Error('本机服务返回了无法读取的响应。');
  return data as T;
}

export const api = {
  health: (signal: AbortSignal) => request<Health>('/api/health', signal),
  models: (signal: AbortSignal) => request<ModelInfo[]>('/api/models', signal),
  jobs: (signal: AbortSignal) => request<Job[]>('/api/jobs', signal),
  job: (id: string, signal: AbortSignal) =>
    request<Job>(`/api/jobs/${encodeURIComponent(id)}`, signal),
  submit: (submission: JobSubmission, signal: AbortSignal) =>
    request<Job>('/api/jobs', signal, submission),
  noiseVariant: (id: string, submission: NoiseVariantSubmission, signal: AbortSignal) =>
    request<Job>(`/api/jobs/${encodeURIComponent(id)}/noise-variants`, signal, submission),
  cancel: (id: string, signal: AbortSignal) =>
    request<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`, signal, {}),
};

export function errorMessage(error: unknown): string {
  if (error instanceof TypeError) return '无法连接本机服务。请确认服务仍在运行，然后重试。';
  return error instanceof Error ? error.message : '发生未知错误。';
}
import type { BridgeTask, BridgeTransport, WorkerLease } from './renderBridge.ts';
import { BridgeHttpError } from './renderBridge.ts';
async function bridgeRequest<T>(
  action: string,
  body: object,
  signal?: AbortSignal,
  keepalive = false,
): Promise<T> {
  const response = await fetch(`/api/render-worker/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(5000),
    cache: 'no-store',
    keepalive,
  });
  const data = await response.json();
  if (!response.ok)
    throw new BridgeHttpError(
      response.status,
      String(data.error ?? `网页采集连接失败（HTTP ${response.status}）`),
    );
  return data as T;
}
export const renderBridgeApi: BridgeTransport = {
  register: (signal) => bridgeRequest<WorkerLease>('register', {}, signal),
  heartbeat: (worker_token, signal) => bridgeRequest('heartbeat', { worker_token }, signal),
  poll: (worker_token, signal) =>
    bridgeRequest<{ task: BridgeTask | null }>('poll', { worker_token }, signal),
  result: (body, signal) => bridgeRequest('result', body, signal),
  release: (worker_token) => bridgeRequest('release', { worker_token }, undefined, true),
};
