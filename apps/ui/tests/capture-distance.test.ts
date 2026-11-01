import assert from 'node:assert/strict';
import test from 'node:test';

const distance = await import('../src/captureDistance.ts').catch(() => null);
function api() {
  assert.ok(distance, 'Capture distance needs a shared wheel conversion boundary');
  return distance;
}
function near(actual: number, expected: number, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

test('capture distance limits remain 10–30 km with a 20 km default', () => {
  const { DEFAULT_CAPTURE_DISTANCE, MIN_CAPTURE_DISTANCE, MAX_CAPTURE_DISTANCE } = api();
  assert.equal(DEFAULT_CAPTURE_DISTANCE, 20000);
  assert.equal(MIN_CAPTURE_DISTANCE, 10000);
  assert.equal(MAX_CAPTURE_DISTANCE, 30000);
});

test('positive wheel increases distance and reversing it restores an unclamped distance', () => {
  const { distanceAfterWheel } = api();
  const farther = distanceAfterWheel(20000, 120, 0, 600);
  const nearer = distanceAfterWheel(20000, -120, 0, 600);
  assert.ok(farther > 20000 && nearer < 20000);
  near(farther / 20000, Math.exp(0.12));
  near(distanceAfterWheel(farther, -120, 0, 600), 20000);
  near(distanceAfterWheel(nearer, 120, 0, 600), 20000);
});

test('pixel, line and page units describe the same wheel displacement', () => {
  const { distanceAfterWheel } = api();
  for (const sign of [-1, 1]) {
    const pixels = distanceAfterWheel(20000, sign * 160, 0, 640);
    near(distanceAfterWheel(20000, sign * 10, 1, 640), pixels);
    near(distanceAfterWheel(20000, sign * 0.25, 2, 640), pixels);
  }
});

test('wheel distance never escapes the physical limits, including huge deltas', () => {
  const { distanceAfterWheel } = api();
  assert.equal(distanceAfterWheel(29999, 1000, 0, 600), 30000);
  assert.equal(distanceAfterWheel(10001, -1000, 0, 600), 10000);
  assert.equal(distanceAfterWheel(30000, 1, 0, 600), 30000);
  assert.equal(distanceAfterWheel(10000, -1, 0, 600), 10000);
  assert.ok(distanceAfterWheel(30000, -1, 0, 600) < 30000);
  assert.ok(distanceAfterWheel(10000, 1, 0, 600) > 10000);
  // Extreme finite inputs saturate the pixel delta before exponentiation.
  near(distanceAfterWheel(10000, Number.MAX_VALUE, 2, Number.MAX_VALUE), 10000 * Math.E);
  near(distanceAfterWheel(30000, -Number.MAX_VALUE, 1, 600), 30000 / Math.E);
});

test('zero and subpixel wheel inputs preserve the full distance precision', () => {
  const { distanceAfterWheel } = api();
  const original = 20123.456789;
  assert.equal(distanceAfterWheel(original, 0, 0, 600), original);
  assert.equal(distanceAfterWheel(original, -0, 2, 600), original);
  const next = distanceAfterWheel(original, 0.001, 0, 600);
  assert.ok(next > original && next - original < 0.1);
  near(next, original * Math.exp(0.000001));
});

test('repeated small wheel updates accumulate instead of rounding away', () => {
  const { distanceAfterWheel } = api();
  let current = 20000;
  for (let i = 0; i < 1000; i++) current = distanceAfterWheel(current, 0.001, 0, 600);
  near(current, distanceAfterWheel(20000, 1, 0, 600), 1e-7);
  assert.ok(current > 20020);
});

test('invalid current distance, wheel units and viewport inputs are rejected', () => {
  const { distanceAfterWheel } = api();
  for (const value of [NaN, Infinity, -Infinity, 0, 9999, 30001])
    assert.throws(() => distanceAfterWheel(value, 1, 0, 600));
  for (const value of [NaN, Infinity, -Infinity])
    assert.throws(() => distanceAfterWheel(20000, value, 0, 600));
  for (const value of [NaN, Infinity, -1, 0.5, 3])
    assert.throws(() => distanceAfterWheel(20000, 1, value, 600));
  for (const value of [NaN, Infinity, -1, 0])
    assert.throws(() => distanceAfterWheel(20000, 1, 0, value));
});
