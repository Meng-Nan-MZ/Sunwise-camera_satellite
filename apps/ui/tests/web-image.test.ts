import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import {
  applyNoise,
  encodeGrayPng,
  resizeLanczos,
  processCapture,
} from '../src/web/imagePipeline.ts';

function crc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
test('PNG independently inflates to exact grayscale scanlines and every chunk CRC matches', async () => {
  const png = await encodeGrayPng(Uint8Array.of(0, 127, 255, 3, 5, 8), 3, 2);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const compressed: Uint8Array[] = [];
  const names: string[] = [];
  for (let offset = 8; offset < png.length; ) {
    const size = view.getUint32(offset);
    const name = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    names.push(name);
    assert.equal(
      view.getUint32(offset + size + 8),
      crc(png.subarray(offset + 4, offset + size + 8)),
    );
    if (name === 'IHDR') {
      assert.equal(view.getUint32(offset + 8), 3);
      assert.equal(view.getUint32(offset + 12), 2);
      assert.deepEqual([...png.subarray(offset + 16, offset + 21)], [8, 0, 0, 0, 0]);
    }
    if (name === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  assert.deepEqual(names, ['IHDR', 'IDAT', 'IEND']);
  assert.deepEqual([...inflateSync(Buffer.concat(compressed))], [0, 0, 127, 255, 0, 3, 5, 8]);
});
test('noise repeatability, seed separation, bounds and source immutability', () => {
  const pixels = new Uint8Array(10000).fill(128);
  const noise = { enabled: true, gaussian_sigma: 0.012, poisson_peak: 96 };
  const first = applyNoise(pixels, noise, 42);
  assert.deepEqual(first, applyNoise(pixels, noise, 42));
  assert.notDeepEqual(first, applyNoise(pixels, noise, 43));
  assert.ok(first.some((v) => v !== 128));
  assert.ok(pixels.every((v) => v === 128));
  const mean = first.reduce((a, b) => a + b, 0) / first.length;
  const variance = first.reduce((a, b) => a + (b - mean) ** 2, 0) / first.length;
  assert.ok(Math.abs(mean - 128) < 2);
  assert.ok(variance > 250 && variance < 450);
  assert.deepEqual(applyNoise(pixels, { ...noise, enabled: false }, 42), pixels);
});
test('Poisson handles zero and large intensities without unbounded loops', () => {
  assert.ok(
    applyNoise(
      new Uint8Array(100),
      { enabled: true, gaussian_sigma: 0, poisson_peak: 96 },
      0,
    ).every((v) => v === 0),
  );
  const result = applyNoise(
    new Uint8Array(10000).fill(128),
    { enabled: true, gaussian_sigma: 0, poisson_peak: 1e7 },
    1,
  );
  assert.ok(result.every((v) => v >= 127 && v <= 129));
});
test('Lanczos preserves constant fields and exact-size images; reduces a checkerboard', () => {
  assert.ok(resizeLanczos(new Uint8Array(64).fill(71), 8, 8, 4, 4).every((v) => v === 71));
  assert.deepEqual(
    resizeLanczos(Uint8Array.of(2, 9, 20, 30), 2, 2, 2, 2),
    Uint8Array.of(2, 9, 20, 30),
  );
  const checker = Uint8Array.from(
    { length: 64 * 64 },
    (_, i) => (((i % 64) + Math.floor(i / 64)) % 2) * 255,
  );
  const reduced = resizeLanczos(checker, 64, 64, 32, 32);
  assert.ok([...reduced.subarray(33, 63)].every((v) => v >= 127 && v <= 128));
});
test('image pipeline rejects invalid dimensions, pixels, noise, seeds and malformed capture', async () => {
  for (const [w, h] of [
    [0, 2],
    [2.5, 1],
    [1, Infinity],
    [1000000, 1000000],
  ])
    await assert.rejects(encodeGrayPng(Uint8Array.of(1), w, h));
  await assert.rejects(encodeGrayPng(Uint8Array.of(1), 2, 2));
  const valid = { enabled: true, gaussian_sigma: 0.1, poisson_peak: 96 };
  for (const seed of [NaN, -1, 1.2, 4294967296])
    assert.throws(() => applyNoise(Uint8Array.of(1), valid, seed));
  for (const noise of [
    { ...valid, gaussian_sigma: NaN },
    { ...valid, gaussian_sigma: -1 },
    { ...valid, poisson_peak: 0 },
    { ...valid, poisson_peak: Infinity },
  ])
    assert.throws(() => applyNoise(Uint8Array.of(1), noise, 0));
  await assert.rejects(processCapture({ png_base64: 'corrupt!', metadata: {} }, valid, 0));
});
test('capture rejects CRC corruption and truncated PNG before platform image decoding', async () => {
  const png = await encodeGrayPng(new Uint8Array(2048 * 2048), 2048, 2048);
  const corrupt = png.slice();
  corrupt[29] ^= 1;
  const noise = { enabled: false, gaussian_sigma: 0, poisson_peak: 96 };
  await assert.rejects(
    processCapture({ png_base64: Buffer.from(corrupt).toString('base64'), metadata: {} }, noise, 0),
    /CRC/,
  );
  await assert.rejects(
    processCapture(
      { png_base64: Buffer.from(png.subarray(0, png.length - 3)).toString('base64'), metadata: {} },
      noise,
      0,
    ),
    /truncated|incomplete/i,
  );
});
