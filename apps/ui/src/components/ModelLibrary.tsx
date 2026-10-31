import type { ModelInfo } from '../types';
import { SatelliteIcon } from './Controls';

const configurationLabels: Record<string, string> = {
  double_panel: '双帆板',
  single_panel: '单帆板',
  no_panel: '无帆板',
  synthetic_variant: '合成变体',
};

interface Props {
  models: ModelInfo[];
  modelId: string;
  setModelId: (id: string) => void;
  bootError: string;
}

export default function ModelLibrary({ models, modelId, setModelId, bootError }: Props) {
  const model = models.find((item) => item.id === modelId);
  return (
    <section className="panel library-panel">
      <div className="section-title">
        <h2>模型库</h2>
        <span className="count-badge">{models.length.toString().padStart(2, '0')}</span>
      </div>
      <p className="section-caption">选择本地仿真目标</p>
      <div className="model-list" aria-label="选择卫星模型">
        {models.map((item, index) => (
          <button
            key={item.id}
            className={`model-card ${modelId === item.id ? 'selected' : ''}`}
            onClick={() => setModelId(item.id)}
            aria-pressed={modelId === item.id}
          >
            <span className="model-icon">
              <SatelliteIcon small />
            </span>
            <span className="model-copy">
              <strong>{item.name}</strong>
              <small>
                {configurationLabels[item.configuration] ?? item.configuration}
                <span>R {item.radius_m.toFixed(2)} m</span>
              </small>
            </span>
            <span className="model-index">{String(index + 1).padStart(2, '0')}</span>
          </button>
        ))}
        {!models.length && (
          <div className="library-empty">{bootError ? '模型清单不可用' : '正在读取模型清单…'}</div>
        )}
      </div>
      {model && (
        <div className="asset-detail">
          <span>资产版本</span>
          <code title={model.sha256}>{model.sha256.slice(0, 12)}</code>
          <small>米制机体系 · 载荷安装采用仿真假设</small>
        </div>
      )}
    </section>
  );
}
