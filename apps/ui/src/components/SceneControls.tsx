import type { ReactNode } from 'react';
import { Slider, Toggle } from './Controls';
import type { EulerTuple, QuaternionTuple, SceneSettings, ViewMode } from '../types';

interface Props {
  poseDisabled?: boolean;
  customSequenceControls?: ReactNode;
  angles: EulerTuple;
  quaternion: QuaternionTuple;
  distance: number;
  lighting: SceneSettings['lighting'];
  noise: SceneSettings['noise'];
  viewMode: ViewMode;
  updateAngle: (index: number, value: number) => void;
  setDistance: (distance: number) => void;
  setLighting: (lighting: SceneSettings['lighting']) => void;
  setNoise: (noise: SceneSettings['noise']) => void;
  onResetPose: () => void;
}

export default function SceneControls({
  poseDisabled = false,
  customSequenceControls,
  angles,
  quaternion,
  distance,
  lighting,
  noise,
  viewMode,
  updateAngle,
  setDistance,
  setLighting,
  setNoise,
  onResetPose,
}: Props) {
  return (
    <aside className="right-column panel">
      <div className="section-title">
        <h2>场景参数</h2>
        <span className="eyebrow">SCENE</span>
      </div>
      <fieldset className="control-section manual-pose" disabled={poseDisabled}>
        <div className="control-title">
          <h3>手动目标姿态</h3>
          <button className="text-button" onClick={onResetPose}>
            归零
          </button>
        </div>
        {poseDisabled && (
          <p className="control-caption accent">正在显示序列预览；退出预览后恢复此手动姿态。</p>
        )}
        <p className="control-caption">内禀 XYZ 欧拉角 · 主动旋转 B → W</p>
        <p className="control-caption">左手系 · 零姿态 X 图像右、Y 朝观测相机、Z 图像上</p>
        {(['X 轴旋转', 'Y 轴旋转', 'Z 轴旋转'] as const).map((label, index) => (
          <Slider
            key={label}
            label={label}
            value={angles[index]}
            min={-180}
            max={180}
            step={0.5}
            unit="°"
            onChange={(value) => updateAngle(index, value)}
          />
        ))}
        <div className="quaternion">
          <span>
            SatQuat <small>[W, X, Y, Z]</small>
          </span>
          <code>
            {[quaternion[3], quaternion[0], quaternion[1], quaternion[2]]
              .map((value) => (Math.abs(value) < 0.0000005 ? '0.000000' : value.toFixed(6)))
              .join('  ')}
          </code>
        </div>
      </fieldset>
      {customSequenceControls}
      <section className="control-section">
        <div className="control-title">
          <h3>观测相机</h3>
          <span className="mini-tag">固定内参</span>
        </div>
        <Slider
          label="目标距离"
          value={distance / 1000}
          min={10}
          max={30}
          step={0.1}
          unit="km"
          onChange={(value) => setDistance(Math.round(value * 1000))}
        />
        <div className="range-labels">
          <span>10 km</span>
          <span>30 km</span>
        </div>
        <p className="control-caption">
          切换模型时按包围球建立视场；同一模型改变距离不会自动调焦。
        </p>
        <div className="quaternion">
          <span>
            默认 CamQuat <small>[W, X, Y, Z]</small>
          </span>
          <code>0.5 0.5 -0.5 0.5</code>
        </div>
        <p className="control-caption">
          观测相机左手系：X 图像上、Y 图像左、Z 沿光轴朝目标。自由观察不改变观测相机或采集姿态。
        </p>
      </section>
      <section className="control-section">
        <div className="control-title">
          <h3>太阳光照</h3>
          <span className="sun-icon">☼</span>
        </div>
        <Slider
          label="方位角"
          value={lighting.azimuth_deg}
          min={-180}
          max={180}
          unit="°"
          onChange={(value) => setLighting({ ...lighting, azimuth_deg: value })}
        />
        <Slider
          label="高度角"
          value={lighting.elevation_deg}
          min={-90}
          max={90}
          unit="°"
          onChange={(value) => setLighting({ ...lighting, elevation_deg: value })}
        />
        <Slider
          label="光照能量"
          value={lighting.energy}
          min={0}
          max={12}
          step={0.1}
          onChange={(value) => setLighting({ ...lighting, energy: value })}
        />
        {viewMode === 'inspect' && (
          <p className="control-caption accent">自由观察已启用独立补光，正式任务仍使用此处参数。</p>
        )}
      </section>
      <section className="control-section">
        <div className="control-title">
          <h3>像素噪声</h3>
          <Toggle
            label="启用像素噪声"
            checked={noise.enabled}
            onChange={(enabled) => setNoise({ ...noise, enabled })}
          />
        </div>
        <Slider
          label="高斯 σ"
          value={noise.gaussian_sigma}
          min={0}
          max={0.1}
          step={0.001}
          onChange={(value) => setNoise({ ...noise, gaussian_sigma: value })}
          disabled={!noise.enabled}
        />
        <Slider
          label="泊松峰值"
          value={noise.poisson_peak}
          min={1}
          max={512}
          step={1}
          onChange={(value) => setNoise({ ...noise, poisson_peak: value })}
          disabled={!noise.enabled}
        />
        <p className="control-caption">
          像素域模拟，在正式输出中应用。启用时保存原图与含噪图；关闭时仅保存原图。也可从已有原图追加噪声版本。
        </p>
      </section>
      <div className="schema-note">
        <span className="status-led" />
        <span>
          satellite-pose-4.0
          <br />
          <small>左手坐标系 · lh-client-world-v2</small>
        </span>
      </div>
    </aside>
  );
}
