import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { resultImages } from '../noiseVariants';
import {
  filterJobs,
  frameOffset,
  modeLabels,
  statusLabels,
  zoomDisplay,
  savedDistanceLabel,
} from '../workbench';
import type { Job, ModelInfo, JobFrame } from '../types';
import OpenFolderButton from './OpenFolderButton';
import TaskContextMenu, { type TaskMenuPosition } from './TaskContextMenu';
export default function ResultsWorkspace({
  jobs,
  job,
  models,
  selectedId,
  onSelect,
  detailError,
  onNoise,
  variantReason,
  canceling,
  submitting,
  onCancel,
  onLoadMore,
  loadingMore,
  hasMore,
  onDelete,
}: {
  jobs: Job[];
  job: Job | undefined;
  models: ModelInfo[];
  selectedId: string;
  onSelect: (id: string) => void;
  detailError: string;
  onNoise: () => void;
  variantReason: string;
  canceling: boolean;
  submitting: boolean;
  onCancel: () => void;
  onLoadMore: () => void;
  loadingMore: boolean;
  hasMore: boolean;
  onDelete: (id: string) => void;
}) {
  const [menu, setMenu] = useState<TaskMenuPosition | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [model, setModel] = useState('');
  const [offset, setOffset] = useState(0);
  const [frame, setFrame] = useState<JobFrame | null>(null);
  const [total, setTotal] = useState(0);
  const [frameError, setFrameError] = useState('');
  const [frameRetry, setFrameRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<'clean' | 'noisy'>('noisy');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [imageError, setImageError] = useState(false);
  useEffect(() => {
    setOffset(0);
    setFrame(null);
    setTotal(0);
    setFrameError('');
  }, [selectedId]);
  useEffect(() => {
    if (!job) return;
    const c = new AbortController();
    setLoading(true);
    setImageError(false);
    setFrameError('');
    setFrame(null);
    void api
      .frames(job.id, offset, c.signal)
      .then((page) => {
        if (!c.signal.aborted) {
          setFrame(page.frames[0] ?? null);
          setTotal(page.total);
          if (offset >= page.total && page.total > 0) setOffset(frameOffset(offset, page.total));
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setFrameError(errorMessage(e));
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [job?.id, job?.completed_frames, offset, frameRetry]);
  const images = frame?.images ?? { clean: null, noisy: null };
  const shown = images[kind] ? kind : images.clean ? 'clean' : 'noisy';
  const url = images[shown] ?? '';
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setImageError(false);
  }, [url]);
  const filtered = filterJobs(jobs, models, query, status, model);
  const modelName = (id: string) => models.find((m) => m.id === id)?.name ?? id ?? '历史模型';
  const snapshot = job?.source_parameters ?? job?.parameters;
  return (
    <main className="results-workspace" aria-label="任务与结果工作区">
      <div className="results-heading">
        <div>
          <h2>任务与结果</h2>
          <p>查看生成图片，管理采集任务</p>
        </div>
        <OpenFolderButton label="打开数据目录" />
      </div>
      <div className="results-grid">
        <aside className="panel queue-panel">
          <div className="section-title">
            <h2>最近任务</h2>
            <small>已加载 {jobs.length} 项</small>
          </div>
          <input
            aria-label="搜索模型或任务"
            placeholder="搜索模型或任务"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="job-filters">
            <select
              aria-label="任务状态筛选"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">全部状态</option>
              {Object.entries(statusLabels).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="任务模型筛选"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">全部模型</option>
              {models.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="job-list">
            {filtered.map((item) => {
              const img = resultImages(item);
              return (
                <button
                  key={item.id}
                  className={`job-row ${selectedId === item.id ? 'selected' : ''}`}
                  onClick={() => onSelect(item.id)}
                  aria-pressed={selectedId === item.id}
                  data-job-id={item.id}
                  aria-haspopup="menu"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({
                      id: item.id,
                      x: event.clientX,
                      y: event.clientY,
                      anchor: event.currentTarget,
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenu({
                        id: item.id,
                        x: rect.left + 20,
                        y: rect.top + 20,
                        anchor: event.currentTarget,
                      });
                    }
                  }}
                >
                  <div className="job-card-top">
                    <span className="job-thumbnail">
                      {img.clean || img.noisy ? (
                        <img
                          src={img.clean || img.noisy || ''}
                          alt="已保存任务缩略图"
                          loading="lazy"
                        />
                      ) : (
                        <span>待生成</span>
                      )}
                    </span>
                    <span>
                      <strong>{modelName(item.model_id)}</strong>
                      <small>
                        {modeLabels[item.mode]} · {item.total_frames} 张
                      </small>
                    </span>
                  </div>
                  <div className="job-card-bottom">
                    <time>
                      {new Date(item.created_at).toLocaleString('zh-CN', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                    <span className={`status-badge ${item.status}`}>
                      {statusLabels[item.status]}
                    </span>
                  </div>
                </button>
              );
            })}
            {!filtered.length && (
              <p className="queue-empty">
                {jobs.length ? '当前已加载任务中没有匹配项。' : '暂无任务，完成设置后开始采集。'}
              </p>
            )}
          </div>
          {hasMore && (
            <button className="button load-more" disabled={loadingMore} onClick={onLoadMore}>
              {loadingMore ? '正在读取…' : '查看更多任务'}
            </button>
          )}
          <p className="control-caption search-scope">搜索与筛选当前已加载任务 · 右键可删除</p>
        </aside>
        <section className="panel result-panel">
          <div className="selected-job-heading">
            <div>
              <h2>
                {job ? `${modelName(job.model_id)} · ${modeLabels[job.mode]}` : '选择任务查看结果'}
              </h2>
              {job && (
                <p>
                  <span className={`status-badge ${job.status}`}>{statusLabels[job.status]}</span>
                  <span>
                    {new Date(job.created_at).toLocaleString('zh-CN')} · {job.completed_frames} /{' '}
                    {job.total_frames} 张
                  </span>
                </p>
              )}
            </div>
            <div className="result-actions">
              {url && !imageError && (
                <a className="button" href={url} target="_blank" rel="noreferrer">
                  打开图片
                </a>
              )}
              {job && <OpenFolderButton jobId={job.id} label="打开所在文件夹" />}
            </div>
          </div>
          <div className="result-body">
            <div className="gallery">
              <div className="gallery-toolbar">
                <div className="segmented">
                  <button
                    className={shown === 'clean' && images.clean ? 'active' : ''}
                    aria-pressed={shown === 'clean' && !!images.clean}
                    disabled={!images.clean || loading}
                    onClick={() => setKind('clean')}
                  >
                    原图
                  </button>
                  <button
                    className={shown === 'noisy' && images.noisy ? 'active' : ''}
                    aria-pressed={shown === 'noisy' && !!images.noisy}
                    disabled={!images.noisy || loading}
                    onClick={() => setKind('noisy')}
                  >
                    噪声图
                  </button>
                </div>
                <small>{frame ? `${frame.frame_id}.png` : ''}</small>
              </div>
              <div
                className="result-image"
                aria-label="保存图像查看器"
                onWheel={(e) => {
                  setZoom((v) => zoomDisplay(v * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
                }}
                onPointerDown={(e) => {
                  if (!url) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (d) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
                }}
                onPointerUp={() => {
                  drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
              >
                {loading ? (
                  <div className="image-placeholder">正在读取保存帧…</div>
                ) : url && !imageError ? (
                  <img
                    src={url}
                    alt="任务已保存的正式灰度 PNG"
                    draggable={false}
                    style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }}
                    onError={() => setImageError(true)}
                  />
                ) : (
                  <div className="image-placeholder">
                    <p>{frameError || (imageError ? '图像加载失败' : '等待正式输出')}</p>
                    <small>生成完成后显示已保存的 PNG</small>
                    {(frameError || imageError) && (
                      <button
                        className="button"
                        onClick={() => setFrameRetry((value) => value + 1)}
                      >
                        重新加载图像
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="gallery-zoom">
                <small>拖动平移 · 滚轮缩放</small>
                <div>
                  <button
                    className="text-button"
                    aria-label="缩小图像"
                    onClick={() => setZoom((v) => zoomDisplay(v / 1.25))}
                  >
                    −
                  </button>
                  <button
                    className="text-button"
                    aria-label="复位图像显示"
                    onClick={() => {
                      setZoom(1);
                      setPan({ x: 0, y: 0 });
                    }}
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                  <button
                    className="text-button"
                    aria-label="放大图像"
                    onClick={() => setZoom((v) => zoomDisplay(v * 1.25))}
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="frame-navigation">
                <button
                  className="button"
                  aria-label="上一帧"
                  disabled={loading || offset === 0 || !total}
                  onClick={() => setOffset((v) => frameOffset(v - 1, total))}
                >
                  ‹
                </button>
                <span>
                  第 {total ? offset + 1 : 0} / {total} 张
                </span>
                <button
                  className="button"
                  aria-label="下一帧"
                  disabled={loading || offset >= total - 1 || !total}
                  onClick={() => setOffset((v) => frameOffset(v + 1, total))}
                >
                  ›
                </button>
              </div>
            </div>
            <aside className="result-details">
              <section>
                <h3>结果操作</h3>
                <button className="button noise-launch" disabled={!job} onClick={onNoise}>
                  基于原图追加噪声
                </button>
                <p className="control-caption">在独立窗口中设置噪声参数</p>
                {variantReason && <p className="control-caption">{variantReason}</p>}
                {job && (job.status === 'queued' || job.status === 'running') && (
                  <button
                    className="button danger"
                    disabled={canceling || submitting}
                    onClick={onCancel}
                  >
                    {canceling ? '正在取消…' : '取消任务'}
                  </button>
                )}
              </section>
              <section className="task-info">
                <h3>任务信息</h3>
                {job ? (
                  <dl>
                    <dt>卫星模型</dt>
                    <dd>{modelName(job.model_id)}</dd>
                    <dt>采集方式</dt>
                    <dd>{modeLabels[job.mode]}</dd>
                    <dt>图片数量</dt>
                    <dd>
                      {job.completed_frames} / {job.total_frames} 张
                    </dd>
                    <dt>图像规格</dt>
                    <dd>1024 × 1024 灰度</dd>
                    <dt>保存内容</dt>
                    <dd>
                      {job.mode === 'noise_variant'
                        ? '噪声图 · 复用原图与标签'
                        : '原图、标注与姿态'}
                    </dd>
                    <dt>拍摄距离</dt>
                    <dd>{savedDistanceLabel(snapshot)}</dd>
                  </dl>
                ) : (
                  <p className="control-caption">选择左侧任务查看已保存信息</p>
                )}
              </section>
              <details className="technical-details">
                <summary>详细信息</summary>
                {job && (
                  <>
                    <p>
                      任务 ID：<code>{job.id}</code>
                    </p>
                    <p>
                      原始任务：<code aria-label="原始任务">{job.source_job_id ?? job.id}</code>
                    </p>
                    <p>{job.output_directory}</p>
                    {job.seed !== undefined && <p>已保存随机种子：{job.seed}</p>}
                    {job.noise && (
                      <p>
                        已保存噪声：{job.noise.enabled ? '启用' : '关闭'} · 高斯 σ{' '}
                        {job.noise.gaussian_sigma} · 泊松峰值 {job.noise.poisson_peak}
                      </p>
                    )}
                    <pre>
                      {JSON.stringify(
                        { parameters: job.parameters, source_parameters: job.source_parameters },
                        null,
                        2,
                      )}
                    </pre>
                  </>
                )}
              </details>
              <p className="control-caption technical-note">任务 ID、保存路径与参数</p>
              {(detailError || job?.error) && (
                <p className="inline-error" role="alert">
                  {detailError || job?.error}
                </p>
              )}
            </aside>
          </div>
        </section>
      </div>
      {menu && (
        <TaskContextMenu
          position={menu}
          onClose={() => setMenu(null)}
          onDelete={(id) => {
            setMenu(null);
            onDelete(id);
          }}
        />
      )}
    </main>
  );
}
