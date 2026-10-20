// Playing rendered audio in the browser, and encoding it as OGG Vorbis (with the bundled libvorbis build, loaded the
// first time it's needed).

import { RATE } from "./render.js";

let ctx = null;
export function audioContext() {
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// Plays samples, looping between loopStart and loopEnd (in samples) if given. Returns a handle with stop() and
// position() (seconds into the samples, following the loop).
export function play(samples, loopStart = null, loopEnd = null, offset = 0) {
  const ac = audioContext();
  const buf = ac.createBuffer(1, samples.length || 1, RATE);
  buf.copyToChannel(samples, 0);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const looping = loopStart !== null && loopEnd > loopStart;
  if (looping) { src.loop = true; src.loopStart = loopStart / RATE; src.loopEnd = loopEnd / RATE; }
  src.connect(ac.destination);
  const start = ac.currentTime + 0.02;
  src.start(start, offset);
  const h = {
    ended: false,
    stop() { if (!h.ended) { h.ended = true; try { src.stop(); } catch { } } },
    position() {
      let t = offset + Math.max(0, ac.currentTime - start);
      if (looping && t >= src.loopEnd) t = src.loopStart + (t - src.loopStart) % (src.loopEnd - src.loopStart);
      return t;
    },
  };
  src.onended = () => { h.ended = true; h.onended?.(); };
  return h;
}

let encoderLib = null;
function loadEncoder() {
  encoderLib ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/WasmMediaEncoder.min.js";
    s.onload = () => resolve(window.WasmMediaEncoder);
    s.onerror = () => { encoderLib = null; reject(new Error("The OGG encoder couldn't be loaded. Are you offline before it was first used?")); };
    document.head.append(s);
  });
  return encoderLib;
}

// OGG Vorbis, mono. `quality` is Vorbis's -1 (smallest) to 10 (best).
export async function ogg(samples, quality = 6) {
  const lib = await loadEncoder();
  const enc = await lib.createEncoder("audio/ogg", "vendor/ogg.wasm");
  enc.configure({ channels: 1, sampleRate: RATE, vbrQuality: quality });
  const parts = [];
  const CHUNK = RATE; // feed a second at a time
  for (let i = 0; i < samples.length; i += CHUNK) parts.push(enc.encode([samples.subarray(i, i + CHUNK)]).slice());
  parts.push(enc.finalize().slice());
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
