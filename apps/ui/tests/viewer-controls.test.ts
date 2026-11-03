import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { PerspectiveCamera, Vector3 } from 'three';

class Canvas extends EventTarget {
  style = { touchAction: 'none' };
  clientWidth = 800;
  clientHeight = 600;
  captures = new Set<number>();
  ownerDocument = Object.assign(new EventTarget(), {
    hidden: false,
    defaultView: new EventTarget(),
  });
  getRootNode() {
    return this.ownerDocument;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  setPointerCapture(id: number) {
    this.captures.add(id);
  }
  hasPointerCapture(id: number) {
    return this.captures.has(id);
  }
  releasePointerCapture(id: number) {
    if (this.captures.delete(id))
      this.dispatchEvent(pointer('lostpointercapture', { pointerId: id }));
  }
}

function pointer(type: string, overrides: Record<string, unknown> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 100,
    clientY: 100,
    pageX: 100,
    pageY: 100,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    ...overrides,
  });
}

async function fixture() {
  const module = await import('../src/viewerControls.ts').catch(() => null);
  assert.ok(module, 'cancel-safe observation controls must exist');
  const canvas = new Canvas();
  const target = new Vector3(2, 3, 4);
  const camera = new PerspectiveCamera(45, 4 / 3, 0.01, 200);
  camera.position.set(4, 6, 14);
  camera.lookAt(target);
  const controls = module.createViewerOrbit(
    camera,
    canvas as unknown as HTMLCanvasElement,
    1,
    target,
  );
  return { canvas, target, camera, controls };
}

for (const cancel of ['lostpointercapture', 'pointercancel', 'blur', 'hidden'] as const) {
  test(`${cancel} ends an orbit gesture, preserves the view, and permits the next drag`, async () => {
    const { canvas, camera, controls } = await fixture();
    const stableTarget = controls.target;
    canvas.dispatchEvent(pointer('pointerdown'));
    canvas.dispatchEvent(pointer('pointermove', { clientX: 180 }));
    const position = camera.position.clone();
    const quaternion = camera.quaternion.clone();
    const target = controls.target.clone();
    if (cancel === 'blur') canvas.ownerDocument.defaultView.dispatchEvent(new Event('blur'));
    else if (cancel === 'hidden') {
      canvas.ownerDocument.hidden = true;
      canvas.ownerDocument.dispatchEvent(new Event('visibilitychange'));
    } else canvas.dispatchEvent(pointer(cancel));
    assert.equal(controls.target, stableTarget, 'target identity survives replacement controls');
    assert.ok(camera.position.distanceTo(position) < 1e-10);
    assert.ok(1 - Math.abs(camera.quaternion.dot(quaternion)) < 1e-10);
    assert.ok(controls.target.distanceTo(target) < 1e-10);
    canvas.dispatchEvent(pointer('pointermove', { buttons: 0, clientX: 300, clientY: 140 }));
    controls.update();
    assert.ok(
      camera.position.distanceTo(position) < 1e-10,
      'hover after cancellation must not rotate',
    );
    canvas.ownerDocument.hidden = false;
    canvas.dispatchEvent(pointer('pointerdown', { pointerId: 2 }));
    canvas.dispatchEvent(pointer('pointermove', { pointerId: 2, clientX: 190 }));
    assert.ok(camera.position.distanceTo(position) > 0.1, 'the next deliberate drag must work');
    controls.dispose();
  });
}

test('visible visibilitychange keeps an active gesture and a replacement retains keyboard panning', async () => {
  const { canvas, camera, controls } = await fixture();
  canvas.dispatchEvent(pointer('pointerdown'));
  const before = camera.position.clone();
  canvas.ownerDocument.dispatchEvent(new Event('visibilitychange'));
  canvas.dispatchEvent(pointer('pointermove', { clientX: 180 }));
  assert.ok(camera.position.distanceTo(before) > 0.1);
  canvas.ownerDocument.defaultView.dispatchEvent(new Event('blur'));
  const target = controls.target.clone();
  canvas.dispatchEvent(
    Object.assign(new Event('keydown', { cancelable: true }), {
      code: 'ArrowRight',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    }),
  );
  assert.ok(controls.target.distanceTo(target) > 0, 'replacement must reconnect keyboard controls');
  controls.dispose();
});

test('canceling either finger clears the whole multi-touch gesture', async () => {
  const { canvas, camera, controls } = await fixture();
  canvas.dispatchEvent(pointer('pointerdown', { pointerType: 'touch', pageX: 100 }));
  canvas.dispatchEvent(pointer('pointerdown', { pointerType: 'touch', pointerId: 2, pageX: 200 }));
  canvas.dispatchEvent(pointer('pointermove', { pointerType: 'touch', pointerId: 2, pageX: 230 }));
  const position = camera.position.clone();
  const target = controls.target.clone();
  canvas.dispatchEvent(pointer('pointercancel', { pointerType: 'touch', pointerId: 2 }));
  canvas.dispatchEvent(pointer('pointermove', { pointerType: 'touch', pageX: 180, pageY: 160 }));
  controls.update();
  assert.ok(camera.position.distanceTo(position) < 1e-10);
  assert.ok(controls.target.distanceTo(target) < 1e-10);
  controls.dispose();
});

test('disposing mid-gesture removes listeners, releases pointer capture, and leaves pose touch behavior enabled', async () => {
  const { canvas, camera, controls } = await fixture();
  canvas.dispatchEvent(pointer('pointerdown'));
  canvas.dispatchEvent(pointer('pointermove', { clientX: 180 }));
  controls.dispose();
  controls.dispose();
  const position = camera.position.clone();
  canvas.dispatchEvent(pointer('pointerdown'));
  canvas.dispatchEvent(pointer('pointermove', { clientX: 300 }));
  canvas.ownerDocument.defaultView.dispatchEvent(new Event('blur'));
  controls.update();
  assert.ok(camera.position.equals(position));
  assert.equal(canvas.captures.size, 0);
  assert.equal(canvas.style.touchAction, 'none');
  for (const event of [
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointercancel',
    'lostpointercapture',
    'wheel',
    'contextmenu',
    'keydown',
  ])
    assert.equal(getEventListeners(canvas, event).length, 0, `${event} listener leaked`);
  assert.equal(getEventListeners(canvas.ownerDocument.defaultView, 'blur').length, 0);
  assert.equal(getEventListeners(canvas.ownerDocument, 'visibilitychange').length, 0);
  assert.equal(getEventListeners(canvas.ownerDocument, 'keydown').length, 0);
});
