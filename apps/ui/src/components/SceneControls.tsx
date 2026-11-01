import type { ReactNode } from 'react';
import { Slider } from './Controls';
import ImageCountControls from './ImageCountControls';
import NoiseControls, { NoiseSeedControls } from './NoiseControls';
import type {
  DistancePolicy,
  EulerTuple,
  QuaternionTuple,
  SceneSettings,
  RenderJobMode,
} from '../types';
interface Props {
  mode: RenderJobMode;
  count: number;
  setCount: (v: number) => void;
  seed: number;
  setSeed: (v: number) => void;
  poseDisabled?: boolean;
  customSequenceControls?: ReactNode;
  footer?: ReactNode;
  angles: EulerTuple;
  quaternion: QuaternionTuple;
  distance: number;
  distanceDisabled?: boolean;
  distancePolicy: DistancePolicy;
  setDistancePolicy: (v: DistancePolicy) => void;
  lighting: SceneSettings['lighting'];
  noise: SceneSettings['noise'];
  updateAngle: (i: number, v: number) => void;
  setDistance: (v: number) => void;
  setLighting: (v: SceneSettings['lighting']) => void;
  setNoise: (v: SceneSettings['noise']) => void;
  onResetPose: () => void;
}
export default function SceneControls(p: Props) {
  const random = p.mode === 'coverage' || p.mode === 'sequence';
  return (
    <aside className="right-column panel" aria-label="本次采集参数">
      <h2 className="settings-title">拍摄设置</h2>
      <div className="settings-content">
        {random && (
          <p className="control-caption mode-guidance">
            {p.mode === 'coverage'
              ? '按种子均匀采样全部朝向，当前模式不使用手动调姿。'
              : '初始姿态由种子生成，默认每秒旋转 1°，当前模式不使用手动调姿。'}
          </p>
        )}
        {p.mode !== 'single' && (
          <ImageCountControls key={p.mode} mode={p.mode} count={p.count} setCount={p.setCount} />
        )}
        {(p.mode === 'single' || p.mode === 'custom_sequence') && (
          <fieldset className="control-section manual-pose" disabled={p.poseDisabled}>
            <div className="control-title">
              <h3>卫星朝向</h3>
              <button className="text-button" onClick={p.onResetPose}>
                归零
              </button>
            </div>
            <p className="control-caption">
              {p.poseDisabled
                ? '当前暂停编辑，退出预览或完成提交后可继续调姿。'
                : p.mode === 'custom_sequence'
                  ? '拖动与角度同步，可将当前姿态设为起点或终点。'
                  : '拖动与角度同步，生成图片使用当前姿态。'}
            </p>
            {(['X', 'Y', 'Z'] as const).map((axis, i) => (
              <Slider
                key={axis}
                label={`${axis} 轴旋转`}
                value={p.angles[i]}
                min={-180}
                max={180}
                step={0.5}
                displayPrecision={2}
                unit="°"
                onChange={(v) => p.updateAngle(i, v)}
              />
            ))}
          </fieldset>
        )}
        {p.customSequenceControls}
        {random && (
          <section className="control-section">
            <label className="field distance-policy">
              拍摄距离方式
              <select
                aria-label="拍摄距离方式"
                value={p.distancePolicy}
                onChange={(e) => p.setDistancePolicy(e.target.value as DistancePolicy)}
              >
                <option value="fixed">固定距离</option>
                <option value="automatic">自动距离</option>
              </select>
            </label>
            {p.distancePolicy === 'automatic' && (
              <p className="control-caption">
                {p.mode === 'coverage'
                  ? '距离在 10–30 km 分层采样。'
                  : '距离从 30 km 变化至 10 km。'}
              </p>
            )}
          </section>
        )}
        <section className="control-section capture-basics">
          {(!random || p.distancePolicy === 'fixed') && (
            <>
              <Slider
                label="拍摄距离"
                value={p.distance / 1000}
                min={10}
                max={30}
                step={0.1}
                displayPrecision={2}
                unit="km"
                disabled={p.distanceDisabled}
                onChange={(v) => p.setDistance(v * 1000)}
              />
              <div className="range-labels">
                <span>10 km</span>
                <span>30 km</span>
              </div>
            </>
          )}
        </section>
        <details className="lighting-disclosure">
          <summary>
            <strong>光照与噪声</strong>
            <small>{p.noise.enabled ? '已启用像素噪声' : '标准光照 · 无噪声'}</small>
          </summary>
          <Slider
            label="太阳光照方向角"
            value={p.lighting.azimuth_deg}
            min={-180}
            max={180}
            unit="°"
            onChange={(v) => p.setLighting({ ...p.lighting, azimuth_deg: v })}
          />
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
          <NoiseControls
            noise={p.noise}
            setNoise={p.setNoise}
            seed={p.seed}
            setSeed={p.setSeed}
            showSeed={false}
          />
        </details>
        <NoiseSeedControls seed={p.seed} setSeed={p.setSeed} />
        <details className="technical-details">
          <summary>技术详情</summary>
          <section className="control-section">
            <h3>当前预览姿态四元数 [W, X, Y, Z]</h3>
            <code>
              {[p.quaternion[3], ...p.quaternion.slice(0, 3)].map((v) => v.toFixed(6)).join('  ')}
            </code>
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
            <p>
              拖动调姿与角度输入同步；固定距离时滚轮、距离输入和正式出图联动。辅助线不进入正式图片。
            </p>
          </section>
        </details>
      </div>
      {p.footer}
    </aside>
  );
}
