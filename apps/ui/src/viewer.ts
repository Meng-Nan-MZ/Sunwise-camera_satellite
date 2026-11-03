import * as THREE from 'three';

export type ViewerPreset = 'home' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
export type ViewerStyle = 'solid' | 'wireframe' | 'edges';
export type ViewerCommand = {
  sequence: number;
  action: ViewerPreset | 'fit' | 'zoomIn' | 'zoomOut';
};
export type ViewerOptions = { enabled: boolean; style: ViewerStyle; command: ViewerCommand };
export type ViewerModelStats = {
  dimensions: [number, number, number];
  meshCount: number;
  triangleCount: number;
};

/** Directions are expressed in the renderer's basis, with a fixed +Y camera up. */
export function viewerPresetDirection(preset: ViewerPreset): THREE.Vector3 {
  switch (preset) {
    case 'front':
      return new THREE.Vector3(0, 0, 1);
    case 'back':
      return new THREE.Vector3(0, 0, -1);
    case 'left':
      return new THREE.Vector3(-1, 0, 0);
    case 'right':
      return new THREE.Vector3(1, 0, 0);
    // Avoid the lookAt pole while retaining OrbitControls' fixed up axis.
    case 'top':
      return new THREE.Vector3(0, 1, 1e-6).normalize();
    case 'bottom':
      return new THREE.Vector3(0, -1, 1e-6).normalize();
    case 'home':
      return new THREE.Vector3(1, 0.7, 1).normalize();
  }
}

function finiteVector(vector: THREE.Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

/** Fit a complete sphere, including the limiting horizontal FOV on narrow screens. */
export function fitViewerCamera(
  camera: THREE.PerspectiveCamera,
  center: THREE.Vector3,
  radius: number,
  aspect: number,
  direction?: THREE.Vector3,
): void {
  if (
    !finiteVector(center) ||
    !Number.isFinite(radius) ||
    radius < 0 ||
    !Number.isFinite(aspect) ||
    aspect <= 0 ||
    !Number.isFinite(camera.fov) ||
    camera.fov <= 0 ||
    camera.fov >= 180 ||
    !Number.isFinite(camera.zoom) ||
    camera.zoom <= 0 ||
    (direction && (!finiteVector(direction) || direction.lengthSq() === 0))
  )
    throw new RangeError(
      'Viewer fit requires finite bounds, a positive aspect and a valid camera.',
    );

  const outward = direction?.clone() ?? camera.position.clone().sub(center);
  if (!finiteVector(outward) || outward.lengthSq() === 0)
    outward.copy(viewerPresetDirection('home'));
  outward.normalize();
  const fitRadius = radius > 0 ? radius : 1e-6;
  const halfVertical = THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2;
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * aspect);
  // sin, rather than tan, accounts for the sphere's tangent points, not just its center plane.
  const distance = (fitRadius * 1.25) / Math.sin(Math.min(halfVertical, halfHorizontal));
  const position = center.clone().addScaledVector(outward, distance);
  // OrbitControls may move from 1.05 to 100 radii without refitting the camera.
  const near = fitRadius * 1e-4;
  const far = Math.max(distance + fitRadius * 1.5, fitRadius * 102);
  if (!finiteVector(position) || !Number.isFinite(far) || near <= 0 || far <= near)
    throw new RangeError('Viewer bounds exceed the finite camera range.');

  camera.aspect = aspect;
  camera.position.copy(position);
  camera.up.set(0, 1, 0);
  camera.near = near;
  camera.far = far;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/** Measure imported model geometry before any parent target pose; never infer engineering parts. */
export function getViewerModelStats(root: THREE.Object3D): ViewerModelStats {
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  let meshCount = 0;
  let triangleCount = 0;
  const visit = (object: THREE.Object3D, parent: THREE.Matrix4) => {
    // Build local matrices separately so neither scene transforms nor source geometry caches change.
    const local = object.matrixAutoUpdate
      ? new THREE.Matrix4().compose(object.position, object.quaternion, object.scale)
      : object.matrix;
    const transform = new THREE.Matrix4().multiplyMatrices(parent, local);
    if (object instanceof THREE.Mesh) {
      meshCount++;
      const position = object.geometry.getAttribute('position');
      if (position) {
        triangleCount += Math.floor((object.geometry.index?.count ?? position.count) / 3);
        for (let i = 0; i < position.count; i++) {
          object.getVertexPosition(i, point).applyMatrix4(transform);
          if (finiteVector(point)) bounds.expandByPoint(point);
        }
      }
    }
    for (const child of object.children) visit(child, transform);
  };
  visit(root, new THREE.Matrix4());
  const size = bounds.getSize(new THREE.Vector3());
  return { dimensions: [size.x, size.y, size.z], meshCount, triangleCount };
}

/** Owns only display clones and edge overlays; original model resources belong to the caller. */
export function createViewerDisplay(root: THREE.Object3D): {
  setStyle(style: ViewerStyle): void;
  dispose(): void;
} {
  const meshes: {
    mesh: THREE.Mesh;
    original: THREE.Material | THREE.Material[];
    wire?: THREE.Material | THREE.Material[];
  }[] = [];
  const wireMaterials = new Map<THREE.Material, THREE.Material>();
  const edgeGeometries = new Map<THREE.BufferGeometry, THREE.EdgesGeometry>();
  const edges: THREE.LineSegments[] = [];
  let edgeMaterial: THREE.LineBasicMaterial | undefined;
  let style: ViewerStyle = 'solid';
  let disposed = false;
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push({ mesh: object, original: object.material });
  });

  const wireMaterial = (original: THREE.Material): THREE.Material => {
    let clone = wireMaterials.get(original);
    if (!clone) {
      clone = original.clone();
      (clone as THREE.Material & { wireframe: boolean }).wireframe = true;
      wireMaterials.set(original, clone);
    }
    return clone;
  };
  const buildEdges = () => {
    edgeMaterial = new THREE.LineBasicMaterial({
      color: 0x9cecff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    for (const { mesh } of meshes) {
      if (!mesh.geometry.getAttribute('position')) continue;
      let geometry = edgeGeometries.get(mesh.geometry);
      if (!geometry) {
        geometry = new THREE.EdgesGeometry(mesh.geometry, 25);
        edgeGeometries.set(mesh.geometry, geometry);
      }
      const edge = new THREE.LineSegments(geometry, edgeMaterial);
      edge.name = 'viewer-edges';
      edge.renderOrder = 1;
      mesh.add(edge);
      edges.push(edge);
    }
  };
  return {
    setStyle(next) {
      if (disposed || next === style) return;
      if (next === 'edges' && !edgeMaterial) buildEdges();
      for (const entry of meshes) {
        if (next === 'wireframe') {
          entry.wire ??= Array.isArray(entry.original)
            ? entry.original.map(wireMaterial)
            : wireMaterial(entry.original);
          entry.mesh.material = entry.wire;
        } else entry.mesh.material = entry.original;
      }
      for (const edge of edges) edge.visible = next === 'edges';
      style = next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const { mesh, original } of meshes) mesh.material = original;
      for (const edge of edges) edge.removeFromParent();
      for (const material of wireMaterials.values()) material.dispose();
      for (const geometry of edgeGeometries.values()) geometry.dispose();
      edgeMaterial?.dispose();
      wireMaterials.clear();
      edgeGeometries.clear();
      edges.length = 0;
      meshes.length = 0;
    },
  };
}
