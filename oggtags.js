// Adds comments to an Ogg Vorbis file, such as LOOPSTART and LOOPLENGTH (in samples), which many game engines read to
// loop music seamlessly. The comment header is rebuilt, and the pages after it renumbered with fresh checksums.

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});
const oggCrc = b => { let c = 0; for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ b[i]) & 255]) >>> 0; return c; };

function readPages(bytes) {
  const pages = [];
  for (let p = 0; p < bytes.length;) {
    if (bytes[p] !== 0x4f || bytes[p + 1] !== 0x67 || bytes[p + 2] !== 0x67 || bytes[p + 3] !== 0x53) throw new Error("Not an Ogg file.");
    const nseg = bytes[p + 26], lacing = bytes.subarray(p + 27, p + 27 + nseg);
    const size = lacing.reduce((a, b) => a + b, 0), head = 27 + nseg;
    pages.push({ header: bytes.slice(p, p + 27), lacing: [...lacing], body: bytes.subarray(p + head, p + head + size) });
    p += head + size;
  }
  return pages;
}

function writePage(header, lacing, body, seq) {
  const out = new Uint8Array(27 + lacing.length + body.length), dv = new DataView(out.buffer);
  out.set(header.subarray(0, 27));
  out[26] = lacing.length;
  out.set(lacing, 27);
  out.set(body, 27 + lacing.length);
  dv.setUint32(18, seq, true);
  dv.setUint32(22, 0, true);
  dv.setUint32(22, oggCrc(out), true);
  return out;
}

export function addComments(bytes, tags) {
  const pages = readPages(bytes);
  // Collect the packets of the header pages after the first (the comment and setup headers), as byte arrays.
  const packets = [];
  let cur = [], i = 1;
  for (; i < pages.length && packets.length < 2; i++) {
    let o = 0;
    for (const l of pages[i].lacing) {
      cur.push(pages[i].body.subarray(o, o + l)); o += l;
      if (l < 255) { packets.push(concat(cur)); cur = []; if (packets.length === 2) break; }
    }
  }
  const after = i; // the first audio page
  if (packets.length < 2 || packets[0][0] !== 3) throw new Error("Unexpected Vorbis headers.");

  // Rebuild the comment packet: vendor string, then the old comments plus ours.
  const c = packets[0], dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
  const vlen = dv.getUint32(7, true);
  let p = 11 + vlen;
  const count = dv.getUint32(p, true); p += 4;
  const comments = [];
  for (let k = 0; k < count; k++) { const n = dv.getUint32(p, true); comments.push(c.subarray(p + 4, p + 4 + n)); p += 4 + n; }
  const enc = new TextEncoder();
  for (const [k, v] of Object.entries(tags)) comments.push(enc.encode(`${k}=${v}`));
  const parts = [c.subarray(0, 11 + vlen), u32(comments.length)];
  for (const cm of comments) parts.push(u32(cm.length), cm);
  parts.push(new Uint8Array([1])); // framing bit
  const comment = concat(parts);

  // Both packets on one page (or more, if large), as encoders lay them out.
  const out = [writePage(pages[0].header, pages[0].lacing, pages[0].body, 0)];
  const header = pages[1].header.slice();
  header[5] = 0; // not a continuation, not BOS/EOS
  let seq = 1, lacing = [], body = [];
  const flush = cont => {
    const h = header.slice(); h[5] = cont ? 1 : 0;
    out.push(writePage(h, lacing, concat(body), seq++));
    lacing = []; body = [];
  };
  let continued = false;
  for (const pk of [comment, packets[1]]) {
    let o = 0;
    for (;;) {
      if (lacing.length === 255) { flush(continued); continued = true; }
      const l = Math.min(255, pk.length - o);
      lacing.push(l); body.push(pk.subarray(o, o + l)); o += l;
      if (l < 255) break;
    }
    continued = false;
  }
  flush(false);
  for (let k = after; k < pages.length; k++) out.push(writePage(pages[k].header, pages[k].lacing, pages[k].body, seq++));
  return concat(out);
}

function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function concat(list) {
  const out = new Uint8Array(list.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}
