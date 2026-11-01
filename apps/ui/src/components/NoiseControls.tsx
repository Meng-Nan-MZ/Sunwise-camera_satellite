import { useState } from 'react';
import { Slider } from './Controls';
import {
  applyNoisePreset,
  inferNoisePreset,
  syncNoisePresetChoice,
  type NoisePreset,
  type NoisePresetChoice,
} from '../noisePresets';
import type { SceneSettings } from '../types';

interface SeedProps {
  seed: number;
  setSeed: (value: number) => void;
  labelPrefix?: string;
}

interface Props extends SeedProps {
  noise: SceneSettings['noise'];
  setNoise: (value: SceneSettings['noise']) => void;
  showSeed?: boolean;
}

export function NoiseSeedControls({ seed, setSeed, labelPrefix = '' }: SeedProps) {
  return (
    <details className="parameter-disclosure">
      <summary>更多参数</summary>
      <label className="field">
        随机种子
        <input
          aria-label={`${labelPrefix}随机种子`}
          type="number"
          min="0"
          max="4294967295"
          step="1"
          value={Number.isFinite(seed) ? seed : ''}
          onChange={(event) => setSeed(event.target.valueAsNumber)}
        />
      </label>
      <p className="control-caption">使用相同参数和种子，可重复生成相同结果。</p>
    </details>
  );
}

export default function NoiseControls({
  noise,
  setNoise,
  seed,
  setSeed,
  labelPrefix = '',
  showSeed = true,
}: Props) {
  const [choice, setChoice] = useState<NoisePresetChoice>(() => ({
    noise,
    preset: inferNoisePreset(noise),
  }));
  const current = syncNoisePresetChoice(choice, noise);
  if (current !== choice) setChoice(current);

  function update(nextNoise: SceneSettings['noise'], preset: NoisePreset) {
    setChoice({ noise: nextNoise, preset });
    setNoise(nextNoise);
  }

  return (
    <div className="noise-controls">
      <label className="field">
        噪声强度
        <select
          aria-label={`${labelPrefix}噪声强度`}
          value={current.preset}
          onChange={(event) => {
            const preset = event.target.value as NoisePreset;
            update(applyNoisePreset(noise, preset), preset);
          }}
        >
          <option value="none">无</option>
          <option value="light">轻微</option>
          <option value="medium">中等</option>
          <option value="custom">自定义</option>
        </select>
      </label>
      {current.preset === 'custom' && (
        <div className="noise-custom-parameters">
          <Slider
            label={`${labelPrefix}高斯 σ`}
            value={noise.gaussian_sigma}
            min={0}
            max={0.1}
            step={0.001}
            onChange={(value) => update({ ...noise, gaussian_sigma: value }, 'custom')}
          />
          <Slider
            label={`${labelPrefix}泊松峰值`}
            value={noise.poisson_peak}
            min={1}
            max={512}
            onChange={(value) => update({ ...noise, poisson_peak: value }, 'custom')}
          />
        </div>
      )}
      {showSeed && <NoiseSeedControls seed={seed} setSeed={setSeed} labelPrefix={labelPrefix} />}
    </div>
  );
}
