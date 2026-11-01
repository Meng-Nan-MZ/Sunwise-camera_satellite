import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { quaternionFromEuler, toRenderQuaternion } from '../src/scene.ts';
import type { EulerTuple, QuaternionTuple } from '../src/types.ts';

const manipulation = await import('../src/poseManipulation.ts').catch(() => null);
function api() {
  assert.ok(manipulation, 'Dragging needs a client-coordinate pose manipulation boundary');
  return manipulation;
}
function rotationNear(actual: QuaternionTuple, expected: QuaternionTuple, tolerance = 1e-10) {
  const a = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...actual));
  const b = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...expected));
  a.elements.forEach((value, i) =>
    assert.ok(Math.abs(value - b.elements[i]) < tolerance, `${actual} != ${expected}`),
  );
}
function near(actual: number[], expected: number[], tolerance = 1e-9) {
  actual.forEach((value, i) =>
    assert.ok(Math.abs(value - expected[i]) < tolerance, `${actual} != ${expected}`),
  );
}

test('arcball drags follow the screen and existing left-handed render boundary', () => {
  const { applyArcballDrag } = api();
  // On a radius-100 trackball, moving 50 px gives a 30-degree screen rotation.
  const right = applyArcballDrag([0, 0, 0, 1], [200, 100], [250, 100], 400, 200);
  const up = applyArcballDrag([0, 0, 0, 1], [200, 100], [200, 50], 400, 200);
  rotationNear(right, quaternionFromEuler([0, 0, -30]));
  rotationNear(up, quaternionFromEuler([30, 0, 0]));
  near(
    new THREE.Vector3(0, 0, 1)
      .applyQuaternion(new THREE.Quaternion(...toRenderQuaternion(right)))
      .toArray(),
    [0.5, 0, Math.sqrt(3) / 2],
  );
  near(
    new THREE.Vector3(0, 0, 1)
      .applyQuaternion(new THREE.Quaternion(...toRenderQuaternion(up)))
      .toArray(),
    [0, 0.5, Math.sqrt(3) / 2],
  );
});

test('drag uses world/screen rotation before an existing asymmetric pose', () => {
  const { applyArcballDrag } = api();
  const start = quaternionFromEuler([23, -41, 67]);
  const next = applyArcballDrag(start, [200, 100], [250, 100], 400, 200);
  const expected = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6)
    .multiply(new THREE.Quaternion(...toRenderQuaternion(start)));
  rotationNear(toRenderQuaternion(next), expected.toArray() as QuaternionTuple);
  near(start, quaternionFromEuler([23, -41, 67]));
});

test('reverse dragging restores arbitrary poses and retains unit length and sign continuity', () => {
  const { applyArcballDrag } = api();
  const start = quaternionFromEuler([56, 122, -168]).map((v) => -v) as QuaternionTuple;
  const from: [number, number] = [155, 53];
  const to: [number, number] = [319, 179];
  const next = applyArcballDrag(start, from, to, 440, 220);
  const restored = applyArcballDrag(next, to, from, 440, 220);
  assert.ok(Math.abs(Math.hypot(...next) - 1) < 1e-14);
  assert.ok(next.reduce((dot, v, i) => dot + v * start[i], 0) >= -1e-14);
  rotationNear(restored, start);
  near(applyArcballDrag(start, from, from, 440, 220), start);
});

test('out-of-canvas and antipodal drags remain finite and reversible', () => {
  const { applyArcballDrag } = api();
  for (const [from, to] of [
    [
      [-1000, 100],
      [1000, 100],
    ],
    [
      [80, -500],
      [650, 900],
    ],
  ] as Array<[[number, number], [number, number]]>) {
    const start = quaternionFromEuler([34, 12, -51]);
    const q = applyArcballDrag(start, from, to, 300, 200);
    assert.ok(q.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-14);
    rotationNear(applyArcballDrag(q, to, from, 300, 200), start);
  }
});

