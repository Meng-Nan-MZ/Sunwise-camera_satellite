export type QuaternionTuple = [number, number, number, number];
export interface ClientQuaternion {
  W: number;
  X: number;
  Y: number;
  Z: number;
}
export type EulerTuple = [number, number, number];
export type RendererBackend = 'blender' | 'threejs';
export type RenderJobMode = 'single' | 'coverage' | 'sequence' | 'custom_sequence';
export type JobMode = RenderJobMode | 'noise_variant';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'interrupted';
export type ViewMode = 'capture' | 'inspect';

export interface ModelInfo {
  id: string;
  name: string;
  configuration: string;
  radius_m: number;
  preview_url: string;
  preview_sha256: string;
  sha256: string;
  source_to_body: number[][];
  installation_source: string;
  physical_scale_calibrated?: boolean;
  scale_note?: string;
  source_provider?: string;
  source_page?: string;
  license?: string;
  license_url?: string;
}

export interface SceneSettings {
  model_id: string;
  sat_quat: ClientQuaternion;
  distance_m: number;
  resolution: 1024;
  seed: number;
  noise: { enabled: boolean; gaussian_sigma: number; poisson_peak: number };
  lighting: { azimuth_deg: number; elevation_deg: number; energy: number };
}

export interface TrajectorySettings {
  start_quat: ClientQuaternion;
  end_quat: ClientQuaternion;
  time_step_s?: number;
}

export type DistancePolicy = 'fixed' | 'automatic';
export interface JobSubmission {
  distance_policy?: DistancePolicy;
  renderer_backend: RendererBackend;
  trajectory?: TrajectorySettings;
  mode: RenderJobMode;
  count: number;
  scene: SceneSettings;
}
export interface JobFrame {
  frame_id: string;
  images: { clean: string | null; noisy: string | null };
}
export interface FramePage {
  frames: JobFrame[];
  total: number;
}
export interface Job {
  parameters?: Record<string, unknown>;
  source_parameters?: Record<string, unknown> | null;
  renderer_backend?: RendererBackend;
  model_id: string;
  id: string;
  mode: JobMode;
  status: JobStatus;
  completed_frames: number;
  total_frames: number;
  created_at: string;
  error: string | null;
  latest_image_url: string | null;
  output_directory: string;
  source_job_id?: string | null;
  noise?: SceneSettings['noise'];
  seed?: number;
  can_generate_noise?: boolean;
  latest_images?: { clean: string | null; noisy: string | null };
}

export interface NoiseVariantSubmission {
  noise: SceneSettings['noise'];
  seed: number;
}

export interface DeletionPreview {
  job_id: string;
  jobs: Pick<
    Job,
    'id' | 'mode' | 'status' | 'output_directory' | 'model_id' | 'created_at' | 'total_frames'
  >[];
  can_delete: boolean;
  blocked_reason: string | null;
  fingerprint: string;
}
export interface DeletionResult {
  deleted_job_ids: string[];
  deleted_count: number;
}

export interface Health {
  status: 'ok';
  renderer_available: boolean;
  renderers?: Partial<Record<'threejs', { available: boolean; reason: string | null }>>;
  schema_version: string;
}
