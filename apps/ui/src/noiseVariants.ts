import type { Job, NoiseVariantSubmission, SceneSettings } from './types.ts';

export function createNoiseVariant(
  noise: SceneSettings['noise'],
  seed: number,
): NoiseVariantSubmission {
  if (!noise.enabled) throw new Error('请先启用像素噪声。');
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295)
    throw new Error('随机种子须为 0–4294967295 的整数。');
  if (
    !Number.isFinite(noise.gaussian_sigma) ||
    noise.gaussian_sigma < 0 ||
    noise.gaussian_sigma > 1 ||
    !Number.isFinite(noise.poisson_peak) ||
    noise.poisson_peak < 1 ||
    noise.poisson_peak > 1e7
  )
    throw new Error('噪声参数超出范围。');
  return Object.freeze({
    noise: Object.freeze({
      enabled: true,
      gaussian_sigma: noise.gaussian_sigma,
      poisson_peak: noise.poisson_peak,
    }),
    seed,
  });
}

export function resultImages(job?: Pick<Job, 'latest_images' | 'latest_image_url'>) {
  // An explicit availability map is authoritative, including null entries.
  if (job && Object.hasOwn(job, 'latest_images'))
    return job.latest_images ?? { clean: null, noisy: null };
  const url = job?.latest_image_url;
  return {
    clean: url && !url.includes('/images_noisy/') ? url : null,
    noisy: url?.includes('/images_noisy/') ? url : null,
  };
}

export function noiseVariantReason(
  job: Pick<Job, 'status' | 'can_generate_noise'> | undefined,
  noise: SceneSettings['noise'],
  seed: number,
  busy: boolean,
): string {
  if (busy) return '任务请求进行中，请稍候。';
  if (!job || job.status !== 'completed') return '请选择已完成的任务。';
  if (!job.can_generate_noise) return '原图来源不可用，请检查来源任务及其完整产物。';
  try {
    createNoiseVariant(noise, seed);
  } catch (error) {
    return error instanceof Error ? error.message : '噪声参数无效。';
  }
  return '';
}
