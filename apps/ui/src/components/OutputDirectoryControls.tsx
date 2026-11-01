import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  FolderPickerClient,
  nativeFolderBridge,
  OutputDirectoryController,
} from '../outputDirectory';
import Dialog from './Dialog';

function compactPath(path: string) {
  const characters = Array.from(path);
  if (characters.length <= 58) return path;
  return `${characters.slice(0, 24).join('')}…${characters.slice(-33).join('')}`;
}

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
  const [editing, setEditing] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const disabled =
    state.loading || state.saving || state.captureBusy || submitting || state.picking;

  async function choose() {
    if (disabled || pending.current || !state.saved) return;
    if (!bridge) {
      controller.setDraft(state.saved);
      setEditing(true);
      return;
    }
    const operation = new AbortController();
    pending.current = operation;
    try {
      await controller.selectDirectory(picker, operation.signal);
    } finally {
      if (pending.current === operation) pending.current = null;
    }
  }

  async function save() {
    if (!disabled && (await controller.apply())) setEditing(false);
  }

  const feedback = (
    <div className="folder-feedback">
      {state.error && (
        <>
          <p className="inline-error" role="alert">
            {state.error}
          </p>
          <button
            className="text-button"
            type="button"
            disabled={disabled}
            onClick={() => void (state.retryAction === 'pick' ? choose() : controller.retry())}
          >
            重试
          </button>
        </>
      )}
      {!state.error && (state.saving || state.notice) && (
        <span className="inline-notice" role="status">
          {state.saving ? '正在保存…' : state.notice}
        </span>
      )}
    </div>
  );

  return (
    <section className="output-directory-panel" aria-label="数据集保存位置">
      <div className="folder-summary">
        <strong>输出文件夹</strong>
        <span title={state.saved} aria-label={state.saved || undefined}>
          {compactPath(state.saved) || (state.loading ? '正在读取…' : '未读取保存位置')}
        </span>
        <button
          className="text-button"
          disabled={disabled || !state.saved}
          onClick={() => void choose()}
        >
          {state.picking ? '正在选择…' : '更改'}
        </button>
      </div>
      {!editing && feedback}
      {editing && (
        <Dialog title="更改保存位置" onClose={() => setEditing(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (state.draft.trim() && state.draft !== state.saved) void save();
            }}
          >
            <label className="field">
              <span>文件夹路径</span>
              <input
                aria-label="数据集保存位置"
                value={state.draft}
                onChange={(event) => controller.setDraft(event.target.value)}
                disabled={disabled}
                spellCheck={false}
                autoFocus
              />
            </label>
            <p className="hint">输入本机已存在且可写的绝对路径。</p>
            <div className="output-directory-actions">
              <button
                className="button primary"
                type="submit"
                disabled={disabled || !state.draft.trim() || state.draft === state.saved}
              >
                {state.saving ? '正在保存…' : '保存'}
              </button>
              <button className="button" type="button" onClick={() => setEditing(false)}>
                取消
              </button>
            </div>
            {feedback}
          </form>
        </Dialog>
      )}
    </section>
  );
}
