import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FolderPickerClient,
  OutputDirectoryController,
  parseOutputSettings,
} from '../src/outputDirectory.ts';

class NativeBridge {
  listeners = new Set<(event: { data: unknown }) => void>();
  requests: any[] = [];
  postMessage(data: unknown) {
    this.requests.push(data);
  }
  addEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
    this.listeners.delete(listener);
  }
  reply(data: unknown) {
    for (const listener of this.listeners) listener({ data });
  }
}
const settings = { output_directory: 'C:\\数据 集', default_output_directory: 'H:\\工作区\\jobs' };
const reply = (id: string, path: string | null, extra = {}) => ({
  type: 'satellite.output-directory-selected',
  request_id: id,
  path,
  ...extra,
});

test('browser picker absence reports desktop reason without a listener', async () => {
  await assert.rejects(
    new FolderPickerClient(undefined).select('', new AbortController().signal),
    /桌面/,
  );
});
test('picker correlates strict replies and cancellation removes listener', async () => {
  const bridge = new NativeBridge();
  const client = new FolderPickerClient(bridge);
  const promise = client.select(settings.output_directory, new AbortController().signal);
  const request = bridge.requests[0];
  assert.deepEqual(Object.keys(request).sort(), ['initial_directory', 'request_id', 'type']);
  assert.equal(request.type, 'satellite.select-output-directory');
  assert.equal(request.initial_directory, settings.output_directory);
  bridge.reply(reply('wrong', 'C:\\wrong'));
  bridge.reply(reply(request.request_id, 'C:\\wrong', { unexpected: true }));
  bridge.reply(reply(request.request_id, 5 as any));
  assert.equal(bridge.listeners.size, 1);
  bridge.reply(reply(request.request_id, null));
  assert.equal(await promise, null);
  assert.equal(bridge.listeners.size, 0);
});
test('one pending dialog; abort cleanup ignores late replies and permits retry', async () => {
  const bridge = new NativeBridge();
  const client = new FolderPickerClient(bridge);
  const controller = new AbortController();
  const first = client.select('', controller.signal);
  await assert.rejects(client.select('', controller.signal), /选择/);
  const oldId = bridge.requests[0].request_id;
  controller.abort();
  await assert.rejects(first, /取消/);
  assert.equal(bridge.listeners.size, 0);
  const second = client.select('', new AbortController().signal);
  bridge.reply(reply(oldId, 'C:\\old'));
  assert.equal(bridge.listeners.size, 1);
  bridge.reply(reply(bridge.requests[1].request_id, 'H:\\新的 文件夹'));
  assert.equal(await second, 'H:\\新的 文件夹');
});
test('native errors remove listeners and surface useful reason', async () => {
  const bridge = new NativeBridge();
  const promise = new FolderPickerClient(bridge).select('', new AbortController().signal);
  bridge.reply(reply(bridge.requests[0].request_id, null, { error: '对话框无法打开' }));
  await assert.rejects(promise, /对话框无法打开/);
  assert.equal(bridge.listeners.size, 0);
});
test('settings response requires exact nonempty string paths', () => {
  assert.deepEqual(parseOutputSettings(settings), settings);
  for (const invalid of [
    null,
    {},
    { ...settings, output_directory: 3 },
    { ...settings, output_directory: '' },
    { ...settings, extra: true },
  ])
    assert.throws(() => parseOutputSettings(invalid), /保存位置/);
});
test('load, draft, explicit save and failed save preserve authoritative path', async () => {
  let rejectSave = false;
  const writes: string[] = [];
  const controller = new OutputDirectoryController({
    load: async () => settings,
    save: async (path) => {
      writes.push(path);
      if (rejectSave) throw new Error('目录不可写');
      return { ...settings, output_directory: path };
    },
  });
  assert.equal(controller.canCapture(), false);
  await controller.load();
  controller.setDraft('H:\\未来 数据');
  assert.equal(controller.getSnapshot().saved, settings.output_directory);
  assert.deepEqual(writes, []);
  await controller.apply();
  assert.equal(controller.getSnapshot().saved, 'H:\\未来 数据');
  rejectSave = true;
  controller.setDraft('Z:\\离线');
  await controller.apply();
  assert.equal(controller.getSnapshot().saved, 'H:\\未来 数据');
  assert.equal(controller.getSnapshot().draft, 'Z:\\离线');
  assert.match(controller.getSnapshot().error, /目录不可写/);
  assert.equal(controller.canCapture(), true);
});
test('capture lease and save exclude each other synchronously; restore uses saved default', async () => {
  let finish: (value: unknown) => void = () => {};
  const controller = new OutputDirectoryController({
    load: async () => settings,
    save: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await controller.load();
  assert.equal(controller.beginCapture(), true);
  controller.setDraft('H:\\next');
  await controller.apply();
  assert.equal(controller.getSnapshot().saving, false);
  controller.endCapture();
  const pending = controller.restoreDefault();
  assert.equal(controller.canCapture(), false);
  assert.equal(controller.beginCapture(), false);
  finish({ ...settings, output_directory: settings.default_output_directory });
  await pending;
  assert.equal(controller.getSnapshot().saved, settings.default_output_directory);
  assert.equal(controller.canCapture(), true);
});
test('initial load failure blocks capture and allows retry', async () => {
  let fail = true;
  const controller = new OutputDirectoryController({
    load: async () => {
      if (fail) throw new Error('离线');
      return settings;
    },
    save: async () => settings,
  });
  await controller.load();
  assert.equal(controller.canCapture(), false);
  fail = false;
  await controller.load();
  assert.equal(controller.canCapture(), true);
});

test('output settings API sends exact path-only body and preserves Chinese/spaces', async () => {
  const { api } = await import('../src/api.ts');
  const previous = globalThis.fetch;
  const calls: { url: unknown; options: RequestInit }[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options: options! });
    return new Response(JSON.stringify(settings));
  };
  try {
    const signal = new AbortController().signal;
    assert.deepEqual(await api.outputSettings(signal), settings);
    assert.deepEqual(await api.saveOutputSettings('H:\\中文 文件夹', signal), settings);
    assert.equal(calls[0].url, '/api/settings/output-directory');
    assert.equal(calls[0].options.method, undefined);
    assert.equal(calls[1].url, '/api/settings/output-directory');
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[1].options.signal, signal);
    assert.deepEqual(JSON.parse(calls[1].options.body as string), {
      output_directory: 'H:\\中文 文件夹',
    });
  } finally {
    globalThis.fetch = previous;
  }
});
test('disposing pending load ignores late completion and controller can reload', async () => {
  let finish: (value: unknown) => void = () => {};
  const controller = new OutputDirectoryController({
    load: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    save: async () => settings,
  });
  const pending = controller.load();
  controller.dispose();
  finish(settings);
  await pending;
  assert.equal(controller.getSnapshot().saved, '');
  assert.equal(controller.canCapture(), false);
  const retry = controller.load();
  finish(settings);
  await retry;
  assert.equal(controller.canCapture(), true);
});
test('malformed save response cannot replace saved or draft paths', async () => {
  const controller = new OutputDirectoryController({
    load: async () => settings,
    save: async () => ({ output_directory: 'C:\\wrong' }),
  });
  await controller.load();
  controller.setDraft('H:\\新数据');
  await controller.apply();
  assert.equal(controller.getSnapshot().saved, settings.output_directory);
  assert.equal(controller.getSnapshot().draft, 'H:\\新数据');
  assert.match(controller.getSnapshot().error, /保存位置/);
});

