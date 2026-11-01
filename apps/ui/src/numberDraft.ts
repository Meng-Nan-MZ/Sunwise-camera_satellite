/** Numeric editing stays local; only a committed, finite value enters the capture draft. */
export function commitNumberDraft(
  draft: string,
  current: number,
  min: number,
  max: number,
): number {
  const value = draft.trim() === '' ? NaN : Number(draft);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : current;
}
