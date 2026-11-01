import assert from 'node:assert/strict';
import test from 'node:test';
import { applyNoisePreset, inferNoisePreset, syncNoisePresetChoice } from '../src/noisePresets.ts';

const custom = { enabled: true, gaussian_sigma: 0.037, poisson_peak: 173 };

test('light and medium presets map to existing noise schema without mutating the draft', () => {
  assert.deepEqual(applyNoisePreset(custom, 'light'), {
    enabled: true,
    gaussian_sigma: 0.006,
    poisson_peak: 256,
  });
  assert.deepEqual(applyNoisePreset(custom, 'medium'), {
    enabled: true,
    gaussian_sigma: 0.012,
    poisson_peak: 96,
  });
  assert.deepEqual(custom, { enabled: true, gaussian_sigma: 0.037, poisson_peak: 173 });
});

test('turning noise off preserves custom parameters and custom re-enables those values', () => {
  const off = applyNoisePreset(custom, 'none');
  assert.deepEqual(off, { ...custom, enabled: false });
  assert.deepEqual(applyNoisePreset(off, 'custom'), custom);
  assert.notEqual(off, custom);
});

test('loaded values infer off, light, medium, or custom accurately', () => {
  assert.equal(inferNoisePreset({ ...custom, enabled: false }), 'none');
  assert.equal(inferNoisePreset(applyNoisePreset(custom, 'light')), 'light');
  assert.equal(inferNoisePreset(applyNoisePreset(custom, 'medium')), 'medium');
  assert.equal(inferNoisePreset(custom), 'custom');
  assert.equal(inferNoisePreset({ ...custom, gaussian_sigma: 0.012 }), 'custom');
});

test('explicit custom choice stays editable when its initial values match a preset', () => {
  for (const preset of ['light', 'medium'] as const) {
    const noise = applyNoisePreset(applyNoisePreset(custom, preset), 'custom');
    const choice = { preset: 'custom' as const, noise };
    assert.equal(syncNoisePresetChoice(choice, noise), choice);
    assert.equal(syncNoisePresetChoice(choice, noise).preset, 'custom');
  }
});

test('custom editing can equal a preset without switching the explicit UI choice', () => {
  const edited = { enabled: true, gaussian_sigma: 0.012, poisson_peak: 96 };
  const choice = { preset: 'custom' as const, noise: edited };
  assert.equal(syncNoisePresetChoice(choice, edited).preset, 'custom');
});

test('an external reset synchronizes selection even when the replacement has identical numbers', () => {
  const noise = applyNoisePreset(custom, 'medium');
  const choice = { preset: 'custom' as const, noise };
  const externalReset = { ...noise };
  const reset = syncNoisePresetChoice(choice, externalReset);
  assert.equal(reset.preset, 'medium');
  assert.equal(reset.noise, externalReset);
  assert.notEqual(reset, choice);
});

test('external disabling or loading custom parameters replaces a stale preset choice', () => {
  const noise = applyNoisePreset(custom, 'light');
  const choice = { preset: 'light' as const, noise };
  assert.equal(syncNoisePresetChoice(choice, { ...noise, enabled: false }).preset, 'none');
  assert.equal(syncNoisePresetChoice(choice, custom).preset, 'custom');
});