test('native selection saves immediately and excludes capture until the save is acknowledged', async () => {
  const bridge = new NativeBridge();
  const picker = new FolderPickerClient(bridge);
  let finishSave: (value: unknown) => void = () => {};
  const writes: string[] = [];
  const controller = new OutputDirectoryController({
    load: async () => settings,
    save: (path) => {
      writes.push(path);
      return new Promise((resolve) => {
        finishSave = resolve;
      });
    },
  });
  await controller.load();
  const captureAvailability: boolean[] = [];
  controller.subscribe(() => captureAvailability.push(controller.canCapture()));
  const pending = controller.selectDirectory(picker, new AbortController().signal);
  assert.equal(controller.getSnapshot().picking, true);
  assert.equal(controller.beginCapture(), false);
  bridge.reply(reply(bridge.requests[0].request_id, 'H:\\新 数据'));
  await Promise.resolve();
  assert.deepEqual(writes, ['H:\\新 数据']);
  assert.equal(controller.getSnapshot().saved, settings.output_directory);
  assert.equal(controller.getSnapshot().saving, true);
  assert.ok(captureAvailability.every((value) => !value));
  finishSave({ ...settings, output_directory: 'H:\\新 数据' });
  assert.equal(await pending, true);
  assert.equal(controller.getSnapshot().saved, 'H:\\新 数据');
  assert.equal(controller.canCapture(), true);
});

test('cancelled native selection preserves the saved path without a write', async () => {
  const bridge = new NativeBridge();
  let writes = 0;
  const controller = new OutputDirectoryController({
    load: async () => settings,
    save: async () => {
      writes++;
      return settings;
    },
  });
  await controller.load();
  const pending = controller.selectDirectory(
    new FolderPickerClient(bridge),
    new AbortController().signal,
  );
  bridge.reply(reply(bridge.requests[0].request_id, null));
  assert.equal(await pending, false);
  assert.equal(writes, 0);
  assert.equal(controller.getSnapshot().saved, settings.output_directory);
  assert.equal(controller.getSnapshot().error, '');
  assert.equal(controller.canCapture(), true);
});

