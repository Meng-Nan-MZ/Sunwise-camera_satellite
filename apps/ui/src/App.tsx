import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRenderBridge } from './useRenderBridge';
import { api, errorMessage } from './api';
import { captureFov, createSubmission, quaternionFromEuler, rendererReadiness } from './scene';
import OutputDirectoryControls from './components/OutputDirectoryControls';
import { OutputDirectoryController } from './outputDirectory';
import Viewport from './components/Viewport';
import { SatelliteIcon } from './components/Controls';
import SceneControls from './components/SceneControls';
import CustomSequenceControls from './components/CustomSequenceControls';
import { useCustomSequence } from './useCustomSequence';
import { toClientQuaternion } from './trajectory';
import { createNoiseVariant, noiseVariantReason, resultImages } from './noiseVariants';
import type {
  EulerTuple,
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
  custom_sequence: '起止姿态序列',
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
  const [outputDirectory] = useState(
    () => new OutputDirectoryController({ load: api.outputSettings, save: api.saveOutputSettings }),
  );
  useSyncExternalStore(outputDirectory.subscribe, outputDirectory.getSnapshot);
  useEffect(() => {
    void outputDirectory.load();
    return () => outputDirectory.dispose();
  }, [outputDirectory]);
  const rendererBackend = 'threejs';
  const [page, setPage] = useState<'generate' | 'results'>('generate');
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
  const [noise, setNoise] = useState({ enabled: false, gaussian_sigma: 0.012, poisson_peak: 96 });
  const [seed, setSeed] = useState(20260919);
  const [variantNoise, setVariantNoise] = useState({
    enabled: true,
    gaussian_sigma: 0.012,
    poisson_peak: 96,
  });
  const [variantSeed, setVariantSeed] = useState(20260919);
  const [jobMode, setJobMode] = useState<RenderJobMode>('custom_sequence');
  const [count, setCount] = useState(120);
  const customSequence = useCustomSequence(jobMode === 'custom_sequence', count, modelId);
  const [viewMode, setViewMode] = useState<ViewMode>('inspect');
  const [axes, setAxes] = useState(false);
  const [safeFrame, setSafeFrame] = useState(false);
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
    networkError ||
    detailError ||
    noiseVariantReason(job, variantNoise, variantSeed, submitting || canceling);
  useEffect(() => {
    setImageError(false);
    setImageLoaded(false);
  }, [imageUrl]);
  const readyCallback = useCallback((id: string | null) => setModelReady(id), []);
  const activeJobs = jobs.filter(running).length;

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
    if (submitting || canceling || actionController.current || !outputDirectory.beginCapture())
      return;
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
      outputDirectory.endCapture();
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
      outputDirectory.endCapture();
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  async function generateNoiseVariant() {
    if (variantReason || !job || actionController.current) return;
    const sourceId = job.id;
    const snapshot = createNoiseVariant(variantNoise, variantSeed);
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
    outputDirectory.canCapture() &&
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
          <h1>卫星数据集生成工具</h1>
        </div>
        <nav className="page-tabs" role="tablist" aria-label="工作台页面">
          <button
            role="tab"
            aria-selected={page === 'generate'}
            onClick={() => setPage('generate')}
          >
            生成数据
          </button>
          <button role="tab" aria-selected={page === 'results'} onClick={() => setPage('results')}>
            任务与结果{activeJobs > 0 && <span className="tab-count">{activeJobs}</span>}
          </button>
        </nav>
        <div className="header-meta">
          <span className={networkError || bootError ? 'connection bad' : 'connection good'}>
            {networkError || bootError ? '连接异常' : health ? '本机服务已连接' : '连接中…'}
          </span>
          <span className="version-tag">V2.4</span>
        </div>
      </header>
      {(bootError || networkError) && (
        <div className="global-alert" role="alert">
          <span>{bootError || networkError}</span>
          <button className="button" onClick={() => setRetry((v) => v + 1)}>
            重新连接
          </button>
        </div>
      )}
      {health && (!rendererState.available || worker.error) && (
        <div className="global-alert warning" role="status">
          {rendererReason || '网页采集尚未就绪。'}{' '}
          {worker.error && (
            <button className="button" onClick={worker.retry}>
              重新连接网页采集
            </button>
          )}
        </div>
      )}
      <main className="workspace" hidden={page !== 'generate'} aria-label="生成数据工作区">
        <section className="panel scene-panel">
          <div className="model-mode-toolbar">
            <label>
              卫星模型
              <select
                aria-label="卫星模型"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              生成模式
              <select
                aria-label="生成模式"
                value={jobMode}
                onChange={(e) => chooseMode(e.target.value as RenderJobMode)}
              >
                {(['single', 'coverage', 'sequence', 'custom_sequence'] as const).map((mode) => (
                  <option key={mode} value={mode}>
                    {modeLabels[mode]}
                  </option>
                ))}
              </select>
            </label>
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
          <div className="viewport-toolbar">
            <div className="segmented">
              <button
                className={viewMode === 'inspect' ? 'active' : ''}
                aria-pressed={viewMode === 'inspect'}
                onClick={() => setViewMode('inspect')}
              >
                模型观察
              </button>
              <button
                className={viewMode === 'capture' ? 'active' : ''}
                aria-pressed={viewMode === 'capture'}
                onClick={() => setViewMode('capture')}
              >
                采集构图
              </button>
            </div>
            <span className="observation-note">观察缩放不改变采集参数</span>
            {jobMode === 'custom_sequence' && (
              <div className="preview-playback">
                <button
                  className="button"
                  disabled={Boolean(customSequence.error)}
                  onClick={customSequence.playing ? customSequence.pause : customSequence.play}
                >
                  {customSequence.playing ? '暂停预览' : '播放预览'}
                </button>
                {customSequence.active && (
                  <button className="button exit-preview" onClick={customSequence.exit}>
                    退出预览
                  </button>
                )}
                <input
                  type="range"
                  aria-label="预览帧"
                  min="0"
                  max={Number.isInteger(count) && count >= 2 ? count - 1 : 1}
                  value={customSequence.frame}
                  disabled={Boolean(customSequence.error)}
                  onChange={(e) => customSequence.scrub(e.target.valueAsNumber)}
                />
                <span aria-label="当前预览帧">
                  {customSequence.frame + 1} / {count}
                </span>
              </div>
            )}
            {jobMode !== 'custom_sequence' && (
              <span className="render-status">
                {modelReady === modelId && modelId ? '实时预览' : '正在准备'}
              </span>
            )}
          </div>
        </section>
        <SceneControls
          mode={jobMode}
          count={count}
          setCount={setCount}
          seed={seed}
          setSeed={setSeed}
          axes={axes}
          setAxes={setAxes}
          safeFrame={safeFrame}
          setSafeFrame={setSafeFrame}
          resetView={() => setResetView((v) => v + 1)}
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
            customSequence.exit();
            setAngles([0, 0, 0]);
            setQuaternion((previous) => quaternionFromEuler([0, 0, 0], previous));
          }}
        />
      </main>
      <main className="results-workspace" hidden={page !== 'results'} aria-label="任务与结果工作区">
        <div className="results-heading">
          <h2>任务与结果</h2>
          <p>已保存的图像与参数独立于当前采集设置。</p>
        </div>
        <div className="results-grid">
          <section className="panel result-panel">
            <div className="section-title">
              <div>
                <span className="eyebrow">RENDER OUTPUT</span>
                <h2>正式图像</h2>
              </div>
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
                      {models.find((m) => m.id === job.model_id)?.name ??
                        job.model_id ??
                        '历史模型'}{' '}
                      · {modeLabels[job.mode]}{' '}
                      <span>
                        {job.renderer_backend === 'threejs'
                          ? '网页出图（细节优先）'
                          : '历史 Blender'}
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
                  <fieldset className="variant-settings">
                    <legend>追加噪声设置</legend>
                    <label className="variant-enable">
                      <input
                        aria-label="追加版本启用噪声"
                        type="checkbox"
                        checked={variantNoise.enabled}
                        onChange={(e) =>
                          setVariantNoise({ ...variantNoise, enabled: e.target.checked })
                        }
                      />
                      启用像素噪声
                    </label>
                    <div className="variant-fields">
                      <label>
                        高斯 σ
                        <input
                          aria-label="追加高斯标准差"
                          type="number"
                          min="0"
                          max="0.1"
                          step="0.001"
                          value={
                            Number.isFinite(variantNoise.gaussian_sigma)
                              ? variantNoise.gaussian_sigma
                              : ''
                          }
                          onChange={(e) =>
                            setVariantNoise({
                              ...variantNoise,
                              gaussian_sigma: e.target.valueAsNumber,
                            })
                          }
                        />
                      </label>
                      <label>
                        泊松峰值
                        <input
                          aria-label="追加泊松峰值"
                          type="number"
                          min="1"
                          max="512"
                          value={
                            Number.isFinite(variantNoise.poisson_peak)
                              ? variantNoise.poisson_peak
                              : ''
                          }
                          onChange={(e) =>
                            setVariantNoise({
                              ...variantNoise,
                              poisson_peak: e.target.valueAsNumber,
                            })
                          }
                        />
                      </label>
                      <label>
                        随机种子
                        <input
                          aria-label="追加随机种子"
                          type="number"
                          min="0"
                          max="4294967295"
                          step="1"
                          value={Number.isFinite(variantSeed) ? variantSeed : ''}
                          onChange={(e) => setVariantSeed(e.target.valueAsNumber)}
                        />
                      </label>
                    </div>
                    <p className="control-caption">
                      仅用于追加版本；采集草稿与原任务参数保持不变。
                    </p>
                  </fieldset>
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
                      '使用追加噪声设置与随机种子，复用所选任务的原图，不改变采集草稿。'}
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
                      <strong>
                        {models.find((m) => m.id === item.model_id)?.name ??
                          item.model_id ??
                          '历史模型'}{' '}
                        · {modeLabels[item.mode]}
                      </strong>
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
      </main>
      {(actionError || notice) && (
        <div className="action-feedback" role={actionError ? 'alert' : 'status'}>
          {actionError || notice}
          {notice && page === 'generate' && (
            <button className="text-button" onClick={() => setPage('results')}>
              查看任务
            </button>
          )}
        </div>
      )}
      <footer className="app-footer">
        <OutputDirectoryControls controller={outputDirectory} submitting={submitting} />
        <div className="task-summary">
          <strong>{page === 'generate' ? '本次任务' : '采集草稿'}</strong>
          <span>
            {model?.name ?? '选择模型'}　|　{modeLabels[jobMode]}　|　
            {jobMode === 'single' ? 1 : count} 帧　|　
            {jobMode === 'coverage'
              ? '距离 10–30 km'
              : jobMode === 'sequence'
                ? '距离 30→10 km'
                : '距离 ' + distance / 1000 + ' km'}
            　|　光照 {lighting.azimuth_deg}°　|　{noise.enabled ? '含噪声' : '无噪声'}
          </span>
        </div>
        {page === 'generate' ? (
          <button
            className="button primary generate"
            disabled={!canSubmit}
            onClick={() => void submit(jobMode)}
          >
            {submitting ? '正在提交…' : '生成' + (jobMode === 'single' ? 1 : count) + '帧图像'}
          </button>
        ) : (
          <button className="button primary generate" onClick={() => setPage('generate')}>
            返回生成数据
          </button>
        )}
      </footer>
    </div>
  );
}
