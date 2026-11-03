import assert from 'node:assert/strict';
import test from 'node:test';
import { bindWebMcp, createWebMcpTools } from '../src/web/webmcp.ts';
import type { WebMcpActions } from '../src/web/webmcp.ts';
function fixture() {
  const calls: unknown[][] = [];
  const actions = Object.fromEntries(
    [
      'listModels',
      'getState',
      'configure',
      'startCapture',
      'getJob',
      'cancelJob',
      'addNoiseVariant',
      'prepareDownload',
    ].map((name) => [
      name,
      (...args: unknown[]) => {
        calls.push([name, ...args]);
        return { action: name };
      },
    ]),
  ) as unknown as WebMcpActions;
  return { calls, actions, tools: createWebMcpTools(actions) };
}
const noise = { enabled: true, gaussian_sigma: 0.01, poisson_peak: 96 };
test('eight tools route valid arguments to shared actions including staged download', async () => {
  const { calls, tools } = fixture();
  const configuration = {
    model_id: 'model.glb',
    mode: 'custom_sequence',
    count: 500,
    distance_m: 30000,
    euler_deg: [0, 90, 0],
    start_euler_deg: [0, 0, 0],
    end_euler_deg: [90, 0, 0],
    seed: 4294967295,
    noise,
    lighting: { azimuth_deg: 35, elevation_deg: 28, energy: 4 },
  };
  const args = [
    {},
    {},
    configuration,
    {},
    { job_id: 'job-1' },
    { job_id: 'job-1' },
    { job_id: 'job-1', noise, seed: 1 },
    { job_id: 'job-1' },
  ];
  for (let i = 0; i < tools.length; i++)
    assert.ok(!('error' in ((await tools[i].execute(args[i])) as object)));
  assert.equal(calls.length, 8);
  assert.deepEqual(calls[2], ['configure', configuration]);
  assert.deepEqual(calls[7], ['prepareDownload', 'job-1']);
  assert.match(tools[7].description, /用户点击保存/);
  assert.equal(new Set(tools.map((t) => t.name)).size, 8);
});
test('reject malformed values before shared actions run', async () => {
  const { calls, tools } = fixture();
  for (const input of [
    null,
    [],
    {},
    { extra: 1 },
    { count: 0 },
    { count: 501 },
    { count: 1.2 },
    { seed: -1 },
    { seed: 2 ** 32 },
    { distance_m: NaN },
    { distance_m: 9999 },
    { distance_m: 30001 },
    { mode: 'bad' },
    { euler_deg: [0, 1] },
    { euler_deg: [0, 0, Infinity] },
    { euler_deg: [0, , 0] },
    { noise: { ...noise, enabled: 'yes' } },
    { noise: { ...noise, poisson_peak: 0 } },
    { lighting: { azimuth_deg: 0, elevation_deg: 91, energy: 4 } },
    { lighting: { energy: 1 } },
  ]) {
    assert.ok('error' in ((await tools[2].execute(input)) as object), JSON.stringify(input));
  }
  for (const input of [
    { job_id: '' },
    { job_id: '../a' },
    { job_id: 'a/b' },
    { job_id: 'a', extra: true },
    { job_id: 1 },
    { job_id: 'a'.repeat(129) },
  ])
    assert.ok('error' in ((await tools[4].execute(input)) as object));
  assert.ok('error' in ((await tools[0].execute({ extra: 1 })) as object));
  assert.equal(calls.length, 0);
});
test('action failures become actionable tool error payloads', async () => {
  const { actions } = fixture();
  actions.startCapture = async () => {
    throw new Error('Choose a model first');
  };
  assert.deepEqual(await createWebMcpTools(actions)[3].execute({}), {
    error: 'Choose a model first',
  });
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function withDocument(value: unknown, run: () => Promise<void>) {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value });
  try {
    await run();
  } finally {
    if (old) Object.defineProperty(globalThis, 'document', old);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}
test('unsupported feature is honest and harmless', async () => {
  await withDocument({}, async () => {
    const statuses: unknown[] = [];
    bindWebMcp(fixture().actions, (s) => statuses.push(s))();
    assert.equal((statuses[0] as { available: boolean }).available, false);
  });
});
test('mock native registry cleans abort signals and unregisters without duplicate active names', async () => {
  const active = new Set<string>();
  const removed: string[] = [];
  const registry = {
    registerTool(tool: { name: string }, options: { signal: AbortSignal }) {
      assert.equal(active.has(tool.name), false);
      active.add(tool.name);
      options.signal.addEventListener('abort', () => active.delete(tool.name));
    },
    unregisterTool(name: string) {
      active.delete(name);
      removed.push(name);
    },
  };
  await withDocument({ modelContext: registry }, async () => {
    const statuses: { registered: number }[] = [];
    const first = bindWebMcp(fixture().actions, (s) => statuses.push(s));
    await tick();
    assert.equal(active.size, 8);
    const second = bindWebMcp(fixture().actions, (s) => statuses.push(s));
    await tick();
    first();
    assert.equal(active.size, 8);
    second();
    second();
    assert.equal(active.size, 0);
    assert.equal(removed.length, 16);
    assert.equal(statuses.at(-1)?.registered, 8);
  });
});
test('synchronous and promised registration failures roll back, allow retry', async () => {
  for (const asyncFailure of [false, true]) {
    let count = 0;
    const signals: AbortSignal[] = [];
    const registry = {
      registerTool(_tool: unknown, options: { signal: AbortSignal }) {
        signals.push(options.signal);
        if (++count === 3) {
          if (asyncFailure) return Promise.reject(new Error('registry denied'));
          throw new Error('registry denied');
        }
      },
    };
    await withDocument({ modelContext: registry }, async () => {
      const statuses: { registered: number; message: string }[] = [];
      bindWebMcp(fixture().actions, (s) => statuses.push(s));
      await tick();
      assert.match(statuses.at(-1)!.message, /registry denied/);
      assert.equal(statuses.at(-1)!.registered, 0);
      assert.ok(signals.every((s) => s.aborted));
      const stop = bindWebMcp(fixture().actions, (s) => statuses.push(s));
      await tick();
      assert.equal(statuses.at(-1)!.registered, 8);
      stop();
    });
  }
});
test('pending registration cleanup waits before rebinding', async () => {
  let resolve!: () => void;
  let calls = 0;
  const registry = {
    registerTool() {
      if (++calls === 1)
        return new Promise<void>((r) => {
          resolve = r;
        });
    },
  };
  await withDocument({ modelContext: registry }, async () => {
    const first = bindWebMcp(fixture().actions, () => {});
    await tick();
    const second = bindWebMcp(fixture().actions, () => {});
    await tick();
    assert.equal(calls, 1);
    resolve();
    await tick();
    assert.equal(calls, 9);
    first();
    second();
  });
});
test('navigator legacy registry is used only when document registry is absent', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let registrations = 0;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      modelContext: {
        registerTool() {
          registrations++;
        },
      },
    },
  });
  try {
    await withDocument({}, async () => {
      const stop = bindWebMcp(fixture().actions, () => {});
      await tick();
      assert.equal(registrations, 8);
      stop();
    });
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
test('legacy asynchronous unregister settles before next registration', async () => {
  let calls = 0;
  const releases: (() => void)[] = [];
  const registry = {
    registerTool() {
      calls++;
    },
    unregisterTool() {
      return new Promise<void>((resolve) => releases.push(resolve));
    },
  };
  await withDocument({ modelContext: registry }, async () => {
    const stop = bindWebMcp(fixture().actions, () => {});
    await tick();
    stop();
    const next = bindWebMcp(fixture().actions, () => {});
    await tick();
    assert.equal(calls, 8);
    releases.splice(0).forEach((resolve) => resolve());
    await tick();
    assert.equal(calls, 16);
    next();
    releases.splice(0).forEach((resolve) => resolve());
  });
});
test('noise peak inclusive bounds match browser image pipeline', async () => {
  const { tools, calls } = fixture();
  for (const peak of [1, 1e7])
    assert.ok(
      !(
        'error' in
        ((await tools[6].execute({
          job_id: 'job-1',
          seed: 0,
          noise: { ...noise, poisson_peak: peak },
        })) as object)
      ),
    );
  for (const peak of [0.5, 1e7 + 1])
    assert.ok(
      'error' in
        ((await tools[6].execute({
          job_id: 'job-1',
          seed: 0,
          noise: { ...noise, poisson_peak: peak },
        })) as object),
    );
  assert.equal(calls.length, 2);
});
