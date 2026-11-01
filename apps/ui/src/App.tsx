import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRenderBridge } from './useRenderBridge';
import { api, errorMessage } from './api';
import { captureFov, createSubmission, quaternionFromEuler, rendererReadiness } from './scene';
import Viewport from './components/Viewport';
import { SatelliteIcon } from './components/Controls';
import ModelLibrary from './components/ModelLibrary';
import SceneControls from './components/SceneControls';
import CustomSequenceControls from './components/CustomSequenceControls';
import { useCustomSequence } from './useCustomSequence';
import { toClientQuaternion } from './trajectory';
import { createNoiseVariant, noiseVariantReason, resultImages } from './noiseVariants';
import type {
  EulerTuple,
  RendererBackend,
  Health,
  Job,
  JobMode,
  RenderJobMode,
  ModelInfo,
  QuaternionTuple,
  SceneSettings,
  ViewMode,
} from './types';

const modeLabels: Record<JobMode, string> = {
  single: '单张采集',
  coverage: '全姿态采样',
  sequence: '连续序列',
  custom_sequence: '自定义姿态序列',
  noise_variant: '噪声版本',
};
const statusLabels: Record<Job['status'], string> = {
  queued: '等待中',
  running: '生成中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  interrupted: '已中断',
};
const running = (job: Job) => job.status === 'queued' || job.status === 'running';

