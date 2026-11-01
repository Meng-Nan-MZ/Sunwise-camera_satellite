import { ApiError } from './api.ts';
import type { DeletionResult } from './types.ts';

/** A lost DELETE response is ambiguous. Only per-ID 404s can establish success. */
export async function reconcileDeletion(
  ids: string[],
  lookup: (id: string) => Promise<unknown>,
): Promise<DeletionResult | null> {
  if (!ids.length) return null;
  for (const id of ids) {
    try {
      await lookup(id);
      return null;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) return null;
    }
  }
  return { deleted_job_ids: [...ids], deleted_count: ids.length };
}
