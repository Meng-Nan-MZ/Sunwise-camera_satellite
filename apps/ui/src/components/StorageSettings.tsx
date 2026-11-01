import { useSyncExternalStore } from 'react';
import { OutputDirectoryController } from '../outputDirectory';
import OutputDirectoryControls from './OutputDirectoryControls';

export default function StorageSettings({
  controller,
  submitting,
}: {
  controller: OutputDirectoryController;
  submitting: boolean;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const disabled =
    state.loading || state.saving || state.picking || state.captureBusy || submitting;
  return (
    <section className="storage-settings" aria-label="存储设置">
      <h3>存储设置</h3>
      <OutputDirectoryControls controller={controller} submitting={submitting} />
      <div className="output-directory-actions">
        <button
          className="button"
          disabled={disabled || !state.saved || state.saved === state.defaultDirectory}
          onClick={() => void controller.restoreDefault()}
        >
          恢复默认
        </button>
      </div>
      <details className="storage-help">
        <summary>保存位置说明</summary>
        <p>请选择本机已存在、可写的绝对路径。更改后的保存位置仅用于后续新建的采集任务。</p>
        <p>每次新采集会在保存位置下创建独立任务子文件夹；已有任务保留在原位置，不会迁移。</p>
        <p>噪声版本始终保存在原始任务所在文件夹旁，不受当前保存位置更改影响。</p>
        <p>恢复默认会使用工作区的默认任务目录，不会移动或删除已有数据。</p>
        <p>默认位置：{state.defaultDirectory || '尚未读取'}</p>
      </details>
    </section>
  );
}
