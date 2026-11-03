import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Viewport from '../components/Viewport';
import type { ModelInfo, QuaternionTuple, SceneSettings } from '../types';
import type { ViewerCommand, ViewerModelStats, ViewerPreset, ViewerStyle } from '../viewer';
import './viewer.css';

type Mode = 'observe' | 'pose' | 'capture';
interface Props {
  model: ModelInfo | undefined;
  scene: SceneSettings;
  rotating: boolean;
  onStopRotation: () => void;
  onRotateChange: (rotating: boolean) => void;
  onDistanceWheel: (deltaY: number, deltaMode: number, pageHeight: number) => void;
  onPoseChange: (quaternion: QuaternionTuple) => void;
  onReady: (modelId: string | null) => void;
  ready: string | null;
}

const modes: { value: Mode; label: string; hint: string }[] = [
  { value: 'observe', label: '自由观察', hint: '拖动环绕 · 右键平移 · 滚轮缩放；拍摄参数保持不变' },
  { value: 'pose', label: '拍照调姿', hint: '拖动修改拍摄姿态 · 滚轮调整拍摄距离' },
  { value: 'capture', label: '拍摄预览', hint: '灰度拍摄视角 · 姿态与距离由右侧拍摄设置控制' },
];
const presets: { value: ViewerPreset; label: string }[] = [
  { value: 'home', label: '默认' },
  { value: 'front', label: '前' },
  { value: 'back', label: '后' },
  { value: 'left', label: '左' },
  { value: 'right', label: '右' },
  { value: 'top', label: '顶' },
  { value: 'bottom', label: '底' },
];

