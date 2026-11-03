import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip } from '../src/web/zip.ts';

function crc(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
test('stored ZIP independently extracts UTF8 paths and verifies central directory, offsets and CRCs', () => {
  const entries = [
    { name: 'images_clean/0001.png', data: Uint8Array.of(137, 80, 78, 71) },
    { name: 'poses/卫星.json', data: new TextEncoder().encode('{"W":1}') },
    { name: 'labels/empty.txt', data: new Uint8Array() },
  ];
  const zip = createZip(entries);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), entries.length);
  const centralStart = view.getUint32(end + 16, true);
  assert.equal(centralStart + view.getUint32(end + 12, true), end);
  let central = centralStart;
  for (const entry of entries) {
    assert.equal(view.getUint32(central, true), 0x02014b50);
    assert.equal(view.getUint16(central + 8, true), 0x0800);
    assert.equal(view.getUint16(central + 10, true), 0);
    const size = view.getUint32(central + 24, true);
    const nameSize = view.getUint16(central + 28, true);
    assert.equal(
      new TextDecoder('utf-8', { fatal: true }).decode(
        zip.subarray(central + 46, central + 46 + nameSize),
      ),
      entry.name,
    );
    const local = view.getUint32(central + 42, true);
    assert.equal(view.getUint32(local, true), 0x04034b50);
    assert.equal(view.getUint16(local + 6, true), 0x0800);
    assert.equal(view.getUint32(local + 18, true), size);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + size);
    assert.deepEqual(data, entry.data);
    assert.equal(view.getUint32(local + 14, true), crc(data));
    assert.equal(view.getUint32(central + 16, true), crc(data));
    central += 46 + nameSize;
  }
  assert.equal(central, end);
});
test('ZIP rejects unsafe portable paths, Unicode aliases, duplicate names and excess entries', () => {
  for (const name of [
    '',
    '/a',
    '../a',
    'a/../b',
    'a//b',
    'a\\b',
    'C:/a',
    'a\0b',
    'a/',
    './x',
    'a\nx',
    'aux.txt',
    'x/CON',
    'x./y',
    'a?b',
    'bad\ud800name',
  ])
    assert.throws(() => createZip([{ name, data: new Uint8Array() }]), name);
  for (const names of [
    ['a', 'a'],
    ['A', 'a'],
    ['é', 'e\u0301'],
  ])
    assert.throws(() => createZip(names.map((name) => ({ name, data: new Uint8Array() }))));
  assert.throws(() => createZip([{ name: 'a'.repeat(65536), data: new Uint8Array() }]));
  assert.throws(() =>
    createZip(
      Array.from({ length: 65536 }, (_, i) => ({ name: String(i), data: new Uint8Array() })),
    ),
  );
  assert.equal(createZip([]).length, 22);
});
