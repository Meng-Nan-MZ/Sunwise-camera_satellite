import { useEffect, useState } from 'react';
import { Euler, Quaternion } from 'three';
import WebViewport from './WebViewport';
import type { EulerTuple, ModelInfo, SceneSettings } from '../types';
import { BrowserStudio, WEB_VERSION } from './studio';
import { bindWebMcp, createWebMcpTools } from './webmcp';
import { modeLabels, statusLabels } from '../workbench';
import { fromClientQuaternion } from '../trajectory';
import './browser.css';

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
const configNames: Record<string, string> = {
  single_panel: '单帆板',
  double_panel: '双帆板',
  multi_panel: '多帆板',
};
const noisePresets: Record<string, SceneSettings['noise']> = {
  none: { enabled: false, gaussian_sigma: 0.012, poisson_peak: 96 },
  light: { enabled: true, gaussian_sigma: 0.006, poisson_peak: 192 },
  medium: { enabled: true, gaussian_sigma: 0.012, poisson_peak: 96 },
  strong: { enabled: true, gaussian_sigma: 0.025, poisson_peak: 48 },
};
function Field({
  label,
  value,
  onCommit,
  min,
  max,
  step = 1,
  unit = '',
}: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(Math.round(value * 1e6) / 1e6)), [value]);
  return (
    <label className="number-field">
      <span>{label}</span>
      <span className="number-input">
        <input
          aria-label={label}
          type="number"
          min={min}
          max={max}
          step={step}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text.trim() !== '' && Number.isFinite(Number(text))) onCommit(Number(text));
            setText(String(Math.round(value * 1e6) / 1e6));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        {unit && <b>{unit}</b>}
      </span>
    </label>
  );
}
function useImage(bytes: Uint8Array | undefined) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!bytes) {
      setUrl('');
      return;
    }
    const next = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'image/png' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes]);
  return url;
}
export default function BrowserApp() {
  const [studio, setStudio] = useState<BrowserStudio>();
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    const ctrl = new AbortController();
    let instance: BrowserStudio | undefined;
    void fetch('./catalog.json', { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error('无法读取模型目录，请运行本地启动脚本。');
        return r.json();
      })
      .then((models: ModelInfo[]) => {
        if (ctrl.signal.aborted) return;
        instance = new BrowserStudio(models);
        setStudio(instance);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setLoadError(String(e));
      });
    return () => {
      ctrl.abort();
      instance?.dispose();
    };
  }, []);
  return studio ? (
    <Workbench studio={studio} />
  ) : (
    <div className="loading-page">
      <div className="brand-mark">S↗</div>
      <h1>Satellite Studio V4</h1>
      <p role="status">{loadError || '正在准备本地模型工作台…'}</p>
      {loadError && <button onClick={() => location.reload()}>重新载入</button>}
    </div>
  );
}
function Workbench({ studio }: { studio: BrowserStudio }) {
  const [, refresh] = useState(0);
  useEffect(() => studio.subscribe(() => refresh((n) => n + 1)), [studio]);
  const state = studio.getState(),
    draft = state.draft,
    scene = draft.scene;
  const [page, setPage] = useState<'capture' | 'results' | 'agent'>('capture');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [selected, setSelected] = useState(''),
    [frameIndex, setFrameIndex] = useState(0),
    [showNoisy, setShowNoisy] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [ready, setReady] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<{
    available: boolean;
    registered: number;
    message: string;
  }>({ available: false, registered: 0, message: '正在检查浏览器支持…' });
  const [noiseLevel, setNoiseLevel] = useState('medium');
  const models = studio.listModels(),
    model = models.find((m) => m.id === scene.model_id);
  const job = state.jobs.find((j) => j.id === selected) ?? state.jobs[0];
  useEffect(() => {
    setFrameIndex(0);
  }, [job?.id]);
  const frame = job
    ? studio.getFrame(job.id, Math.min(frameIndex, Math.max(0, job.completed_frames - 1)))
    : undefined;
  const imageUrl = useImage(showNoisy && frame?.noisy ? frame.noisy : frame?.clean);
  const euler = new Euler().setFromQuaternion(
    new Quaternion(...fromClientQuaternion(scene.sat_quat)),
    'XYZ',
  );
  const angles = [euler.x, euler.y, euler.z].map((n) => (n * 180) / Math.PI) as EulerTuple;
  function act(action: () => unknown) {
    try {
      setError('');
      return action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const configure = (input: unknown) =>
    act(() => {
      setRotating(false);
      return studio.configure(input);
    });
  useEffect(() => bindWebMcp(studio, setAgentStatus), [studio]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (studio.getState().busy || studio.getState().jobs.length) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [studio]);
  const launch = () =>
    act(() => {
      const created = studio.startCapture();
      setSelected(created.id);
      setFrameIndex(0);
      setNotice('任务已开始；请保持此页面运行。');
    });
  const download = () =>
    job &&
    act(() => {
      studio.prepareDownload(job.id);
      setNotice('ZIP 已准备好，点击保存按钮下载。');
    });
  return (
    <div className="web-shell">
      <header className="site-header">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage('capture');
          }}
        >
          <span className="brand-mark">S↗</span>
          <span>
            SATELLITE<span className="brand-sub">Satellite Studio V4</span>
          </span>
        </a>
        <div className="header-badges">
          <span className="local-badge">● 本机运算 · 数据不上传</span>
          <span className="version-tag">WEB V4</span>
        </div>
      </header>
      <main>
        <section className="intro">
          <div>
            <span className="intro-tag">你的浏览器，就是影像实验室</span>
            <h1>
              卫星影像<span>实验台。</span>
            </h1>
            <p>转动模型，设定参数，把每个视角变成可下载的数据集。</p>
          </div>
          <div className="intro-stamp" aria-label="浏览器本地出图">
            <span>LOCAL</span>
            <strong>100%</strong>
            <span>浏览器出图 ↙</span>
          </div>
        </section>
        <nav className="work-tabs" aria-label="工作台导航">
          {(
            [
              ['capture', '01', '采集工作台'],
              ['results', '02', '本次结果'],
              ['agent', '03', 'AI 接入'],
            ] as const
          ).map(([key, n, label]) => (
            <button
              key={key}
              className={page === key ? 'active' : ''}
              aria-current={page === key ? 'page' : undefined}
              onClick={() => setPage(key)}
            >
              <span>{n}</span>
              {label}
              {key === 'results' && <b>{state.jobs.length}</b>}
            </button>
          ))}
          <span className="session-size">会话 {mb(state.retained_bytes)} / 256 MiB</span>
        </nav>
        {error && (
          <div className="alert error" role="alert">
            <strong>操作未完成</strong> {error}
            <button aria-label="关闭错误提示" onClick={() => setError('')}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="alert notice" role="status">
            {notice}
            <button aria-label="关闭提示" onClick={() => setNotice('')}>
              ×
            </button>
          </div>
        )}
        <div className={page === 'capture' ? 'capture-layout' : 'capture-layout is-hidden'}>
          <section className="viewport-panel panel">
            <div className="panel-heading">
              <h2>
                <span className="section-number">01</span> 模型视口
              </h2>
              <span className="live-tag">{ready === model?.id ? '● 已就绪' : '○ 载入中'}</span>
            </div>
            <WebViewport
              model={model}
              scene={scene}
              rotating={rotating}
              onStopRotation={() => setRotating(false)}
              onRotateChange={setRotating}
              onDistanceWheel={(dy) =>
                configure({
                  distance_m: Math.max(10000, Math.min(30000, scene.distance_m + dy * 5)),
                })
              }
              onPoseChange={(q) => act(() => studio.setQuaternion(q))}
              onReady={setReady}
              ready={ready}
            />
            <div className="output-strip">
              <div>
                <b>1024 × 1024</b>
                <span>8 位灰度图像</span>
              </div>
              <div>
                <b>PNG + JSON + YOLO</b>
                <span>图像、姿态与目标标注</span>
              </div>
            </div>
            {state.busy && (
              <div className="running-strip" role="status">
                <strong>
                  正在采集 {state.jobs[0]?.completed_frames} / {state.jobs[0]?.total_frames}
                </strong>
                <progress
                  max={state.jobs[0]?.total_frames}
                  value={state.jobs[0]?.completed_frames}
                />
                <button onClick={() => act(() => studio.cancelJob(state.jobs[0].id))}>
                  取消任务
                </button>
              </div>
            )}
          </section>
          <section className="settings-panel panel">
            <div className="panel-heading lime">
              <h2>
                <span className="section-number">02</span> 拍摄设置
              </h2>
              <span>CONFIGURE ↙</span>
            </div>
            <div className="settings-body">
              <label className="field-label">
                卫星模型
                <select
                  aria-label="卫星模型"
                  value={scene.model_id}
                  onChange={(e) => {
                    setReady(null);
                    configure({ model_id: e.target.value });
                  }}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="model-detail">
                <span>{configNames[model?.configuration ?? ''] ?? '卫星模型'}</span>
                <span>{models.length} 套可选模型</span>
              </div>
              <fieldset className="mode-field">
                <legend>采集方式</legend>
                <div className="mode-grid">
                  {(['single', 'coverage', 'sequence', 'custom_sequence'] as const).map(
                    (mode, index) => (
                      <button
                        key={mode}
                        aria-pressed={draft.mode === mode}
                        className={draft.mode === mode ? 'selected' : ''}
                        onClick={() => configure({ mode })}
                      >
                        <b>{['◎', '✳', '↻', '↗'][index]}</b>
                        {modeLabels[mode]}
                      </button>
                    ),
                  )}
                </div>
              </fieldset>
              <div className="control-group">
                <div className="field-heading">
                  <b>卫星姿态</b>
                  <button
                    className="text-button"
                    onClick={() => configure({ euler_deg: [0, 0, 0] })}
                  >
                    归零 ↺
                  </button>
                </div>
                <div className="triple-fields">
                  {angles.map((value, index) => (
                    <Field
                      key={index}
                      label={['X 角度', 'Y 角度', 'Z 角度'][index]}
                      value={value}
                      min={-360}
                      max={360}
                      unit="°"
                      onCommit={(n) => {
                        const next = [...angles];
                        next[index] = n;
                        configure({ euler_deg: next });
                      }}
                    />
                  ))}
                </div>
                <p className="hint">
                  {draft.mode === 'coverage' || draft.mode === 'sequence'
                    ? '此姿态用于模型预览；正式采集按所选方式生成姿态。'
                    : '切换左侧「拍照调姿」后拖动，或输入 XYZ 角度。'}
                </p>
              </div>
              {draft.mode === 'custom_sequence' && (
                <div className="endpoint-controls">
                  <button onClick={() => act(() => studio.saveEndpoint('start'))}>
                    当前姿态设为起点
                  </button>
                  <button onClick={() => act(() => studio.saveEndpoint('end'))}>
                    当前姿态设为终点
                  </button>
                  <p className="hint">
                    包含首尾，沿最短旋转路径过渡。
                    <br />
                    起点 W {draft.trajectory?.start_quat.W.toFixed(3)} · 终点 W{' '}
                    {draft.trajectory?.end_quat.W.toFixed(3)}
                  </p>
                </div>
              )}
              <div className="distance-control">
                <Field
                  label="拍摄距离"
                  value={scene.distance_m / 1000}
                  min={10}
                  max={30}
                  step={0.1}
                  unit="km"
                  onCommit={(n) => configure({ distance_m: n * 1000 })}
                />
                <input
                  aria-label="拍摄距离滑杆"
                  type="range"
                  min={10}
                  max={30}
                  step={0.1}
                  value={scene.distance_m / 1000}
                  onChange={(e) => configure({ distance_m: Number(e.target.value) * 1000 })}
                />
                <div className="range-labels">
                  <span>10 km</span>
                  <span>30 km</span>
                </div>
              </div>
              {draft.mode !== 'single' && (
                <Field
                  label="生成图片数量"
                  value={draft.count}
                  min={draft.mode === 'custom_sequence' ? 2 : 1}
                  max={500}
                  unit="张"
                  onCommit={(count) => configure({ count })}
                />
              )}
              <details className="advanced">
                <summary>
                  光照、噪声与随机种子 <span>＋</span>
                </summary>
                <div className="triple-fields">
                  <Field
                    label="光照方位"
                    value={scene.lighting.azimuth_deg}
                    min={-360}
                    max={360}
                    onCommit={(n) => configure({ lighting: { ...scene.lighting, azimuth_deg: n } })}
                  />
                  <Field
                    label="光照仰角"
                    value={scene.lighting.elevation_deg}
                    min={-90}
                    max={90}
                    onCommit={(n) =>
                      configure({ lighting: { ...scene.lighting, elevation_deg: n } })
                    }
                  />
                  <Field
                    label="光照强度"
                    value={scene.lighting.energy}
                    min={0}
                    max={100}
                    step={0.1}
                    onCommit={(n) => configure({ lighting: { ...scene.lighting, energy: n } })}
                  />
                </div>
                <label className="field-label">
                  图像噪声
                  <select
                    aria-label="图像噪声"
                    value={
                      !scene.noise.enabled
                        ? 'none'
                        : (Object.keys(noisePresets).find(
                            (k) => JSON.stringify(noisePresets[k]) === JSON.stringify(scene.noise),
                          ) ?? 'custom')
                    }
                    onChange={(e) => configure({ noise: noisePresets[e.target.value] })}
                  >
                    <option value="none">无噪声 · 仅原图</option>
                    <option value="light">轻微噪声</option>
                    <option value="medium">中等噪声</option>
                    <option value="strong">较强噪声</option>
                    <option value="custom" disabled>
                      自定义参数（AI 设置）
                    </option>
                  </select>
                </label>
                <Field
                  label="随机种子"
                  value={scene.seed}
                  min={0}
                  max={4294967295}
                  onCommit={(seed) => configure({ seed })}
                />
              </details>
              <div className="capture-action">
                <button
                  className="primary capture-button"
                  disabled={state.busy || ready !== model?.id}
                  onClick={launch}
                >
                  <span>开始采集</span>
                  <b>{draft.mode === 'single' ? 1 : draft.count} 张 ↗</b>
                </button>
                <p>本机生成 · 无需上传 · 下载到电脑</p>
              </div>
            </div>
          </section>
        </div>
        {page === 'results' && (
          <div className="results-layout">
            <section className="panel job-panel">
              <div className="panel-heading cyan">
                <h2>本次任务</h2>
                <b>{state.jobs.length.toString().padStart(2, '0')}</b>
              </div>
              {state.jobs.length === 0 ? (
                <div className="empty-state">
                  <b>还没有采集结果</b>
                  <p>先在工作台拍一张，结果会出现在这里。</p>
                  <button onClick={() => setPage('capture')}>去拍摄 ↗</button>
                </div>
              ) : (
                <div className="job-list">
                  {state.jobs.map((j) => (
                    <button
                      key={j.id}
                      className={`job-row ${job?.id === j.id ? 'selected' : ''}`}
                      onClick={() => {
                        setSelected(j.id);
                        setFrameIndex(0);
                        setShowNoisy(j.mode === 'noise_variant');
                      }}
                    >
                      <span>
                        <b>{models.find((m) => m.id === j.model_id)?.name ?? j.model_id}</b>
                        <small>
                          {modeLabels[j.mode as keyof typeof modeLabels]} ·{' '}
                          {new Date(j.created_at).toLocaleTimeString()}
                        </small>
                      </span>
                      <span className={`status ${j.status}`}>{statusLabels[j.status]}</span>
                      <progress max={j.total_frames} value={j.completed_frames} />
                      <small>
                        {j.completed_frames} / {j.total_frames} 张
                      </small>
                    </button>
                  ))}
                </div>
              )}
              <p className="session-note">
                结果仅保存在当前页面。刷新或关闭前，请下载需要保留的数据集。
              </p>
            </section>
            <section className="panel result-panel">
              <div className="panel-heading">
                <h2>图像与数据</h2>
                {job && <span>{job.id.slice(0, 8).toUpperCase()}</span>}
              </div>
              {job ? (
                <>
                  <div className="result-image">
                    {imageUrl ? (
                      <img
                        src={imageUrl}
                        alt={`${job.model_id} 第 ${frameIndex + 1} 帧${showNoisy ? '噪声图' : '原图'}`}
                      />
                    ) : (
                      <div className="empty-image">
                        {job.status === 'running' ? '正在生成第一帧…' : '没有完整图像'}
                      </div>
                    )}
                  </div>
                  <div className="result-controls">
                    <button disabled={frameIndex <= 0} onClick={() => setFrameIndex((n) => n - 1)}>
                      ← 上一帧
                    </button>
                    <span>
                      {job.completed_frames ? frameIndex + 1 : 0} / {job.completed_frames}
                    </span>
                    <button
                      disabled={frameIndex >= job.completed_frames - 1}
                      onClick={() => setFrameIndex((n) => n + 1)}
                    >
                      下一帧 →
                    </button>
                    {frame?.noisy && (
                      <label>
                        <input
                          type="checkbox"
                          checked={showNoisy}
                          onChange={(e) => setShowNoisy(e.target.checked)}
                        />{' '}
                        查看噪声图
                      </label>
                    )}
                  </div>
                  {job.error && job.status === 'failed' && (
                    <p className="inline-error" role="alert">
                      {job.error}
                    </p>
                  )}
                  {job.status === 'canceled' && (
                    <p className="hint session-note">
                      任务已取消，已完成的 {job.completed_frames} 帧仍可下载。
                    </p>
                  )}
                  <div className="result-actions">
                    {job.status === 'running' ? (
                      <button onClick={() => act(() => studio.cancelJob(job.id))}>取消采集</button>
                    ) : (
                      <button
                        className="primary"
                        disabled={!job.completed_frames}
                        onClick={download}
                      >
                        准备数据集 ZIP ↗
                      </button>
                    )}
                    {job.status !== 'running' && (
                      <button onClick={() => act(() => studio.removeJob(job.id))}>
                        移出本次会话
                      </button>
                    )}
                  </div>
                  {state.download?.job_id === job.id && (
                    <a
                      className="download-link"
                      href={state.download.url}
                      download={state.download.name}
                    >
                      ↓ 保存 ZIP 到电脑 <span>{mb(state.download.bytes)} MiB</span>
                    </a>
                  )}
                  {job.status === 'completed' && !job.source_job_id && (
                    <div className="noise-variant">
                      <h3>复用原图，追加噪声</h3>
                      <p>保留原始姿态和标注，生成独立噪声版本。</p>
                      <select
                        aria-label="追加噪声等级"
                        value={noiseLevel}
                        onChange={(e) => setNoiseLevel(e.target.value)}
                      >
                        <option value="light">轻微噪声</option>
                        <option value="medium">中等噪声</option>
                        <option value="strong">较强噪声</option>
                      </select>
                      <button
                        disabled={state.busy}
                        onClick={() =>
                          act(() => {
                            const created = studio.addNoiseVariant({
                              job_id: job.id,
                              noise: noisePresets[noiseLevel],
                              seed: scene.seed,
                            });
                            setSelected(created.id);
                            setFrameIndex(0);
                            setShowNoisy(true);
                          })
                        }
                      >
                        生成噪声版本 ＋
                      </button>
                    </div>
                  )}
                  <details className="technical">
                    <summary>查看任务参数与姿态 JSON</summary>
                    <pre>
                      {frame
                        ? new TextDecoder().decode(frame.pose)
                        : JSON.stringify(job.parameters, null, 2)}
                    </pre>
                  </details>
                </>
              ) : (
                <div className="empty-state">
                  <span className="empty-glyph">▧</span>
                  <p>你的第一张卫星影像，将出现在这里。</p>
                </div>
              )}
            </section>
          </div>
        )}
        {page === 'agent' && (
          <section className="panel agent-panel">
            <div className="panel-heading pink">
              <h2>让 AI 操作你的实验台</h2>
              <b>WebMCP</b>
            </div>
            <div className="agent-content">
              <div>
                <span className={`agent-status ${agentStatus.available ? 'connected' : ''}`}>
                  {agentStatus.available
                    ? `● 已注册 ${agentStatus.registered} 个工具`
                    : '○ 当前浏览器未连接'}
                </span>
                <h3>
                  你描述目标，
                  <br />
                  工具完成采集。
                </h3>
                <p>{agentStatus.message}</p>
                <p>
                  使用支持 WebMCP 的浏览器
                  AI，可直接选择模型、设置参数、提交任务、查询进度和准备下载。所有操作与手动按钮使用同一条采集流程。
                </p>
                <blockquote>
                  选择 GOES-R，距离 20 km，随机拍摄 10 张，种子 42。完成后准备数据集下载。
                </blockquote>
                <button
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(
                        '选择 GOES-R，距离 20 km，随机拍摄 10 张，种子 42。完成后准备数据集下载。',
                      )
                      .then(() => setNotice('示例指令已复制。'))
                      .catch(() => setError('无法访问剪贴板，请手动选择示例文本复制。'));
                  }}
                >
                  复制示例指令 ↗
                </button>
                <p className="hint">
                  此页面提供工具接口；AI 对话由支持该接口的浏览器或客户端提供。
                </p>
              </div>
              <div className="tools-list">
                <h3>可用操作</h3>
                {createWebMcpTools(studio).map((tool) => (
                  <div key={tool.name}>
                    <code>{tool.name}</code>
                    <p>{tool.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
        {state.download && (page !== 'results' || state.download.job_id !== job?.id) && (
          <div className="download-banner">
            <span>数据集已准备好 · {state.download.job_id.slice(0, 8).toUpperCase()}</span>
            <a href={state.download.url} download={state.download.name}>
              ↓ 保存 ZIP 到电脑
            </a>
          </div>
        )}
        <footer className="site-footer">
          <span>
            卫星数据工作台 <b>WEB / {WEB_VERSION}</b>
          </span>
          <span>请保持页面运行，离开前下载结果。</span>
          <a
            href="https://www.stylekit.top/zh/styles/neo-brutalist"
            target="_blank"
            rel="noreferrer"
          >
            视觉参考 ↗
          </a>
        </footer>
      </main>
    </div>
  );
}
