import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

const geometryModule = await import('../src/captureGeometry.ts').catch(() => null);
function bounds(root: THREE.Object3D, camera = makeCamera(), resolution = 1024) {
  assert.ok(geometryModule, 'captureGeometry module must implement projected mesh bounds');
  return geometryModule.projectCaptureBounds(root, camera, resolution);
}
function makeCamera() {
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  camera.position.z = 4;
  return camera;
}
function mesh(vertices = [-1, -1, 0, 1, -1, 0, 0, 1, 0]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}
function near(actual: number[], expected: number[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-8, `${actual} != ${expected}`));
}

test('known triangle yields continuous image edges, y down, no integer rounding', () => {
  // fov=90 => x_ndc=x/(4-z), y_ndc=y/(4-z).
  near(bounds(mesh()), [384, 384, 640, 640]);
  near(bounds(mesh(), makeCamera(), 101), [37.875, 37.875, 63.125, 63.125]);
});

test('uses each actual vertex rather than geometry AABB corners', () => {
  // Near vertex is on x=0; fictitious AABB corner (1,*,2) would overestimate x.
  near(bounds(mesh([-1, -1, 0, 1, -1, 0, 0, 1, 2])), [384, 256, 640, 640]);
});

test('composes parent transforms and translated camera without reapplying asset basis', () => {
  const parent = new THREE.Group();
  parent.position.set(1, 2, 0);
  const root = new THREE.Group();
  root.rotation.z = Math.PI / 2;
  root.scale.set(2, 1, 1);
  root.add(mesh());
  parent.add(root);
  const camera = makeCamera();
  camera.position.set(1, 2, 8);
  // World-camera xy: (1,-2), (1,2), (-1,0); depth 8.
  near(bounds(root, camera), [448, 384, 576, 640]);
});

test('camera rotation is honored, including its parent transform', () => {
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  const parent = new THREE.Group();
  parent.position.x = 4;
  parent.rotation.y = Math.PI / 2;
  parent.add(camera);
  // Looks down world -X; camera x corresponds world -Z.
  near(bounds(mesh([0, -1, 1, 0, -1, -1, 0, 1, 0]), camera), [384, 384, 640, 640]);
});

test('index and draw range exclude unused and unsubmitted extreme vertices', () => {
  const object = mesh([-1, -1, 0, 1, -1, 0, 0, 1, 0, 100, 100, 0]);
  object.geometry.setIndex([3, 3, 3, 0, 1, 2]);
  object.geometry.setDrawRange(3, 3);
  near(bounds(object), [384, 384, 640, 640]);
});

test('nonindexed range starts a new triangle at its actual first vertex', () => {
  const object = mesh([100, 100, 0, -1, -1, 0, 1, -1, 0, 0, 1, 0, 100, 100, 0]);
  object.geometry.setDrawRange(1, 4); // Final incomplete primitive is not drawn.
  near(bounds(object), [384, 384, 640, 640]);
});

test('material-array groups intersect draw range and skip invisible materials', () => {
  const object = mesh([-1, -1, 0, 1, -1, 0, 0, 1, 0, 100, 100, 0, 101, 100, 0, 100, 101, 0]);
  const hidden = new THREE.MeshBasicMaterial();
  hidden.visible = false;
  const grouped = new THREE.Mesh(object.geometry, [object.material, hidden]);
  grouped.geometry.addGroup(0, 3, 0);
  grouped.geometry.addGroup(3, 3, 1);
  grouped.geometry.setDrawRange(0, 6);
  near(bounds(grouped), [384, 384, 640, 640]);
  grouped.geometry.setDrawRange(3, 3);
  assert.throws(() => bounds(grouped), /triangle/i);
});

test('single material ignores groups, array material without groups draws nothing', () => {
  const object = mesh();
  object.geometry.addGroup(0, 0, 0);
  near(bounds(object), [384, 384, 640, 640]);
  assert.throws(() => bounds(new THREE.Mesh(mesh().geometry, [object.material])), /triangle/i);
});

test('ancestor visibility and camera layers exclude inactive geometry', () => {
  const root = new THREE.Group();
  root.add(mesh());
  const hidden = new THREE.Group();
  hidden.visible = false;
  hidden.add(new THREE.Line(mesh().geometry));
  root.add(hidden);
  const outside = mesh([100, 100, 0, 101, 100, 0, 100, 101, 0]);
  outside.layers.set(1);
  root.add(outside);
  near(bounds(root), [384, 384, 640, 640]);
  root.visible = false;
  assert.throws(() => bounds(root), /triangle/i);
});

