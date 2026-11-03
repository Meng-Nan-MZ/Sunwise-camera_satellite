import type { CaptureResult } from '../renderBridge.ts';
import type { SceneSettings } from '../types.ts';
import { crc32 } from './zip.ts';

export const IMAGE_PIPELINE_VERSION = 'browser-lanczos3-gray8-v1';
export const NOISE_ALGORITHM_VERSION = 'browser-mulberry32-poisson-ptrs-boxmuller-v1';
type Noise = SceneSettings['noise'];
const MAX_PIXELS = 4096 * 4096;

function validateImage(pixels: Uint8Array, width: number, height: number) {
  if (
    !(pixels instanceof Uint8Array) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_PIXELS ||
    pixels.length !== width * height
  )
    throw new Error('Invalid grayscale dimensions or pixel buffer (maximum 4096² pixels).');
}
function validateNoise(noise: Noise, seed: number) {
  if (
    !noise ||
    typeof noise.enabled !== 'boolean' ||
    !Number.isFinite(noise.gaussian_sigma) ||
    noise.gaussian_sigma < 0 ||
    noise.gaussian_sigma > 1 ||
    !Number.isFinite(noise.poisson_peak) ||
    noise.poisson_peak < 1 ||
    noise.poisson_peak > 1e7 ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff
  )
    throw new Error('Invalid noise parameters or uint32 seed.');
}

// Exact discrete Poisson sampling: inversion for small lambda, Hörmann PTRS for large lambda.
const logFactorials = new Float64Array(256);
for (let i = 2; i < logFactorials.length; i++)
  logFactorials[i] = logFactorials[i - 1] + Math.log(i);
function logFactorial(k: number) {
  if (k < logFactorials.length) return logFactorials[k];
  const inverse = 1 / k;
  return (k + 0.5) * Math.log(k) - k + 0.9189385332046727 + inverse / 12 - inverse ** 3 / 360;
}

/** Browser algorithm is reproducible for a seed; it does not reproduce NumPy's RNG stream. */
export function applyNoise(pixels: Uint8Array, noise: Noise, seed: number): Uint8Array {
  validateNoise(noise, seed);
  if (!(pixels instanceof Uint8Array) || pixels.length > MAX_PIXELS)
    throw new Error('Invalid noise pixel buffer.');
  const output = pixels.slice();
  if (!noise.enabled) return output;
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
  let spare: number | undefined;
  const gaussian = () => {
    if (spare !== undefined) {
      const result = spare;
      spare = undefined;
      return result;
    }
    const radius = Math.sqrt(-2 * Math.log(random())),
      angle = 2 * Math.PI * random();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
  // Only 256 possible intensities: cache coefficients, not a per-pixel setup cost.
  const parameters = Array.from({ length: 256 }, (_, value) => {
    const lambda = (value * noise.poisson_peak) / 255;
    const b = 0.931 + 2.53 * Math.sqrt(lambda),
      a = -0.059 + 0.02483 * b;
    return {
      lambda,
      limit: Math.exp(-lambda),
      log: Math.log(lambda),
      b,
      a,
      inverseAlpha: 1.1239 + 1.1328 / (b - 3.4),
      vr: 0.9277 - 3.6224 / (b - 2),
    };
  });
  for (let i = 0; i < pixels.length; i++) {
    const p = parameters[pixels[i]];
    let count = 0;
    if (p.lambda > 0 && p.lambda < 10) {
      let product = 1;
      do {
        count++;
        product *= random();
      } while (product > p.limit);
      count--;
    } else if (p.lambda >= 10) {
      for (;;) {
        const u = random() - 0.5,
          v = random(),
          us = 0.5 - Math.abs(u);
        const k = Math.floor(((2 * p.a) / us + p.b) * u + p.lambda + 0.43);
        if (us >= 0.07 && v <= p.vr) {
          count = k;
          break;
        }
        if (k < 0 || (us < 0.013 && v > us)) continue;
        if (
          Math.log((v * p.inverseAlpha) / (p.a / (us * us) + p.b)) <=
          -p.lambda + k * p.log - logFactorial(k)
        ) {
          count = k;
          break;
        }
      }
    }
    const value =
      count / noise.poisson_peak + (noise.gaussian_sigma ? gaussian() * noise.gaussian_sigma : 0);
    output[i] = Math.round(Math.min(1, Math.max(0, value)) * 255);
  }
  return output;
}

function lanczos(x: number) {
  x = Math.abs(x);
  if (x < 1e-12) return 1;
  if (x >= 3) return 0;
  return (3 * Math.sin(Math.PI * x) * Math.sin((Math.PI * x) / 3)) / (Math.PI * Math.PI * x * x);
}
function contributions(input: number, output: number) {
  const scale = Math.max(1, input / output),
    support = 3 * scale;
  return Array.from({ length: output }, (_, i) => {
    const center = ((i + 0.5) * input) / output - 0.5;
    const indices: number[] = [],
      weights: number[] = [];
    let sum = 0;
    for (
      let source = Math.ceil(center - support);
      source <= Math.floor(center + support);
      source++
    ) {
      if (source < 0 || source >= input) continue;
      const weight = lanczos((source - center) / scale);
      indices.push(source);
      weights.push(weight);
      sum += weight;
    }
    return { indices, weights: weights.map((weight) => weight / sum) };
  });
}
/** Separable antialiased Lanczos3; intermediate values retain precision until final clipping. */
export function resizeLanczos(
  pixels: Uint8Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): Uint8Array {
  validateImage(pixels, width, height);
  if (
    !Number.isSafeInteger(outWidth) ||
    !Number.isSafeInteger(outHeight) ||
    outWidth < 1 ||
    outHeight < 1 ||
    outWidth * outHeight > MAX_PIXELS ||
    outWidth * height > MAX_PIXELS
  )
    throw new Error('Invalid resize dimensions.');
  if (width === outWidth && height === outHeight) return pixels.slice();
  const horizontal = contributions(width, outWidth),
    vertical = contributions(height, outHeight);
  const intermediate = new Float32Array(outWidth * height),
    output = new Uint8Array(outWidth * outHeight);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < outWidth; x++) {
      const { indices, weights } = horizontal[x];
      let sum = 0;
      for (let i = 0; i < indices.length; i++) sum += pixels[y * width + indices[i]] * weights[i];
      intermediate[y * outWidth + x] = sum;
    }
  for (let y = 0; y < outHeight; y++)
    for (let x = 0; x < outWidth; x++) {
      const { indices, weights } = vertical[y];
      let sum = 0;
      for (let i = 0; i < indices.length; i++)
        sum += intermediate[indices[i] * outWidth + x] * weights[i];
      output[y * outWidth + x] = Math.max(0, Math.min(255, Math.round(sum)));
    }
  return output;
}

