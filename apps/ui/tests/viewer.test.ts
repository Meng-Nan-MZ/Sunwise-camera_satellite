import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

async function helpers() {
  const module = await import('../src/viewer.ts').catch(() => null);
  assert.ok(module, 'Viewer helpers must be available');
  return module;
}

function close(actual: number, expected: number, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);
}

test('camera fit contains the entire sphere in wide and portrait viewports', async () => {
  const { fitViewerCamera } = await helpers();
  const center = new THREE.Vector3(12, -8, 4);
  for (const aspect of [2.4, 1, 0.25]) {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
    camera.zoom = 1.5;
    fitViewerCamera(camera, center, 7, aspect, new THREE.Vector3(2, 1, 3));
    assert.equal(camera.aspect, aspect);
    const distance = camera.position.distanceTo(center);
    assert.ok(camera.near > 0 && camera.near < distance - 7);
    assert.ok(camera.far > distance + 7);
    assert.ok(camera.up.equals(new THREE.Vector3(0, 1, 0)));
    assert.ok(
      camera
        .getWorldDirection(new THREE.Vector3())
        .dot(center.clone().sub(camera.position).normalize()) > 0.999999,
    );
    camera.updateMatrixWorld(true);
    for (let latitude = -90; latitude <= 90; latitude += 5) {
      for (let longitude = 0; longitude < 360; longitude += 5) {
        const a = THREE.MathUtils.degToRad(latitude);
        const b = THREE.MathUtils.degToRad(longitude);
        const point = new THREE.Vector3(
          Math.cos(a) * Math.cos(b),
          Math.sin(a),
          Math.cos(a) * Math.sin(b),
        );
        point.multiplyScalar(7).add(center).project(camera);
        assert.ok(
          Math.abs(point.x) <= 0.85 && Math.abs(point.y) <= 0.85 && Math.abs(point.z) <= 1,
          `sphere clipped at aspect ${aspect}: ${point.toArray()}`,
        );
      }
    }
  }
});

test('fit clipping allows the complete free-orbit zoom range without refitting', async () => {
  const { fitViewerCamera } = await helpers();
  for (const radius of [1e-8, 1, 1000]) {
    const camera = new THREE.PerspectiveCamera(45);
    fitViewerCamera(camera, new THREE.Vector3(), radius, 1, new THREE.Vector3(0, 0, 1));
    for (const distance of [radius * 1.05, radius * 100]) {
      camera.position.set(0, 0, distance);
      camera.updateMatrixWorld(true);
      for (const z of [-radius, radius]) {
        const projected = new THREE.Vector3(0, 0, z).project(camera);
        assert.ok(
          projected.z > -1 && projected.z < 1,
          `depth clipped at radius ${radius}, distance ${distance}`,
        );
      }
    }
  }
});

test('presets place the camera on the named side with stable top and bottom views', async () => {
  const { fitViewerCamera, viewerPresetDirection } = await helpers();
  const sides = {
    front: [0, 0, 1],
    back: [0, 0, -1],
    left: [-1, 0, 0],
    right: [1, 0, 0],
    top: [0, 1, 0],
    bottom: [0, -1, 0],
  } as const;
  for (const [preset, side] of Object.entries(sides)) {
    const direction = viewerPresetDirection(preset as keyof typeof sides);
    close(direction.length(), 1);
    assert.ok(direction.dot(new THREE.Vector3(...side)) > 0.99999);
    const camera = new THREE.PerspectiveCamera(45);
    fitViewerCamera(camera, new THREE.Vector3(), 1, 0.4, direction);
    assert.ok(camera.position.clone().normalize().dot(direction) > 0.99999);
    assert.ok(camera.quaternion.toArray().every(Number.isFinite));
    assert.deepEqual(camera.up.toArray(), [0, 1, 0]);
  }
  const first = viewerPresetDirection('home');
  const second = viewerPresetDirection('home');
  first.set(0, 0, 0);
  close(second.length(), 1);
  assert.ok(second.x > 0 && second.y > 0 && second.z > 0);
});

test('fit preserves a prior observation direction and provides a home fallback at the center', async () => {
  const { fitViewerCamera } = await helpers();
  const camera = new THREE.PerspectiveCamera(45);
  const center = new THREE.Vector3(2, 3, 4);
  camera.position.copy(center).add(new THREE.Vector3(-8, 0, 0));
  fitViewerCamera(camera, center, 1, 1);
  close(camera.position.y, center.y);
  close(camera.position.z, center.z);
  assert.ok(camera.position.x < center.x);
  camera.position.copy(center);
  fitViewerCamera(camera, center, 0, 1);
  assert.ok(camera.position.toArray().every(Number.isFinite));
  assert.ok(camera.position.distanceTo(center) > 0);
  assert.ok(camera.near > 0 && camera.far > camera.near);
});

test('invalid fit inputs are rejected before changing the camera', async () => {
  const { fitViewerCamera } = await helpers();
  const camera = new THREE.PerspectiveCamera(45);
  camera.position.set(1, 2, 3);
  const snapshot = camera.toJSON();
  for (const [center, radius, aspect, direction] of [
    [new THREE.Vector3(NaN, 0, 0), 1, 1, undefined],
    [new THREE.Vector3(), Infinity, 1, undefined],
    [new THREE.Vector3(), -1, 1, undefined],
    [new THREE.Vector3(), 1, 0, undefined],
    [new THREE.Vector3(), 1, NaN, undefined],
    [new THREE.Vector3(), 1, 1, new THREE.Vector3(Infinity, 0, 0)],
    [new THREE.Vector3(), 1, 1, new THREE.Vector3()],
  ] as const) {
    assert.throws(() => fitViewerCamera(camera, center, radius, aspect, direction), RangeError);
    assert.deepEqual(camera.toJSON(), snapshot);
  }
  for (const fov of [0, 180, NaN]) {
    camera.fov = fov;
    assert.throws(() => fitViewerCamera(camera, new THREE.Vector3(), 1, 1), RangeError);
  }
});