test('invisible ancestor outside supplied root also suppresses drawing', () => {
  const parent = new THREE.Group();
  const object = mesh();
  parent.visible = false;
  parent.add(object);
  assert.throws(() => bounds(object), /triangle/i);
});

for (const [name, vertices] of [
  ['behind camera', [-1, -1, 5, 1, -1, 5, 0, 1, 5]],
  ['outside image', [-10, -1, 0, 1, -1, 0, 0, 1, 0]],
  ['near clipped', [-0.01, -0.01, 3.95, 0.01, -0.01, 3.95, 0, 0.01, 3.95]],
  ['far clipped', [-1, -1, -101, 1, -1, -101, 0, 1, -101]],
  ['nonfinite position', [NaN, -1, 0, 1, -1, 0, 0, 1, 0]],
] as const) {
  test(`rejects ${name} rather than silently clipping labels`, () => {
    assert.throws(() => bounds(mesh([...vertices])));
  });
}

test('exact image edges are valid and do not acquire a pixel offset', () => {
  near(bounds(mesh([-4, -4, 0, 4, -4, 0, 0, 4, 0])), [0, 0, 1024, 1024]);
});

test('rejects empty and degenerate triangle sets', () => {
  assert.throws(() => bounds(new THREE.Group()), /triangle/i);
  assert.throws(() => bounds(mesh([0, 0, 0, 0, 0, 0, 0, 0, 0])), /triangle/i);
});

test('rejects invalid active indices and nonfinite transforms', () => {
  const object = mesh();
  object.geometry.setIndex([0, 1, 20]);
  assert.throws(() => bounds(object));
  object.geometry.setIndex(null);
  object.position.x = Infinity;
  assert.throws(() => bounds(object));
});

for (const kind of ['line', 'points', 'skinned', 'instanced', 'morph', 'wireframe'] as const) {
  test(`rejects active unsupported ${kind} geometry`, () => {
    const triangle = mesh();
    let object: THREE.Object3D = triangle;
    if (kind === 'line') object = new THREE.Line(triangle.geometry);
    if (kind === 'points') object = new THREE.Points(triangle.geometry);
    if (kind === 'skinned') object = new THREE.SkinnedMesh(triangle.geometry, triangle.material);
    if (kind === 'instanced')
      object = new THREE.InstancedMesh(triangle.geometry, triangle.material, 1);
    if (kind === 'morph')
      triangle.geometry.morphAttributes.position = [
        triangle.geometry.getAttribute('position').clone(),
      ];
    if (kind === 'wireframe') triangle.material.wireframe = true;
    assert.throws(() => bounds(object), /unsupported/i);
  });
}

test('rejects invalid resolution and camera matrix', () => {
  for (const resolution of [0, -1, NaN, Infinity])
    assert.throws(() => bounds(mesh(), makeCamera(), resolution));
  const camera = makeCamera();
  camera.projectionMatrix.elements[0] = NaN;
  assert.throws(() => bounds(mesh(), camera));
});

test('matrixRows preserves actual camera world/projection matrices in row order', () => {
  assert.ok(geometryModule, 'captureGeometry must export matrixRows');
  const camera = makeCamera();
  camera.position.set(2, -3, 4);
  camera.updateMatrixWorld(true);
  assert.deepEqual(geometryModule.matrixRows(camera.matrixWorld), [
    [1, 0, 0, 2],
    [0, 1, 0, -3],
    [0, 0, 1, 4],
    [0, 0, 0, 1],
  ]);
  const rows = geometryModule.matrixRows(camera.projectionMatrix);
  near(rows.flat(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -100.1 / 99.9, -20 / 99.9, 0, 0, -1, 0]);
  rows[0][0] = 123;
  assert.ok(camera.projectionMatrix.elements[0] < 2, 'rows must be independent snapshots');
  camera.matrixWorld.elements[0] = Infinity;
  assert.throws(() => geometryModule.matrixRows(camera.matrixWorld), /finite/i);
});

test('unsupported objects with empty draw or instance counts do not contaminate bounds', () => {
  const root = new THREE.Group();
  root.add(mesh());
  const line = new THREE.Line(mesh().geometry);
  line.geometry.setDrawRange(0, 0);
  root.add(line);
  const instances = new THREE.InstancedMesh(mesh().geometry, new THREE.MeshBasicMaterial(), 1);
  instances.count = 0;
  root.add(instances);
  near(bounds(root), [384, 384, 640, 640]);
});
