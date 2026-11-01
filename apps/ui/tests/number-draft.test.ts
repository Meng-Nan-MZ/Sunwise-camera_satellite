import assert from 'node:assert/strict';
import test from 'node:test';
import { commitNumberDraft } from '../src/numberDraft.ts';
test('ordinary integer, decimal, negative and partial numeric drafts commit only complete finite values', () => {
  assert.equal(commitNumberDraft('25', 20, 10, 30), 25);
  assert.equal(commitNumberDraft('22.5', 20, 10, 30), 22.5);
  assert.equal(commitNumberDraft('-25', 0, -180, 180), -25);
  assert.equal(commitNumberDraft('', 20, 10, 30), 20);
  assert.equal(commitNumberDraft('-', 0, -180, 180), 0);
  assert.equal(commitNumberDraft('Infinity', 20, 10, 30), 20);
  assert.equal(commitNumberDraft('NaN', 20, 10, 30), 20);
});
test('committed out-of-range values clamp once while invalid drafts preserve external value', () => {
  assert.equal(commitNumberDraft('2', 20, 10, 30), 10);
  assert.equal(commitNumberDraft('250', 20, 10, 30), 30);
  assert.equal(commitNumberDraft('-200', 0, -180, 180), -180);
  assert.equal(commitNumberDraft('', 22.5, 10, 30), 22.5);
});
