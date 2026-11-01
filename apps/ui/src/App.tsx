import { AppearanceController } from './appearance';
import Dialog from './components/Dialog';
import ResultsWorkspace from './components/ResultsWorkspace';
import OpenFolderButton from './components/OpenFolderButton';
import { mergeJobs } from './workbench';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRenderBridge } from './useRenderBridge';
import { api, errorMessage } from './api';
import { captureFov, createSubmission, quaternionFromEuler, rendererReadiness } from './scene';
import { eulerFromQuaternion } from './poseManipulation';
import OutputDirectoryControls from './components/OutputDirectoryControls';
import StorageSettings from './components/StorageSettings';
import NoiseControls from './components/NoiseControls';
import { OutputDirectoryController } from './outputDirectory';
import Viewport from './components/Viewport';
import { SatelliteIcon } from './components/Controls';
import SceneControls from './components/SceneControls';
import CustomSequenceControls from './components/CustomSequenceControls';
import { useCustomSequence } from './useCustomSequence';
import { toClientQuaternion } from './trajectory';
import { createNoiseVariant, noiseVariantReason } from './noiseVariants';
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
  DistancePolicy,
} from './types';

const modeLabels: Record<JobMode, string> = {
  single: '单张采集',
  coverage: '全姿态采样',
  sequence: '连续序列',
  custom_sequence: '起止姿态序列',
  noise_variant: '噪声版本',
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const olderPagesLoaded = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [noiseOpen, setNoiseOpen] = useState(false);
  const [appearance] = useState(
    () => new AppearanceController({ load: api.appearance, save: api.saveAppearance }),
  );
  const appearanceState = useSyncExternalStore(appearance.subscribe, appearance.getSnapshot);
  const theme = appearanceState.theme;
  useEffect(() => {
    void appearance.load();
    return () => appearance.dispose();
  }, [appearance]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const [distancePolicy, setDistancePolicy] = useState<DistancePolicy>('fixed');
  const [selectedId, setSelectedId] = useState('');
  const [selectedDetail, setSelectedDetail] = useState<Job | null>(null);
  const [detailError, setDetailError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [angles, setAngles] = useState<EulerTuple>([0, 0, 0]);
  const [quaternion, setQuaternion] = useState<QuaternionTuple>([0, 0, 0, 1]);
  const [poseEditEpoch, setPoseEditEpoch] = useState(0);
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
  const [jobMode, setJobMode] = useState<RenderJobMode>('single');
  const [count, setCount] = useState(1);
  const customSequence = useCustomSequence(jobMode === 'custom_sequence', count, modelId);
  const [viewMode, setViewMode] = useState<ViewMode>('capture');
  const [axes, setAxes] = useState(false);
  const [safeFrame, setSafeFrame] = useState(false);
  const [resetView, setResetView] = useState(0);
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
        setJobs((previous) => mergeJobs(list, previous));
        if (!olderPagesLoaded.current) setHasMore(list.length >= 100);
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
  const displayedQuaternion = customSequence.quaternion ?? quaternion;
  const displayedAngles = customSequence.quaternion
    ? eulerFromQuaternion(customSequence.quaternion, angles)
    : angles;
  const manualMode = jobMode === 'single' || jobMode === 'custom_sequence';
  const poseEditable = manualMode && !customSequence.active && !submitting;
  const poseEditHint = !manualMode
    ? '姿态按采集方式与种子生成 · 滚轮放大查看'
    : customSequence.active
      ? '正在预览序列 · 退出预览后可拖动调姿'
      : '拖动调整拍摄姿态 · 滚轮只放大查看';
  const job =
    selectedDetail?.id === selectedId
      ? selectedDetail
      : jobs.find((item) => item.id === selectedId);
  const variantReason =
    networkError ||
    detailError ||
    noiseVariantReason(job, variantNoise, variantSeed, submitting || canceling);
  const readyCallback = useCallback((id: string | null) => setModelReady(id), []);
  const activeJobs = jobs.filter(running).length;
  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    const controller = new AbortController();
    try {
      const more = await api.jobsPage(jobs.length, controller.signal);
      setJobs((previous) => mergeJobs(previous, more));
      olderPagesLoaded.current = true;
      setHasMore(more.length === 100);
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }
  function resetDraft() {
    setPoseEditEpoch((v) => v + 1);
    customSequence.exit();
    customSequence.setStart([0, 0, 0]);
    customSequence.setEnd([90, 0, 0]);
    setAngles([0, 0, 0]);
    setQuaternion([0, 0, 0, 1]);
    setDistance(20000);
    setDistancePolicy('fixed');
    setLighting({ azimuth_deg: 35, elevation_deg: 28, energy: 4 });
    setNoise({ enabled: false, gaussian_sigma: 0.012, poisson_peak: 96 });
    setSeed(20260919);
    chooseMode('single');
    setResetView((v) => v + 1);
    setNotice('采集草稿已重置。');
  }

  function updateAngle(index: number, value: number) {
    setPoseEditEpoch((v) => v + 1);
    const next: EulerTuple = [...angles];
    next[index] = value;
    setAngles(next);
    setQuaternion((previous) => quaternionFromEuler(next, previous));
  }

  function updateDraggedPose(next: QuaternionTuple) {
    if (!poseEditable) return;
    setQuaternion(next);
    setAngles((previous) => eulerFromQuaternion(next, previous));
  }

  function chooseMode(mode: RenderJobMode) {
    setPoseEditEpoch((v) => v + 1);
    customSequence.exit();
    setJobMode(mode);
    setDistancePolicy('fixed');
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
        distancePolicy,
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
      setNoiseOpen(false);
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
          <div>
            <h1>卫星数据工作台</h1>
          </div>
        </div>
        <nav className="page-tabs" aria-label="工作台页面">
          <button
            aria-current={page === 'generate' ? 'page' : undefined}
            onClick={() => setPage('generate')}
          >
            数据采集
          </button>
          <button
            aria-current={page === 'results' ? 'page' : undefined}
            onClick={() => setPage('results')}
          >
            任务与结果{activeJobs > 0 && <span className="tab-count">{activeJobs}</span>}
          </button>
          <button onClick={() => setSettingsOpen(true)}>设置</button>
        </nav>
        <div className="header-meta">
          <span
            className={
              networkError || bootError || worker.error
                ? 'connection bad'
                : rendererState.available
                  ? 'connection good'
                  : 'connection'
            }
          >
            {networkError || bootError || worker.error
              ? '连接异常'
              : rendererState.available
                ? '本机已就绪'
                : '正在准备…'}
          </span>
          <span className="version-tag">V2.4.3</span>
        </div>
      </header>
      {(bootError || networkError) && (
        <div className="global-alert" role="alert">
          {bootError || networkError}
          <button className="button" onClick={() => setRetry((v) => v + 1)}>
            重新连接
          </button>
        </div>
      )}
      {health && (!rendererState.available || worker.error) && (
        <div className="global-alert warning" role="status">
          {rendererReason || '网页采集尚未就绪。'}
          {worker.error && (
            <button className="button" onClick={worker.retry}>
              重新连接网页采集
            </button>
          )}
        </div>
      )}
      <div className="capture-page" hidden={page !== 'generate'}>
        <section className="context-strip panel">
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
            采集方式
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
          <div className="context-folder">
            <OutputDirectoryControls controller={outputDirectory} submitting={submitting} />
            <OpenFolderButton />
          </div>
          <div className="output-format">
            <small>输出格式</small>
            <strong>1024 × 1024 · 灰度 PNG</strong>
          </div>
        </section>
        <main className="workspace" aria-label="生成数据工作区">
          <section className="panel scene-panel">
            <div className="scene-heading">
              <h2>{model?.name ?? '卫星预览'}</h2>
              <span className="render-status">
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
                  {manualMode ? '拖动调姿' : '模型预览'}
                </button>
              </div>
              <div className="preview-helpers">
                <label>
                  <input
                    type="checkbox"
                    checked={axes}
                    onChange={(e) => setAxes(e.target.checked)}
                  />
                  坐标轴
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={safeFrame}
                    onChange={(e) => setSafeFrame(e.target.checked)}
                  />
                  安全框
                </label>
                <button className="text-button" onClick={() => setResetView((v) => v + 1)}>
                  复位观察
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
              poseEditable={poseEditable}
              poseEditEpoch={poseEditEpoch}
              poseEditHint={poseEditHint}
              onPoseChange={updateDraggedPose}
              onReady={readyCallback}
            />
            <div className="preview-caption">
              <span>
                {viewMode === 'capture'
                  ? '拍摄视角 · 灰度预览'
                  : manualMode
                    ? '彩色预览 · 拍摄姿态实时同步'
                    : '彩色预览 · 姿态由采集方式生成'}
              </span>
              <span>辅助线不会进入图片</span>
            </div>
            {jobMode === 'custom_sequence' && (
              <div className="preview-playback">
                <button
                  className="button"
                  disabled={!!customSequence.error}
                  onClick={customSequence.playing ? customSequence.pause : customSequence.play}
                >
                  {customSequence.playing ? '暂停预览' : '播放预览'}
                </button>
                {customSequence.active && (
                  <button className="button" onClick={customSequence.exit}>
                    退出预览
                  </button>
                )}
                <input
                  type="range"
                  aria-label="预览帧"
                  min="0"
                  max={Number.isInteger(count) && count >= 2 ? count - 1 : 1}
                  value={customSequence.frame}
                  disabled={!!customSequence.error}
                  onChange={(e) => customSequence.scrub(e.target.valueAsNumber)}
                />
                <span aria-label="当前预览帧">
                  {customSequence.frame + 1} / {count}
                </span>
              </div>
            )}
          </section>
          <SceneControls
            mode={jobMode}
            count={count}
            setCount={setCount}
            seed={seed}
            setSeed={setSeed}
            poseDisabled={!poseEditable}
            customSequenceControls={
              jobMode === 'custom_sequence' ? (
                <CustomSequenceControls
                  sequence={customSequence}
                  manualAngles={displayedAngles}
                  count={count}
                />
              ) : undefined
            }
            angles={displayedAngles}
            quaternion={displayedQuaternion}
            distance={distance}
            distancePolicy={distancePolicy}
            setDistancePolicy={setDistancePolicy}
            lighting={lighting}
            noise={noise}
            updateAngle={updateAngle}
            setDistance={setDistance}
            setLighting={setLighting}
            setNoise={setNoise}
            onResetPose={() => {
              setPoseEditEpoch((v) => v + 1);
              customSequence.exit();
              setAngles([0, 0, 0]);
              setQuaternion((previous) => quaternionFromEuler([0, 0, 0], previous));
            }}
            footer={
              <section className="generation-bar" aria-label="生成操作">
                <div>
                  <strong>1024 × 1024 · 8 位灰度 PNG</strong>
                  <small>
                    同时保存原图、YOLO 标注与姿态文件 ·{' '}
                    {distancePolicy === 'fixed' ? distance / 1000 + ' km' : '自动距离'} ·{' '}
                    {noise.enabled ? '含噪声' : '无噪声'}
                  </small>
                </div>
                <button className="button reset-draft" onClick={resetDraft}>
                  重置参数
                </button>
                <button
                  className="button primary generate"
                  disabled={!canSubmit}
                  onClick={() => void submit(jobMode)}
                >
                  {submitting
                    ? '正在提交…'
                    : '生成 ' + (jobMode === 'single' ? 1 : count) + ' 张图片 →'}
                </button>
              </section>
            }
          />
        </main>
      </div>
      {page === 'results' && (
        <ResultsWorkspace
          jobs={jobs}
          job={job}
          models={models}
          selectedId={selectedId}
          onSelect={setSelectedId}
          detailError={detailError}
          onNoise={() => setNoiseOpen(true)}
          variantReason={variantReason}
          canceling={canceling}
          submitting={submitting}
          onCancel={() => void cancel()}
          onLoadMore={() => void loadMore()}
          loadingMore={loadingMore}
          hasMore={hasMore}
        />
      )}
      {(actionError || notice) && (
        <div className="action-feedback" role={actionError ? 'alert' : 'status'}>
          {actionError || notice}
          {notice && page === 'generate' && (
            <button className="text-button" onClick={() => setPage('results')}>
              查看任务
            </button>
          )}
          <button
            className="text-button"
            aria-label="关闭通知"
            onClick={() => {
              setActionError('');
              setNotice('');
            }}
          >
            关闭
          </button>
        </div>
      )}
      <footer className="app-footer">
        <span>● 本地工作区 · 所有数据保存在本机</span>
        <span>
          {page === 'generate'
            ? '提交时冻结参数，后续调整不影响已生成任务'
            : '结果来自已保存文件，不随预览参数变化'}
        </span>
      </footer>
      {settingsOpen && (
        <Dialog title="设置" onClose={() => setSettingsOpen(false)}>
          <label className="field">
            外观主题
            <select
              aria-label="外观主题"
              value={theme}
              disabled={appearanceState.loading || appearanceState.saving}
              onChange={(e) => void appearance.save(e.target.value as 'dark' | 'light')}
            >
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
          </label>
          <p className="control-caption">主题仅改变工作台外观，设置保存在本机。</p>
          {(appearanceState.loading || appearanceState.saving) && (
            <p role="status" className="control-caption">
              {appearanceState.loading ? '正在读取主题…' : '正在保存主题…'}
            </p>
          )}
          {appearanceState.error && (
            <div>
              <p className="inline-error" role="alert">
                {appearanceState.error}
              </p>
              <button
                className="button"
                disabled={appearanceState.loading || appearanceState.saving}
                onClick={() => void appearance.load()}
              >
                重新读取主题
              </button>
            </div>
          )}
          <StorageSettings controller={outputDirectory} submitting={submitting} />
          <p>卫星数据工作台 V2.4.3</p>
        </Dialog>
      )}
      {noiseOpen && (
        <Dialog title="追加噪声设置" onClose={() => setNoiseOpen(false)}>
          {' '}
          <fieldset className="variant-settings">
            <NoiseControls
              noise={variantNoise}
              setNoise={setVariantNoise}
              seed={variantSeed}
              setSeed={setVariantSeed}
              labelPrefix="追加"
            />
            <p className="control-caption">仅用于追加版本；采集草稿与原任务参数保持不变。</p>
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
            {variantReason || '使用追加噪声设置与随机种子，复用所选任务的原图，不改变采集草稿。'}
          </p>
        </Dialog>
      )}
    </div>
  );
}
