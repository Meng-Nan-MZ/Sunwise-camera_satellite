import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubmission } from '../src/scene.ts';
import {
  filterJobs,
  zoomDisplay,
  frameOffset,
  mergeJobs,
  selectableModels,
} from '../src/workbench.ts';
import type { Job } from '../src/types.ts';
const scene = {
  model_id: 'gps',
  sat_quat: { W: 1, X: 0, Y: 0, Z: 0 },
  distance_m: 20000,
  resolution: 1024 as const,
  seed: 1,
  noise: { enabled: false, gaussian_sigma: 0.012, poisson_peak: 96 },
  lighting: { azimuth_deg: 35, elevation_deg: 28, energy: 4 },
};
test('retired duplicate is absent from capture choices but retains searchable historical identity', () => {
  const models = [
    { id: 'hubble', name: 'Hubble 空间望远镜' },
    { id: 'hubble_textured', name: 'Hubble 哈勃空间望远镜·贴图版', selectable: false },
    { id: 'sar_radar', name: 'SAR 雷达卫星', selectable: true },
  ];
  const original = structuredClone(models);
  assert.deepEqual(
    selectableModels(models).map((m) => m.id),
    ['hubble', 'sar_radar'],
  );
  const jobs = [
    { id: 'old', model_id: 'hubble_textured', status: 'completed', mode: 'single' },
  ] as Job[];
  assert.deepEqual(filterJobs(jobs, models, '贴图版', '', ''), jobs);
  assert.deepEqual(models, original);
});
test('explicit fixed distance freezes across all capture modes; legacy request retains absent policy', () => {
  for (const mode of ['single', 'coverage', 'sequence', 'custom_sequence'] as const) {
    const t =
      mode === 'custom_sequence'
        ? { start_quat: scene.sat_quat, end_quat: scene.sat_quat }
        : undefined;
    const submission = createSubmission(mode, 2, scene, t, 'threejs', 'fixed');
    assert.equal(submission.distance_policy, 'fixed');
    assert.equal(submission.scene.distance_m, 20000);
    assert.ok(Object.isFrozen(submission));
  }
  assert.ok(!Object.hasOwn(createSubmission('coverage', 2, scene), 'distance_policy'));
  assert.throws(() => createSubmission('single', 1, scene, undefined, 'threejs', 'automatic'));
  assert.equal(
    createSubmission('sequence', 2, scene, undefined, 'threejs', 'automatic').distance_policy,
    'automatic',
  );
});
test('search matches saved model name and ID, composes both filters, never mutates records', () => {
  const jobs = [
    { id: 'a', model_id: 'gps', status: 'completed', mode: 'single' },
    { id: 'b', model_id: 'hubble', status: 'running', mode: 'sequence' },
  ] as Job[];
  const models = [
    { id: 'gps', name: 'GPS 导航卫星' },
    { id: 'hubble', name: '哈勃' },
  ];
  assert.deepEqual(filterJobs(jobs, models, '导航', 'completed', 'gps'), [jobs[0]]);
  assert.equal(filterJobs(jobs, models, '导航', 'running', '').length, 0);
  assert.equal(jobs.length, 2);
});
test('gallery offset clamps at published count boundaries and zoom leaves capture values untouched', () => {
  assert.equal(frameOffset(500, 3), 2);
  assert.equal(frameOffset(-1, 3), 0);
  assert.equal(frameOffset(1, 0), 0);
  assert.equal(zoomDisplay(30), 4);
  assert.equal(zoomDisplay(0), 0.25);
  assert.equal(scene.distance_m, 20000);
});
test('fresh polling merges older paged tasks without duplicating or replacing fresh status', () => {
  const old = [
    { id: 'x', status: 'running' },
    { id: 'old', status: 'completed' },
  ] as Job[];
  const fresh = [{ id: 'x', status: 'completed' }] as Job[];
  assert.deepEqual(mergeJobs(fresh, old), [fresh[0], old[1]]);
});
test('deleted IDs never reappear from stale polls or retained older pages', () => {
  const live = { id: 'live', status: 'completed' } as Job;
  const deleted = { id: 'deleted', status: 'completed' } as Job;
  const variant = { id: 'variant', status: 'completed' } as Job;
  const removed = new Set(['deleted', 'variant']);
  assert.deepEqual(mergeJobs([deleted, live], [variant, deleted], removed), [live]);
  assert.deepEqual(mergeJobs([live], [deleted, variant], removed), [live]);
  assert.deepEqual(mergeJobs([deleted], [variant], removed), []);
});
import { savedDistanceLabel } from '../src/workbench.ts';
test('saved distance label uses original snapshot policy including legacy variable mode semantics', () => {
  assert.equal(
    savedDistanceLabel({ mode: 'coverage', scene: { distance_m: 20000 } }),
    '10–30 km（自动）',
  );
  assert.equal(
    savedDistanceLabel({ mode: 'sequence', scene: { distance_m: 20000 } }),
    '30→10 km（自动）',
  );
  assert.equal(
    savedDistanceLabel({
      mode: 'coverage',
      distance_policy: 'fixed',
      scene: { distance_m: 22500 },
    }),
    '22.5 km（固定）',
  );
  assert.equal(savedDistanceLabel({ mode: 'single', scene: { distance_m: 20000 } }), '20 km');
  assert.equal(savedDistanceLabel(undefined), '历史记录');
});
