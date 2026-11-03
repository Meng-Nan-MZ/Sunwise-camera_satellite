import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sampleFrames, validateSubmission, buildPose, bboxToYolo } from '../src/web/domain.ts';
import { formalProfile } from '../src/formalProfile.ts';
import type { JobSubmission, ModelInfo } from '../src/types.ts';

const identity = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const model: ModelInfo = {
  id: 'sat',
  name: 'Satellite',
  configuration: 'test',
  radius_m: 10,
  sha256: 'b'.repeat(64),
  preview_sha256: 'a'.repeat(64),
  preview_url: '/sat.glb',
  source_to_body: identity,
  installation_source: 'simulation_default',
  physical_scale_calibrated: false,
  scale_note: 'Simulation scale',
  license: 'CC0',
};
const request = (mode: JobSubmission['mode'] = 'single', count = 1): JobSubmission => ({
  mode,
  count,
  renderer_backend: 'threejs',
  distance_policy: 'fixed',
  scene: {
    model_id: 'sat',
    sat_quat: { W: 1, X: 0, Y: 0, Z: 0 },
    distance_m: 20000,
    resolution: 1024,
    seed: 42,
    noise: { enabled: false, gaussian_sigma: 0.012, poisson_peak: 96 },
    lighting: { azimuth_deg: 35, elevation_deg: 28, energy: 4 },
  },
});
const close = (a: number, b: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
function result() {
  const d = 20000,
    r = 10,
    near = d - 2 * r,
    far = d + 2 * r + 1;
  const f = (0.8 * Math.sqrt(10000 ** 2 - r * r)) / r;
  return {
    png_base64: '',
    metadata: {
      bbox_xyxy: [256, 384, 768, 640],
      camera_world: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, d],
        [0, 0, 0, 1],
      ],
      projection_matrix: [
        [f, 0, 0, 0],
        [0, f, 0, 0],
        [0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near)],
        [0, 0, -1, 0],
      ],
      asset_sha256: model.preview_sha256,
      three_revision: '180',
      profile_id: 'threejs-detail-v1',
      settings: { ...formalProfile, actual_antialias: true },
      render_ms: 2,
    },
  };
}