export default function App() {
  const worker = useRenderBridge();
  const [rendererBackend, setRendererBackend] = useState<RendererBackend>('threejs');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelId] = useState('');
  const [modelReady, setModelReady] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [bootError, setBootError] = useState('');
  const [networkError, setNetworkError] = useState('');
  const [retry, setRetry] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [expandedJobs, setExpandedJobs] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [selectedDetail, setSelectedDetail] = useState<Job | null>(null);
  const [detailError, setDetailError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [angles, setAngles] = useState<EulerTuple>([0, 0, 0]);
  const [quaternion, setQuaternion] = useState<QuaternionTuple>([0, 0, 0, 1]);
  const [distance, setDistance] = useState(20000);
  const [lighting, setLighting] = useState({ azimuth_deg: 35, elevation_deg: 28, energy: 4 });
  const [noise, setNoise] = useState({ enabled: true, gaussian_sigma: 0.012, poisson_peak: 96 });
  const [seed, setSeed] = useState(20260919);
  const [jobMode, setJobMode] = useState<RenderJobMode>('single');
  const [count, setCount] = useState(1);
  const customSequence = useCustomSequence(jobMode === 'custom_sequence', count, modelId);
  const [viewMode, setViewMode] = useState<ViewMode>('capture');
  const [axes, setAxes] = useState(true);
  const [safeFrame, setSafeFrame] = useState(true);
  const [resetView, setResetView] = useState(0);
  const [imageKind, setImageKind] = useState<'noisy' | 'clean'>('noisy');
  const [imageError, setImageError] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const actionController = useRef<AbortController | null>(null);

  useEffect(() => () => actionController.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    setBootError('');
    void Promise.all([api.health(controller.signal), api.models(controller.signal)])
      .then(([status, list]) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(list) || !list.length)
          throw new Error('本机模型清单为空，请完成模型资产准备。');
        list.forEach((model) => captureFov(model.radius_m));
        setHealth(status);
        setModels(list);
        setModelId((id) => (list.some((model) => model.id === id) ? id : list[0].id));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setBootError(errorMessage(error));
      });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const poll = async () => {
      try {
        const [list, status] = await Promise.all([
          api.jobs(controller.signal),
          api.health(controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setJobs(list);
        setHealth(status);
        setNetworkError('');
        setSelectedId((id) => id || list[0]?.id || '');
      } catch (error) {
        if (!controller.signal.aborted) setNetworkError(errorMessage(error));
      }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [retry]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    let timer = 0;
    setDetailError('');
    const poll = async () => {
      try {
        const job = await api.job(selectedId, controller.signal);
        if (controller.signal.aborted) return;
        setSelectedDetail(job);
        setDetailError('');
        if (running(job)) timer = window.setTimeout(poll, 1200);
      } catch (error) {
        if (!controller.signal.aborted) {
          setDetailError(errorMessage(error));
          timer = window.setTimeout(poll, 3000);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [selectedId, retry]);

  const model = models.find((item) => item.id === modelId);
  const scene: SceneSettings = useMemo(
    () => ({
      model_id: modelId,
      sat_quat: { W: quaternion[3], X: quaternion[0], Y: quaternion[1], Z: quaternion[2] },
      distance_m: distance,
      resolution: 1024,
      seed,
      noise,
      lighting,
    }),
    [modelId, quaternion, distance, seed, noise, lighting],
  );
  const displayedScene = customSequence.quaternion
    ? { ...scene, sat_quat: toClientQuaternion(customSequence.quaternion) }
    : scene;
  const job =
    selectedDetail?.id === selectedId
      ? selectedDetail
      : jobs.find((item) => item.id === selectedId);
  const images = resultImages(job);
  const displayedImageKind = images[imageKind] ? imageKind : images.clean ? 'clean' : 'noisy';
  const imageUrl = images[displayedImageKind] ?? '';
  const variantReason =
    networkError || detailError || noiseVariantReason(job, noise, seed, submitting || canceling);
  useEffect(() => {
    setImageError(false);
    setImageLoaded(false);
  }, [imageUrl]);
  const readyCallback = useCallback((id: string | null) => setModelReady(id), []);
  const activeJobs = jobs.filter(running).length;
  const fov = model ? (captureFov(model.radius_m) * 180) / Math.PI : 0;

  function updateAngle(index: number, value: number) {
    const next: EulerTuple = [...angles];
    next[index] = value;
    setAngles(next);
    setQuaternion((previous) => quaternionFromEuler(next, previous));
  }

  function chooseMode(mode: RenderJobMode) {
    customSequence.exit();
    setJobMode(mode);
    setCount(mode === 'single' ? 1 : mode === 'coverage' ? 1000 : 120);
  }

  async function submit(mode: RenderJobMode) {
    if (submitting || canceling || actionController.current) return;
    setActionError('');
    setNotice('');
    let snapshot;
    try {
      if (mode === 'single') customSequence.pause();
      snapshot = createSubmission(
        mode,
        mode === 'single' ? 1 : count,
        mode === 'single' ? displayedScene : scene,
        mode === 'custom_sequence' ? customSequence.trajectory : undefined,
        rendererBackend,
      );
    } catch (error) {
      setActionError(errorMessage(error));
      return;
    }
    const controller = new AbortController();
    actionController.current = controller;
    setSubmitting(true);
    try {
      const created = await api.submit(snapshot, controller.signal);
      if (controller.signal.aborted) return;
      setJobs((previous) => [created, ...previous.filter((item) => item.id !== created.id)]);
      setSelectedId(created.id);
      setSelectedDetail(created);
      setNotice(`已提交${modeLabels[mode]}，${snapshot.count} 帧。任务使用提交时的参数快照。`);
    } catch (error) {
      if (!controller.signal.aborted) setActionError(errorMessage(error));
    } finally {
      actionController.current = null;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  async function generateNoiseVariant() {
    if (variantReason || !job || actionController.current) return;
    const sourceId = job.id;
    const snapshot = createNoiseVariant(noise, seed);
    const controller = new AbortController();
    actionController.current = controller;
    setSubmitting(true);
    setActionError('');
    setNotice('');
    try {
      const created = await api.noiseVariant(sourceId, snapshot, controller.signal);
      if (controller.signal.aborted) return;
      setJobs((previous) => [created, ...previous.filter((item) => item.id !== created.id)]);
      setSelectedId(created.id);
      setSelectedDetail(created);
      setNotice('已提交噪声版本，复用原始任务的原图、姿态与标签。');
    } catch (error) {
      if (!controller.signal.aborted) setActionError(errorMessage(error));
    } finally {
      actionController.current = null;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  async function cancel() {
    if (!job || canceling || submitting || actionController.current) return;
    const id = job.id;
    const controller = new AbortController();
    actionController.current = controller;
    setCanceling(true);
    setActionError('');
    try {
      const canceled = await api.cancel(id, controller.signal);
      if (controller.signal.aborted) return;
      setJobs((previous) => previous.map((item) => (item.id === id ? canceled : item)));
      setSelectedDetail(canceled);
      setNotice('已请求取消。正在生成的帧结束后停止，已完成产物保留。');
    } catch (error) {
      if (!controller.signal.aborted) setActionError(errorMessage(error));
    } finally {
      actionController.current = null;
      if (!controller.signal.aborted) setCanceling(false);
    }
  }

  const rendererState = rendererReadiness(health, rendererBackend);
  const rendererReason =
    rendererBackend === 'threejs' && worker.error ? worker.error : rendererState.reason;
  const canSubmit = Boolean(
    model &&
      rendererState.available &&
      !(rendererBackend === 'threejs' && worker.error) &&
      !submitting &&
      !canceling &&
      !networkError &&
      !bootError,
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <SatelliteIcon />
          </span>
          <div>
            <h1>Satellite Dataset Studio V2.2.1</h1>
            <p>卫星姿态数据工作台</p>
          </div>
        </div>
        <div className="header-meta">
          <span
            className={`connection ${networkError || bootError ? 'bad' : health ? 'good' : 'pending'}`}
          >
            <i />
            {networkError || bootError ? '连接异常' : health ? '本机服务已连接' : '连接本机服务…'}
          </span>
          <span className="version-tag">
            V2.2.1 <b>2.2.1</b>
          </span>
        </div>
      </header>

      {(bootError || networkError) && (
        <div className="global-alert" role="alert">
          <span>{bootError || networkError}</span>
          <button className="button" onClick={() => setRetry((value) => value + 1)}>
            重新连接
          </button>
        </div>
      )}
      {health && (!rendererState.available || (rendererBackend === 'threejs' && worker.error)) && (
        <div className="global-alert warning" role="status">
          {rendererReason || '所选出图方式尚未就绪。'} 仍可查看已有结果或生成噪声版本。
          {rendererBackend === 'threejs' && worker.error && (
            <button className="button" onClick={worker.retry}>
              重新连接网页采集
            </button>
          )}
        </div>
      )}

      <main className="workspace">
        <aside className="left-column">
          <ModelLibrary
            models={models}
            modelId={modelId}
            setModelId={setModelId}
            bootError={bootError}
          />

          <section className="panel collection-panel">
            <div className="section-title">
              <h2>采集任务</h2>
              <span className="eyebrow">DATASET</span>
            </div>
            <label className="field">
              <span>出图方式</span>
              <select
                aria-label="出图方式"
                value={rendererBackend}
                onChange={(event) => setRendererBackend(event.target.value as RendererBackend)}
              >
                <option value="threejs">网页出图（细节优先）</option>
                <option value="blender">Blender 对照</option>
              </select>
            </label>
            <p className="hint">网页采集需保持工作台打开；正式结果以保存的 PNG 为准。</p>
            <div className="mode-options">
              {(['single', 'coverage', 'sequence', 'custom_sequence'] as const).map((mode) => (
                <button
                  key={mode}
                  className={`mode-option ${jobMode === mode ? 'selected' : ''}`}
                  onClick={() => chooseMode(mode)}
                  aria-pressed={jobMode === mode}
                >
                  <i />
                  <span>{modeLabels[mode]}</span>
                  <small>{mode === 'single' ? '01' : mode === 'coverage' ? 'SO(3)' : 'SEQ'}</small>
                </button>
              ))}
            </div>
            <p className="mode-description">
              {jobMode === 'single'
                ? '保存当前姿态、距离与光照的一帧正式图像。'
                : jobMode === 'coverage'
                  ? '均匀采样 SO(3) 姿态，距离在 10–30 km 分层采样。当前姿态与距离不参与随机采样。'
                  : jobMode === 'custom_sequence'
                    ? '指定起止姿态，沿最短旋转路径生成包含首尾的序列。请在右侧配置与预览。'
                    : '固定视场连续旋转，默认 1°/s、1 秒间隔，距离由 30 km 变化至 10 km；初始姿态由种子生成。'}
            </p>
            <div className="field-pair">
              <label>
                采集数量
                <input
                  aria-label="采集数量"
                  type="number"
                  min={jobMode === 'custom_sequence' ? 2 : 1}
                  max="100000"
                  step="1"
                  value={count}
                  disabled={jobMode === 'single'}
                  onChange={(event) => setCount(event.target.valueAsNumber || 0)}
                />
              </label>
              <label>
                随机种子
                <input
                  aria-label="随机种子"
                  type="number"
                  min="0"
                  max="4294967295"
                  step="1"
                  value={Number.isNaN(seed) ? '' : seed}
                  onChange={(event) => setSeed(event.target.valueAsNumber)}
                />
              </label>
            </div>
            <div className="format-note">
              <span>1024 × 1024 · 8 位灰度</span>
              <span>PNG + YOLO TXT + 姿态 JSON</span>
            </div>
            <button
              className="button primary generate"
              disabled={!canSubmit}
              onClick={() => void submit(jobMode)}
            >
              {submitting ? (
                <>
                  <span className="spinner" />
                  正在提交…
                </>
              ) : (
                <>
                  开始生成 <span>↗</span>
                </>
              )}
            </button>
            <p className="fine-print">提交后冻结参数，后续调整不影响已有任务。</p>
            {actionError && (
              <p className="inline-error" role="alert">
                {actionError}
              </p>
            )}
            {notice && (
              <p className="inline-notice" role="status">
                {notice}
              </p>
            )}
          </section>
        </aside>

        <div className="center-column">
          <section className="panel scene-panel">
            <div className="scene-heading">
              <div>
                <span className="eyebrow">LIVE VIEWPORT</span>
                <h2>{model?.name ?? '三维场景'}</h2>
              </div>
              <span className={`render-status ${modelReady === modelId && modelId ? 'ready' : ''}`}>
                <i />
                {modelReady === modelId && modelId ? '实时预览' : '正在准备'}
              </span>
            </div>
            <div className="viewport-toolbar">
              <div className="segmented">
                <button
                  className={viewMode === 'capture' ? 'active' : ''}
                  aria-pressed={viewMode === 'capture'}
                  onClick={() => setViewMode('capture')}
                >
                  拍摄视角
                </button>
                <button
                  className={viewMode === 'inspect' ? 'active' : ''}
                  aria-pressed={viewMode === 'inspect'}
                  onClick={() => setViewMode('inspect')}
                >
                  自由观察
                </button>
              </div>
              <div className="view-tools">
                <button
                  aria-pressed={axes}
                  className={axes ? 'tool active' : 'tool'}
                  onClick={() => setAxes(!axes)}
                  title="显示左手机体系坐标轴：零姿态 X 向右、Y 朝观测相机、Z 向上"
                >
                  坐标轴
                </button>
                <button
                  aria-pressed={safeFrame}
                  className={safeFrame ? 'tool active' : 'tool'}
                  onClick={() => setSafeFrame(!safeFrame)}
                  disabled={viewMode === 'inspect'}
                >
                  安全框
                </button>
                <button
                  className="tool"
                  onClick={() => setResetView((value) => value + 1)}
                  title="复位自由观察相机"
                >
                  ↺ 复位
                </button>
              </div>
            </div>
            <Viewport
              model={model}
              scene={displayedScene}
              mode={viewMode}
              axes={axes}
              safeFrame={safeFrame}
              reset={resetView}
              onReady={readyCallback}
            />
            <div className="scene-metrics">
              <div>
                <span>采集距离</span>
                <strong>
                  {(distance / 1000).toFixed(1)} <small>km</small>
                </strong>
              </div>
              <div>
                <span>固定视场</span>
                <strong>
                  {model ? fov.toFixed(5) : '—'} <small>°</small>
                </strong>
              </div>
              <div>
                <span>包围球半径</span>
                <strong>
                  {model ? model.radius_m.toFixed(2) : '—'} <small>m</small>
                </strong>
              </div>
            </div>
            <div className="preview-note">
              <span className="info-icon">i</span>
              <p>
                自由观察显示材质颜色，拍摄视角显示灰度。Three.js
                实时近似预览。材质、曝光及像素噪声以所选出图方式的
                保存的正式图像为准；辅助线不会进入输出。
              </p>
            </div>
          </section>

          <section className="panel result-panel">
            <div className="section-title">
              <div>
                <span className="eyebrow">RENDER OUTPUT</span>
                <h2>正式图像</h2>
              </div>
              <button
                className="button"
                disabled={!canSubmit}
                onClick={() => void submit('single')}
              >
                生成当前单帧
              </button>
            </div>
            <p className="control-caption">所选任务的保存结果，不随当前场景参数变化。</p>
            <div className="result-body">
              <div className="result-image">
                {imageUrl && !imageError ? (
                  <>
                    <img
                      src={imageUrl}
                      alt="任务已保存的正式灰度 PNG"
                      onLoad={() => setImageLoaded(true)}
                      onError={() => setImageError(true)}
                    />
                    {!imageLoaded && <span className="spinner image-spinner" />}
                  </>
                ) : (
                  <div className="image-placeholder">
                    <span>▧</span>
                    <p>{imageError ? '正式图像加载失败' : '等待正式输出'}</p>
                    <small>
                      {imageError ? '请检查本机服务与产物文件' : '生成完成后显示已保存的 PNG'}
                    </small>
                  </div>
                )}
              </div>
              <div className="result-details">
                <div className="segmented small">
                  <button
                    className={displayedImageKind === 'noisy' && images.noisy ? 'active' : ''}
                    disabled={!images.noisy}
                    onClick={() => setImageKind('noisy')}
                    aria-pressed={displayedImageKind === 'noisy' && Boolean(images.noisy)}
                  >
                    含噪声
                  </button>
                  <button
                    className={displayedImageKind === 'clean' && images.clean ? 'active' : ''}
                    disabled={!images.clean}
                    onClick={() => setImageKind('clean')}
                    aria-pressed={displayedImageKind === 'clean' && Boolean(images.clean)}
                  >
                    干净图像
                  </button>
                </div>
                {job ? (
                  <>
                    <span className={`status-badge ${job.status}`}>{statusLabels[job.status]}</span>
                    <p className="job-title">
                      {modeLabels[job.mode]}{' '}
                      <span>
                        {job.renderer_backend === 'threejs'
                          ? '网页出图（细节优先）'
                          : 'Blender 对照'}
                      </span>{' '}
                      <span>
                        {job.completed_frames} / {job.total_frames} 帧
                      </span>
                    </p>
                    <progress
                      value={job.completed_frames}
                      max={job.total_frames || 1}
                      aria-label="任务完成进度"
                    />
                    <code className="job-id">{job.id}</code>
                    {!images.noisy && <p className="control-caption">本任务未生成含噪声图像</p>}
                    <div className="noise-provenance">
                      <p>
                        原始任务：<code aria-label="原始任务">{job.source_job_id ?? job.id}</code>
                      </p>
                      {job.noise && (
                        <p>
                          已保存噪声：{job.noise.enabled ? '启用' : '关闭'} · 高斯 σ{' '}
                          {job.noise.gaussian_sigma} · 泊松峰值 {job.noise.poisson_peak}
                        </p>
                      )}
                      {job.seed !== undefined && <p>已保存随机种子：{job.seed}</p>}
                      {job.mode === 'noise_variant' && (
                        <p>复用原图、姿态与标签。移动或备份时请同时保留原始任务。</p>
                      )}
                    </div>
                    <p className="output-path" title={job.output_directory}>
                      {job.output_directory}
                    </p>
                    {job.error && (
                      <p className="inline-error" role="alert">
                        {job.error}
                      </p>
                    )}
                    {detailError && (
                      <p className="inline-error" role="alert">
                        {detailError}
                      </p>
                    )}
                    <div className="result-actions">
                      {imageUrl && !imageError && (
                        <a className="text-link" href={imageUrl} target="_blank" rel="noreferrer">
                          打开已保存 PNG ↗
                        </a>
                      )}
                      {running(job) && (
                        <button
                          className="button danger"
                          disabled={canceling || submitting}
                          onClick={() => void cancel()}
                        >
                          {canceling ? '正在取消…' : '取消任务'}
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="empty-copy">
                    正式图像来自任务保存文件。选择已有任务，或用当前参数生成一帧以检查效果。
                  </p>
                )}
                <div className="noise-variant-control">
                  <button
                    className="button"
                    disabled={Boolean(variantReason)}
                    aria-describedby="noise-variant-reason"
                    onClick={() => void generateNoiseVariant()}
                  >
                    基于原图生成噪声版本
                  </button>
                  <p id="noise-variant-reason" className="control-caption">
                    {variantReason ||
                      '使用当前像素噪声设置与随机种子，复用所选任务的原图，不改变场景。'}
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section className="panel queue-panel">
            <div className="section-title">
              <h2>最近任务</h2>
              <span className="queue-count">
                {activeJobs ? `${activeJobs} 个任务等待 / 生成中` : '队列空闲'}
              </span>
            </div>
            <div className="job-list">
              {jobs.length ? (
                jobs.slice(0, expandedJobs ? jobs.length : 8).map((item) => (
                  <button
                    key={item.id}
                    className={`job-row ${selectedId === item.id ? 'selected' : ''}`}
                    onClick={() => setSelectedId(item.id)}
                    aria-pressed={selectedId === item.id}
                  >
                    <span className={`job-dot ${item.status}`} />
                    <span>
                      <strong>{modeLabels[item.mode]}</strong>
                      <small>{item.id.slice(0, 16)}</small>
                    </span>
                    <span className="job-progress">
                      {item.completed_frames}
                      <small> / {item.total_frames}</small>
                    </span>
                    <span className={`status-text ${item.status}`}>
                      {statusLabels[item.status]}
                    </span>
                  </button>
                ))
              ) : (
                <p className="queue-empty">尚无采集任务。完成设置后，开始生成第一组数据。</p>
              )}
            </div>
            {jobs.length > 8 && (
              <button
                className="button"
                aria-expanded={expandedJobs}
                onClick={() => setExpandedJobs(!expandedJobs)}
              >
                {expandedJobs ? '收起最近任务' : '显示全部任务'}
              </button>
            )}
          </section>
        </div>

        <SceneControls
          poseDisabled={customSequence.active}
          customSequenceControls={
            jobMode === 'custom_sequence' ? (
              <CustomSequenceControls
                sequence={customSequence}
                manualAngles={angles}
                count={count}
              />
            ) : undefined
          }
          angles={angles}
          quaternion={quaternion}
          distance={distance}
          lighting={lighting}
          noise={noise}
          viewMode={viewMode}
          updateAngle={updateAngle}
          setDistance={setDistance}
          setLighting={setLighting}
          setNoise={setNoise}
          onResetPose={() => {
            setAngles([0, 0, 0]);
            setQuaternion((previous) => quaternionFromEuler([0, 0, 0], previous));
          }}
        />
      </main>
      <footer className="app-footer">
        <span>本地工作区 · 资源与产物均保存在本机</span>
        <span>仿真数据 / 非真实传感器定标</span>
      </footer>
    </div>
  );
}
