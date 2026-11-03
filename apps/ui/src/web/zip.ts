/** CRC-32/ISO-HDLC, shared by PNG chunks and stored ZIP entries. */
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  return c >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ crcTable[(c ^ bytes[i]) & 255];
  return (c ^ 0xffffffff) >>> 0;
}

/** Classic stored ZIP, UTF-8 names, fixed DOS epoch, no ZIP64. 256 MiB output cap. */
export function createZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  if (!Array.isArray(entries) || entries.length > 65535)
    throw new Error('ZIP entry count exceeds classic ZIP limit.');
  const names = new Set<string>();
  let localSize = 0,
    centralSize = 0;
  const files = entries.map((entry) => {
    if (!entry || typeof entry.name !== 'string' || !(entry.data instanceof Uint8Array))
      throw new Error('Invalid ZIP entry.');
    const name = entry.name.normalize('NFC');
    const parts = name.split('/');
    if (
      !name ||
      /[\\\x00-\x1f\x7f<>:"|?*]/.test(name) ||
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(name) ||
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
    )
      throw new Error('Unsafe ZIP path.');
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error('Duplicate ZIP path.');
    names.add(key);
    const bytes = new TextEncoder().encode(name);
    if (bytes.length > 65535) throw new Error('ZIP filename too long.');
    localSize += 30 + bytes.length + entry.data.length;
    centralSize += 46 + bytes.length;
    if (localSize + centralSize + 22 > 256 * 1024 * 1024)
      throw new Error('ZIP exceeds 256 MiB output limit.');
    return { bytes, data: entry.data };
  });
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let local = 0,
    central = localSize;
  for (const file of files) {
    const checksum = crc32(file.data),
      size = file.data.length,
      nameSize = file.bytes.length;
    view.setUint32(local, 0x04034b50, true);
    view.setUint16(local + 4, 20, true);
    view.setUint16(local + 6, 0x0800, true);
    view.setUint16(local + 12, 0x0021, true); // 1980-01-01
    view.setUint32(local + 14, checksum, true);
    view.setUint32(local + 18, size, true);
    view.setUint32(local + 22, size, true);
    view.setUint16(local + 26, nameSize, true);
    output.set(file.bytes, local + 30);
    output.set(file.data, local + 30 + nameSize);
    view.setUint32(central, 0x02014b50, true);
    view.setUint16(central + 4, 20, true);
    view.setUint16(central + 6, 20, true);
    view.setUint16(central + 8, 0x0800, true);
    view.setUint16(central + 14, 0x0021, true);
    view.setUint32(central + 16, checksum, true);
    view.setUint32(central + 20, size, true);
    view.setUint32(central + 24, size, true);
    view.setUint16(central + 28, nameSize, true);
    view.setUint32(central + 42, local, true);
    output.set(file.bytes, central + 46);
    local += 30 + nameSize + size;
    central += 46 + nameSize;
  }
  view.setUint32(central, 0x06054b50, true);
  view.setUint16(central + 8, files.length, true);
  view.setUint16(central + 10, files.length, true);
  view.setUint32(central + 12, centralSize, true);
  view.setUint32(central + 16, localSize, true);
  return output;
}
