import assert from 'node:assert/strict';
import test from 'node:test';
import { captureFov, quaternionFromEuler, createSubmission } from '../src/scene.ts';

test('identity and active +90 degree Z rotation use xyzw order', () => {
  assert.deepEqual(quaternionFromEuler([0, 0, 0]), [0, 0, 0, 1]);
  const q = quaternionFromEuler([0, 0, 90]);
  assert.ok(Math.abs(q[2] - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(q[3] - Math.SQRT1_2) < 1e-12);
});

test('crossing 180 degrees preserves the previous quaternion sign', () => {
  let previous: [number, number, number, number] = [0, 0, 0, 1];
  for (let angle = 0; angle <= 720; angle += 3) {
    const q = quaternionFromEuler([angle, 0, 0], previous);
    assert.ok(q.reduce((sum, v, i) => sum + v * previous[i], 0) > 0);
    assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-12);
    previous = q;
  }
});

test('fixed sphere FOV reserves 20 percent of the shortest frame edge at 10km', () => {
  const fov = captureFov(6000);
  // A 6-8-10 triangle gives tangent radius / (80% of tangent-plane depth) = 6/6.4.
  assert.ok(Math.abs(Math.tan(fov / 2) - 0.9375) < 1e-12);
  assert.throws(() => captureFov(10000));
  assert.throws(() => captureFov(0));
  assert.throws(() => captureFov(NaN));
});

const settings = () => ({
  model_id: 'insat_3b',
  quaternion_xyzw: [0, 0, 0, 1] as [number, number, number, number],
  distance_m: 20000,
  resolution: 1024 as const,
  seed: 20260919,
  noise: { enabled: true, gaussian_sigma: 0.012, poisson_peak: 96 },
  lighting: { azimuth_deg: 35, elevation_deg: 28, energy: 4 },
});

test('submission freezes its own nested scene rather than following live controls', () => {
  const live = settings();
  const snapshot = createSubmission('single', 900, live);
  live.noise.gaussian_sigma = 1;
  live.quaternion_xyzw[0] = 1;
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.scene.noise.gaussian_sigma, 0.012);
  assert.deepEqual(snapshot.scene.quaternion_xyzw, [0, 0, 0, 1]);
  assert.ok(Object.isFrozen(snapshot.scene.lighting));
});

test('invalid physical inputs and non-finite numbers never enter a submission', () => {
  for (const patch of [
    { distance_m: 9999 },
    { distance_m: 30001 },
    { seed: -1 },
    { seed: 4294967296 },
    { seed: 1.5 },
    { distance_m: NaN },
    { quaternion_xyzw: [0, 0, 0, 0] },
    { resolution: 512 },
  ]) {
    assert.throws(() =>
      createSubmission('single', 1, { ...settings(), ...patch } as ReturnType<typeof settings>),
    );
  }
  assert.throws(() => createSubmission('coverage', 0, settings()));
  assert.throws(() => createSubmission('sequence', 1.5, settings()));
});
