import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { errorMessage } from '../api';
import {
  FolderPickerClient,
  nativeFolderBridge,
  OutputDirectoryController,
} from '../outputDirectory';

export default function OutputDirectoryControls({
  controller,
  submitting,
}: {
  controller: OutputDirectoryController;
  submitting: boolean;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [bridge] = useState(nativeFolderBridge);
  const [picker] = useState(() => new FolderPickerClient(bridge));
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const disabled = state.loading || state.saving || state.captureBusy || submitting || picking;
  const dirty = state.draft !== state.saved;
  async function choose() {
    if (disabled || pending.current) return;
    const operation = new AbortController();
    pending.current = operation;
    setPicking(true);
    setPickerError('');
    try {
      const path = await picker.select(state.draft || state.saved, operation.signal);
      if (!operation.signal.aborted && path !== null) controller.setDraft(path);
    } catch (error) {
      if (!operation.signal.aborted) setPickerError(errorMessage(error));
    } finally {
      pending.current = null;
      if (!operation.signal.aborted) setPicking(false);
    }
  }
  return (
    <section className="panel output-directory-panel" aria-label="数据集保存设置">
      <div className="section-title">
        <h2>数据集保存位置</h2>
        <span className="eyebrow">STORAGE</span>
      </div>
      <label className="field">
        <span>文件夹路径</span>
        <input
          aria-label="数据集保存位置"
          value={state.draft}
          onChange={(event) => {
            controller.setDraft(event.target.value);
            setPickerError('');
          }}
          disabled={disabled}
          spellCheck={false}
        />
      </label>
      <p className="output-directory-saved">
        已应用：<span>{state.saved || '尚未读取'}</span>
      </p>
      <div className="output-directory-actions">
        <button
          className="button"
          disabled={disabled || !bridge}
          title={!bridge ? '仅桌面应用支持选择文件夹，可手动输入路径后应用。' : undefined}
          onClick={() => void choose()}
        >
          {picking ? '正在选择…' : '选择文件夹'}
        </button>
        <button
          className="button"
          disabled={disabled || !state.saved || !dirty}
          onClick={() => void controller.apply()}
        >
          {state.saving ? '正在应用…' : '应用'}
        </button>
        <button
          className="button"
          disabled={disabled || !state.saved || (state.saved === state.defaultDirectory && !dirty)}
          onClick={() => void controller.restoreDefault()}
        >
          恢复默认
        </button>
      </div>
      {!bridge && <p className="hint">选择文件夹仅桌面应用可用；浏览器可手动输入路径并应用。</p>}
      {state.loading && (
        <p className="hint" role="status">
          正在读取保存位置，新采集暂不可用…
        </p>
      )}
      {dirty && (
        <p className="hint" role="status">
          路径尚未应用；新采集仍使用上方已应用位置。
        </p>
      )}
      {(state.error || pickerError) && (
        <p className="inline-error" role="alert">
          {pickerError || state.error}
        </p>
      )}
      {state.error && (
        <button className="button" disabled={disabled} onClick={() => void controller.load()}>
          重新读取保存位置
        </button>
      )}
      {state.notice && (
        <p className="inline-notice" role="status">
          {state.notice}
        </p>
      )}
      <p className="hint">
        请选择已存在、可写的绝对路径。后续新采集在此创建任务子文件夹，已有任务留在原处。噪声版本始终保存在原始任务所在文件夹旁。
      </p>
    </section>
  );
}
