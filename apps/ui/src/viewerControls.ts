import type { PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createViewerOrbit(
  camera: PerspectiveCamera,
  canvas: HTMLCanvasElement,
  radius: number,
  target: Vector3,
): {
  target: Vector3;
  update(): void;
  dispose(): void;
} {
  const stableTarget = target.clone();
  const document = canvas.ownerDocument;
  const window = document.defaultView;
  const pointers = new Set<number>();
  let disposed = false;
  let resetting = false;
  const createControls = () => {
    // The OrbitControls constructor updates around its default origin. Preserve
    // the current view while attaching a fresh gesture state to our stable target.
    const position = camera.position.clone();
    const quaternion = camera.quaternion.clone();
    const next = new OrbitControls(camera, canvas);
    next.target = stableTarget;
    next.enableDamping = false;
    next.minDistance = Math.max(0.001, radius * 1.05);
    next.maxDistance = radius * 100;
    next.listenToKeyEvents(canvas);
    camera.position.copy(position);
    camera.quaternion.copy(quaternion);
    camera.updateMatrixWorld(true);
    return next;
  };
  let controls = createControls();
  const releasePointers = () => {
    for (const pointer of pointers) {
      if (canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    }
    pointers.clear();
  };
  const cancelGesture = () => {
    if (disposed || resetting) return;
    resetting = true;
    controls.dispose();
    releasePointers();
    controls = createControls();
    resetting = false;
  };
  const pointerDown = (event: PointerEvent) => pointers.add(event.pointerId);
  const pointerUp = (event: PointerEvent) => pointers.delete(event.pointerId);
  const visibilityChanged = () => {
    if (document.hidden) cancelGesture();
  };
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('lostpointercapture', cancelGesture);
  canvas.addEventListener('pointercancel', cancelGesture);
  window?.addEventListener('blur', cancelGesture);
  document.addEventListener('visibilitychange', visibilityChanged);
  return {
    target: stableTarget,
    update() {
      if (!disposed) controls.update();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('lostpointercapture', cancelGesture);
      canvas.removeEventListener('pointercancel', cancelGesture);
      window?.removeEventListener('blur', cancelGesture);
      document.removeEventListener('visibilitychange', visibilityChanged);
      controls.dispose();
      releasePointers();
      // The same canvas returns to the custom pose gesture handlers afterward.
      canvas.style.touchAction = 'none';
    },
  };
}
