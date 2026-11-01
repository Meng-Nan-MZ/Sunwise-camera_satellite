import * as THREE from 'three';

/** Snapshot Three's column-major storage as JSON-friendly mathematical rows. */
export function matrixRows(matrix: THREE.Matrix4): number[][] {
  if (!matrix.elements.every(Number.isFinite)) {
    throw new Error('Capture matrix must contain only finite values');
  }
  return Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 4 }, (_, column) => matrix.elements[column * 4 + row]),
  );
}

/**
 * Bounds of the actual submitted triangle vertices, in continuous image-edge
 * coordinates (origin top left). This is geometric projection, not a silhouette
 * or occlusion test. GLB vertices and root transforms are already in engine basis.
 * Updates world matrices but never changes geometry, pose or camera projection.
 */
export function projectCaptureBounds(
  root: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  resolution = 1024,
): [number, number, number, number] {
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new Error('Capture resolution must be positive and finite');
  }
  root.updateWorldMatrix(true, true);
  camera.updateWorldMatrix(true, false);
  matrixRows(camera.matrixWorld);
  matrixRows(camera.projectionMatrix);
  if (camera.matrixWorld.determinant() === 0) {
    throw new Error('Capture camera transform is singular');
  }
  const view = camera.matrixWorldInverse;
  const projection = camera.projectionMatrix;
  const result: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  let triangles = 0;
  const world = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const clip = new THREE.Vector4();

  function visit(object: THREE.Object3D) {
    if (!object.visible) return;
    if (object.layers.test(camera.layers)) {
      const renderable = object as THREE.Mesh;
      if (
        (renderable as unknown as THREE.Line).isLine ||
        (renderable as unknown as THREE.Points).isPoints ||
        (object as THREE.Sprite).isSprite
      ) {
        const material = renderable.material;
        const geometry = renderable.geometry;
        const hasDraws =
          !geometry ||
          (geometry.drawRange.count > 0 &&
            (geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) >
              geometry.drawRange.start);
        if (hasDraws && (Array.isArray(material) ? material : [material]).some((m) => m?.visible)) {
          throw new Error('Unsupported capture line, point or sprite geometry');
        }
      }
      if (renderable.isMesh) projectMesh(renderable);
    }
    // A layer mismatch does not suppress children in Three's renderer.
    object.children.forEach(visit);
  }

  function projectMesh(object: THREE.Mesh) {
    if (
      (object as THREE.InstancedMesh).isInstancedMesh &&
      (object as THREE.InstancedMesh).count === 0
    )
      return;
    const geometry = object.geometry;
    const materials = object.material;
    const ranges: { start: number; count: number; material: THREE.Material }[] = [];
    if (Array.isArray(materials)) {
      for (const group of geometry.groups) {
        const material = materials[group.materialIndex ?? 0];
        if (material?.visible) ranges.push({ ...group, material });
      }
    } else if (materials.visible) {
      ranges.push({ start: 0, count: Infinity, material: materials });
    }
    if (ranges.length === 0 || geometry.drawRange.count === 0) return;
    const position = geometry.getAttribute('position');
    if (!position || position.itemSize !== 3)
      throw new Error('Unsupported capture position attribute');
    const index = geometry.index;
    const count = index ? index.count : position.count;
    const draw = geometry.drawRange;
    const validRange = (start: number, length: number) =>
      Number.isInteger(start) &&
      start >= 0 &&
      (length === Infinity || (Number.isInteger(length) && length >= 0));
    if (!validRange(draw.start, draw.count)) throw new Error('Invalid capture draw range');
    for (const range of ranges) {
      if (!validRange(range.start, range.count)) throw new Error('Invalid capture material group');
      const start = Math.max(draw.start, range.start);
      const end = Math.min(count, draw.start + draw.count, range.start + range.count);
      if (end - start < 3) continue;
      if (
        (object as THREE.SkinnedMesh).isSkinnedMesh ||
        (object as THREE.InstancedMesh).isInstancedMesh ||
        Object.values(geometry.morphAttributes).some(
          (attributes) => attributes && attributes.length > 0,
        ) ||
        (range.material as THREE.MeshBasicMaterial).wireframe
      )
        throw new Error('Unsupported capture skinned, instanced, morph or wireframe geometry');
      matrixRows(object.matrixWorld);
      for (let offset = start; offset + 2 < end; offset += 3) {
        for (let corner = 0; corner < 3; corner++) {
          const vertex = index ? index.getX(offset + corner) : offset + corner;
          if (!Number.isInteger(vertex) || vertex < 0 || vertex >= position.count)
            throw new Error('Invalid capture vertex index');
          world[corner].fromBufferAttribute(position, vertex).applyMatrix4(object.matrixWorld);
          if (!world[corner].toArray().every(Number.isFinite))
            throw new Error('Capture vertex must be finite');
        }
        // Degenerate primitives produce no triangle rasterization.
        edgeA.subVectors(world[1], world[0]);
        edgeB.subVectors(world[2], world[0]);
        if (edgeA.cross(edgeB).lengthSq() === 0) continue;
        for (const vertex of world) {
          clip.set(vertex.x, vertex.y, vertex.z, 1).applyMatrix4(view).applyMatrix4(projection);
          if (!clip.toArray().every(Number.isFinite) || clip.w <= 0)
            throw new Error('Capture triangle is nonfinite or behind camera');
          const x = clip.x / clip.w;
          const y = clip.y / clip.w;
          const z = clip.z / clip.w;
          // Only roundoff at the exact clipping planes is tolerated.
          const epsilon = 1e-10;
          if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 1 + epsilon)
            throw new Error('Capture triangle is outside camera frame or clipping planes');
          const px = ((THREE.MathUtils.clamp(x, -1, 1) + 1) * resolution) / 2;
          const py = ((1 - THREE.MathUtils.clamp(y, -1, 1)) * resolution) / 2;
          result[0] = Math.min(result[0], px);
          result[1] = Math.min(result[1], py);
          result[2] = Math.max(result[2], px);
          result[3] = Math.max(result[3], py);
        }
        triangles++;
      }
    }
  }

  // Visibility above the supplied subtree still affects actual rendering.
  for (let ancestor = root.parent; ancestor; ancestor = ancestor.parent) {
    if (!ancestor.visible) throw new Error('Capture has no visible triangles');
  }
  visit(root);
  if (triangles === 0 || result[0] >= result[2] || result[1] >= result[3]) {
    throw new Error('Capture has no valid visible triangles');
  }
  return result;
}