test('model statistics use actual indexed and non-indexed geometry in model coordinates', async () => {
  const { getViewerModelStats } = await helpers();
  const root = new THREE.Group();
  root.scale.setScalar(2);
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6), new THREE.MeshStandardMaterial());
  const panelGeometry = new THREE.BufferGeometry();
  panelGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 1, 0], 3),
  );
  const panel = new THREE.Mesh(panelGeometry, new THREE.MeshBasicMaterial());
  panel.position.x = 3;
  root.add(body, panel, new THREE.AxesHelper(100));
  const pose = new THREE.Group();
  pose.position.set(100, 200, -400);
  pose.rotation.set(0.6, 1.1, 0.2);
  pose.add(root);
  const bodyPosition = body.geometry.getAttribute('position').array.slice();
  const quaternion = pose.quaternion.toArray();
  assert.deepEqual(getViewerModelStats(root), {
    dimensions: [12, 8, 12],
    meshCount: 2,
    triangleCount: 13,
  });
  assert.deepEqual(body.geometry.getAttribute('position').array, bodyPosition);
  assert.equal(
    body.geometry.boundingBox,
    null,
    'statistics must not rewrite source geometry caches',
  );
  assert.deepEqual(pose.quaternion.toArray(), quaternion);
  assert.deepEqual(getViewerModelStats(new THREE.Group()), {
    dimensions: [0, 0, 0],
    meshCount: 0,
    triangleCount: 0,
  });
});

test('display modes are local, lazily build edges, and restore exact original material arrays', async () => {
  const { createViewerDisplay, getViewerModelStats } = await helpers();
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(2, 3, 4);
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ color: 0x5577aa, map: texture });
  const other = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const originalArray = [material, other];
  const first = new THREE.Mesh(geometry, originalArray);
  const second = new THREE.Mesh(geometry, material);
  second.position.x = 4;
  root.add(first, second);
  const positionBefore = first.position.toArray();
  const stats = getViewerModelStats(root);
  const controller = createViewerDisplay(root);
  assert.equal(first.material, originalArray);
  assert.equal(first.children.length, 0, 'no edge geometry should exist until requested');
  controller.setStyle('wireframe');
  const wireArray = first.material as THREE.MeshStandardMaterial[];
  const wireMaterial = second.material as THREE.MeshStandardMaterial;
  assert.notEqual(wireArray, originalArray);
  assert.equal(wireArray[0], wireMaterial, 'shared source material should share one owned clone');
  assert.equal(wireMaterial.wireframe, true);
  assert.equal(wireMaterial.map, texture);
  assert.equal(material.wireframe, false);
  controller.setStyle('wireframe');
  assert.equal(second.material, wireMaterial);
  assert.equal(first.children.length, 0);
  controller.setStyle('edges');
  assert.equal(first.material, originalArray);
  assert.equal(second.material, material);
  const edge = first.children.find(
    (child) => child instanceof THREE.LineSegments,
  ) as THREE.LineSegments;
  assert.ok(edge);
  assert.ok(edge.visible);
  assert.notEqual(edge.geometry, geometry);
  assert.deepEqual(getViewerModelStats(root), stats);
  controller.setStyle('solid');
  assert.equal(edge.visible, false);
  assert.equal(first.material, originalArray);
  controller.setStyle('edges');
  assert.equal(first.children.length, 1);
  assert.equal(first.children[0], edge);
  assert.equal(edge.visible, true);
  assert.deepEqual(first.position.toArray(), positionBefore);
  assert.equal(first.geometry, geometry);
  controller.dispose();
});

test('display disposal releases owned resources once without disposing source geometry, materials or textures', async () => {
  const { createViewerDisplay } = await helpers();
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const mesh = new THREE.Mesh(geometry, material);
  root.add(mesh);
  const disposed: unknown[] = [];
  for (const source of [geometry, material, texture])
    source.addEventListener('dispose', () => disposed.push(source));
  const controller = createViewerDisplay(root);
  controller.setStyle('wireframe');
  const wire = mesh.material;
  wire.addEventListener('dispose', () => disposed.push(wire));
  controller.setStyle('edges');
  const edge = mesh.children[0] as THREE.LineSegments;
  const edgeMaterial = edge.material as THREE.Material;
  edge.geometry.addEventListener('dispose', () => disposed.push(edge.geometry));
  edgeMaterial.addEventListener('dispose', () => disposed.push(edgeMaterial));
  controller.setStyle('wireframe');
  controller.dispose();
  controller.dispose();
  controller.setStyle('edges');
  assert.equal(mesh.material, material);
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.children.length, 0);
  assert.equal(disposed.length, 3);
  assert.equal(new Set(disposed).size, 3);
  assert.ok(
    disposed.includes(wire) && disposed.includes(edge.geometry) && disposed.includes(edgeMaterial),
  );
  assert.ok(
    !disposed.includes(material) && !disposed.includes(geometry) && !disposed.includes(texture),
  );
});