test('failed automatic save preserves the old path and retries the selected path', async () => {
  const bridge = new NativeBridge();
  let fail = true;
  const writes: string[] = [];
  const controller = new OutputDirectoryController({
    load: async () => settings,
    save: async (path) => {
      writes.push(path);
      if (fail) throw new Error('目录不可写');
      return { ...settings, output_directory: path };
    },
  });
  await controller.load();
  const pending = controller.selectDirectory(
    new FolderPickerClient(bridge),
    new AbortController().signal,
  );
  bridge.reply(reply(bridge.requests[0].request_id, 'H:\\目标'));
  assert.equal(await pending, false);
  assert.equal(controller.getSnapshot().saved, settings.output_directory);
  assert.equal(controller.getSnapshot().retryAction, 'save');
  assert.match(controller.getSnapshot().error, /目录不可写/);
  assert.equal(controller.canCapture(), true);
  fail = false;
  assert.equal(await controller.retry(), true);
  assert.deepEqual(writes, ['H:\\目标', 'H:\\目标']);
  assert.equal(controller.getSnapshot().saved, 'H:\\目标');
  assert.equal(controller.getSnapshot().error, '');
});

test('active capture and active picker reject overlapping directory mutations', async () => {
  const bridge = new NativeBridge();
  const picker = new FolderPickerClient(bridge);
  let loads = 0;
  let writes = 0;
  const controller = new OutputDirectoryController({
    load: async () => {
      loads++;
      return settings;
    },
    save: async () => {
      writes++;
      return settings;
    },
  });
  await controller.load();
  controller.beginCapture();
  await controller.selectDirectory(picker, new AbortController().signal);
  assert.equal(bridge.requests.length, 0);
  controller.endCapture();
  const pending = controller.selectDirectory(picker, new AbortController().signal);
  await controller.selectDirectory(picker, new AbortController().signal);
  await controller.restoreDefault();
  await controller.apply();
  await controller.load();
  assert.equal(bridge.requests.length, 1);
  assert.equal(writes, 0);
  assert.equal(loads, 1);
  bridge.reply(reply(bridge.requests[0].request_id, null));
  await pending;
});

test('aborting selection releases capture and picker, and late replies cannot overwrite the next selection', async () => {
  const bridge = new NativeBridge();
  const picker = new FolderPickerClient(bridge);
  const writes: string[] = [];
  const controller = new OutputDirectoryController({
    load: async () => settings,
    save: async (path) => {
      writes.push(path);
      return { ...settings, output_directory: path };
    },
  });
  await controller.load();
  const abort = new AbortController();
  const first = controller.selectDirectory(picker, abort.signal);
  const oldId = bridge.requests[0].request_id;
  abort.abort();
  await first;
  assert.equal(controller.canCapture(), true);
  assert.equal(bridge.listeners.size, 0);
  assert.equal(controller.getSnapshot().error, '');
  assert.deepEqual(writes, []);
  const second = controller.selectDirectory(picker, new AbortController().signal);
  bridge.reply(reply(oldId, 'H:\\过期'));
  assert.equal(controller.getSnapshot().picking, true);
  bridge.reply(reply(bridge.requests[1].request_id, 'H:\\当前'));
  await second;
  assert.deepEqual(writes, ['H:\\当前']);
  assert.equal(controller.getSnapshot().saved, 'H:\\当前');
});

test('closing settings after selection cannot abort the committed save or leave the cached path stale', async () => {
  const bridge = new NativeBridge();
  const pickerLifetime = new AbortController();
  let finishSave: (value: unknown) => void = () => {};
  let savingSignal: AbortSignal | undefined;
  let serverPath = settings.output_directory;
  const controller = new OutputDirectoryController({
    load: async () => ({ ...settings, output_directory: serverPath }),
    save: (path, signal) => {
      serverPath = path;
      savingSignal = signal;
      return new Promise((resolve) => {
        finishSave = resolve;
      });
    },
  });
  await controller.load();
  const pending = controller.selectDirectory(new FolderPickerClient(bridge), pickerLifetime.signal);
  bridge.reply(reply(bridge.requests[0].request_id, 'H:\\已选择'));
  await Promise.resolve();
  assert.equal(controller.getSnapshot().saving, true);
  pickerLifetime.abort();
  assert.equal(controller.canCapture(), false);
  assert.equal(controller.getSnapshot().saved, settings.output_directory);
  finishSave({ ...settings, output_directory: serverPath });
  assert.equal(await pending, true);
  assert.equal(savingSignal?.aborted, false);
  assert.equal(controller.getSnapshot().saved, 'H:\\已选择');
  assert.equal(controller.getSnapshot().error, '');
  assert.equal(controller.canCapture(), true);
});

test('disposing during automatic save ignores late server completion and allows a fresh load', async () => {
  const bridge = new NativeBridge();
  let finishSave: (value: unknown) => void = () => {};
  let savingSignal: AbortSignal | undefined;
  const controller = new OutputDirectoryController({
    load: async () => settings,
    save: (_path, signal) => {
      savingSignal = signal;
      return new Promise((resolve) => {
        finishSave = resolve;
      });
    },
  });
  await controller.load();
  const pending = controller.selectDirectory(
    new FolderPickerClient(bridge),
    new AbortController().signal,
  );
  bridge.reply(reply(bridge.requests[0].request_id, 'H:\\过期'));
  await Promise.resolve();
  controller.dispose();
  assert.equal(savingSignal?.aborted, true);
  await controller.load();
  finishSave({ ...settings, output_directory: 'H:\\过期' });
  await pending;
  assert.equal(controller.getSnapshot().saved, settings.output_directory);
  assert.equal(controller.canCapture(), true);
});