export default function WebViewport(props: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const infoId = useId();
  const [mode, setMode] = useState<Mode>('observe');
  const [axes, setAxes] = useState(false);
  const [style, setStyle] = useState<ViewerStyle>('solid');
  const [command, setCommand] = useState<ViewerCommand>({ sequence: 0, action: 'home' });
  const [showInfo, setShowInfo] = useState(false);
  const [stats, setStats] = useState<{
    modelId: string | undefined;
    value: ViewerModelStats;
  } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenPending, setFullscreenPending] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const observing = mode === 'observe';
  const capturing = mode === 'capture';
  const loaded = !!props.model && props.ready === props.model.id;
  const modelStats = loaded && stats?.modelId === props.model?.id ? stats?.value : null;
  const modeHint = modes.find((item) => item.value === mode)!.hint;
  const onModelStats = useCallback(
    (value: ViewerModelStats | null) => {
      setStats(value ? { modelId: props.model?.id, value } : null);
    },
    [props.model?.id],
  );

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === wrapperRef.current);
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.fullscreenElement !== wrapperRef.current) return;
      event.preventDefault();
      void document.exitFullscreen().catch((error: unknown) => {
        setFullscreenError(
          `退出全屏未完成：${error instanceof Error ? error.message : '请使用全屏按钮重试。'}`,
        );
      });
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('keydown', exitOnEscape);
    sync();
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('keydown', exitOnEscape);
    };
  }, []);

  function switchMode(next: Mode) {
    if (next === mode) return;
    props.onStopRotation();
    setMode(next);
  }

  function issue(action: ViewerCommand['action']) {
    setCommand((current) => ({ sequence: current.sequence + 1, action }));
  }

  async function toggleFullscreen() {
    const wrapper = wrapperRef.current;
    if (!wrapper || fullscreenPending) return;
    setFullscreenError('');
    setFullscreenPending(true);
    try {
      if (document.fullscreenElement === wrapper) {
        await document.exitFullscreen();
      } else {
        if (!wrapper.requestFullscreen || !document.fullscreenEnabled) {
          throw new Error('当前浏览器或页面不支持全屏。');
        }
        await wrapper.requestFullscreen();
      }
      setFullscreen(document.fullscreenElement === wrapper);
    } catch (error) {
      setFullscreenError(
        `全屏切换未完成：${error instanceof Error ? error.message : '请重试或检查浏览器权限。'}`,
      );
    } finally {
      setFullscreenPending(false);
    }
  }

  return (
    <div className="web-viewer" ref={wrapperRef}>
      <div className="viewer-modebar" role="group" aria-label="模型视口模式">
        {modes.map((item, index) => (
          <button
            type="button"
            key={item.value}
            aria-pressed={mode === item.value}
            className={`viewer-mode viewer-mode-${item.value}`}
            onClick={() => switchMode(item.value)}
          >
            <span aria-hidden="true">0{index + 1}</span> {item.label}
          </button>
        ))}
      </div>
      <div className="viewer-stage">
        <Viewport
          model={props.model}
          scene={props.scene}
          mode={capturing ? 'capture' : 'inspect'}
          axes={!capturing && axes}
          rotating={!capturing && props.rotating}
          onStopRotation={props.onStopRotation}
          reset={0}
          dragEnabled={mode === 'pose'}
          previewOnly={observing}
          onBeginPoseDrag={props.onStopRotation}
          poseEditEpoch={0}
          poseEditHint={modeHint}
          distanceEditable={mode === 'pose'}
          automaticDistance={false}
          onDistanceWheel={(...args) => {
            if (mode === 'pose') props.onDistanceWheel(...args);
          }}
          onPoseChange={(quaternion) => {
            if (mode === 'pose') props.onPoseChange(quaternion);
          }}
          onReady={props.onReady}
          viewer={{ enabled: observing, style: capturing ? 'solid' : style, command }}
          onModelStats={onModelStats}
        />
      </div>
      <div className="viewer-toolbar" aria-label="模型观察工具">
        <div className="viewer-camera-tools" role="group" aria-label="观察视角与缩放">
          <span className="viewer-group-label">视角</span>
          <div className="viewer-presets" role="group" aria-label="标准视角">
            {presets.map((preset) => (
              <button
                type="button"
                key={preset.value}
                aria-label={`${preset.label}视角`}
                title={observing ? `${preset.label}视角` : '请切换到自由观察'}
                disabled={!observing || !loaded}
                onClick={() => issue(preset.value)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="viewer-zoom" role="group" aria-label="观察缩放">
            <button
              type="button"
              disabled={!observing || !loaded}
              onClick={() => issue('fit')}
              title="完整显示模型"
            >
              适应
            </button>
            <button
              type="button"
              disabled={!observing || !loaded}
              onClick={() => issue('zoomOut')}
              aria-label="缩小观察视图"
            >
              −
            </button>
            <button
              type="button"
              disabled={!observing || !loaded}
              onClick={() => issue('zoomIn')}
              aria-label="放大观察视图"
            >
              ＋
            </button>
          </div>
        </div>
        <div className="viewer-display-tools" role="group" aria-label="显示与辅助工具">
          <label className="viewer-style">
            <span>显示</span>
            <select
              aria-label="模型显示样式"
              value={capturing ? 'solid' : style}
              disabled={capturing}
              onChange={(event) => setStyle(event.target.value as ViewerStyle)}
            >
              <option value="solid">实体</option>
              <option value="wireframe">线框</option>
              <option value="edges">实体＋边线</option>
            </select>
          </label>
          <button
            type="button"
            aria-pressed={!capturing && axes}
            disabled={capturing}
            onClick={() => setAxes(!axes)}
          >
            坐标轴
          </button>
          <button
            type="button"
            aria-pressed={!capturing && props.rotating}
            disabled={capturing || !loaded}
            onClick={() => props.onRotateChange(!props.rotating)}
          >
            自动旋转
          </button>
          <button
            type="button"
            aria-expanded={showInfo}
            aria-controls={infoId}
            onClick={() => setShowInfo(!showInfo)}
          >
            模型信息 <span aria-hidden="true">{showInfo ? '−' : '＋'}</span>
          </button>
          <button
            type="button"
            className="viewer-fullscreen"
            aria-pressed={fullscreen}
            disabled={fullscreenPending}
            onClick={() => void toggleFullscreen()}
            aria-label={fullscreen ? '退出模型视口全屏' : '模型视口全屏'}
          >
            {fullscreen ? '退出全屏 ↙' : '全屏 ↗'}
          </button>
        </div>
      </div>
      <div className={`viewer-caption viewer-caption-${mode}`}>
        <span>{modeHint}</span>
        <strong>拍摄 {(props.scene.distance_m / 1000).toFixed(2)} km</strong>
      </div>
      <section className="viewer-info" id={infoId} hidden={!showInfo} aria-label="模型信息">
        <div className="viewer-info-title">
          <strong>{props.model?.name ?? '等待模型'}</strong>
          <span>{props.model?.id}</span>
        </div>
        {modelStats ? (
          <>
            <dl>
              <div>
                <dt>网格数</dt>
                <dd>{modelStats.meshCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>三角面数</dt>
                <dd>{modelStats.triangleCount.toLocaleString()}</dd>
              </div>
              <div className="viewer-dimensions">
                <dt>
                  {props.model?.physical_scale_calibrated
                    ? '模型尺寸 · 已标定'
                    : '模型尺寸 · 未做物理标定'}
                </dt>
                <dd>
                  {modelStats.dimensions
                    .map((n) => Number(n.toPrecision(4)).toLocaleString())
                    .join(' × ')}{' '}
                  {props.model?.physical_scale_calibrated ? 'm' : '模型单位'}
                </dd>
              </div>
            </dl>
            <p>尺寸为原始模型包围盒的三边尺寸；网格数不代表工程部件数。{props.model?.scale_note}</p>
          </>
        ) : (
          <p>模型就绪后显示网格与尺寸信息。</p>
        )}
      </section>
      {fullscreenError && (
        <div className="viewer-fullscreen-error" role="alert">
          <span>{fullscreenError}</span>
          <button type="button" aria-label="关闭全屏提示" onClick={() => setFullscreenError('')}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
