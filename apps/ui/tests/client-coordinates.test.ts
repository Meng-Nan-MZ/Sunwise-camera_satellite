import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import * as scene from '../src/scene.ts';
import type { QuaternionTuple } from '../src/types.ts';

function adapted(q: QuaternionTuple): QuaternionTuple {
  assert.equal(
    typeof scene.toRenderQuaternion,
    'function',
    'V2 needs one render conversion boundary',
  );
  return scene.toRenderQuaternion(q);
}
function near(actual: number[], expected: number[]) {
  actual.forEach((value, i) =>
    assert.ok(Math.abs(value - expected[i]) < 1e-12, `${actual} != ${expected}`),
  );
}
const p = (v: number[]) => [v[0], v[2], v[1]];

for (let axis = 0; axis < 3; axis++) {
  for (const degrees of [-90, 90]) {
    test(`client ${'XYZ'[axis]} ${degrees} degrees maps all body axes into renderer`, () => {
      const angles: [number, number, number] = [0, 0, 0];
      angles[axis] = degrees;
      const q = scene.quaternionFromEuler(angles);
      const expectedQ = [0, 0, 0, Math.SQRT1_2];
      expectedQ[axis] = Math.sign(degrees) * Math.SQRT1_2;
      near(q, expectedQ);
      const engine = new THREE.Quaternion().fromArray(adapted(q));
      const client = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(...[0, 1, 2].map((i) => (i === axis ? 1 : 0))),
        (degrees * Math.PI) / 180,
      );
      for (const v of [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]) {
        near(
          new THREE.Vector3(...p(v)).applyQuaternion(engine).toArray(),
          p(new THREE.Vector3(...v).applyMatrix4(client).toArray()),
        );
      }
    });
  }
}
test('asymmetric intrinsic XYZ composition conjugates by P without reflecting asset geometry', () => {
  const angles: [number, number, number] = [23, -41, 67];
  const [x, y, z] = angles.map((v) => (v * Math.PI) / 180);
  const reference = new THREE.Matrix4()
    .makeRotationX(x)
    .multiply(new THREE.Matrix4().makeRotationY(y))
    .multiply(new THREE.Matrix4().makeRotationZ(z));
  const q = scene.quaternionFromEuler(angles);
  const engine = new THREE.Quaternion().fromArray(adapted(q));
  for (const v of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0.3, -1.7, 2.9],
  ]) {
    near(
      new THREE.Vector3(...p(v)).applyQuaternion(engine).toArray(),
      p(new THREE.Vector3(...v).applyMatrix4(reference).toArray()),
    );
  }
  const negative = adapted(q.map((v) => -v) as QuaternionTuple);
  near(
    new THREE.Vector3(1, 2, 3)
      .applyQuaternion(new THREE.Quaternion().fromArray(negative))
      .toArray(),
    new THREE.Vector3(1, 2, 3).applyQuaternion(engine).toArray(),
  );
});

test('auxiliary client axes reflect only their own helper and keep red X green Y blue Z', async () => {
  const module = await import('../src/renderCoordinates.ts').catch(() => null);
  assert.ok(module, 'V2 client axes helper is missing');
  const helper = module.createClientAxes(1);
  const positions = helper.geometry.getAttribute('position');
  const colors = helper.geometry.getAttribute('color');
  helper.updateMatrixWorld(true);
  for (const [i, expected] of [
    [1, [1, 0, 0]],
    [3, [0, 0, 1]],
    [5, [0, 1, 0]],
  ] as const) {
    near(
      new THREE.Vector3()
        .fromBufferAttribute(positions, i)
        .applyMatrix4(helper.matrixWorld)
        .toArray(),
      [...expected],
    );
    const color = new THREE.Vector3().fromBufferAttribute(colors, i - 1).toArray();
    assert.equal(color.indexOf(Math.max(...color)), (i - 1) / 2);
  }
  assert.equal(helper.matrix.determinant(), -1);
  helper.geometry.dispose();
  (helper.material as THREE.Material).dispose();
});
