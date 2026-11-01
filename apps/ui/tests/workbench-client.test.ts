import test from 'node:test';
import assert from 'node:assert/strict';
import { openOutputFolder } from '../src/openOutputFolder.ts';
import { api, ApiError } from '../src/api.ts';
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
test('delete client uses confirmed identity and fingerprint, never sends a filesystem path', async () => {
  const previous = globalThis.fetch;
  const calls: { url: string; options: RequestInit }[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options: options! });
    return new Response(JSON.stringify({ deleted_job_ids: ['a'], deleted_count: 1 }));
  };
  try {
    const signal = new AbortController().signal;
    await api.deletionPreview('a/b', signal);
    assert.equal(calls[0].url, '/api/jobs/a%2Fb/deletion-preview');
    assert.equal(calls[0].options.body, undefined);
    const result = await api.deleteJob('a/b', 'confirmed-fingerprint', signal);
    assert.equal(result.deleted_count, 1);
    assert.equal(calls[1].url, '/api/jobs/a%2Fb');
    assert.equal(calls[1].options.method, 'DELETE');
    assert.deepEqual(calls[1].options.headers, { 'If-Match': 'confirmed-fingerprint' });
    assert.equal(calls[1].options.body, undefined);
    assert.equal(calls[1].options.signal, signal);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: '任务列表已改变', code: 'DELETE_PLAN_CHANGED' }), {
        status: 409,
      });
    await assert.rejects(
      api.deleteJob('a', 'old', signal),
      (error: unknown) =>
        error instanceof ApiError && error.status === 409 && error.code === 'DELETE_PLAN_CHANGED',
    );
  } finally {
    globalThis.fetch = previous;
  }
});
test('folder opening sends only constrained native target and saved job identity, correlates strict reply', async () => {
  const b = new NativeBridge();
  const id = 'a'.repeat(32);
  const promise = openOutputFolder(b, id, new AbortController().signal);
  const request = b.requests[0];
  assert.deepEqual(Object.keys(request).sort(), ['job_id', 'request_id', 'target', 'type']);
  assert.equal(request.target, 'job-output');
  assert.equal(request.job_id, id);
  assert.equal(request.type, 'satellite.open-output-directory');
  const reply = {
    type: 'satellite.output-directory-opened',
    request_id: request.request_id,
    error: null,
  };
  b.reply({ ...reply, request_id: 'wrong' });
  b.reply({ ...reply, path: 'C:\\injected' });
  b.reply({ ...reply, error: 4 });
  assert.equal(b.listeners.size, 1);
  b.reply(reply);
  await promise;
  assert.equal(b.listeners.size, 0);
  const root = openOutputFolder(b, undefined, new AbortController().signal);
  assert.equal(b.requests[1].target, 'output-root');
  assert.ok(!('job_id' in b.requests[1]));
  b.reply({ ...reply, request_id: b.requests[1].request_id });
  await root;
});
test('browser-only, malformed identity, native errors and abort cannot leave folder listeners', async () => {
  await assert.rejects(
    openOutputFolder(undefined, undefined, new AbortController().signal),
    /桌面/,
  );
  const b = new NativeBridge();
  await assert.rejects(openOutputFolder(b, '../../path', new AbortController().signal), /编号/);
  assert.equal(b.requests.length, 0);
  const c = new AbortController();
  const pending = openOutputFolder(b, undefined, c.signal);
  c.abort();
  await assert.rejects(pending, /取消/);
  assert.equal(b.listeners.size, 0);
  const failure = openOutputFolder(b, undefined, new AbortController().signal);
  b.reply({
    type: 'satellite.output-directory-opened',
    request_id: b.requests.at(-1).request_id,
    error: '目录不存在',
  });
  await assert.rejects(failure, /目录不存在/);
  assert.equal(b.listeners.size, 0);
});
test('gallery and older-job clients preserve endpoint identities, pagination and abort signal', async () => {
  const previous = globalThis.fetch;
  const calls: { url: string; options: RequestInit }[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options: options! });
    return new Response(
      JSON.stringify(
        String(url).includes('/frames')
          ? {
              frames: [
                {
                  frame_id: '000001',
                  images: { clean: '/api/jobs/x/images/000001.png', noisy: null },
                },
              ],
              total: 5,
            }
          : [],
      ),
    );
  };
  try {
    const signal = new AbortController().signal;
    const response = await api.frames('a/b', 4, signal);
    assert.equal(response.total, 5);
    assert.equal(response.frames[0].images.noisy, null);
    assert.equal(calls[0].url, '/api/jobs/a%2Fb/frames?offset=4&limit=1');
    assert.equal(calls[0].options.signal, signal);
    assert.equal(calls[0].options.cache, 'no-store');
    await api.jobsPage(100, signal);
    assert.equal(calls[1].url, '/api/jobs?offset=100&limit=100');
  } finally {
    globalThis.fetch = previous;
  }
});
