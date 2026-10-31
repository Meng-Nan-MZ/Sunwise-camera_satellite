import type {
  EulerTuple,
  JobMode,
  JobSubmission,
  QuaternionTuple,
  SceneSettings,
} from './types.ts';

/** Fixed shortest-edge FOV for the model's origin-centered sphere at 10 km. */
export function captureFov(radius: number): number {
  if (!Number.isFinite(radius) || radius <= 0 || radius >= 10000)
    throw new Error('模型包围球半径必须大于 0 且小于 10,000 米。');
  return 2 * Math.atan(radius / (0.8 * Math.sqrt(10000 ** 2 - radius ** 2)));
}

/** Intrinsic XYZ Euler inputs in degrees, active B-to-W rotation. */
export function quaternionFromEuler(
  angles: EulerTuple,
  previous?: QuaternionTuple,
): QuaternionTuple {
  if (!angles.every(Number.isFinite)) throw new Error('姿态角必须为有限数值。');
  const [x, y, z] = angles.map((angle) => (angle * Math.PI) / 360);
  const [c1, c2, c3] = [Math.cos(x), Math.cos(y), Math.cos(z)];
  const [s1, s2, s3] = [Math.sin(x), Math.sin(y), Math.sin(z)];
  const q: QuaternionTuple = [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
  if (previous && q.reduce((dot, value, i) => dot + value * previous[i], 0) < 0)
    return q.map((value) => -value) as QuaternionTuple;
  return q;
}

export function createSubmission(
  mode: JobMode,
  count: number,
  scene: SceneSettings,
): JobSubmission {
  const finiteValues = [
    ...scene.quaternion_xyzw,
    scene.distance_m,
    scene.seed,
    scene.noise.gaussian_sigma,
    scene.noise.poisson_peak,
    ...Object.values(scene.lighting),
  ];
  if (!finiteValues.every(Number.isFinite)) throw new Error('参数中有无效数值，请检查输入。');
  if (!scene.model_id) throw new Error('请先选择模型。');
  if (scene.distance_m < 10000 || scene.distance_m > 30000)
    throw new Error('采集距离须为 10–30 km。');
  if (!Number.isInteger(scene.seed) || scene.seed < 0 || scene.seed > 4294967295)
    throw new Error('随机种子须为 0–4294967295 的整数。');
  if (scene.resolution !== 1024) throw new Error('正式输出固定为 1024 × 1024。');
  if (scene.quaternion_xyzw.length !== 4 || Math.hypot(...scene.quaternion_xyzw) < 1e-10)
    throw new Error('姿态四元数无效。');
  if (scene.noise.gaussian_sigma < 0 || scene.noise.poisson_peak <= 0 || scene.lighting.energy < 0)
    throw new Error('噪声参数和光照能量超出范围。');
  if (mode !== 'single' && (!Number.isInteger(count) || count < 1 || count > 100000))
    throw new Error('采集数量须为 1–100000 的整数。');
  const snapshot = structuredClone(scene);
  const length = Math.hypot(...snapshot.quaternion_xyzw);
  snapshot.quaternion_xyzw = snapshot.quaternion_xyzw.map(
    (value) => value / length,
  ) as QuaternionTuple;
  Object.freeze(snapshot.quaternion_xyzw);
  Object.freeze(snapshot.noise);
  Object.freeze(snapshot.lighting);
  Object.freeze(snapshot);
  return Object.freeze({ mode, count: mode === 'single' ? 1 : count, scene: snapshot });
}
