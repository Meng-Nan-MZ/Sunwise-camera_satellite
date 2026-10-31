import type { ClientQuaternion, QuaternionTuple } from './types.ts';
export function normalizeQuaternion(q: QuaternionTuple): QuaternionTuple {
  if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite))
    throw new Error('四元数须为四个有限数值。');
  const length = Math.hypot(...q);
  if (!Number.isFinite(length) || length < 1e-10) throw new Error('姿态四元数无效。');
  return q.map((v) => v / length) as QuaternionTuple;
}
export function toClientQuaternion(q: QuaternionTuple): ClientQuaternion {
  return { W: q[3], X: q[0], Y: q[1], Z: q[2] };
}
export function fromClientQuaternion(q: ClientQuaternion): QuaternionTuple {
  if (!q || Object.keys(q).length !== 4 || !['W', 'X', 'Y', 'Z'].every((k) => Object.hasOwn(q, k)))
    throw new Error('端点须使用 W、X、Y、Z 四个分量。');
  return normalizeQuaternion([q.X, q.Y, q.Z, q.W]);
}
/** Hamilton client-basis XYZW; renderer conversion remains at the existing boundary. */
export function slerp(start: QuaternionTuple, end: QuaternionTuple, t: number): QuaternionTuple {
  if (!Number.isFinite(t) || t < 0 || t > 1) throw new Error('插值位置须在 0–1。');
  const a = normalizeQuaternion(start);
  let b = normalizeQuaternion(end);
  let dot = a.reduce((s, v, i) => s + v * b[i], 0);
  if (Math.abs(dot) <= 1e-15) {
    // Vector part of conjugate(a)*b. First largest component resolves equal-axis ties.
    const [x, y, z, w] = a,
      [u, v, r, s] = b;
    const relative = [
      w * u - x * s - y * r + z * v,
      w * v + x * r - y * s - z * u,
      w * r - x * v + y * u - z * s,
    ];
    let largest = 0;
    for (let i = 1; i < 3; i++)
      if (Math.abs(relative[i]) > Math.abs(relative[largest])) largest = i;
    if (relative[largest] < 0) b = b.map((v) => -v) as QuaternionTuple;
    dot = 0;
  } else if (dot < 0) {
    b = b.map((v) => -v) as QuaternionTuple;
    dot = -dot;
  }
  if (t === 0) return a;
  if (t === 1) return b;
  dot = Math.max(-1, Math.min(1, dot));
  if (dot > 1 - 1e-8)
    return normalizeQuaternion(a.map((v, i) => v * (1 - t) + b[i] * t) as QuaternionTuple);
  const angle = Math.acos(dot),
    denominator = Math.sin(angle);
  return normalizeQuaternion(
    a.map(
      (v, i) => (v * Math.sin((1 - t) * angle) + b[i] * Math.sin(t * angle)) / denominator,
    ) as QuaternionTuple,
  );
}
export function validateFrameCount(count: number): void {
  if (!Number.isInteger(count) || count < 2 || count > 100000)
    throw new Error('自定义序列帧数须为 2–100000 的整数（包含首尾）。');
}
export function samplePreview(
  start: QuaternionTuple,
  end: QuaternionTuple,
  count: number,
  frame: number,
): QuaternionTuple {
  validateFrameCount(count);
  if (!Number.isInteger(frame) || frame < 0 || frame >= count)
    throw new Error('预览帧须为范围内的整数。');
  return slerp(start, end, frame / (count - 1));
}

export interface PreviewState {
  active: boolean;
  playing: boolean;
  frame: number;
  key: string;
}
/** Ignore timer tasks queued before pause or a configuration change. */
export function advancePreview(previous: PreviewState, key: string, count: number): PreviewState {
  if (!previous.active || !previous.playing || previous.key !== key) return previous;
  const frame = Math.min(count - 1, previous.frame + 1);
  return { ...previous, frame, playing: frame < count - 1 };
}
