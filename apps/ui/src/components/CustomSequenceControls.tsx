import type { EulerTuple, QuaternionTuple } from '../types';
import type { useCustomSequence } from '../useCustomSequence';

export function QuaternionReadout({
  label,
  value,
}: {
  label: string;
  value: QuaternionTuple | null;
}) {
  return (
    <div className="quaternion">
      <span>
        {label} <small>[W, X, Y, Z]</small>
      </span>
      <code>
        {value
          ? [value[3], value[0], value[1], value[2]].map((v) => v.toFixed(6)).join('  ')
          : '请填写有效角度'}
      </code>
    </div>
  );
}
export default function CustomSequenceControls({
  sequence,
  manualAngles,
  count,
}: {
  sequence: ReturnType<typeof useCustomSequence>;
  manualAngles: EulerTuple;
  count: number;
}) {
  return (
    <section className="control-section custom-sequence" aria-label="自定义姿态序列配置">
      <div className="control-title">
        <h3>自定义姿态序列</h3>
        <span className="mini-tag">包含首尾</span>
      </div>
      <p className="control-caption">
        沿最短旋转路径过渡；相同起止姿态得到静止序列，不表示转一整圈。距离、相机与光照在序列内固定。
      </p>
      {(['起点', '终点'] as const).map((label, endpoint) => {
        const angles = endpoint === 0 ? sequence.start : sequence.end;
        const setAngles = endpoint === 0 ? sequence.setStart : sequence.setEnd;
        return (
          <div className="trajectory-endpoint" key={label}>
            <div className="control-title">
              <h4>{label}姿态 · XYZ (°)</h4>
              <button
                className="text-button"
                aria-label={`${label}使用当前姿态`}
                onClick={() => setAngles([...manualAngles])}
              >
                使用当前姿态
              </button>
            </div>
            <div className="trajectory-angles">
              {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                <label key={axis}>
                  {axis}
                  <input
                    aria-label={`${label}${axis}角度`}
                    type="number"
                    step="0.5"
                    value={Number.isFinite(angles[i]) ? angles[i] : ''}
                    onChange={(event) => {
                      const next: EulerTuple = [...angles];
                      next[i] = event.target.valueAsNumber;
                      setAngles(next);
                    }}
                  />
                </label>
              ))}
            </div>
            <QuaternionReadout
              label={`${label} SatQuat`}
              value={endpoint === 0 ? sequence.startQuaternion : sequence.endQuaternion}
            />
          </div>
        );
      })}
      <p className="control-caption">
        “使用当前姿态”记录手动配置，预览不覆盖手动姿态。预览以 10 帧/秒播放；标注时间间隔为 1 秒。
      </p>
      {sequence.error && (
        <p className="inline-error" role="alert">
          {sequence.error}
        </p>
      )}
      <div className="trajectory-actions">
        <button
          className="button"
          disabled={Boolean(sequence.error)}
          onClick={sequence.playing ? sequence.pause : sequence.play}
        >
          {sequence.playing ? '暂停预览' : '播放预览'}
        </button>
        <button className="button" onClick={sequence.exit} disabled={!sequence.active}>
          退出预览
        </button>
      </div>
      <label className="trajectory-timeline">
        预览帧
        <input
          aria-label="预览帧"
          type="range"
          min="0"
          max={Number.isInteger(count) && count >= 2 ? count - 1 : 1}
          step="1"
          value={sequence.frame}
          disabled={Boolean(sequence.error)}
          onChange={(event) => sequence.scrub(event.target.valueAsNumber)}
        />
      </label>
      <p className="control-caption" aria-label="当前预览帧">
        {sequence.active ? `当前预览帧 ${sequence.frame + 1} / ${count}` : '手动姿态 · 预览未启用'}
      </p>
      {sequence.active && (
        <QuaternionReadout label="当前预览 SatQuat" value={sequence.quaternion} />
      )}
    </section>
  );
}
