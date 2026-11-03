import { createSubmission, captureFov } from '../scene.ts';
import {
  fromClientQuaternion,
  toClientQuaternion,
  normalizeQuaternion,
  slerp,
} from '../trajectory.ts';
import { formalProfile } from '../formalProfile.ts';
import { IMAGE_PIPELINE_VERSION, NOISE_ALGORITHM_VERSION } from './imagePipeline.ts';
import type { CaptureResult } from '../renderBridge.ts';
import type {
  JobSubmission,
  ModelInfo,
  SceneSettings,
  QuaternionTuple,
  TrajectorySettings,
} from '../types.ts';

export const samplingAlgorithm = 'browser-mulberry32-box-muller-so3-v1';
const coordinateInfo = 'left‑handed coordinates; Origin: target center; X:right,Z:up';
const cameraCoordInfo = 'left‑handed coordinates; Z:optical axis, X:UP, Y:left';
type Matrix = number[][];
type InstallationSource = 'simulation_default' | 'user_defined' | 'calibrated';
type PayloadScene = SceneSettings & {
  payload_body_from_camera?: Matrix;
  installation_source?: InstallationSource;
};
export interface BrowserFrame extends SceneSettings {
  frame_id: string;
  master_seed: number;
  frame_index: number;
  sequence_id: string | null;
  timestamp_s: number | null;
  trajectory?: TrajectorySettings & { type: 'shortest_path_slerp'; count: number; t: number };
  payload_body_from_camera?: Matrix;
  installation_source?: InstallationSource;
  sequence_axis_world?: number[];
  angular_speed_deg_s?: number;
  sampling_algorithm: string;
}
const identity = (): Matrix => [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const clean = (n: number) => (Object.is(n, -0) ? 0 : n);
const transpose = (a: Matrix): Matrix => a[0].map((_, j) => a.map((row) => row[j]));
const multiply = (a: Matrix, b: Matrix): Matrix =>
  a.map((row) => b[0].map((_, j) => clean(row.reduce((s, v, k) => s + v * b[k][j], 0))));
function object(input: unknown, name: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error(`${name} 必须为对象。`);
  return input as Record<string, unknown>;
}
function number(value: unknown, name: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name} 超出允许范围。`);
  return value;
}
function matrix(value: unknown, name: string): Matrix {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 4 &&
        row.every((v) => typeof v === 'number' && Number.isFinite(v)),
    )
  )
    throw new Error(`${name} 必须为有限 4×4 矩阵。`);
  return value.map((row) => [...row]);
}
function installation(value: unknown): Matrix {
  const m = matrix(value, 'payload_body_from_camera');
  if (m[3].some((v, i) => Math.abs(v - [0, 0, 0, 1][i]) > 1e-10))
    throw new Error('载荷矩阵末行无效。');
  const r = m.slice(0, 3).map((row) => row.slice(0, 3));
  const gram = multiply(transpose(r), r);
  const det =
    r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) -
    r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) +
    r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  if (
    Math.abs(det - 1) > 1e-8 ||
    gram.some((row, i) => row.some((v, j) => Math.abs(v - (i === j ? 1 : 0)) > 1e-8))
  )
    throw new Error('载荷旋转必须正交且行列式为 +1。');
  return m;
}

/** Single ingress for UI and agent actions. Browser capture deliberately uses fixed distance. */
export function validateSubmission(input: unknown, models: ModelInfo[]): JobSubmission {
  const value = object(input, '采集任务'),
    scene = object(value.scene, 'scene');
  if (!['single', 'coverage', 'sequence', 'custom_sequence'].includes(value.mode as string))
    throw new Error('采集模式无效。');
  const count = number(value.count, 'count', value.mode === 'custom_sequence' ? 2 : 1, 500);
  if (!Number.isInteger(count) || (value.mode === 'single' && count !== 1))
    throw new Error('采集帧数无效（最多 500）。');
  if (value.distance_policy !== undefined && value.distance_policy !== 'fixed')
    throw new Error('浏览器采集仅支持固定距离。');
  if (value.sequence !== undefined)
    throw new Error('浏览器连续序列采用固定默认参数，不接受 sequence 覆盖。');
  const model = models.find((m) => m.id === scene.model_id && m.selectable !== false);
  if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(model.id))
    throw new Error('请选择可用模型。');
  captureFov(model.radius_m);
  const noise = object(scene.noise, 'noise'),
    lighting = object(scene.lighting, 'lighting');
  if (typeof noise.enabled !== 'boolean') throw new Error('noise.enabled 必须为布尔值。');
  number(noise.gaussian_sigma, 'gaussian_sigma', 0, 1);
  number(noise.poisson_peak, 'poisson_peak', 1, 1e7);
  number(lighting.azimuth_deg, 'azimuth_deg', -360, 360);
  number(lighting.elevation_deg, 'elevation_deg', -90, 90);
  number(lighting.energy, 'energy', 0, 100);
  const payload = installation(scene.payload_body_from_camera ?? identity());
  const source =
    scene.installation_source ??
    (scene.payload_body_from_camera === undefined ? 'simulation_default' : 'user_defined');
  if (!['simulation_default', 'user_defined', 'calibrated'].includes(source as string))
    throw new Error('installation_source 无效。');
  // Copy only declared fields: arbitrary input cannot enter the immutable scene snapshot.
  const snapshot: PayloadScene = {
    model_id: model.id,
    sat_quat: scene.sat_quat as SceneSettings['sat_quat'],
    distance_m: scene.distance_m as number,
    resolution: scene.resolution as 1024,
    seed: scene.seed as number,
    noise: {
      enabled: noise.enabled,
      gaussian_sigma: noise.gaussian_sigma as number,
      poisson_peak: noise.poisson_peak as number,
    },
    lighting: {
      azimuth_deg: lighting.azimuth_deg as number,
      elevation_deg: lighting.elevation_deg as number,
      energy: lighting.energy as number,
    },
    payload_body_from_camera: payload,
    installation_source: source as InstallationSource,
  };
  if ('quaternion_xyzw' in scene) throw new Error('请使用 WXYZ sat_quat。');
  const submission = createSubmission(
    value.mode as JobSubmission['mode'],
    count,
    snapshot,
    value.trajectory as TrajectorySettings | undefined,
    value.renderer_backend as JobSubmission['renderer_backend'],
    'fixed',
  );
  // createSubmission freezes regular scene fields; freeze the nested optional installation too.
  const frozenPayload = (submission.scene as PayloadScene).payload_body_from_camera!;
  frozenPayload.forEach(Object.freeze);
  Object.freeze(frozenPayload);
  return submission;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Isotropic Gaussian direction in R4 gives Haar-uniform SO(3), canonical W >= 0. */
function normal(rng: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}
function randomQuaternion(rng: () => number): QuaternionTuple {
  const q = normalizeQuaternion([normal(rng), normal(rng), normal(rng), normal(rng)]);
  return q[3] < 0 ? (q.map((v) => -v) as QuaternionTuple) : q;
}
function product(a: QuaternionTuple, b: QuaternionTuple): QuaternionTuple {
  const [x, y, z, w] = a,
    [u, v, r, s] = b;
  return normalizeQuaternion([
    w * u + x * s + y * r - z * v,
    w * v - x * r + y * s + z * u,
    w * r + x * v - y * u + z * s,
    w * s - x * u - y * v - z * r,
  ]);
}
export async function sampleFrames(request: JobSubmission, jobId: string): Promise<BrowserFrame[]> {
  // Revalidate shape/ranges without needing a catalog; caller supplies real catalog at ingress.
  const normalized = validateSubmission(request, [
    { id: request.scene.model_id, radius_m: 1 } as ModelInfo,
  ]);
  const { scene, mode, count, trajectory } = normalized,
    rng = random(scene.seed);
  let q = mode === 'sequence' ? randomQuaternion(rng) : fromClientQuaternion(scene.sat_quat);
  const axis = mode === 'sequence' ? [normal(rng), normal(rng), normal(rng)] : [1, 0, 0];
  const length = Math.hypot(...axis);
  axis.forEach((v, i) => (axis[i] = v / length));
  const half = Math.PI / 360,
    step: QuaternionTuple = [
      axis[0] * Math.sin(half),
      axis[1] * Math.sin(half),
      axis[2] * Math.sin(half),
      Math.cos(half),
    ];
  const frames: BrowserFrame[] = [];
  for (let index = 0; index < count; index++) {
    if (mode === 'coverage') q = randomQuaternion(rng);
    else if (mode === 'single' && q[3] < 0) q = q.map((v) => -v) as QuaternionTuple;
    else if (mode === 'sequence' && index > 0) q = product(step, q);
    else if (mode === 'custom_sequence')
      q = slerp(
        fromClientQuaternion(trajectory!.start_quat),
        fromClientQuaternion(trajectory!.end_quat),
        index / (count - 1),
      );
    const frame_id = String(index + 1).padStart(6, '0');
    const hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`satellite-pose-4.0\0${scene.seed}\0${scene.model_id}\0${frame_id}`),
    );
    frames.push({
      ...structuredClone(scene),
      sat_quat: toClientQuaternion(q),
      frame_id,
      master_seed: scene.seed,
      seed: new DataView(hash).getUint32(0, false),
      frame_index: index,
      sequence_id: mode === 'sequence' || mode === 'custom_sequence' ? `${jobId}-sequence` : null,
      timestamp_s:
        mode === 'custom_sequence'
          ? index * trajectory!.time_step_s!
          : mode === 'sequence'
            ? index
            : null,
      sampling_algorithm: samplingAlgorithm,
      ...(mode === 'sequence' ? { sequence_axis_world: [...axis], angular_speed_deg_s: 1 } : {}),
      ...(mode === 'custom_sequence'
        ? {
            trajectory: {
              ...structuredClone(trajectory!),
              type: 'shortest_path_slerp' as const,
              count,
              t: index / (count - 1),
            },
          }
        : {}),
    });
  }
  return frames;
}

export function bboxToYolo(bbox: unknown, resolution = 1024): [number, number, number, number] {
  number(resolution, 'resolution', 1);
  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    !bbox.every((v) => typeof v === 'number' && Number.isFinite(v))
  )
    throw new Error('像素边界框无效。');
  const [x, y, u, v] = bbox;
  if (!(0 <= x && x < u && u <= resolution && 0 <= y && y < v && v <= resolution))
    throw new Error('目标超出边界或边界框为空，拒绝裁切标签。');
  return [
    (x + u) / (2 * resolution),
    (y + v) / (2 * resolution),
    (u - x) / resolution,
    (v - y) / resolution,
  ];
}
function rotation([x, y, z, w]: QuaternionTuple): Matrix {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}
function matrixQuaternion(m: Matrix): QuaternionTuple {
  const trace = m[0][0] + m[1][1] + m[2][2];
  let q: QuaternionTuple;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    q = [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, s / 4];
  } else {
    let i = 0;
    for (let j = 1; j < 3; j++) if (m[j][j] > m[i][i]) i = j;
    const j = (i + 1) % 3,
      k = (i + 2) % 3,
      s = 2 * Math.sqrt(1 + m[i][i] - m[j][j] - m[k][k]);
    q = [0, 0, 0, (m[k][j] - m[j][k]) / s];
    q[i] = s / 4;
    q[j] = (m[j][i] + m[i][j]) / s;
    q[k] = (m[k][i] + m[i][k]) / s;
  }
  q = normalizeQuaternion(q);
  return q[3] < 0 ? (q.map((v) => -v) as QuaternionTuple) : q;
}
function nearMatrix(value: unknown, expected: Matrix, name: string): Matrix {
  const actual = matrix(value, name);
  if (
    actual.some((row, i) =>
      row.some((v, j) => Math.abs(v - expected[i][j]) > 1e-9 + Math.abs(expected[i][j]) * 1e-10),
    )
  )
    throw new Error(`${name} 与固定正式相机不匹配。`);
  return actual;
}
function equalJson(a: unknown, b: unknown): boolean {
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;
  const aa = a as Record<string, unknown>,
    bb = b as Record<string, unknown>;
  return (
    Object.keys(aa).length === Object.keys(bb).length &&
    Object.keys(aa).every((k) => Object.hasOwn(bb, k) && equalJson(aa[k], bb[k]))
  );
}

/** Build satellite-pose-4.0 truth only from validated renderer evidence and catalog provenance. */
export function buildPose(
  frame: BrowserFrame,
  model: ModelInfo,
  result: CaptureResult,
): Record<string, unknown> {
  if (frame.model_id !== model.id || !/^\d{6}$/.test(frame.frame_id))
    throw new Error('帧或模型标识无效。');
  const meta = object(result.metadata, 'metadata'),
    settings = object(meta.settings, 'settings');
  if (
    typeof settings.actual_antialias !== 'boolean' ||
    !equalJson(settings, { ...formalProfile, actual_antialias: settings.actual_antialias })
  )
    throw new Error('网页渲染配置不匹配。');
  if (
    meta.three_revision !== formalProfile.three_revision ||
    meta.profile_id !== formalProfile.profile_id
  )
    throw new Error('网页引擎或配置版本不匹配。');
  if (!/^[a-fA-F0-9]{64}$/.test(model.preview_sha256) || meta.asset_sha256 !== model.preview_sha256)
    throw new Error('网页模型 SHA256 不匹配。');
  number(meta.render_ms, 'render_ms', 0);
  const d = number(frame.distance_m, 'distance_m', 10000, 30000),
    fov = captureFov(model.radius_m),
    r = model.radius_m;
  const cameraExpected = identity();
  cameraExpected[2][3] = d;
  const actual = nearMatrix(meta.camera_world, cameraExpected, 'camera_world');
  const near = Math.max(0.001, d - 2 * r),
    far = d + 2 * r + 1,
    f = 1 / Math.tan(fov / 2);
  nearMatrix(
    meta.projection_matrix,
    [
      [f, 0, 0, 0],
      [0, f, 0, 0],
      [0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near)],
      [0, 0, -1, 0],
    ],
    'projection_matrix',
  );
  const sourceToBody = matrix(model.source_to_body, 'source_to_body');
  const yolo = bboxToYolo(meta.bbox_xyxy),
    q = fromClientQuaternion(frame.sat_quat),
    rot = rotation(q);
  const P = [
      [1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    engineToCamera = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ];
  const actualRot = actual.slice(0, 3).map((row) => row.slice(0, 3));
  const cameraRot = multiply(multiply(P, actualRot), engineToCamera);
  const position = multiply(
    P,
    actual.slice(0, 3).map((row) => [row[3]]),
  ).map((row) => row[0]);
  const cameraWorld = cameraRot.map((row, i) => [...row, position[i]]);
  cameraWorld.push([0, 0, 0, 1]);
  const invRot = transpose(cameraRot),
    invPosition = multiply(
      invRot,
      position.map((v) => [-v]),
    );
  const worldCamera = invRot.map((row, i) => [...row, invPosition[i][0]]);
  worldCamera.push([0, 0, 0, 1]);
  const cameraCv = [
      [0, -1, 0],
      [-1, 0, 0],
      [0, 0, 1],
    ],
    focal = 1024 / (2 * Math.tan(fov / 2)),
    K = [
      [focal, 0, 512],
      [0, focal, 512],
      [0, 0, 1],
    ];
  const observer = {
    coordinate_convention: cameraCoordInfo,
    K_basis: 'CV: +X right, +Y down, +Z forward',
    camera_to_cv_rotation: cameraCv,
    projection_world_to_pixel: multiply(multiply(K, cameraCv), worldCamera.slice(0, 3)),
    K,
    camera_to_world: cameraWorld,
    world_to_camera: worldCamera,
    image_basis: 'right-handed image basis: +X right, +Y up, +Z toward observer',
    image_basis_to_world: multiply(P, actualRot),
    fov_y_rad: fov,
    width: 1024,
    height: 1024,
    distance_m: d,
    actual_distance_m: Math.hypot(...position),
    pixel_convention: 'continuous image edges [0,width] x [0,height]',
  };
  const alpha_valid = rot[0].map((v, i) => Math.hypot(v, rot[2][i]) >= 1e-8);
  const alpha_rad = rot[0].map((v, i) =>
    alpha_valid[i] ? (Math.atan2(rot[2][i], v) + 2 * Math.PI) % (2 * Math.PI) : 0,
  );
  const beta_rad = rot[1].map((v) => Math.acos(Math.max(-1, Math.min(1, v))));
  const bodyCamera = installation(frame.payload_body_from_camera ?? identity());
  const worldBody = rot.map((row) => [...row, 0]);
  worldBody.push([0, 0, 0, 1]);
  const files: Record<string, string> = {
    clean: `images_clean/${frame.frame_id}.png`,
    label: `labels/${frame.frame_id}.txt`,
    pose: `poses/${frame.frame_id}.json`,
  };
  if (frame.noise.enabled) files.noisy = `images_noisy/${frame.frame_id}.png`;
  const pose: Record<string, unknown> = {
    schema_version: 'satellite-pose-4.0',
    coordinate_convention_id: 'lh-client-world-v2',
    frame_id: frame.frame_id,
    model_id: model.id,
    model_sha256: model.preview_sha256,
    Location: {
      SatQuat: toClientQuaternion(q),
      CamQuat: toClientQuaternion(matrixQuaternion(cameraRot)),
    },
    CoordinateInfo: coordinateInfo,
    CameraCoordInfo: cameraCoordInfo,
    rotation_world_from_body: rot,
    six_angles: { alpha_rad, beta_rad, alpha_valid },
    distance_m: d,
    resolution: [1024, 1024],
    bbox_xyxy: structuredClone(meta.bbox_xyxy),
    bbox_yolo: yolo,
    class_id: 0,
    radius_m: r,
    fov_y_rad: fov,
    source_to_body: sourceToBody,
    observer_camera: observer,
    payload_camera: {
      body_from_camera: bodyCamera,
      world_from_camera: multiply(worldBody, bodyCamera),
      installation_source: frame.installation_source ?? 'simulation_default',
    },
    sequence_id: frame.sequence_id,
    frame_index: frame.frame_index,
    timestamp_s: frame.timestamp_s,
    master_seed: frame.master_seed,
    noise_seed: frame.seed,
    noise_model: 'pixel_domain_poisson_then_gaussian',
    noise_algorithm: NOISE_ALGORITHM_VERSION,
    sampling_algorithm: samplingAlgorithm,
    seed_compatibility: 'Browser RNG differs from NumPy; no desktop seed/pixel equivalence.',
    scene: structuredClone(frame),
    renderer: {
      name: 'Three.js',
      version: meta.three_revision,
      profile_id: meta.profile_id,
      settings: structuredClone(settings),
      render_ms: meta.render_ms,
      asset_role: 'preview_glb',
      asset_sha256: model.preview_sha256,
      camera_world: structuredClone(actual),
      projection_matrix: structuredClone(meta.projection_matrix),
      image_pipeline_version: IMAGE_PIPELINE_VERSION,
      postprocessing:
        'browser Lanczos3 separable Float32 intermediate v1; BT.601 gray conversion after output Rec.709 shader; alpha composite black',
    },
    files,
  };
  if (frame.trajectory) pose.trajectory = structuredClone(frame.trajectory);
  if (model.physical_scale_calibrated !== undefined) {
    const fields = [
      'collection_id',
      'source_model_id',
      'source_sha256',
      'source_provider',
      'source_page',
      'license',
      'license_url',
      'source_scale',
      'source_scale_basis',
      'physical_scale_calibrated',
      'scale_note',
      'source_coordinate_system',
      'body_axes_source',
      'installation_source',
    ];
    const catalog = model as unknown as Record<string, unknown>;
    pose.model_provenance = Object.fromEntries(
      fields
        .filter((key) => Object.hasOwn(catalog, key))
        .map((key) => [key, structuredClone(catalog[key])]),
    );
  }
  return pose;
}
