import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewRotationClock } from '../src/previewRotation.ts';

test('preview rotation advances 12 degrees per second independently of frame rate', () => {
  for (const fps of [20, 60, 120]) {
    const clock = new PreviewRotationClock();
    clock.step(0, true);
    let angle = 0;
    for (let frame = 1; frame <= fps; frame++) angle = clock.step((frame * 1000) / fps, true);
    assert.ok(Math.abs(angle - Math.PI / 15) < 1e-12);
  }
});

test('stopping resets the preview offset and restarting begins at the configured pose', () => {
  const clock = new PreviewRotationClock();
  clock.step(0, true);
  assert.ok(clock.step(100, true) > 0);
  assert.equal(clock.step(200, false), 0);
  assert.equal(clock.step(10000, true), 0);
  assert.ok(clock.step(10050, true) > 0);
});

test('a delayed frame cannot jump the preview by more than 100 milliseconds', () => {
  const clock = new PreviewRotationClock();
  clock.step(1000, true);
  const angle = clock.step(11000, true);
  assert.ok(Math.abs(angle - Math.PI / 150) < 1e-12);
});

test('disabled preview never accumulates rotation', () => {
  const clock = new PreviewRotationClock();
  assert.equal(clock.step(0, false), 0);
  assert.equal(clock.step(100000, false), 0);
  assert.equal(clock.step(100001, true), 0);
});

test('full turns remain bounded while preserving direction', () => {
  const clock = new PreviewRotationClock();
  clock.step(0, true);
  let angle = 0;
  for (let frame = 1; frame <= 310; frame++) angle = clock.step(frame * 100, true);
  assert.ok(Math.abs(angle - Math.PI / 15) < 1e-10);
});
