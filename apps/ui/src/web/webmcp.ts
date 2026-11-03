export interface WebMcpActions {
  listModels(): unknown;
  getState(): unknown;
  configure(input: unknown): unknown;
  startCapture(): unknown;
  getJob(id: string): unknown;
  cancelJob(id: string): unknown;
  addNoiseVariant(input: unknown): unknown;
  prepareDownload(id: string): unknown;
}

type Schema = {
  type: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
};
const number = (minimum: number, maximum: number): Schema => ({ type: 'number', minimum, maximum });
const integer = (minimum: number, maximum: number): Schema => ({
  type: 'integer',
  minimum,
  maximum,
});
const object = (
  properties: Record<string, Schema>,
  required = Object.keys(properties),
): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const id: Schema = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$',
};
const seed = integer(0, 4294967295);
const euler: Schema = { type: 'array', items: number(-360, 360), minItems: 3, maxItems: 3 };
const noise = object({
  enabled: { type: 'boolean' },
  gaussian_sigma: number(0, 1),
  poisson_peak: number(1, 1e7),
});
const configure = {
  ...object(
    {
      model_id: id,
      mode: { type: 'string', enum: ['single', 'coverage', 'sequence', 'custom_sequence'] },
      count: integer(1, 500),
      distance_m: number(10000, 30000),
      euler_deg: euler,
      seed,
      lighting: object({
        azimuth_deg: number(-360, 360),
        elevation_deg: number(-90, 90),
        energy: number(0, 100),
      }),
      noise,
      start_euler_deg: euler,
      end_euler_deg: euler,
    },
    [],
  ),
  minProperties: 1,
};

function validate(value: unknown, schema: Schema, path = 'input'): void {
  const fail = () => {
    throw new Error(`Invalid ${path}`);
  };
  if (schema.type === 'object') {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    )
      return fail();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length < (schema.minProperties ?? 0)) fail();
    for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) fail();
    for (const key of Object.keys(record)) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) fail();
      validate(record[key], schema.properties![key], `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length !== schema.minItems) return fail();
    for (let i = 0; i < value.length; i++) validate(value[i], schema.items!, `${path}[${i}]`);
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isInteger(value)) ||
      value < schema.minimum! ||
      value > schema.maximum!
    )
      fail();
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail();
  } else if (
    typeof value !== 'string' ||
    value.length < (schema.minLength ?? 0) ||
    value.length > (schema.maxLength ?? Infinity) ||
    (schema.pattern && !new RegExp(schema.pattern).test(value)) ||
    (schema.enum && !schema.enum.includes(value))
  )
    fail();
}

export function createWebMcpTools(actions: WebMcpActions) {
  const tool = (
    name: string,
    description: string,
    inputSchema: Schema,
    run: (input: Record<string, unknown>) => unknown,
  ) => ({
    name,
    description,
    inputSchema,
    async execute(input: unknown) {
      try {
        validate(input, inputSchema);
        return await run(input as Record<string, unknown>);
      } catch (error) {
        return { error: error instanceof Error ? error.message : '工具执行失败' };
      }
    },
  });
  return [
    tool('list_satellite_models', '列出本地可用的卫星模型。', object({}), () =>
      actions.listModels(),
    ),
    tool('get_capture_state', '读取当前采集设置和会话任务状态。', object({}), () =>
      actions.getState(),
    ),
    tool('configure_capture', '更新页面共用的采集设置，并执行参数校验。', configure, (input) =>
      actions.configure(input),
    ),
    tool('start_capture', '使用当前已校验的设置开始采集。', object({}), () =>
      actions.startCapture(),
    ),
    tool('get_capture_job', '读取指定会话采集任务的状态。', object({ job_id: id }), (input) =>
      actions.getJob(input.job_id as string),
    ),
    tool('cancel_capture_job', '取消采集并保留已完成的完整帧。', object({ job_id: id }), (input) =>
      actions.cancelJob(input.job_id as string),
    ),
    tool(
      'add_noise_variant',
      '基于会话中保留的原图生成噪声版本。',
      object({ job_id: id, noise, seed }),
      (input) => actions.addNoiseVariant(input),
    ),
    tool(
      'prepare_dataset_download',
      '在页面准备数据集 ZIP 链接，等待用户点击保存；此操作不会自动下载文件。',
      object({ job_id: id }),
      (input) => actions.prepareDownload(input.job_id as string),
    ),
  ];
}

type Tool = ReturnType<typeof createWebMcpTools>[number];
type Registry = {
  registerTool(tool: Tool, options: { signal: AbortSignal }): unknown;
  unregisterTool?(name: string): unknown;
};
type Status = { available: boolean; registered: number; message: string };
const bindings = new WeakMap<Registry, { dispose: () => void; done: Promise<void> }>();

/** Native tools only. No polyfill or simulated agent is installed. */
export function bindWebMcp(actions: WebMcpActions, onStatus: (status: Status) => void): () => void {
  const doc =
    typeof document === 'undefined'
      ? undefined
      : (document as Document & { modelContext?: Registry });
  const nav =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { modelContext?: Registry });
  const registry = [doc?.modelContext, nav?.modelContext].find(
    (candidate) => typeof candidate?.registerTool === 'function',
  );
  if (!registry) {
    onStatus({
      available: false,
      registered: 0,
      message: '当前浏览器不支持原生 WebMCP，可继续使用页面手动操作。',
    });
    return () => {};
  }
  const previous = bindings.get(registry);
  previous?.dispose();
  const controller = new AbortController();
  let disposed = false;
  const registered: string[] = [];
  const removals: Promise<unknown>[] = [];
  const remove = (name: string) => {
    try {
      if (registry.unregisterTool)
        removals.push(Promise.resolve(registry.unregisterTool(name)).catch(() => undefined));
    } catch {
      /* AbortSignal remains the primary cleanup. */
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    for (const name of registered.splice(0)) remove(name);
  };
  const done = (async () => {
    await previous?.done;
    if (disposed) return;
    onStatus({ available: true, registered: 0, message: '正在注册原生 WebMCP 工具。' });
    try {
      for (const tool of createWebMcpTools(actions)) {
        if (disposed) break;
        await registry.registerTool(tool, { signal: controller.signal });
        if (disposed) {
          remove(tool.name);
          break;
        }
        registered.push(tool.name);
      }
      if (!disposed)
        onStatus({
          available: true,
          registered: registered.length,
          message: '原生 WebMCP 工具已注册。',
        });
    } catch (error) {
      dispose();
      onStatus({
        available: true,
        registered: 0,
        message: `WebMCP 注册失败：${error instanceof Error ? error.message : String(error)}。可继续手动操作，刷新页面后重试。`,
      });
    }
    await Promise.all(removals);
  })();
  bindings.set(registry, {
    dispose,
    get done() {
      return Promise.all([done, ...removals]).then(() => undefined);
    },
  });
  return dispose;
}
