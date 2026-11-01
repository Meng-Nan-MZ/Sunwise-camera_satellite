import type { SceneSettings } from './types';

type NoiseSettings = SceneSettings['noise'];
export type NoisePreset = 'none' | 'light' | 'medium' | 'custom';

export interface NoisePresetChoice {
  preset: NoisePreset;
  noise: NoiseSettings;
}

const presets = {
  light: { gaussian_sigma: 0.006, poisson_peak: 256 },
  medium: { gaussian_sigma: 0.012, poisson_peak: 96 },
} as const;

export function inferNoisePreset(noise: NoiseSettings): NoisePreset {
  if (!noise.enabled) return 'none';
  for (const preset of ['light', 'medium'] as const) {
    if (
      noise.gaussian_sigma === presets[preset].gaussian_sigma &&
      noise.poisson_peak === presets[preset].poisson_peak
    ) {
      return preset;
    }
  }
  return 'custom';
}

export function applyNoisePreset(noise: NoiseSettings, preset: NoisePreset): NoiseSettings {
  if (preset === 'none') return { ...noise, enabled: false };
  if (preset === 'custom') return { ...noise, enabled: true };
  return { enabled: true, ...presets[preset] };
}

export function syncNoisePresetChoice(
  choice: NoisePresetChoice,
  noise: NoiseSettings,
): NoisePresetChoice {
  // Local edits keep their explicit choice; replacement objects are external loads or resets.
  return choice.noise === noise ? choice : { noise, preset: inferNoisePreset(noise) };
}
