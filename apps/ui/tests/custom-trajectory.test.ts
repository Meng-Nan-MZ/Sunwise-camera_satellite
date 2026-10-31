import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as trajectory from '../src/trajectory.ts';
import { createSubmission } from '../src/scene.ts';
import type { QuaternionTuple, TrajectorySettings } from '../src/types.ts';
const fixtures = JSON.parse(
  readFileSync(
    new URL('../../../tests/fixtures/custom-trajectory-vectors.json', import.meta.url),
    'utf8',
  ),
);
const close = (a: number[], b: number[], eps = 1e-12) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a} != ${b}`));
const q = (v: number[]) => v as QuaternionTuple;
const scene = () => ({
  model_id: 'insat_3b',
  sat_quat: { W: 1, X: 0, Y: 0, Z: 0 },
  distance_m: 20000,
  resolution: 1024 as const,
  seed: 2,
  noise: { enabled: true, gaussian_sigma: 0.012, poisson_peak: 96 },
  lighting: { azimuth_deg: 35, elevation_deg: 28, energy: 4 },
});
const endpoints = (): TrajectorySettings => ({
  start_quat: { W: 2, X: 0, Y: 0, Z: 0 },
  end_quat: { W: Math.SQRT1_2, X: Math.SQRT1_2, Y: 0, Z: 0 },
});
for (const vector of fixtures.cases)
  test(`SLERP shared fixture: ${vector.name}`, () => {
    close(trajectory.slerp(q(vector.start), q(vector.end), 0.5), vector.mid);
    close(trajectory.slerp(q(vector.start), q(vector.end), 0), vector.start);
    assert.ok(
      Math.abs(
        trajectory
          .slerp(q(vector.start), q(vector.end), 1)
          .reduce((s, v, i) => s + v * vector.end[i], 0),
      ) >
        1 - 1e-12,
    );
  });
test('axis rotation has independent linear angular distances and unit length', () => {
  const start = q([0, 0, 0, 1]),
    end = q([0, 0, Math.sin(Math.PI / 3), 0.5]);
  for (let i = 0; i <= 12; i++) {
    const value = trajectory.samplePreview(start, end, 13, i);
    assert.ok(Math.abs(2 * Math.atan2(value[2], value[3]) - (i * Math.PI) / 18) < 1e-12);
    assert.ok(Math.abs(Math.hypot(...value) - 1) < 1e-12);
  }
});
test('pi relative-axis tie is invariant under either endpoint sign', () => {
  const start = q([0.5, 0.5, 0.5, 0.5]),
    end = q([-0.5, 0.5, -0.5, 0.5]);
  const expected = trajectory.slerp(start, end, 0.5);
  for (const a of [1, -1])
    for (const b of [1, -1])
      close(
        trajectory.slerp(q(start.map((v) => v * a)), q(end.map((v) => v * b)), 0.5),
        expected.map((v) => v * a),
      );
});
test('same pose stays static, near-coincident stays normalized, endpoints include count2', () => {
  close(trajectory.samplePreview(q([0, 0, 0, 2]), q([0, 0, 0, -3]), 2, 1), [0, 0, 0, 1]);
  close(trajectory.samplePreview(q([0, 0, 0, 1]), q([1e-10, 0, 0, 1]), 3, 1), [5e-11, 0, 0, 1]);
  close(trajectory.samplePreview(q([0, 0, 0, 1]), q([1, 0, 0, 0]), 2, 1), [1, 0, 0, 0]);
});
test('preview rejects bad endpoints/count and noninteger/out-of-bounds timeline', () => {
  for (const v of [
    [0, 0, 0, 0],
    [NaN, 0, 0, 1],
    [Infinity, 0, 0, 1],
  ])
    assert.throws(() => trajectory.slerp(q(v), q([0, 0, 0, 1]), 0.5));
  for (const n of [1, 0, 100001, 2.5, NaN])
    assert.throws(() => trajectory.samplePreview(q([0, 0, 0, 1]), q([1, 0, 0, 0]), n, 0));
  for (const i of [-1, 3, 0.5, NaN])
    assert.throws(() => trajectory.samplePreview(q([0, 0, 0, 1]), q([1, 0, 0, 0]), 3, i));
  for (const t of [-0.1, 1.1, NaN])
    assert.throws(() => trajectory.slerp(q([0, 0, 0, 1]), q([1, 0, 0, 0]), t));
});
test('custom submission freezes normalized endpoints and scene independently of preview', () => {
  const live = scene(),
    path = endpoints();
  const result = createSubmission('custom_sequence', 120, live, path);
  live.sat_quat.X = 1;
  path.start_quat.X = 1;
  path.end_quat.Y = 1;
  assert.deepEqual(result.trajectory?.start_quat, { W: 1, X: 0, Y: 0, Z: 0 });
  assert.equal(result.trajectory?.end_quat.Y, 0);
  assert.equal(result.trajectory?.time_step_s, 1);
  assert.equal(result.scene.sat_quat.X, 0);
  assert.ok(Object.isFrozen(result.trajectory?.end_quat));
  assert.ok(Object.isFrozen(result.trajectory));
});
test('custom request validates missing/invalid endpoints, count, interval and mode', () => {
  assert.throws(() => createSubmission('custom_sequence', 120, scene()));
  for (const n of [1, 2.5, 100001, NaN])
    assert.throws(() => createSubmission('custom_sequence', n, scene(), endpoints()));
  for (const time_step_s of [0, 1e-7, 3601, NaN])
    assert.throws(() =>
      createSubmission('custom_sequence', 2, scene(), { ...endpoints(), time_step_s }),
    );
  for (const start_quat of [
    { W: 0, X: 0, Y: 0, Z: 0 },
    { W: 1, X: 0, Y: 0 },
    { W: 1, X: 0, Y: 0, Z: 0, extra: 0 },
    { W: '1', X: 0, Y: 0, Z: 0 },
    null,
  ])
    assert.throws(() =>
      createSubmission('custom_sequence', 2, scene(), {
        ...endpoints(),
        start_quat,
      } as TrajectorySettings),
    );
  assert.throws(() => createSubmission('single', 1, scene(), endpoints()));
  assert.equal(createSubmission('custom_sequence', 100000, scene(), endpoints()).count, 100000);
});

test('queued preview ticks cannot advance a paused or obsolete configuration', () => {
  const paused = { active: true, playing: false, frame: 1, key: 'A' };
  assert.deepEqual(trajectory.advancePreview(paused, 'A', 3), paused);
  const stale = { ...paused, playing: true };
  assert.deepEqual(trajectory.advancePreview(stale, 'B', 3), stale);
  assert.deepEqual(trajectory.advancePreview({ ...paused, playing: true }, 'A', 3), {
    active: true,
    playing: false,
    frame: 2,
    key: 'A',
  });
});