function chunk(name: string, bytes: Uint8Array) {
  const output = new Uint8Array(bytes.length + 12),
    view = new DataView(output.buffer);
  view.setUint32(0, bytes.length);
  output.set(new TextEncoder().encode(name), 4);
  output.set(bytes, 8);
  view.setUint32(bytes.length + 8, crc32(output.subarray(4, bytes.length + 8)));
  return output;
}
export async function encodeGrayPng(
  pixels: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  validateImage(pixels, width, height);
  if (typeof CompressionStream === 'undefined')
    throw new Error('This browser lacks PNG deflate support.');
  const scanlines = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++)
    scanlines.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const compressed = new Uint8Array(
    await new Response(
      new Blob([scanlines.buffer]).stream().pipeThrough(new CompressionStream('deflate')),
    ).arrayBuffer(),
  );
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // color type 0, 8-bit gray
  const chunks = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array()),
  ];
  const output = new Uint8Array(chunks.reduce((sum, bytes) => sum + bytes.length, 0));
  let offset = 0;
  for (const bytes of chunks) {
    output.set(bytes, offset);
    offset += bytes.length;
  }
  return output;
}

export async function processCapture(
  result: CaptureResult,
  noise: Noise,
  seed: number,
): Promise<{ clean: Uint8Array; noisy?: Uint8Array; pixels: Uint8Array }> {
  validateNoise(noise, seed);
  const base64 = result?.png_base64;
  if (
    typeof base64 !== 'string' ||
    base64.length > 48 * 1024 * 1024 ||
    base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  )
    throw new Error('Invalid capture PNG base64.');
  const raw = atob(base64),
    bytes = Uint8Array.from(raw, (value) => value.charCodeAt(0));
  if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
    throw new Error('Invalid capture PNG signature.');
  const header = new DataView(bytes.buffer);
  if (
    header.getUint32(8) !== 13 ||
    header.getUint32(12) !== 0x49484452 ||
    header.getUint32(16) !== 2048 ||
    header.getUint32(20) !== 2048
  )
    throw new Error('Formal capture must be a 2048×2048 PNG.');
  let offset = 8,
    hasData = false,
    hasEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('Capture PNG is truncated.');
    const length = header.getUint32(offset),
      type = header.getUint32(offset + 4);
    const end = offset + length + 12;
    if (end > bytes.length) throw new Error('Capture PNG chunk is truncated.');
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== header.getUint32(end - 4))
      throw new Error('Capture PNG chunk CRC mismatch.');
    if (type === 0x49444154 && length > 0) hasData = true;
    if (type === 0x49454e44) {
      if (length !== 0 || end !== bytes.length) throw new Error('Invalid capture PNG ending.');
      hasEnd = true;
    }
    offset = end;
  }
  if (!hasData || !hasEnd) throw new Error('Capture PNG is incomplete.');
  if (typeof createImageBitmap === 'undefined')
    throw new Error('This browser lacks image decoding support.');
  const bitmap = await createImageBitmap(new Blob([bytes.buffer], { type: 'image/png' }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  let pixels: Uint8Array;
  try {
    if (bitmap.width !== 2048 || bitmap.height !== 2048)
      throw new Error('Decoded capture dimensions differ from PNG header.');
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(2048, 2048)
        : document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 2048;
    const context = canvas.getContext('2d') as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!context) throw new Error('Cannot create grayscale processing canvas.');
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, 2048, 2048).data;
    const gray = new Uint8Array(2048 * 2048);
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4;
      gray[i] = Math.round(
        ((0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) * rgba[p + 3]) / 255,
      );
    }
    pixels = resizeLanczos(gray, 2048, 2048, 1024, 1024);
    canvas.width = 1;
    canvas.height = 1;
  } finally {
    bitmap.close();
  }
  const clean = await encodeGrayPng(pixels, 1024, 1024);
  const noisy = noise.enabled
    ? await encodeGrayPng(applyNoise(pixels, noise, seed), 1024, 1024)
    : undefined;
  return { clean, noisy, pixels };
}
