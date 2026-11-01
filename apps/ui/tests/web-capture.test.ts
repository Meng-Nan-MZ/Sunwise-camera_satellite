import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubmission } from '../src/scene.ts';
const scene = () => ({
  model_id: 'test',
  sat_quat: { W: 1, X: 0, Y: 0, Z: 0 },
  distance_m: 20000,
  resolution: 1024 as const,
  seed: 1,
  noise: { enabled: false, gaussian_sigma: 0, poisson_peak: 96 },
  lighting: { azimuth_deg: 35, elevation_deg: 28, energy: 4 },
});
test('web backend is frozen into both single and batch submissions', () => {
  for (const mode of ['single', 'coverage', 'sequence'] as const) {
    const request = createSubmission(mode, 2, scene(), undefined, 'threejs');
    assert.equal(request.renderer_backend, 'threejs');
    assert.equal(Object.isFrozen(request), true);
  }
});
test('new captures default to web and reject Blender and unknown backends', () => {
  assert.equal(createSubmission('single', 1, scene()).renderer_backend, 'threejs');
  assert.throws(() => createSubmission('single', 1, scene(), undefined, 'blender'), /Three.js/);
  assert.throws(
    () => createSubmission('single', 1, scene(), undefined, 'unknown' as never),
    /出图方式/,
  );
});
import { readFileSync } from 'node:fs';
import { formalProfile, captureCameraParameters } from '../src/formalProfile.ts';
import { captureFov } from '../src/scene.ts';
test('formal profile matches independently shared backend contract completely', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../tests/fixtures/web-capture-profile.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(formalProfile, fixture);
});
test('capture camera uses fixed square FOV and physically fitted clip planes', () => {
  const camera = captureCameraParameters(50, 10000);
  assert.equal(camera.fov, (captureFov(50) * 180) / Math.PI);
  assert.equal(camera.near, 9900);
  assert.equal(camera.far, 10101);
});
import { runRenderBridge } from '../src/renderBridge.ts';
import type { BridgeTask, BridgeTransport, CaptureDevice } from '../src/renderBridge.ts';
test('stopping during a pending render prevents late results and releases worker resources', async () => {
  const abort = new AbortController();
  let results = 0,
    released = 0,
    disposed = 0,
    captured = 0;
  const transport: BridgeTransport = {
    async register() {
      return { worker_token: 'secret', lease_s: 30, heartbeat_interval_s: 5 };
    },
    async heartbeat() {},
    async poll() {
      return { task: { task_id: 'one', attempt_token: 'attempt' } as BridgeTask };
    },
    async result() {
      results++;
    },
    async release() {
      released++;
    },
  };
  const renderer: CaptureDevice = {
    async capture() {
      captured++;
      abort.abort();
      return { png_base64: 'late', metadata: {} };
    },
    dispose() {
      disposed++;
    },
  };
  await runRenderBridge(transport, renderer, abort.signal);
  assert.equal(captured, 1);
  assert.equal(results, 0);
  assert.equal(released, 1);
  assert.equal(disposed, 1);
});
test('bridge serializes captures and sends independent attempt identity', async () => {
  const abort = new AbortController();
  const sent: object[] = [];
  let index = 0,
    active = 0,
    maximum = 0;
  const transport: BridgeTransport = {
    async register() {
      return { worker_token: 'worker', lease_s: 30, heartbeat_interval_s: 5 };
    },
    async heartbeat() {},
    async poll() {
      index++;
      return { task: { task_id: String(index), attempt_token: `attempt${index}` } as BridgeTask };
    },
    async result(body) {
      sent.push(body);
      if (sent.length === 2) abort.abort();
    },
    async release() {},
  };
  const renderer: CaptureDevice = {
    async capture() {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return { png_base64: 'png', metadata: {} };
    },
    dispose() {},
  };
  await runRenderBridge(transport, renderer, abort.signal);
  assert.equal(maximum, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], {
    worker_token: 'worker',
    task_id: '2',
    attempt_token: 'attempt2',
    png_base64: 'png',
    metadata: {},
  });
});
test('page closure releases lease and GPU immediately even while GLB decode has not returned', async () => {
  const abort = new AbortController();
  let entered!: () => void,
    finish!: (value: { png_base64: string; metadata: Record<string, unknown> }) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<{ png_base64: string; metadata: Record<string, unknown> }>(
    (resolve) => {
      finish = resolve;
    },
  );
  let released = 0,
    disposed = 0;
  const transport: BridgeTransport = {
    async register() {
      return { worker_token: 'worker', lease_s: 30, heartbeat_interval_s: 5 };
    },
    async heartbeat() {},
    async poll() {
      return { task: {} as BridgeTask };
    },
    async result() {
      assert.fail('late result');
    },
    async release() {
      released++;
    },
  };
  const work = runRenderBridge(
    transport,
    {
      capture() {
        entered();
        return pending;
      },
      dispose() {
        disposed++;
      },
    },
    abort.signal,
  );
  await started;
  abort.abort();
  await Promise.resolve();
  try {
    assert.equal(released, 1);
    assert.equal(disposed, 1);
  } finally {
    finish({ png_base64: 'late', metadata: {} });
    await work;
  }
});
import { BridgeHttpError } from '../src/renderBridge.ts';
test('expired attempt response is dropped and never retried under the next identity', async () => {
  const abort = new AbortController();
  const ids: unknown[] = [];
  let index = 0;
  const transport: BridgeTransport = {
    async register() {
      return { worker_token: 'worker', lease_s: 30, heartbeat_interval_s: 5 };
    },
    async heartbeat() {},
    async poll() {
      return { task: { task_id: String(++index), attempt_token: `attempt${index}` } as BridgeTask };
    },
    async result(body) {
      ids.push((body as { task_id: string }).task_id);
      if (ids.length === 1) throw new BridgeHttpError(409, 'canceled');
      abort.abort();
    },
    async release() {},
  };
  await runRenderBridge(
    transport,
    {
      async capture() {
        return { png_base64: 'png', metadata: {} };
      },
      dispose() {},
    },
    abort.signal,
  );
  assert.deepEqual(ids, ['1', '2']);
});
test('independent heartbeat failure interrupts a pending decode and releases the lease', async () => {
  const abort = new AbortController();
  let pulses = 0,
    released = 0,
    disposed = 0;
  const transport: BridgeTransport = {
    async register() {
      return { worker_token: 'worker', lease_s: 30, heartbeat_interval_s: 0.005 };
    },
    async heartbeat() {
      pulses++;
      throw new Error('lease lost');
    },
    async poll() {
      return { task: {} as BridgeTask };
    },
    async result() {
      assert.fail('late result');
    },
    async release() {
      released++;
    },
  };
  const renderer: CaptureDevice = {
    capture(_task, signal) {
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
    dispose() {
      disposed++;
    },
  };
  await assert.rejects(runRenderBridge(transport, renderer, abort.signal), /lease lost/);
  assert.equal(pulses, 1);
  assert.equal(released, 1);
  assert.equal(disposed, 1);
});
import { rendererReadiness } from '../src/scene.ts';
test('submission readiness follows web health and historical Blender is never available', () => {
  const health = {
    status: 'ok' as const,
    schema_version: '4',
    renderer_available: false,
    renderers: {
      blender: { available: false, reason: 'Blender missing' },
      threejs: { available: true, reason: null },
    },
  };
  assert.equal(rendererReadiness(health, 'threejs').available, true);
  assert.equal(rendererReadiness(health, 'blender').available, false);
  assert.match(rendererReadiness(health, 'blender').reason ?? '', /Three.js/);
  const legacy = { status: 'ok' as const, schema_version: '4', renderer_available: true };
  assert.equal(rendererReadiness(legacy, 'blender').available, false);
  assert.equal(rendererReadiness(legacy, 'threejs').available, true);
});

test('web-only health preserves explicit unavailable reason and ignores historical Blender state', () => {
  const health = {
    status: 'ok' as const,
    schema_version: 'satellite-pose-4.0',
    renderer_available: true,
    renderers: { threejs: { available: false, reason: 'worker disconnected' } },
  };
  assert.deepEqual(rendererReadiness(health), { available: false, reason: 'worker disconnected' });
  assert.equal(rendererReadiness(null).available, false);
  assert.equal(rendererReadiness({ ...health, renderers: undefined }).available, true);
  assert.equal(rendererReadiness(health, 'blender').available, false);
});

test('every new capture mode uses web output and freezes explicit noise-off independently of drafts', () => {
  const draft = scene();
  const endpoints = {
    start_quat: { W: 1, X: 0, Y: 0, Z: 0 },
    end_quat: { W: Math.SQRT1_2, X: Math.SQRT1_2, Y: 0, Z: 0 },
  };
  const requests = (['single', 'coverage', 'sequence', 'custom_sequence'] as const).map((mode) =>
    createSubmission(mode, 3, draft, mode === 'custom_sequence' ? endpoints : undefined),
  );
  draft.noise.enabled = true;
  draft.lighting.azimuth_deg = 90;
  endpoints.end_quat.X = 0;
  for (const request of requests) {
    assert.equal(request.renderer_backend, 'threejs');
    assert.equal(request.scene.noise.enabled, false);
    assert.equal(request.scene.lighting.azimuth_deg, 35);
    assert.ok(Object.isFrozen(request));
  }
  assert.equal(requests[0].count, 1);
  assert.ok(Math.abs(requests[3].trajectory!.end_quat.X - Math.SQRT1_2) < 1e-12);
});
