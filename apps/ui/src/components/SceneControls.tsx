import type { ReactNode } from 'react';
import { Slider } from './Controls';
import type { EulerTuple, QuaternionTuple, SceneSettings, ViewMode, RenderJobMode } from '../types';
interface Props {
  mode: RenderJobMode;
  count: number;
  setCount: (v: number) => void;
  seed: number;
  setSeed: (v: number) => void;
  axes: boolean;
  setAxes: (v: boolean) => void;
  safeFrame: boolean;
  setSafeFrame: (v: boolean) => void;
  resetView: () => void;
  poseDisabled?: boolean;
  customSequenceControls?: ReactNode;
  angles: EulerTuple;
  quaternion: QuaternionTuple;
  distance: number;
  lighting: SceneSettings['lighting'];
  noise: SceneSettings['noise'];
  viewMode: ViewMode;
  updateAngle: (index: number, value: number) => void;
  setDistance: (v: number) => void;
  setLighting: (v: SceneSettings['lighting']) => void;
  setNoise: (v: SceneSettings['noise']) => void;
  onResetPose: () => void;
}
export default function SceneControls(p: Props) {
  const fixed = p.mode === 'single' || p.mode === 'custom_sequence';
  return (
    <aside className="right-column panel" aria-label="本次采集参数">
      <h2>本次采集参数</h2>
      {p.customSequenceControls}
      {p.mode === 'single' && (
        <fieldset className="control-section manual-pose" disabled={p.poseDisabled}>
          <div className="control-title">
            <h3>目标姿态（欧拉角，单位：°）</h3>
            <button className="text-button" onClick={p.onResetPose}>
              归零
            </button>
          </div>
          <div className="trajectory-angles">
            {(['X', 'Y', 'Z'] as const).map((axis, i) => (
              <label key={axis}>
                {axis}
                <input
                  aria-label={`${axis} 轴旋转数值`}
                  type="number"
                  step="0.5"
                  value={Number.isFinite(p.angles[i]) ? p.angles[i] : ''}
                  onChange={(e) => {
                    if (Number.isFinite(e.target.valueAsNumber))
                      p.updateAngle(i, e.target.valueAsNumber);
                  }}
                />
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {p.mode === 'coverage' && (
        <section className="control-section">
          <h3>全姿态采样</h3>
          <p className="control-caption">
            均匀采样 SO(3) 姿态，距离在 10–30 km 分层采样。当前手动姿态与距离不参与采样。
          </p>
        </section>
      )}
      {p.mode === 'sequence' && (
        <section className="control-section">
          <h3>连续序列</h3>
          <p className="control-caption">
            固定视场，默认 1°/s、1 秒间隔；距离从 30 km 变化至 10 km，初始姿态由随机种子生成。
          </p>
        </section>
      )}
      <section className="control-section capture-basics">
        <label className="common-row">
          <strong>生成帧数</strong>
          <input
            aria-label="采集数量"
            type="number"
            min={p.mode === 'custom_sequence' ? 2 : 1}
            max="100000"
            step="1"
            value={Number.isFinite(p.count) ? p.count : ''}
            disabled={p.mode === 'single'}
            onChange={(e) => p.setCount(e.target.valueAsNumber)}
          />
          <span>{p.mode === 'custom_sequence' ? '包含起点与终点' : '帧'}</span>
        </label>
        {fixed && (
          <label className="common-row">
            <strong>相机距离（固定）</strong>
            <input
              aria-label="目标距离数值"
              type="number"
              min="10"
              max="30"
              step="0.1"
              value={Number.isFinite(p.distance) ? p.distance / 1000 : ''}
              onChange={(e) => p.setDistance(e.target.valueAsNumber * 1000)}
            />
            <span>km</span>
          </label>
        )}
      </section>
      <section className="control-section">
        <h3>光照设置</h3>
        <Slider
          label="太阳光照方向角"
          value={p.lighting.azimuth_deg}
          min={-180}
          max={180}
          unit="°"
          onChange={(v) => p.setLighting({ ...p.lighting, azimuth_deg: v })}
        />
      </section>
      <section className="control-section">
        <h3>噪声设置</h3>
        <label className="noise-checkbox">
          <input
            aria-label="启用像素噪声"
            type="checkbox"
            checked={p.noise.enabled}
            onChange={(e) => p.setNoise({ ...p.noise, enabled: e.target.checked })}
          />
          添加噪声（默认关闭）
        </label>
      </section>
      <details className="advanced-settings">
        <summary>高级参数</summary>
        <section className="control-section">
          <h3>随机与光照细节</h3>
          <label className="field">
            随机种子
            <input
              aria-label="随机种子"
              type="number"
              min="0"
              max="4294967295"
              step="1"
              value={Number.isFinite(p.seed) ? p.seed : ''}
              onChange={(e) => p.setSeed(e.target.valueAsNumber)}
            />
          </label>
          <Slider
            label="高度角"
            value={p.lighting.elevation_deg}
            min={-90}
            max={90}
            unit="°"
            onChange={(v) => p.setLighting({ ...p.lighting, elevation_deg: v })}
          />
          <Slider
            label="光照能量"
            value={p.lighting.energy}
            min={0}
            max={12}
            step={0.1}
            onChange={(v) => p.setLighting({ ...p.lighting, energy: v })}
          />
        </section>
        <section className="control-section">
          <h3>像素噪声细节</h3>
          <Slider
            label="高斯 σ"
            value={p.noise.gaussian_sigma}
            min={0}
            max={0.1}
            step={0.001}
            disabled={!p.noise.enabled}
            onChange={(v) => p.setNoise({ ...p.noise, gaussian_sigma: v })}
          />
          <Slider
            label="泊松峰值"
            value={p.noise.poisson_peak}
            min={1}
            max={512}
            disabled={!p.noise.enabled}
            onChange={(v) => p.setNoise({ ...p.noise, poisson_peak: v })}
          />
          <p className="control-caption">
            启用时保存原图与含噪图，关闭时仅保存原图；可从已有原图追加噪声版本。
          </p>
        </section>
        <section className="control-section">
          <h3>手动姿态四元数 [W, X, Y, Z]</h3>
          <code>
            {[p.quaternion[3], p.quaternion[0], p.quaternion[1], p.quaternion[2]]
              .map((v) => v.toFixed(6))
              .join('  ')}
          </code>
        </section>
        <section className="control-section">
          <h3>预览辅助</h3>
          <label>
            <input type="checkbox" checked={p.axes} onChange={(e) => p.setAxes(e.target.checked)} />
            坐标轴
          </label>
          <label>
            <input
              type="checkbox"
              checked={p.safeFrame}
              onChange={(e) => p.setSafeFrame(e.target.checked)}
            />
            安全框
          </label>
          <button className="button" onClick={p.resetView}>
            复位观察
          </button>
          <p className="control-caption">
            观察缩放、补光和辅助线不改变正式采集参数，也不进入输出。
          </p>
        </section>
        <section className="control-section coordinate-guidance">
          <h3>坐标与输出约定</h3>
          <p>内禀 XYZ 欧拉角 · 主动旋转 B → W。左手系零姿态 X 图像右、Y 朝观测相机、Z 图像上。</p>
          <p>
            默认 CamQuat [W, X, Y, Z]：0.5 0.5 -0.5 0.5。相机 X 图像上、Y 图像左、Z 沿光轴朝目标。
          </p>
          <p>
            1024 × 1024 · 8 位灰度 · PNG + YOLO TXT + 姿态 JSON。固定视场按模型在 10 km
            处建立，距离改变不自动调焦。
          </p>
          <p>satellite-pose-4.0 · lh-client-world-v2 · threejs-detail-v1</p>
        </section>
      </details>
    </aside>
  );
}
