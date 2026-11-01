import assert from 'node:assert/strict';
import test from 'node:test';
import { imageCountError } from '../src/imageCount.ts';

test('batch counts accept whole images at both inclusive boundaries', () => {
  for (const mode of ['coverage', 'sequence'] as const) {
    assert.equal(imageCountError(mode, 1), null);
    assert.equal(imageCountError(mode, 100000), null);
  }
  assert.equal(imageCountError('custom_sequence', 2), null);
  assert.equal(imageCountError('custom_sequence', 100000), null);
});

test('batch count errors preserve invalid drafts instead of rounding or clamping them', () => {
  for (const mode of ['coverage', 'sequence', 'custom_sequence'] as const) {
    for (const count of [NaN, Infinity, -Infinity, -1, 0, 1.5, 100000.5, 100001]) {
      assert.ok(imageCountError(mode, count), `${mode}: ${count} must be rejected`);
    }
  }
});

test('start/end trajectories require two images but other modes can use one', () => {
  assert.ok(imageCountError('custom_sequence', 1));
  assert.equal(imageCountError('coverage', 1), null);
  assert.equal(imageCountError('sequence', 1), null);
});

test('single capture ignores a stale batch count because submission is always one image', () => {
  assert.equal(imageCountError('single', NaN), null);
  assert.equal(imageCountError('single', 100001), null);
});
