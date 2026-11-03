import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserStudio } from '../src/web/studio.ts';
import type { CaptureDevice } from '../src/renderBridge.ts';
import type { ModelInfo } from '../src/types.ts';
const model = {
  id: 'demo',
  name: 'Demo',
  configuration: 'double_panel',
  radius_m: 5,
  preview_url: './demo.glb',
  preview_sha256: 'a'.repeat(64),
  sha256: 'a'.repeat(64),
  source_to_body: [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ],
  installation_source: 'simulation_default',
} as ModelInfo;
const bytes = (n = 3) => new Uint8Array(n).fill(128);
function setup(capture?: CaptureDevice['capture'], limit?: number) {
  let captures = 0,
    disposals = 0,
    processors = 0;
  const studio = new BrowserStudio(
    [model],
    {
      createRenderer: async () => ({
        capture: async (...args) => {
          captures++;
          return capture ? capture(...args) : { png_base64: 'unused', metadata: {} };
        },
        dispose: () => {
          disposals++;
        },
      }),
      pose: () => ({ bbox_yolo: [0.5, 0.5, 0.2, 0.2], truth: 'fixed' }),
      process: async () => {
        processors++;
        return {
          clean: bytes(),
          pixels: new Uint8Array(1024 * 1024).fill(128),
        };
      },
    },
    limit,
  );
  return { studio, counts: () => ({ captures, disposals, processors }) };
}
async function settled(studio: BrowserStudio) {
  const until = Date.now() + 5000;
  while (studio.getState().busy && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.equal(studio.getState().busy, false, 'job should release busy state');
}
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
test('shared configure rejects malformed inputs atomically and starts immutable request', async () => {
  const { studio } = setup();
  const before = studio.getState().draft;
  for (const input of [
    { count: NaN },
    { distance_m: 9999 },
    { seed: -1 },
    { lighting: { energy: 2 } },
    { noise: { enabled: true, gaussian_sigma: 2, poisson_peak: 96 } },
    { mode: 'unknown' },
    { extra: 1 },
  ]) {
    assert.throws(() => studio.configure(input));
    assert.deepEqual(studio.getState().draft, before);
  }
  studio.configure({ mode: 'coverage', count: 2 });
  const job = studio.startCapture();
  assert.equal(studio.getState().busy, true);
  assert.throws(() => studio.startCapture());
  studio.configure({ distance_m: 25000 });
  await settled(studio);
  assert.equal(studio.getJob(job.id).parameters.scene.distance_m, 20000);
  assert.equal(studio.getJob(job.id).status, 'completed');
  studio.dispose();
});
test('cancel in-flight renderer discards late output and preserves complete frames for partial ZIP', async () => {
  const pending = gate<{
    png_base64: string;
    metadata: Record<string, unknown>;
  }>();
  let calls = 0;
  const { studio, counts } = setup(async () =>
    ++calls === 1 ? { png_base64: 'first', metadata: {} } : pending.promise,
  );
  studio.configure({ mode: 'coverage', count: 3 });
  const job = studio.startCapture();
  while (calls < 2) await new Promise((r) => setTimeout(r, 5));
  assert.equal(studio.getJob(job.id).completed_frames, 1);
  studio.cancelJob(job.id);
  assert.throws(() => studio.startCapture());
  pending.resolve({ png_base64: 'late', metadata: {} });
  await settled(studio);
  const summary = studio.getJob(job.id);
  assert.equal(summary.status, 'canceled');
  assert.equal(summary.completed_frames, 1);
  assert.equal(counts().processors, 1);
  assert.equal(counts().disposals, 1);
  const download = studio.prepareDownload(job.id);
  assert.equal(download.ready, true);
  assert.match(download.filename, /-partial.zip$/);
  const zip = await (await fetch(studio.getState().download!.url)).arrayBuffer();
  assert.match(new TextDecoder().decode(zip), /"partial": true/);
  studio.dispose();
});
test('renderer failure retains complete frames, releases busy, permits retry', async () => {
  let calls = 0;
  const { studio } = setup(async () => {
    if (++calls === 2) throw new Error('GPU failed');
    return { png_base64: 'ok', metadata: {} };
  });
  studio.configure({ mode: 'coverage', count: 2 });
  const job = studio.startCapture();
  await settled(studio);
  assert.equal(studio.getJob(job.id).status, 'failed');
  assert.equal(studio.getJob(job.id).completed_frames, 1);
  assert.match(studio.getJob(job.id).error!, /GPU failed/);
  studio.configure({ mode: 'single' });
  const retry = studio.startCapture();
  await settled(studio);
  assert.equal(studio.getJob(retry.id).status, 'completed');
  studio.dispose();
});
test('memory limit refuses incomplete excess frame without exceeding accounting', async () => {
  const { studio } = setup(undefined, 1024 * 1024 + 500);
  studio.configure({ mode: 'coverage', count: 2 });
  const job = studio.startCapture();
  await settled(studio);
  assert.equal(studio.getJob(job.id).status, 'failed');
  assert.equal(studio.getJob(job.id).completed_frames, 1);
  assert.ok(studio.getState().retained_bytes <= studio.getState().memory_limit);
  studio.removeJob(job.id);
  assert.equal(studio.getState().retained_bytes, 0);
  studio.dispose();
});
test('noise variant reuses clean pixels and unchanged pose/labels without rendering, source retained until child removed', async () => {
  const { studio, counts } = setup();
  const source = studio.startCapture();
  await settled(studio);
  const original = studio.getFrame(source.id, 0)!;
  const pose = original.pose.slice(),
    label = original.label.slice(),
    clean = original.clean.slice();
  const variant = studio.addNoiseVariant({
    job_id: source.id,
    noise: { enabled: true, gaussian_sigma: 0.01, poisson_peak: 96 },
    seed: 123,
  });
  await settled(studio);
  assert.equal(studio.getJob(variant.id).status, 'completed');
  assert.deepEqual(counts(), { captures: 1, disposals: 1, processors: 1 });
  const changed = studio.getFrame(variant.id, 0)!;
  assert.deepEqual(changed.clean, clean);
  assert.deepEqual(changed.pose, pose);
  assert.deepEqual(changed.label, label);
  assert.ok(changed.noisy!.length > 0);
  assert.ok(changed.noiseMeta!.length > 0);
  assert.throws(() => studio.removeJob(source.id));
  assert.throws(() =>
    studio.addNoiseVariant({
      job_id: variant.id,
      noise: { enabled: true, gaussian_sigma: 0.01, poisson_peak: 96 },
      seed: 123,
    }),
  );
  studio.removeJob(variant.id);
  studio.removeJob(source.id);
  assert.equal(studio.getState().retained_bytes, 0);
  studio.dispose();
});
test('prepared URL is revoked when source job removed', async () => {
  const { studio } = setup();
  const job = studio.startCapture();
  await settled(studio);
  studio.prepareDownload(job.id);
  const url = studio.getState().download!.url;
  studio.removeJob(job.id);
  assert.equal(studio.getState().download, null);
  await assert.rejects(fetch(url));
  studio.dispose();
});
test('saving a custom sequence endpoint replaces validated frozen draft', () => {
  const { studio } = setup();
  studio.configure({ mode: 'custom_sequence' });
  assert.deepEqual(studio.getState().endpoint_saved, { start: false, end: false });
  studio.saveEndpoint('start');
  const start = studio.getState().draft.trajectory!.start_quat;
  assert.deepEqual(studio.getState().endpoint_saved, { start: true, end: false });
  studio.configure({ euler_deg: [45, 0, 0] });
  assert.deepEqual(studio.getState().draft.trajectory!.start_quat, start);
  assert.deepEqual(studio.getState().endpoint_saved, { start: true, end: false });
  studio.saveEndpoint('end');
  const end = studio.getState().draft.trajectory!.end_quat;
  assert.deepEqual(end, studio.getState().draft.scene.sat_quat);
  assert.deepEqual(studio.getState().endpoint_saved, { start: true, end: true });
  studio.configure({ euler_deg: [90, 15, 0], distance_m: 15000 });
  studio.saveEndpoint('start');
  studio.saveEndpoint('start');
  assert.deepEqual(studio.getState().draft.trajectory!.end_quat, end);
  assert.deepEqual(
    studio.getState().draft.trajectory!.start_quat,
    studio.getState().draft.scene.sat_quat,
  );
  assert.notDeepEqual(studio.getState().draft.trajectory!.start_quat, start);
  assert.deepEqual(studio.getState().endpoint_saved, { start: true, end: true });
  studio.dispose();
});

test('endpoint confirmation follows validated API changes and resets with trajectory', () => {
  const { studio } = setup();
  studio.configure({ mode: 'custom_sequence', start_euler_deg: [10, 20, 30] });
  assert.deepEqual(studio.getState().endpoint_saved, { start: true, end: false });
  const before = studio.getState();
  assert.throws(() => studio.configure({ end_euler_deg: [40, 0, 0], count: 1 }));
  assert.deepEqual(studio.getState(), before);
  studio.configure({ end_euler_deg: [40, 0, 0] });
  assert.deepEqual(studio.getState().endpoint_saved, { start: true, end: true });
  studio.getState().endpoint_saved.start = false;
  assert.equal(studio.getState().endpoint_saved.start, true);
  studio.configure({ mode: 'single' });
  assert.deepEqual(studio.getState().endpoint_saved, { start: false, end: false });
  assert.throws(() => studio.saveEndpoint('start'));
  assert.deepEqual(studio.getState().endpoint_saved, { start: false, end: false });
  studio.configure({ mode: 'custom_sequence' });
  assert.deepEqual(studio.getState().endpoint_saved, { start: false, end: false });
  studio.dispose();
});
test('canceling a noise variant keeps source unchanged and retains only completed variant frames', async () => {
  const { studio } = setup();
  studio.configure({ mode: 'coverage', count: 3 });
  const source = studio.startCapture();
  await settled(studio);
  const originalPoses = [0, 1, 2].map((i) => studio.getFrame(source.id, i)!.pose.slice());
  const unsubscribe = studio.subscribe(() => {
    const variant = studio.getState().jobs.find((j) => j.source_job_id === source.id);
    if (variant?.completed_frames === 1 && variant.status === 'running')
      studio.cancelJob(variant.id);
  });
  const variant = studio.addNoiseVariant({
    job_id: source.id,
    noise: { enabled: true, gaussian_sigma: 0, poisson_peak: 1e7 },
    seed: 23,
  });
  await settled(studio);
  unsubscribe();
  assert.equal(studio.getJob(variant.id).status, 'canceled');
  assert.equal(studio.getJob(variant.id).completed_frames, 1);
  assert.equal(studio.getJob(source.id).status, 'completed');
  assert.equal(studio.getJob(source.id).completed_frames, 3);
  for (let i = 0; i < 3; i++)
    assert.deepEqual(studio.getFrame(source.id, i)!.pose, originalPoses[i]);
  studio.dispose();
});
test(
  'cancel during clean PNG digest discards pending noise frame and releases busy',
  { timeout: 5000 },
  async (t) => {
    const { studio } = setup();
    const source = studio.startCapture();
    await settled(studio);
    const original = structuredClone(studio.getFrame(source.id, 0)!);
    const retainedBefore = studio.getState().retained_bytes;
    const entered = gate<void>();
    const release = gate<void>();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    t.mock.method(
      crypto.subtle,
      'digest',
      async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        // The clean fixture is three bytes; seed derivation hashes a longer string.
        if (data.byteLength === original.clean.byteLength) {
          entered.resolve();
          await release.promise;
        }
        return digest(algorithm, data);
      },
    );
    try {
      const variant = studio.addNoiseVariant({
        job_id: source.id,
        noise: { enabled: true, gaussian_sigma: 0, poisson_peak: 1e7 },
        seed: 23,
      });
      await entered.promise;
      assert.equal(studio.getJob(variant.id).completed_frames, 0);
      studio.cancelJob(variant.id);
      release.resolve();
      await settled(studio);
      assert.equal(studio.getJob(variant.id).status, 'canceled');
      assert.equal(studio.getJob(variant.id).completed_frames, 0);
      assert.equal(studio.getJob(variant.id).bytes, 0);
      assert.equal(studio.getFrame(variant.id, 0), undefined);
      assert.equal(studio.getState().retained_bytes, retainedBefore);
      assert.deepEqual(studio.getFrame(source.id, 0), original);
      assert.equal(studio.getJob(source.id).status, 'completed');
      assert.throws(() => studio.prepareDownload(variant.id));
    } finally {
      release.resolve();
      studio.dispose();
    }
  },
);

test('cancel before renderer creation produces empty canceled job and no download', async () => {
  const { studio, counts } = setup();
  const job = studio.startCapture();
  studio.cancelJob(job.id);
  await settled(studio);
  assert.equal(studio.getJob(job.id).status, 'canceled');
  assert.equal(studio.getJob(job.id).completed_frames, 0);
  assert.equal(counts().captures, 0);
  assert.throws(() => studio.prepareDownload(job.id));
  studio.dispose();
});

test('renderer disposal failure still releases busy and permits another capture', async () => {
  const studio = new BrowserStudio([model], {
    createRenderer: async () => ({
      capture: async () => ({ png_base64: 'unused', metadata: {} }),
      dispose: () => {
        throw new Error('GPU disposal failure');
      },
    }),
    pose: () => ({ bbox_yolo: [0.5, 0.5, 0.2, 0.2] }),
    process: async () => ({ clean: bytes(), pixels: new Uint8Array(1024 * 1024) }),
  });
  const job = studio.startCapture();
  await settled(studio);
  assert.match(studio.getJob(job.id).error!, /GPU disposal failure/);
  const second = studio.startCapture();
  await settled(studio);
  assert.equal(studio.getJob(second.id).completed_frames, 1);
  studio.dispose();
});
