import { toRenderQuaternion } from './scene.ts';
import { normalizeQuaternion } from './trajectory.ts';
import type { EulerTuple, QuaternionTuple } from './types.ts';

type Point = [number, number];
type Vector = [number, number, number];
const degrees = 180 / Math.PI;

function cross(a: Vector, b: Vector): Vector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function spherePoint([x, y]: Point, width: number, height: number): Vector {
  const radius = Math.min(width, height) / 2;
  const u = (x - width / 2) / radius;
  const v = (height / 2 - y) / radius;
  const length = Math.hypot(u, v);
  if (!Number.isFinite(length)) throw new Error('拖动坐标无效。');
  return length > 1 ? [u / length, v / length, 0] : [u, v, Math.sqrt(Math.max(0, 1 - length ** 2))];
}

/**
 * Canvas-local arcball, fixed camera facing -Z with +Y up; result is client LH XYZW.
 * A single diameter-sized step follows the straight path across the front hemisphere.
 * Call incrementally with each pointer position to retain a longer gesture's path.
 */
export function applyArcballDrag(
  start: QuaternionTuple,
  from: Point,
  to: Point,
  width: number,
  height: number,
): QuaternionTuple {
  if (![...from, ...to, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
    throw new Error('拖动区域与坐标必须为有效数值。');
  const origin = normalizeQuaternion(start);
  const a = spherePoint(from, width, height);
  const b = spherePoint(to, width, height);
  let axis = cross(a, b);
  let scalar = Math.max(0, 1 + a.reduce((dot, value, i) => dot + value * b[i], 0));
  let length = Math.hypot(...axis, scalar);
  if (length < 1e-14) {
    // Only opposite equator points are antipodal on the front hemisphere.
    // The path through its center fixes the limiting axis; an arbitrary
    // perpendicular basis would jump when a straight drag reaches the far rim.
    axis = cross(a, [0, 0, 1]);
    scalar = 0;
    length = Math.hypot(...axis);
  }
  const [x, y, z] = axis.map((value) => value / length);
  const w = scalar / length;
  const [u, v, r, s] = toRenderQuaternion(origin);
  // Screen/world delta pre-multiplies the existing target rotation.
  const engine: QuaternionTuple = [
    w * u + x * s + y * r - z * v,
    w * v - x * r + y * s + z * u,
    w * r + x * v - y * u + z * s,
    w * s - x * u - y * v - z * r,
  ];
  // The existing P-conjugation mapping is its own inverse.
  const result = normalizeQuaternion(toRenderQuaternion(engine));
  return result.reduce((dot, value, i) => dot + value * origin[i], 0) < 0
    ? (result.map((value) => -value) as QuaternionTuple)
    : result;
}

function wrap(angle: number): number {
  const result = ((((angle + 180) % 360) + 360) % 360) - 180;
  return Object.is(result, -0) ? 0 : result;
}

function proximity(angles: EulerTuple, previous: EulerTuple): number {
  return angles.reduce((total, value, i) => total + wrap(value - previous[i]) ** 2, 0);
}

/** Intrinsic XYZ inverse, selecting a nearby equivalent display branch without rounding. */
export function eulerFromQuaternion(q: QuaternionTuple, previous?: EulerTuple): EulerTuple {
  const [x, y, z, w] = normalizeQuaternion(q);
  if (previous && !previous.every(Number.isFinite)) throw new Error('参考姿态角必须为有限数值。');
  // Half-sum/half-difference extraction avoids losing the well-conditioned angle
  // combination near +/-90 degrees, unlike independent matrix atan2 divisions.
  const sum = Math.atan2(x + z, w + y);
  const difference = Math.atan2(x - z, w - y);
  const plus = Math.hypot(x + z, w + y);
  const minus = Math.hypot(x - z, w - y);
  const pitch = 2 * Math.atan2(plus - minus, plus + minus) * degrees;
  let candidates: EulerTuple[];
  if (plus * minus <= 1e-12) {
    const sign = plus >= minus ? 1 : -1;
    const combined = wrap(2 * (sign > 0 ? sum : difference) * degrees);
    candidates = [[combined, sign * 90, 0]];
    if (previous) {
      const px = wrap(previous[0]);
      const pz = wrap(previous[2]);
      // At the pole x +/- z is fixed. Project onto its equivalent families to
      // preserve the previous pair when possible and avoid arbitrary Z=0 jumps.
      for (let turns = -2; turns <= 2; turns++) {
        const correction = (combined + 360 * turns - px - sign * pz) / 2;
        candidates.push([wrap(px + correction), sign * 90, wrap(pz + sign * correction)]);
      }
    }
  } else {
    const roll = wrap((sum + difference) * degrees);
    const yaw = wrap((sum - difference) * degrees);
    candidates = [
      [roll, pitch, yaw],
      [wrap(roll + 180), wrap(180 - pitch), wrap(yaw + 180)],
    ];
  }
  if (!previous) return candidates[0];
  return candidates.reduce((best, candidate) =>
    proximity(candidate, previous) < proximity(best, previous) ? candidate : best,
  );
}
