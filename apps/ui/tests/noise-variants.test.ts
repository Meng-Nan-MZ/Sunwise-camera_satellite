import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../src/api.ts';
import { createNoiseVariant, resultImages, noiseVariantReason } from '../src/noiseVariants.ts';
const noise = { enabled: true, gaussian_sigma: 0.012, poisson_peak: 96 };
const source = { id: 'original', status: 'completed', can_generate_noise: true };

test('noise variant freezes only current noise and explicit seed, independent of scene', () => {
  const live = { ...noise, model_id: 'different-live-model' };
  const request = createNoiseVariant(live, 42);
  live.gaussian_sigma = 0.09;
  assert.deepEqual(request, { noise, seed: 42 });
  assert.ok(Object.isFrozen(request) && Object.isFrozen(request.noise));
});

test('noise variant rejects disabled noise, invalid ranges and invalid seeds', () => {
  for (const value of [-1, NaN, Infinity, 1.1])
    assert.throws(() => createNoiseVariant({ ...noise, gaussian_sigma: value }, 42));
  for (const value of [0, 10000001, NaN])
    assert.throws(() => createNoiseVariant({ ...noise, poisson_peak: value }, 42));
  for (const value of [-1, 0.5, 4294967296, NaN])
    assert.throws(() => createNoiseVariant(noise, value));
  assert.throws(() => createNoiseVariant({ ...noise, enabled: false }, 42));
  assert.doesNotThrow(() =>
    createNoiseVariant({ ...noise, gaussian_sigma: 1, poisson_peak: 1e7 }, 0),
  );
});

test('explicit clean-only and explicit empty results override legacy compatibility URL', () => {
  assert.deepEqual(
    resultImages({
      latest_images: { clean: '/clean.png', noisy: null },
      latest_image_url: '/old.png',
    }),
    { clean: '/clean.png', noisy: null },
  );
  assert.deepEqual(
    resultImages({ latest_images: { clean: null, noisy: null }, latest_image_url: '/old.png' }),
    { clean: null, noisy: null },
  );
});

test('legacy paired results expose only actual existing URL without inventing a sibling', () => {
  assert.deepEqual(resultImages({ latest_image_url: '/data/a/images_noisy/1.png' }), {
    clean: null,
    noisy: '/data/a/images_noisy/1.png',
  });
  assert.deepEqual(resultImages({ latest_image_url: '/data/a/images_clean/1.png' }), {
    clean: '/data/a/images_clean/1.png',
    noisy: null,
  });
});

test('completed canonical and variant sources eligible without renderer, model or preview readiness', () => {
  assert.equal(noiseVariantReason(source, noise, 42, false), '');
  assert.equal(
    noiseVariantReason(
      { ...source, id: 'variant', source_job_id: 'original', mode: 'noise_variant' },
      noise,
      42,
      false,
    ),
    '',
  );
  assert.match(noiseVariantReason(source, noise, 42, true), /进行中/);
  assert.match(
    noiseVariantReason({ ...source, can_generate_noise: false }, noise, 42, false),
    /来源/,
  );
  assert.match(noiseVariantReason({ ...source, status: 'running' }, noise, 42, false), /完成/);
  assert.match(noiseVariantReason(source, { ...noise, enabled: false }, 42, false), /启用/);
});

test('noise API posts only noise and seed to selected entry; backend resolves canonical original', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: 'new', source_job_id: 'original' }), { status: 200 });
  };
  try {
    const signal = new AbortController().signal;
    const result = await api.noiseVariant(
      'selected variant',
      createNoiseVariant(noise, 42),
      signal,
    );
    assert.equal(calls[0].url, '/api/jobs/selected%20variant/noise-variants');
    assert.equal(calls[0].options.signal, signal);
    assert.deepEqual(JSON.parse(calls[0].options.body), { noise, seed: 42 });
    assert.equal(result.source_job_id, 'original');
  } finally {
    globalThis.fetch = previous;
  }
});
