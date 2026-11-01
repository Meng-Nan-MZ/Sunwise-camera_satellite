export interface OutputSettings {
  output_directory: string;
  default_output_directory: string;
}
export interface NativeFolderBridge {
  postMessage(message: object): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}
export function nativeFolderBridge(): NativeFolderBridge | undefined {
  return (window as Window & { chrome?: { webview?: NativeFolderBridge } }).chrome?.webview;
}
export function parseOutputSettings(value: unknown): OutputSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('保存位置响应无效。');
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 2 ||
    typeof data.output_directory !== 'string' ||
    !data.output_directory ||
    typeof data.default_output_directory !== 'string' ||
    !data.default_output_directory
  )
    throw new Error('保存位置响应无效。');
  return data as unknown as OutputSettings;
}

export class FolderPickerClient {
  private pending = false;
  private bridge?: NativeFolderBridge;
  constructor(bridge?: NativeFolderBridge) {
    this.bridge = bridge;
  }
  select(initialDirectory: string, signal: AbortSignal): Promise<string | null> {
    const bridge = this.bridge;
    if (!bridge)
      return Promise.reject(new Error('选择文件夹仅在桌面应用中可用；可直接输入路径后保存。'));
    if (this.pending) return Promise.reject(new Error('请先完成当前文件夹选择。'));
    if (signal.aborted) return Promise.reject(new Error('已取消选择。'));
    if (initialDirectory.length > 32767) return Promise.reject(new Error('路径过长。'));
    const requestId = crypto.randomUUID();
    this.pending = true;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        bridge.removeEventListener('message', onMessage);
        signal.removeEventListener('abort', onAbort);
        this.pending = false;
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('已取消选择。'));
      };
      const onMessage = (event: { data: unknown }) => {
        if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
        const data = event.data as Record<string, unknown>;
        if (
          data.type !== 'satellite.output-directory-selected' ||
          data.request_id !== requestId ||
          !Object.hasOwn(data, 'path') ||
          (data.path !== null &&
            (typeof data.path !== 'string' || data.path.length > 32767 || !data.path)) ||
          Object.keys(data).some((key) => !['type', 'request_id', 'path', 'error'].includes(key)) ||
          (Object.hasOwn(data, 'error') && typeof data.error !== 'string')
        )
          return;
        cleanup();
        if (data.error) reject(new Error(data.error as string));
        else resolve(data.path as string | null);
      };
      bridge.addEventListener('message', onMessage);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        bridge.postMessage({
          type: 'satellite.select-output-directory',
          request_id: requestId,
          initial_directory: initialDirectory,
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}

interface Transport {
  load(signal: AbortSignal): Promise<unknown>;
  save(path: string, signal: AbortSignal): Promise<unknown>;
}
interface State {
  saved: string;
  defaultDirectory: string;
  draft: string;
  loading: boolean;
  saving: boolean;
  picking: boolean;
  captureBusy: boolean;
  error: string;
  notice: string;
  retryAction: 'load' | 'save' | 'pick' | null;
}
export class OutputDirectoryController {
  private state: State = {
    saved: '',
    defaultDirectory: '',
    draft: '',
    loading: true,
    saving: false,
    picking: false,
    captureBusy: false,
    error: '',
    notice: '',
    retryAction: null,
  };
  private listeners = new Set<() => void>();
  private operation: AbortController | null = null;
  private transport: Transport;
  constructor(transport: Transport) {
    this.transport = transport;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(values: Partial<State>) {
    this.state = { ...this.state, ...values };
    for (const listener of this.listeners) listener();
  }
  canCapture() {
    return Boolean(
      this.state.saved &&
        !this.state.loading &&
        !this.state.saving &&
        !this.state.picking &&
        !this.state.captureBusy,
    );
  }
  beginCapture() {
    if (!this.canCapture()) return false;
    this.update({ captureBusy: true });
    return true;
  }
  endCapture() {
    this.update({ captureBusy: false });
  }
  setDraft(draft: string) {
    if (this.canCapture()) this.update({ draft, notice: '', error: '', retryAction: null });
  }
  dispose() {
    this.operation?.abort();
    this.operation = null;
    this.update({ loading: false, saving: false, picking: false });
  }
  async load() {
    if (this.state.saving || this.state.picking || this.state.captureBusy) return false;
    this.operation?.abort();
    const operation = new AbortController();
    this.operation = operation;
    this.update({ loading: true, error: '', notice: '', retryAction: null });
    try {
      const settings = parseOutputSettings(await this.transport.load(operation.signal));
      if (!operation.signal.aborted) {
        this.update({
          saved: settings.output_directory,
          defaultDirectory: settings.default_output_directory,
          draft: settings.output_directory,
        });
        return true;
      }
    } catch (error) {
      if (!operation.signal.aborted) this.update({ error: message(error), retryAction: 'load' });
    } finally {
      this.finish(operation);
    }
    return false;
  }
  apply() {
    return this.save(this.state.draft);
  }
  restoreDefault() {
    return this.save(this.state.defaultDirectory);
  }
  retry() {
    if (this.state.retryAction === 'load') return this.load();
    if (this.state.retryAction === 'save') return this.apply();
    return Promise.resolve(false);
  }
  async selectDirectory(picker: FolderPickerClient, signal: AbortSignal) {
    if (!this.canCapture() || signal.aborted) return false;
    const operation = new AbortController();
    this.operation = operation;
    const abort = () => operation.abort();
    signal.addEventListener('abort', abort, { once: true });
    this.update({ picking: true, error: '', notice: '', retryAction: null });
    try {
      const path = await picker.select(this.state.saved, operation.signal);
      if (operation.signal.aborted || path === null) return false;
      // Closing the picker UI must not interrupt a save the server may already commit.
      // The shared controller still owns cancellation when the app is disposed.
      signal.removeEventListener('abort', abort);
      // Keep the selection and server save in one capture-blocking transaction.
      return await this.persist(path, operation);
    } catch (error) {
      if (!operation.signal.aborted) this.update({ error: message(error), retryAction: 'pick' });
      return false;
    } finally {
      signal.removeEventListener('abort', abort);
      this.finish(operation);
    }
  }
  private async save(path: string) {
    if (!this.canCapture()) return false;
    const operation = new AbortController();
    this.operation = operation;
    try {
      return await this.persist(path, operation);
    } finally {
      this.finish(operation);
    }
  }
  private async persist(path: string, operation: AbortController) {
    this.update({
      draft: path,
      picking: false,
      saving: true,
      error: '',
      notice: '',
      retryAction: null,
    });
    try {
      const settings = parseOutputSettings(await this.transport.save(path, operation.signal));
      if (!operation.signal.aborted) {
        this.update({
          saved: settings.output_directory,
          defaultDirectory: settings.default_output_directory,
          draft: settings.output_directory,
          notice: '保存位置已更新',
        });
        return true;
      }
    } catch (error) {
      if (!operation.signal.aborted) this.update({ error: message(error), retryAction: 'save' });
    }
    return false;
  }
  private finish(operation: AbortController) {
    if (this.operation === operation) {
      this.operation = null;
      this.update({ loading: false, saving: false, picking: false });
    }
  }
}
function message(error: unknown) {
  if (error instanceof TypeError) return '无法连接本机服务，请重试。';
  return error instanceof Error ? error.message : '保存位置操作失败，请重试。';
}
