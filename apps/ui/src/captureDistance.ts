export const DEFAULT_CAPTURE_DISTANCE = 20000;
export const MIN_CAPTURE_DISTANCE = 10000;
export const MAX_CAPTURE_DISTANCE = 30000;

/** DOM wheel delta to physical capture distance in metres; keep full state precision. */
export function distanceAfterWheel(
  distanceM: number,
  deltaY: number,
  deltaMode: number,
  pageHeight: number,
): number {
  if (
    ![distanceM, deltaY, deltaMode, pageHeight].every(Number.isFinite) ||
    distanceM < MIN_CAPTURE_DISTANCE ||
    distanceM > MAX_CAPTURE_DISTANCE ||
    pageHeight <= 0 ||
    ![0, 1, 2].includes(deltaMode)
  )
    throw new Error('拍摄距离、滚轮单位或视口尺寸无效。');
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1;
  const pixels = Math.max(-1000, Math.min(1000, deltaY * unit));
  return Math.max(
    MIN_CAPTURE_DISTANCE,
    Math.min(MAX_CAPTURE_DISTANCE, distanceM * Math.exp(pixels * 0.001)),
  );
}
