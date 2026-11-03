import type {
  ClientQuaternion,
  EulerTuple,
  JobSubmission,
  ModelInfo,
  QuaternionTuple,
  SceneSettings,
} from '../types.ts';
import type { CaptureDevice, CaptureResult } from '../renderBridge.ts';
import { quaternionFromEuler } from '../scene.ts';
import { toClientQuaternion } from '../trajectory.ts';
import { buildPose, sampleFrames, validateSubmission } from './domain.ts';
import {
  applyNoise,
  encodeGrayPng,
  processCapture,
  IMAGE_PIPELINE_VERSION,
  NOISE_ALGORITHM_VERSION,
} from './imagePipeline.ts';
import { createZip } from './zip.ts';

export const WEB_VERSION = '4.0.0-web';
export const MEMORY_LIMIT = 256 * 1024 * 1024;
type Status = 'running' | 'completed' | 'canceled' | 'failed';
export interface LocalFrame {
  id: string;
  clean: Uint8Array;
  noisy?: Uint8Array;
  pixels: Uint8Array;
  pose: Uint8Array;
  label: Uint8Array;
  noiseMeta?: Uint8Array;
}
export interface LocalJob {
  id: string;
  model_id: string;
  mode: string;
  status: Status;
  total_frames: number;
  completed_frames: number;
  created_at: string;
  error: string | null;
  source_job_id?: string;
  parameters: JobSubmission;
  noise?: SceneSettings['noise'];
  seed?: number;
  bytes: number;
  frames: LocalFrame[];
}
export type JobSummary = Omit<LocalJob, 'frames'>;
type Dependencies = {
  createRenderer: () => Promise<CaptureDevice>;
  process: typeof processCapture;
  pose: typeof buildPose;
};
const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');
const summarize = ({ frames: _frames, ...job }: LocalJob): JobSummary => structuredClone(job);
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const defaultScene = (model: string): SceneSettings => ({
  model_id: model,
  sat_quat: { W: 1, X: 0, Y: 0, Z: 0 },
  distance_m: 20000,
  resolution: 1024,
  seed: 42,
  lighting: { azimuth_deg: 35, elevation_deg: 28, energy: 4 },
  noise: { enabled: false, gaussian_sigma: 0.012, poisson_peak: 96 },
});

