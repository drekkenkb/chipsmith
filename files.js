// ZIP and WAV writing, without libraries.

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(data, crc = 0) {
  crc = ~crc;
  for (let i = 0; i < data.length; i++) crc = CRC[(crc ^ data[i]) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}

// Stored (uncompressed) entries: audio doesn't shrink much anyway. `files` is [{ name, data: Uint8Array }].
export function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), n = f.data.length;
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(12, 0x5821, true); // a fixed date, 2024-01-01
    lv.setUint32(14, crc, true); lv.setUint32(18, n, true); lv.setUint32(22, n, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const c = new Uint8Array(46 + name.length), cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(14, 0x5821, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, n, true); cv.setUint32(24, n, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    c.set(name, 46);
    parts.push(local, f.data);
    central.push(c);
    offset += local.length + n;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

// 16-bit mono PCM. With a loop (in samples), a "smpl" chunk marks it, which game engines and samplers read.
export function wav(samples, rate, loopStart = null, loopEnd = null) {
  const n = samples.length, loop = loopStart !== null && loopEnd > loopStart;
  const smpl = loop ? 8 + 36 + 24 : 0;
  const b = new ArrayBuffer(44 + n * 2 + smpl), dv = new DataView(b);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); dv.setUint32(4, 36 + n * 2 + smpl, true); str(8, "WAVE");
  str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  if (loop) {
    const o = 44 + n * 2;
    str(o, "smpl"); dv.setUint32(o + 4, 36 + 24, true);
    dv.setUint32(o + 16, Math.round(1e9 / rate), true); // sample period in ns
    dv.setUint32(o + 20, 60, true);                      // unity note: middle C
    dv.setUint32(o + 36, 1, true);                       // one loop
    dv.setUint32(o + 52, loopStart, true);               // (loop id 0, type 0 = forward)
    dv.setUint32(o + 56, loopEnd - 1, true);             // the last sample played, inclusive
  }
  return new Uint8Array(b);
}
