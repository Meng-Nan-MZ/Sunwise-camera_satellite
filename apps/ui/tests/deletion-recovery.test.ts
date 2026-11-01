import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/api.ts';
import { reconcileDeletion } from '../src/deletionRecovery.ts';

test('lost deletion reply converges only after each confirmed job is independently absent', async () => {
  const looked: string[] = [];
  const result = await reconcileDeletion(['source', 'noise'], async (id) => {
    looked.push(id);
    throw new ApiError('任务不存在', 404);
  });
  assert.deepEqual(looked, ['source', 'noise']);
  assert.deepEqual(result, { deleted_job_ids: ['source', 'noise'], deleted_count: 2 });
});
test('network errors, server errors, or surviving dependencies cannot falsely establish deletion', async () => {
  for (const result of [new TypeError('network'), new ApiError('error', 500), { id: 'noise' }]) {
    assert.equal(
      await reconcileDeletion(['source', 'noise'], async (id) => {
        if (id === 'source') throw new ApiError('not found', 404);
        if (result instanceof Error) throw result;
        return result;
      }),
      null,
    );
  }
  assert.equal(await reconcileDeletion([], async () => ({})), null);
});
