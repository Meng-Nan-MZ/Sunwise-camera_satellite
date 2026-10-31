export type QuaternionTuple = [number, number, number, number];
export interface ClientQuaternion {
  W: number;
  X: number;
  Y: number;
  Z: number;
}
export type EulerTuple = [number, number, number];
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

export interface JobSubmission {
  trajectory?: TrajectorySettings;
  mode: RenderJobMode;
  count: number;
  scene: SceneSettings;
}
export interface Job {
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

export interface Health {
  status: 'ok';
  renderer_available: boolean;
  schema_version: string;
}
