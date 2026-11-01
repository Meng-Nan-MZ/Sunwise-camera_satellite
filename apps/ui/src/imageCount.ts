import type { RenderJobMode } from './types';

export function imageCountError(mode: RenderJobMode, count: number): string | null {
  if (mode === 'single') return null;
  const minimum = mode === 'custom_sequence' ? 2 : 1;
  if (!Number.isInteger(count) || count < minimum || count > 100000) {
    return `请输入 ${minimum}–100000 之间的整数图片数量。`;
  }
  return null;
}