test('straight horizontal and diagonal diameter drags reach their continuous front-hemisphere limit', () => {
  const { applyArcballDrag } = api();
  for (const [u, v] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-0.8, -0.6],
    [0.8, 0.6],
  ]) {
    for (const start of [[0, 0, 0, 1], quaternionFromEuler([23, -41, 67])] as QuaternionTuple[]) {
      const from: [number, number] = [200 + u * 100, 100 - v * 100];
      const opposite: [number, number] = [200 - u * 100, 100 + v * 100];
      const end = applyArcballDrag(start, from, opposite, 400, 200);
      let previousDifference = Infinity;
      for (const epsilon of [1e-4, 1e-6, 1e-8]) {
        const nearEnd = applyArcballDrag(
          start,
          from,
          [200 - u * 100 * (1 - epsilon), 100 + v * 100 * (1 - epsilon)],
          400,
          200,
        );
        const dot = Math.min(
          1,
          Math.abs(end.reduce((total, value, i) => total + value * nearEnd[i], 0)),
        );
        const difference = 2 * Math.acos(dot);
        assert.ok(
          difference < previousDifference,
          'Pose must converge toward the diameter endpoint',
        );
        previousDifference = difference;
      }
      assert.ok(
        previousDifference < 0.0002,
        `Antipodal endpoint jumped by ${previousDifference} radians`,
      );
      const expectedEngine = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(v, -u, 0), Math.PI)
        .multiply(new THREE.Quaternion(...toRenderQuaternion(start)));
      rotationNear(toRenderQuaternion(end), expectedEngine.toArray() as QuaternionTuple);
    }
  }
});

test('Euler readout round-trips random poses in the client convention', () => {
  const { eulerFromQuaternion } = api();
  let state = 243;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 2000; i++) {
    const angles = [random() * 360 - 180, random() * 360 - 180, random() * 360 - 180] as EulerTuple;
    const q = quaternionFromEuler(angles);
    const result = eulerFromQuaternion(q, angles);
    assert.ok(result.every((v) => Number.isFinite(v) && v >= -180 && v <= 180));
    rotationNear(quaternionFromEuler(result), q);
    near(result, angles, 1e-8);
    rotationNear(quaternionFromEuler(eulerFromQuaternion(q.map((v) => -v) as QuaternionTuple)), q);
  }
});

test('Euler extraction remains accurate at and near both gimbal-lock poles', () => {
  const { eulerFromQuaternion } = api();
  for (const y of [-90, 90])
    for (const offset of [0, -1e-10, 1e-10, -1e-6, 1e-6]) {
      for (const [x, z] of [
        [23, 71],
        [-178, 174],
        [139, -123],
      ]) {
        const original: EulerTuple = [x, y + offset, z];
        const q = quaternionFromEuler(original);
        rotationNear(quaternionFromEuler(eulerFromQuaternion(q)), q, 1e-11);
        const withPrevious = eulerFromQuaternion(q, original);
        rotationNear(quaternionFromEuler(withPrevious), q, 1e-11);
        if (offset === 0) near(withPrevious, original, 1e-9);
      }
    }
});

test('Euler selection follows the nearby equivalent branch without quantizing the pose', () => {
  const { eulerFromQuaternion } = api();
  near(eulerFromQuaternion(quaternionFromEuler([20, 91, 35]), [20, 89, 35]), [20, 91, 35]);
  near(eulerFromQuaternion(quaternionFromEuler([-179, 0, 0]), [179, 0, 0]), [-179, 0, 0]);
  const precise: EulerTuple = [12.345678901, -64.123456789, 120.000000123];
  near(eulerFromQuaternion(quaternionFromEuler(precise), precise), precise, 1e-10);
});

test('invalid geometry or quaternion input fails before producing a corrupt pose', () => {
  const { applyArcballDrag, eulerFromQuaternion } = api();
  assert.throws(() => applyArcballDrag([0, 0, 0, 1], [0, 0], [1, 1], 0, 200));
  assert.throws(() => applyArcballDrag([0, 0, 0, 1], [NaN, 0], [1, 1], 200, 200));
  assert.throws(() => eulerFromQuaternion([0, 0, 0, 0]));
  assert.throws(() => eulerFromQuaternion([0, 0, 0, Infinity]));
});
