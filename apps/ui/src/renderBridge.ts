export interface WorkerLease {
  worker_token: string;
  lease_s: number;
  heartbeat_interval_s: number;
}
export interface BridgeTask {
  task_id: string;
  attempt_token: string;
  frame: import('./types.ts').SceneSettings;
  model: import('./types.ts').ModelInfo;
}
export interface CaptureResult {
  png_base64: string;
  metadata: Record<string, unknown>;
}
export interface BridgeTransport {
  register(signal: AbortSignal): Promise<WorkerLease>;
  heartbeat(token: string, signal: AbortSignal): Promise<unknown>;
  poll(token: string, signal: AbortSignal): Promise<{ task: BridgeTask | null }>;
  result(body: object, signal: AbortSignal): Promise<unknown>;
  release(token: string): Promise<unknown>;
}
export interface CaptureDevice {
  capture(task: BridgeTask, signal: AbortSignal): Promise<CaptureResult>;
  dispose(): void;
}

/** A stale/canceled attempt is deliberately dropped; it never retries under another identity. */
export class BridgeHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export async function runRenderBridge(
  transport: BridgeTransport,
  renderer: CaptureDevice,
  signal: AbortSignal,
): Promise<void> {
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  let token = '';
  let released: Promise<unknown> | undefined;
  let disposed = false;
  const cleanup = () => {
    if (!disposed) {
      disposed = true;
      renderer.dispose();
    }
    if (token && !released) released = transport.release(token).catch(() => {});
  };
  lifetime.signal.addEventListener('abort', cleanup, { once: true });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatBusy = false;
  let failure: unknown;
  try {
    const lease = await transport.register(lifetime.signal);
    token = lease.worker_token;
    lifetime.signal.throwIfAborted();
    heartbeat = setInterval(() => {
      if (heartbeatBusy || lifetime.signal.aborted) return;
      heartbeatBusy = true;
      void transport
        .heartbeat(token, lifetime.signal)
        .catch((error: unknown) => {
          failure = error;
          stop();
        })
        .finally(() => {
          heartbeatBusy = false;
        });
    }, lease.heartbeat_interval_s * 1000);
    while (!lifetime.signal.aborted) {
      const { task } = await transport.poll(token, lifetime.signal);
      lifetime.signal.throwIfAborted();
      if (!task) continue;
      const identity = {
        worker_token: token,
        task_id: task.task_id,
        attempt_token: task.attempt_token,
      };
      let result: CaptureResult | { error: string };
      try {
        result = await renderer.capture(task, lifetime.signal);
      } catch (error) {
        lifetime.signal.throwIfAborted();
        result = { error: error instanceof Error ? error.message : '网页出图失败。' };
      }
      lifetime.signal.throwIfAborted();
      try {
        await transport.result({ ...identity, ...result }, lifetime.signal);
      } catch (error) {
        if (!(error instanceof BridgeHttpError && error.status === 409)) throw error;
      }
    }
  } catch (error) {
    if (!signal.aborted) throw failure ?? error;
  } finally {
    stop();
    if (heartbeat !== undefined) clearInterval(heartbeat);
    signal.removeEventListener('abort', stop);
    cleanup();
    await released;
  }
}