test('ingress rejects bad modes, counts, models, booleans, limits and endpoints before capture', () => {
  assert.equal(validateSubmission(request(), [model]).distance_policy, 'fixed');
  const mutations = [
    (r: any) => (r.mode = 'oops'),
    (r: any) => (r.count = 501),
    (r: any) => (r.count = 2),
    (r: any) => (r.distance_policy = 'automatic'),
    (r: any) => (r.scene.model_id = 'missing'),
    (r: any) => (r.scene.sat_quat.W = NaN),
    (r: any) => (r.scene.sat_quat = { W: 0, X: 0, Y: 0, Z: 0 }),
    (r: any) => (r.scene.noise.enabled = 'yes'),
    (r: any) => (r.scene.noise.gaussian_sigma = 1.1),
    (r: any) => (r.scene.noise.poisson_peak = 0.5),
    (r: any) => (r.scene.lighting.elevation_deg = 91),
    (r: any) => (r.scene.lighting.energy = 101),
    (r: any) => (r.scene.distance_m = 9999),
    (r: any) => (r.scene.lighting = { energy: 4 }),
  ];
  for (const mutate of mutations) {
    const r = request();
    mutate(r);
    assert.throws(() => validateSubmission(r, [model]));
  }
  assert.throws(() => validateSubmission(request(), [{ ...model, selectable: false }]));
  const custom = request('custom_sequence', 2);
  custom.trajectory = {
    start_quat: { W: 1, X: 0, Y: 0, Z: 0 },
    end_quat: { W: 0, X: 0, Y: 0, Z: 0 },
  };
  assert.throws(() => validateSubmission(custom, [model]));
});
test('custom SLERP includes both endpoints, timestamps, fixed distance and desktop SHA256 frame seed', async () => {
  const r = request('custom_sequence', 3);
  r.trajectory = {
    start_quat: { W: 1, X: 0, Y: 0, Z: 0 },
    end_quat: { W: 0, X: 0, Y: 0, Z: 1 },
    time_step_s: 0.5,
  };
  const frames = await sampleFrames(r, 'job');
  assert.deepEqual(
    frames.map((f) => f.timestamp_s),
    [0, 0.5, 1],
  );
  assert.deepEqual(
    frames.map((f) => f.distance_m),
    [20000, 20000, 20000],
  );
  assert.deepEqual(frames[0].sat_quat, r.trajectory.start_quat);
  assert.deepEqual(frames[2].sat_quat, r.trajectory.end_quat);
  close(frames[1].sat_quat.W, Math.SQRT1_2);
  close(frames[1].sat_quat.Z, Math.SQRT1_2);
  assert.equal(frames[2].sequence_id, 'job-sequence');
  assert.equal(frames[2].trajectory?.t, 1);
  const seed = createHash('sha256')
    .update('satellite-pose-4.0\0' + '42\0sat\0' + '000001')
    .digest()
    .readUInt32BE(0);
  assert.equal(frames[0].seed, seed);
  assert.equal(frames[0].master_seed, 42);
});
test('coverage is reproducible unit SO3 with broad isotropic orientations; sequence rotates one degree with sign continuity', async () => {
  const a = await sampleFrames(request('coverage', 500), 'a');
  assert.deepEqual(a, await sampleFrames(request('coverage', 500), 'a'));
  const mean = [0, 0, 0];
  for (const frame of a) {
    const { W: w, X: x, Y: y, Z: z } = frame.sat_quat;
    close(Math.hypot(w, x, y, z), 1);
    assert.ok(w >= 0);
    assert.equal(frame.distance_m, 20000);
    [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)].forEach(
      (v, i) => (mean[i] += v / a.length),
    );
  }
  mean.forEach((v) => assert.ok(Math.abs(v) < 0.09));
  const seq = await sampleFrames(request('sequence', 3), 's');
  for (let i = 1; i < seq.length; i++) {
    const p = Object.values(seq[i - 1].sat_quat),
      q = Object.values(seq[i].sat_quat);
    close(
      p.reduce((s, v, j) => s + v * q[j], 0),
      Math.cos(Math.PI / 360),
    );
    assert.equal(seq[i].timestamp_s, i);
  }
});
test('maximum-length sequences keep quaternion signs continuous across W=0 and a full revolution', async (t) => {
  for (const seed of [0, 42, 4294967295]) {
    const r = request('sequence', 500);
    r.scene.seed = seed;
    const frames = await sampleFrames(r, `long-${seed}`);
    const quaternions = frames.map((frame) => Object.values(frame.sat_quat));
    let crossings = 0,
      minDot = 1;
    for (let index = 0; index < quaternions.length; index++) {
      const q = quaternions[index];
      close(Math.hypot(...q), 1, 1e-12);
      if (index === 0) continue;
      const previous = quaternions[index - 1];
      const dot = q.reduce((sum, value, component) => sum + value * previous[component], 0);
      minDot = Math.min(minDot, dot);
      close(dot, Math.cos(Math.PI / 360), 1e-12);
      if (q[0] * previous[0] < 0) {
        crossings++;
        // Exported pose metadata must preserve the same representative at the crossing.
        const pose: any = buildPose(frames[index], model, result());
        Object.values(pose.Location.SatQuat).forEach((value, component) =>
          close(value as number, q[component], 1e-12),
        );
      }
    }
    assert.ok(crossings > 0, `seed ${seed} must exercise W=0`);
    // A continuous quaternion lift is antipodal after 360°, although physical orientation repeats.
    quaternions[360].forEach((value, component) => close(value, -quaternions[0][component], 1e-12));
    t.diagnostic(
      `seed ${seed}: 500 frames, W crossings=${crossings}, minimum adjacent dot=${minDot}`,
    );
  }
});