export class BrowserStudio {
  private draft: JobSubmission;
  private jobs: LocalJob[] = [];
  private listeners = new Set<() => void>();
  private active?: AbortController;
  private download?: { job_id: string; url: string; name: string; bytes: number };
  private dependencies: Dependencies;
  private disposed = false;
  private memoryLimit: number;
  private models: ModelInfo[];
  constructor(
    models: ModelInfo[],
    dependencies: Partial<Dependencies> = {},
    memoryLimit = MEMORY_LIMIT,
  ) {
    if (!models.length) throw new Error('没有可用模型，请先准备模型资源。');
    this.models = structuredClone(models);
    this.draft = {
      mode: 'single',
      count: 1,
      renderer_backend: 'threejs',
      distance_policy: 'fixed',
      scene: defaultScene(models.find((m) => m.id === 'goes_r')?.id ?? models[0].id),
    };
    this.memoryLimit = memoryLimit;
    this.dependencies = {
      createRenderer: async () => {
        const { FormalRenderer } = await import('../formalRenderer.ts');
        return new FormalRenderer(() =>
          this.active?.abort(new Error('WebGL 上下文丢失，请重新开始任务。')),
        );
      },
      process: processCapture,
      pose: buildPose,
      ...dependencies,
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    if (!this.disposed) for (const listener of this.listeners) listener();
  }
  listModels = () => structuredClone(this.models);
  getState = () => ({
    draft: structuredClone(this.draft),
    jobs: this.jobs.map(summarize),
    busy: Boolean(this.active),
    retained_bytes: this.jobs.reduce((sum, j) => sum + j.bytes, 0),
    memory_limit: this.memoryLimit,
    download: this.download ? { ...this.download } : null,
  });
  private job(id: string) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error('找不到该会话任务。');
    return job;
  }
  getJob = (id: string) => summarize(this.job(id));
  getFrame = (id: string, index: number) => this.job(id).frames[index];
  configure = (input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('设置必须为对象。');
    const p = input as Record<string, unknown>;
    const allowed = [
      'model_id',
      'mode',
      'count',
      'distance_m',
      'euler_deg',
      'seed',
      'lighting',
      'noise',
      'start_euler_deg',
      'end_euler_deg',
    ];
    if (!Object.keys(p).length || Object.keys(p).some((k) => !allowed.includes(k)))
      throw new Error('设置包含未知字段或为空。');
    const next = structuredClone(this.draft);
    if ('mode' in p) {
      next.mode = p.mode as JobSubmission['mode'];
      if (next.mode === 'single') next.count = 1;
      else if (next.count === 1) next.count = next.mode === 'custom_sequence' ? 10 : 20;
    }
    if ('count' in p) next.count = p.count as number;
    if ('model_id' in p) next.scene.model_id = p.model_id as string;
    if ('distance_m' in p) next.scene.distance_m = p.distance_m as number;
    if ('seed' in p) next.scene.seed = p.seed as number;
    const euler = (value: unknown): ClientQuaternion => {
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        value.some((v) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 360)
      )
        throw new Error('姿态角须为 -360° 至 360° 的 XYZ 三个数值。');
      return toClientQuaternion(quaternionFromEuler(value as EulerTuple));
    };
    if ('euler_deg' in p) next.scene.sat_quat = euler(p.euler_deg);
    if ('lighting' in p)
      next.scene.lighting = structuredClone(p.lighting) as SceneSettings['lighting'];
    if ('noise' in p) next.scene.noise = structuredClone(p.noise) as SceneSettings['noise'];
    if (next.mode === 'custom_sequence') {
      next.trajectory ??= {
        start_quat: { ...next.scene.sat_quat },
        end_quat: toClientQuaternion(quaternionFromEuler([0, 0, 90])),
        time_step_s: 1,
      };
      if ('start_euler_deg' in p) next.trajectory.start_quat = euler(p.start_euler_deg);
      if ('end_euler_deg' in p) next.trajectory.end_quat = euler(p.end_euler_deg);
    } else {
      if ('start_euler_deg' in p || 'end_euler_deg' in p) throw new Error('请先选择起止姿态序列。');
      delete next.trajectory;
    }
    this.draft = validateSubmission(next, this.models);
    this.emit();
    return this.getState();
  };
  setQuaternion(q: QuaternionTuple) {
    const next = structuredClone(this.draft);
    next.scene.sat_quat = toClientQuaternion(q);
    this.draft = validateSubmission(next, this.models);
    this.emit();
  }
  saveEndpoint(which: 'start' | 'end') {
    const next = structuredClone(this.draft);
    if (!next.trajectory) throw new Error('请先选择起止姿态序列。');
    next.trajectory[which === 'start' ? 'start_quat' : 'end_quat'] = { ...next.scene.sat_quat };
    this.draft = validateSubmission(next, this.models);
    this.emit();
  }
  private begin(mode: string, request: JobSubmission, total = request.count): LocalJob {
    if (this.disposed) throw new Error('工作台已关闭。');
    if (this.active) throw new Error('请等待当前任务完成，或先取消当前任务。');
    if (this.getState().retained_bytes >= this.memoryLimit)
      throw new Error('会话存储已满，请下载并移除旧任务。');
    const job: LocalJob = {
      id: crypto.randomUUID().replaceAll('-', ''),
      model_id: request.scene.model_id,
      mode,
      status: 'running',
      total_frames: total,
      completed_frames: 0,
      created_at: new Date().toISOString(),
      error: null,
      parameters: structuredClone(request),
      bytes: 0,
      frames: [],
    };
    this.active = new AbortController();
    this.jobs.unshift(job);
    this.emit();
    return job;
  }
  private retain(job: LocalJob, frame: LocalFrame, bytes: number) {
    if (this.getState().retained_bytes + bytes > this.memoryLimit)
      throw new Error('已达到浏览器会话 256 MiB 存储上限；完整帧已保留，请下载后分批采集。');
    job.frames.push(frame);
    job.bytes += bytes;
    job.completed_frames = job.frames.length;
    this.emit();
  }
  startCapture = () => {
    const request = validateSubmission(this.draft, this.models);
    const job = this.begin(request.mode, request);
    const signal = this.active!.signal;
    void this.runCapture(job, signal);
    return summarize(job);
  };
  private async runCapture(job: LocalJob, signal: AbortSignal) {
    let renderer: CaptureDevice | undefined;
    try {
      const frames = await sampleFrames(job.parameters, job.id);
      signal.throwIfAborted();
      renderer = await this.dependencies.createRenderer();
      signal.throwIfAborted();
      const model = this.models.find((m) => m.id === job.model_id)!;
      for (const frame of frames) {
        signal.throwIfAborted();
        await delay();
        const result: CaptureResult = await renderer.capture(
          { task_id: frame.frame_id, attempt_token: job.id, frame, model },
          signal,
        );
        signal.throwIfAborted();
        const pose = this.dependencies.pose(frame, model, result);
        const output = await this.dependencies.process(result, frame.noise, frame.seed);
        signal.throwIfAborted();
        const poseData = jsonBytes(pose);
        const yolo = pose.bbox_yolo as number[];
        const label = new TextEncoder().encode(
          '0 ' + yolo.map((v) => v.toFixed(12)).join(' ') + '\n',
        );
        const data = { id: frame.frame_id, ...output, pose: poseData, label };
        this.retain(
          job,
          data,
          output.clean.byteLength +
            (output.noisy?.byteLength ?? 0) +
            output.pixels.byteLength +
            poseData.byteLength +
            label.byteLength,
        );
      }
      job.status = 'completed';
    } catch (error) {
      job.status =
        signal.aborted && !(signal.reason instanceof Error && signal.reason.name !== 'AbortError')
          ? 'canceled'
          : 'failed';
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      try {
        renderer?.dispose();
      } catch (error) {
        job.error = `释放显卡资源失败：${error instanceof Error ? error.message : String(error)}`;
      } finally {
        this.active = undefined;
        this.emit();
      }
    }
  }
  cancelJob = (id: string) => {
    const job = this.job(id);
    if (job.status === 'running') this.active?.abort();
    return summarize(job);
  };
  addNoiseVariant = (input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('噪声参数必须为对象。');
    const { job_id, noise, seed, ...rest } = input as {
      job_id: string;
      noise: SceneSettings['noise'];
      seed: number;
    } & Record<string, unknown>;
    if (Object.keys(rest).length) throw new Error('噪声参数包含未知字段。');
    const source = this.job(job_id);
    if (source.status !== 'completed' || source.source_job_id)
      throw new Error('请选择已完成的原图任务。');
    const candidate = structuredClone(source.parameters);
    candidate.scene.noise = noise;
    candidate.scene.seed = seed;
    validateSubmission(candidate, this.models);
    if (!noise.enabled) throw new Error('追加噪声须启用噪声。');
    const job = this.begin('noise_variant', source.parameters, source.frames.length);
    job.source_job_id = source.id;
    job.noise = structuredClone(noise);
    job.seed = seed;
    const signal = this.active!.signal;
    void this.runNoise(job, source, signal);
    return summarize(job);
  };
  private async runNoise(job: LocalJob, source: LocalJob, signal: AbortSignal) {
    try {
      for (const sourceFrame of source.frames) {
        signal.throwIfAborted();
        await delay();
        const seedData = new TextEncoder().encode(
          `satellite-web-noise-v1\0${job.seed}\0${sourceFrame.id}`,
        );
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', seedData));
        const frameSeed = new DataView(hash.buffer).getUint32(0, false);
        const noisyPixels = applyNoise(sourceFrame.pixels, job.noise!, frameSeed);
        const noisy = await encodeGrayPng(noisyPixels, 1024, 1024);
        signal.throwIfAborted();
        const cleanHash = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', sourceFrame.clean.slice().buffer)),
          (v) => v.toString(16).padStart(2, '0'),
        ).join('');
        signal.throwIfAborted();
        const noiseMeta = jsonBytes({
          schema_version: 'satellite-web-noise-1.0',
          source_job_id: source.id,
          frame_id: sourceFrame.id,
          source_clean_sha256: cleanHash,
          noise: job.noise,
          master_seed: job.seed,
          noise_seed: frameSeed,
          algorithm: NOISE_ALGORITHM_VERSION,
          source_pose: `poses/${sourceFrame.id}.json`,
          source_clean: `images_clean/${sourceFrame.id}.png`,
          noisy: `images_noisy/${sourceFrame.id}.png`,
          source_pose_unchanged: true,
        });
        this.retain(
          job,
          { ...sourceFrame, noisy, noiseMeta },
          noisy.byteLength + noiseMeta.byteLength,
        );
      }
      job.status = 'completed';
    } catch (error) {
      job.status = signal.aborted ? 'canceled' : 'failed';
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.active = undefined;
      this.emit();
    }
  }
  prepareDownload = (id: string) => {
    const job = this.job(id);
    if (job.status === 'running') throw new Error('请等待任务结束或取消后再下载。');
    if (!job.frames.length) throw new Error('该任务没有可下载的完整帧。');
    if (this.download) URL.revokeObjectURL(this.download.url);
    this.download = undefined;
    const entries: { name: string; data: Uint8Array }[] = [
      {
        name: 'job.json',
        data: jsonBytes({
          ...summarize(job),
          application: 'Satellite Dataset Studio Web',
          version: WEB_VERSION,
          image_pipeline: IMAGE_PIPELINE_VERSION,
          noise_algorithm: NOISE_ALGORITHM_VERSION,
          session_only: true,
          partial: job.status !== 'completed',
          included_frames: job.frames.map((f) => f.id),
        }),
      },
    ];
    for (const frame of job.frames) {
      entries.push(
        { name: `images_clean/${frame.id}.png`, data: frame.clean },
        { name: `labels/${frame.id}.txt`, data: frame.label },
        { name: `poses/${frame.id}.json`, data: frame.pose },
      );
      if (frame.noisy) entries.push({ name: `images_noisy/${frame.id}.png`, data: frame.noisy });
      if (frame.noiseMeta)
        entries.push({ name: `noise_meta/${frame.id}.json`, data: frame.noiseMeta });
    }
    const zip = createZip(entries);
    const name = `satellite-${job.model_id}-${job.id.slice(0, 8)}${job.status === 'completed' ? '' : '-partial'}.zip`;
    const url = URL.createObjectURL(new Blob([zip.slice().buffer], { type: 'application/zip' }));
    this.download = { job_id: id, name, url, bytes: zip.length };
    this.emit();
    return {
      job_id: id,
      ready: true,
      filename: name,
      bytes: zip.length,
      completed_frames: job.completed_frames,
      message: '数据集已准备好，请在页面点击“保存 ZIP 到电脑”。',
    };
  };
  removeJob(id: string) {
    const job = this.job(id);
    if (job.status === 'running') throw new Error('请先取消任务并等待停止。');
    if (this.jobs.some((j) => j.source_job_id === id))
      throw new Error('请先移除此原图任务的噪声版本。');
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.download?.job_id === id) {
      URL.revokeObjectURL(this.download.url);
      this.download = undefined;
    }
    this.emit();
  }
  dispose() {
    this.disposed = true;
    this.active?.abort();
    if (this.download) URL.revokeObjectURL(this.download.url);
    this.listeners.clear();
  }
}
