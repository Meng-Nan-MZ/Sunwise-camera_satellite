export type Theme = 'dark' | 'light';
export function parseAppearance(value: unknown): { theme: Theme } {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !('theme' in value) ||
    (value.theme !== 'dark' && value.theme !== 'light')
  )
    throw new Error('主题设置响应无效。');
  return { theme: value.theme };
}
interface AppearanceTransport {
  load(signal: AbortSignal): Promise<unknown>;
  save(theme: Theme, signal: AbortSignal): Promise<unknown>;
}
export class AppearanceController {
  private state: { theme: Theme; loading: boolean; saving: boolean; error: string } = {
    theme: 'light',
    loading: true,
    saving: false,
    error: '',
  };
  private transport: AppearanceTransport;
  private operation: AbortController | null = null;
  private listeners = new Set<() => void>();
  constructor(transport: AppearanceTransport) {
    this.transport = transport;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(values: Partial<typeof this.state>) {
    this.state = { ...this.state, ...values };
    for (const listener of this.listeners) listener();
  }
  dispose() {
    this.operation?.abort();
    this.operation = null;
  }
  async load() {
    if (this.state.saving) return;
    this.operation?.abort();
    const operation = new AbortController();
    this.operation = operation;
    this.update({ loading: true, error: '' });
    try {
      const preference = parseAppearance(await this.transport.load(operation.signal));
      if (!operation.signal.aborted) this.update(preference);
    } catch (error) {
      if (!operation.signal.aborted)
        this.update({ error: error instanceof Error ? error.message : '主题读取失败，请重试。' });
    } finally {
      if (!operation.signal.aborted) {
        this.operation = null;
        this.update({ loading: false });
      }
    }
  }
  async save(theme: Theme) {
    if (this.state.loading || this.state.saving || theme === this.state.theme) return;
    const operation = new AbortController();
    this.operation = operation;
    this.update({ saving: true, error: '' });
    try {
      const preference = parseAppearance(await this.transport.save(theme, operation.signal));
      if (!operation.signal.aborted) this.update(preference);
    } catch (error) {
      if (!operation.signal.aborted)
        this.update({ error: error instanceof Error ? error.message : '主题保存失败，请重试。' });
    } finally {
      if (!operation.signal.aborted) {
        this.operation = null;
        this.update({ saving: false });
      }
    }
  }
}
