import type { Job, ModelInfo } from './types.ts';
export const modeLabels = {
  single: '单张采集',
  coverage: '全姿态采样',
  sequence: '连续序列',
  custom_sequence: '起止姿态序列',
  noise_variant: '噪声版本',
};
export const statusLabels = {
  queued: '等待中',
  running: '生成中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  interrupted: '已中断',
};
export function filterJobs(
  jobs: Job[],
  models: Pick<ModelInfo, 'id' | 'name'>[],
  query: string,
  status: string,
  model: string,
) {
  const search = query.trim().toLocaleLowerCase();
  return jobs.filter(
    (j) =>
      (!status || j.status === status) &&
      (!model || j.model_id === model) &&
      (!search ||
        `${j.id} ${j.model_id} ${models.find((m) => m.id === j.model_id)?.name ?? ''} ${modeLabels[j.mode]}`
          .toLocaleLowerCase()
          .includes(search)),
  );
}
export const zoomDisplay = (value: number) =>
  Math.min(4, Math.max(0.25, Number.isFinite(value) ? value : 1));
export const frameOffset = (value: number, total: number) =>
  Math.max(0, Math.min(Math.max(0, total - 1), Math.floor(value)));
export function mergeJobs(fresh: Job[], previous: Job[]) {
  const ids = new Set(fresh.map((j) => j.id));
  return [...fresh, ...previous.filter((j) => !ids.has(j.id))];
}
export function savedDistanceLabel(snapshot: Record<string, unknown> | undefined): string {
  if (!snapshot) return '历史记录';
  const automatic =
    snapshot.distance_policy === 'automatic' ||
    (snapshot.distance_policy === undefined &&
      (snapshot.mode === 'coverage' || snapshot.mode === 'sequence'));
  if (automatic) return snapshot.mode === 'coverage' ? '10–30 km（自动）' : '30→10 km（自动）';
  const scene = snapshot.scene as Record<string, unknown> | undefined;
  return scene && typeof scene.distance_m === 'number'
    ? `${scene.distance_m / 1000} km${snapshot.distance_policy === 'fixed' ? '（固定）' : ''}`
    : '历史记录';
}
