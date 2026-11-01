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
}: {
  sequence: ReturnType<typeof useCustomSequence>;
  manualAngles: EulerTuple;
  count: number;
}) {
  return (
    <section className="control-section custom-sequence" aria-label="自定义姿态序列配置">
      <div className="control-title">
        <h3>起止姿态（欧拉角，单位：°）</h3>
        <span className="mini-tag">包含首尾</span>
      </div>

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
          </div>
        );
      })}

      {sequence.error && (
        <p className="inline-error" role="alert">
          {sequence.error}
        </p>
      )}
      <details className="sequence-guidance">
        <summary>轨迹说明与四元数</summary>
        <p>
          沿最短旋转路径过渡，包含首尾。相同起止姿态生成静止序列，不表示转一整圈。距离、相机、光照固定；预览
          10 帧/秒，标注间隔 1 秒。
        </p>
        <QuaternionReadout label="起点 SatQuat" value={sequence.startQuaternion} />
        <QuaternionReadout label="终点 SatQuat" value={sequence.endQuaternion} />
      </details>
    </section>
  );
}
