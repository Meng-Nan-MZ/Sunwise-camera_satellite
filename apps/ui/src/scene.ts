import { fromClientQuaternion, toClientQuaternion, validateFrameCount } from './trajectory.ts';
import type {
  DistancePolicy,
  EulerTuple,
  RendererBackend,
  RenderJobMode,
  JobSubmission,
  QuaternionTuple,
  SceneSettings,
  TrajectorySettings,
} from './types.ts';

/** Fixed shortest-edge FOV for the model's origin-centered sphere at 10 km. */
export function captureFov(radius: number): number {
  if (!Number.isFinite(radius) || radius <= 0 || radius >= 10000)
    throw new Error('模型包围球半径必须大于 0 且小于 10,000 米。');
  return 2 * Math.atan(radius / (0.8 * Math.sqrt(10000 ** 2 - radius ** 2)));
}

/** Intrinsic XYZ in the client LH basis, Hamilton active local-to-world rotation. */
export function quaternionFromEuler(
  angles: EulerTuple,
  previous?: QuaternionTuple,
): QuaternionTuple {
  if (!angles.every(Number.isFinite)) throw new Error('姿态角必须为有限数值。');
  // Reduce before multiplication to avoid overflow for finite endpoint inputs.
  // Quaternion half-angles have a 720-degree period; 360 retains the opposite sign.
  const [x, y, z] = angles.map((angle) => ((angle % 720) * Math.PI) / 360);
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

/** Only the target-render boundary uses engine components: R_engine = P R_client P^T. */
export function toRenderQuaternion([x, y, z, w]: QuaternionTuple): QuaternionTuple {
  return [-x, -z, -y, w];
}

export function createSubmission(
  mode: RenderJobMode,
  count: number,
  scene: SceneSettings,
  trajectory?: TrajectorySettings,
  renderer_backend: RendererBackend = 'threejs',
  distance_policy?: DistancePolicy,
): JobSubmission {
  if (renderer_backend === 'blender') throw new Error('新采集仅支持 Three.js 网页出图。');
  if (renderer_backend !== 'threejs') throw new Error('出图方式无效。');
  if (
    distance_policy !== undefined &&
    distance_policy !== 'fixed' &&
    distance_policy !== 'automatic'
  )
    throw new Error('距离方式无效。');
  if (distance_policy === 'automatic' && mode !== 'coverage' && mode !== 'sequence')
    throw new Error('当前模式仅支持固定拍摄距离。');
  let path: TrajectorySettings | undefined;
  if (mode === 'custom_sequence') {
    validateFrameCount(count);
    if (!trajectory) throw new Error('请设置自定义序列起点与终点。');
    const time_step_s = trajectory.time_step_s ?? 1;
    if (!Number.isFinite(time_step_s) || time_step_s < 1e-6 || time_step_s > 3600)
      throw new Error('帧间隔超出范围。');
    path = Object.freeze({
      start_quat: Object.freeze(toClientQuaternion(fromClientQuaternion(trajectory.start_quat))),
      end_quat: Object.freeze(toClientQuaternion(fromClientQuaternion(trajectory.end_quat))),
      time_step_s,
    });
  } else if (trajectory !== undefined) throw new Error('当前模式不接受自定义轨迹。');
  if (
    'quaternion_xyzw' in scene ||
    !scene.sat_quat ||
    Object.keys(scene.sat_quat).length !== 4 ||
    !['W', 'X', 'Y', 'Z'].every((key) => Object.hasOwn(scene.sat_quat, key))
  )
    throw new Error('姿态须使用 sat_quat 的 W、X、Y、Z 四个分量。');
  const { W, X, Y, Z } = scene.sat_quat;
  const finiteValues = [
    W,
    X,
    Y,
    Z,
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
  const length = Math.hypot(W, X, Y, Z);
  if (!Number.isFinite(length) || length < 1e-10) throw new Error('姿态四元数无效。');
  if (scene.noise.gaussian_sigma < 0 || scene.noise.poisson_peak <= 0 || scene.lighting.energy < 0)
    throw new Error('噪声参数和光照能量超出范围。');
  if (mode !== 'single' && (!Number.isInteger(count) || count < 1 || count > 100000))
    throw new Error('采集数量须为 1–100000 的整数。');
  const snapshot = structuredClone(scene);
  snapshot.sat_quat = { W: W / length, X: X / length, Y: Y / length, Z: Z / length };
  Object.freeze(snapshot.sat_quat);
  Object.freeze(snapshot.noise);
  Object.freeze(snapshot.lighting);
  Object.freeze(snapshot);
  return Object.freeze({
    mode,
    renderer_backend,
    ...(distance_policy ? { distance_policy } : {}),
    count: mode === 'single' ? 1 : count,
    scene: snapshot,
    ...(path ? { trajectory: path } : {}),
  });
}
export function rendererReadiness(
  health: import('./types.ts').Health | null,
  backend: RendererBackend = 'threejs',
) {
  if (backend !== 'threejs')
    return { available: false, reason: '新采集仅支持 Three.js 网页出图。' };
  return (
    health?.renderers?.threejs ?? {
      available: Boolean(health?.renderer_available),
      reason: health?.renderer_available ? null : '正在等待网页采集工作页连接。',
    }
  );
}