test('pose follows independent LH identity camera fixture and contains complete schema fields', async () => {
  const frame = (await sampleFrames(request(), 'job'))[0];
  frame.sat_quat = { W: Math.SQRT1_2, X: 0, Y: 0, Z: Math.SQRT1_2 };
  const pose: any = buildPose(frame, model, result());
  const expected = [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ];
  pose.rotation_world_from_body.forEach((row: number[], i: number) =>
    row.forEach((v, j) => close(v, expected[i][j])),
  );
  assert.deepEqual(pose.observer_camera.camera_to_world, [
    [0, -1, 0, 0],
    [0, 0, -1, 20000],
    [1, 0, 0, 0],
    [0, 0, 0, 1],
  ]);
  assert.deepEqual(pose.observer_camera.world_to_camera, [
    [0, 0, 1, 0],
    [-1, 0, 0, 0],
    [0, -1, 0, 20000],
    [0, 0, 0, 1],
  ]);
  assert.deepEqual(pose.Location.CamQuat, { W: 0.5, X: 0.5, Y: -0.5, Z: 0.5 });
  assert.deepEqual(pose.bbox_yolo, [0.5, 0.5, 0.5, 0.25]);
  assert.deepEqual(pose.payload_camera.body_from_camera, identity);
  assert.equal(pose.model_provenance.physical_scale_calibrated, false);
  assert.equal(pose.model_sha256, model.preview_sha256);
  assert.equal(pose.files.clean, 'images_clean/000001.png');
  assert.equal(pose.files.noisy, undefined);
  assert.match(pose.renderer.postprocessing, /browser.*Lanczos/i);
  assert.match(pose.renderer.postprocessing, /Float32/);
  assert.equal(pose.renderer.image_pipeline_version, 'browser-lanczos3-gray8-v1');
  assert.equal(pose.noise_algorithm, 'browser-mulberry32-poisson-ptrs-boxmuller-v1');
  assert.match(pose.sampling_algorithm, /browser/);
  const origin = pose.observer_camera.projection_world_to_pixel.map((row: number[]) => row[3]);
  close(origin[0] / origin[2], 512);
  close(origin[1] / origin[2], 512);
  for (const key of [
    'schema_version',
    'coordinate_convention_id',
    'six_angles',
    'noise_model',
    'CameraCoordInfo',
    'CoordinateInfo',
    'scene',
    'renderer',
    'source_to_body',
    'sequence_id',
    'frame_index',
    'timestamp_s',
    'master_seed',
    'noise_seed',
  ])
    assert.ok(key in pose, key);
});
test('submission keeps optional payload calibration deeply immutable and pose composes its translation', async () => {
  const r: any = request();
  r.scene.payload_body_from_camera = structuredClone(identity);
  r.scene.payload_body_from_camera[0][3] = 3;
  r.scene.installation_source = 'calibrated';
  const frozen: any = validateSubmission(r, [model]);
  assert.throws(() => (frozen.scene.payload_body_from_camera[0][3] = 99));
  const frame = (await sampleFrames(frozen, 'j'))[0];
  frame.sat_quat = { W: Math.SQRT1_2, X: 0, Y: 0, Z: Math.SQRT1_2 };
  const pose: any = buildPose(frame, model, result());
  close(pose.payload_camera.world_from_camera[0][3], 0);
  close(pose.payload_camera.world_from_camera[1][3], 3);
  assert.equal(pose.payload_camera.installation_source, 'calibrated');
  const malformed: any = request();
  malformed.scene.payload_body_from_camera = structuredClone(identity);
  malformed.scene.payload_body_from_camera[0][0] = -1;
  assert.throws(() => validateSubmission(malformed, [model]));
});
test('pose rejects altered camera/profile/hash, malformed matrix and unsafe bounding boxes', async () => {
  const frame = (await sampleFrames(request(), 'j'))[0];
  const changes = [
    (r: any) => r.metadata.camera_world[2][3]++,
    (r: any) => r.metadata.projection_matrix[0][0]++,
    (r: any) => (r.metadata.asset_sha256 = 'x'),
    (r: any) => (r.metadata.settings.exposure = 2),
    (r: any) => (r.metadata.render_ms = NaN),
    (r: any) => (r.metadata.bbox_xyxy = [0, 0, 1025, 1024]),
  ];
  for (const mutate of changes) {
    const r = result();
    mutate(r);
    assert.throws(() => buildPose(frame, model, r));
  }
  assert.throws(() => buildPose(frame, { ...model, source_to_body: [[1]] }, result()));
  for (const bbox of [
    [0, 0, 0, 1],
    [-1, 0, 1, 1],
    [0, 0, Infinity, 1],
  ])
    assert.throws(() => bboxToYolo(bbox, 1024));
});

test('camera quaternion records the accepted actual transform rather than a constant', async () => {
  const frame = (await sampleFrames(request(), 'j'))[0];
  const captured = result();
  // Sub-nanoradian rigid yaw is within the renderer evidence tolerance.
  const angle = 5e-10;
  captured.metadata.camera_world[0][0] = Math.cos(angle);
  captured.metadata.camera_world[0][2] = Math.sin(angle);
  captured.metadata.camera_world[2][0] = -Math.sin(angle);
  captured.metadata.camera_world[2][2] = Math.cos(angle);
  const pose: any = buildPose(frame, model, captured);
  const { W: w, X: x, Y: y, Z: z } = pose.Location.CamQuat;
  const rotation = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  rotation.forEach((row, i) =>
    row.forEach((v, j) => close(v, pose.observer_camera.camera_to_world[i][j], 1e-12)),
  );
});
