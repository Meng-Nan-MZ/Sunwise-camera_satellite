import test from 'node:test';
import assert from 'node:assert/strict';
import { AppearanceController, parseAppearance } from '../src/appearance.ts';
import { api } from '../src/api.ts';
test('appearance server preference wins and exact response validation rejects malformed data', async () => {
  const c = new AppearanceController({
    load: async () => ({ theme: 'dark' }),
    save: async () => ({ theme: 'dark' }),
  });
  assert.equal(c.getSnapshot().theme, 'light');
  assert.equal(c.getSnapshot().loading, true);
  await c.load();
  assert.equal(c.getSnapshot().theme, 'dark');
  assert.equal(c.getSnapshot().loading, false);
  for (const v of [null, {}, { theme: 'blue' }, { theme: 'light', path: 'extra' }])
    assert.throws(() => parseAppearance(v));
});
test('theme saves serialize, loading excludes editing, and a failed save preserves authoritative theme', async () => {
  let releaseLoad!: (v: unknown) => void;
  let releaseSave!: (v: unknown) => void;
  const writes: string[] = [];
  const c = new AppearanceController({
    load: () => new Promise((r) => (releaseLoad = r)),
    save: (theme) => {
      writes.push(theme);
      return new Promise((r) => (releaseSave = r));
    },
  });
  const load = c.load();
  await c.save('light');
  assert.equal(writes.length, 0);
  releaseLoad({ theme: 'dark' });
  await load;
  const save = c.save('light');
  assert.equal(c.getSnapshot().saving, true);
  await c.save('dark');
  assert.deepEqual(writes, ['light']);
  assert.equal(c.getSnapshot().theme, 'dark');
  releaseSave({ theme: 'light' });
  await save;
  assert.equal(c.getSnapshot().theme, 'light');
  const failed = c.save('dark');
  releaseSave({ theme: 'invalid' });
  await failed;
  assert.equal(c.getSnapshot().theme, 'light');
  assert.match(c.getSnapshot().error, /主题/);
});
test('appearance errors allow retry and disposed pending work cannot publish a stale preference', async () => {
  let fail = true;
  let release!: (v: unknown) => void;
  const c = new AppearanceController({
    load: async () => {
      if (fail) throw new Error('读取失败');
      return new Promise((r) => (release = r));
    },
    save: async () => {
      throw new Error('保存失败');
    },
  });
  await c.load();
  assert.equal(c.getSnapshot().error, '读取失败');
  fail = false;
  const pending = c.load();
  c.dispose();
  release({ theme: 'dark' });
  await pending;
  assert.equal(c.getSnapshot().theme, 'light');
  const d = new AppearanceController({
    load: async () => ({ theme: 'light' }),
    save: async () => {
      throw new Error('保存失败');
    },
  });
  await d.load();
  await d.save('dark');
  assert.equal(d.getSnapshot().theme, 'light');
  assert.equal(d.getSnapshot().saving, false);
  assert.equal(d.getSnapshot().error, '保存失败');
});
test('appearance API uses stable settings endpoint and exact theme-only POST body', async () => {
  const old = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ theme: 'light' }));
  };
  try {
    const signal = new AbortController().signal;
    await api.appearance(signal);
    await api.saveAppearance('light', signal);
    assert.equal(calls[0].url, '/api/settings/appearance');
    assert.equal(calls[1].url, '/api/settings/appearance');
    assert.deepEqual(JSON.parse(calls[1].options.body), { theme: 'light' });
    assert.equal(calls[1].options.signal, signal);
    assert.equal(calls[1].options.method, 'POST');
  } finally {
    globalThis.fetch = old;
  }
});
