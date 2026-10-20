// Turns a song or a sound effect into samples: a sound driver that runs once a frame, the way a game's would, and
// sets each channel of the chip from the notes and the instrument envelopes.

import { CHIPS } from "./chips.js";

export const RATE = 44100;

// Frames each step of a song lasts, on average. Steps alternate between whole frame counts, as a driver does.
export const framesPerStep = (song, chip) => CHIPS[chip].frameHz * 60 / (song.bpm * song.steps);

// An envelope: values played one per frame. `loop` is where it goes back to on reaching the end; `rel` is where it
// holds while the note is held, carrying on from there once the note is let go. -1 means none.
export function seqStart(seq) { return { pos: 0, released: false, seq }; }
function seqValue(st, fallback) { const v = st.seq?.v; return v && v.length ? v[Math.min(st.pos, v.length - 1)] : fallback; }
function seqNext(st) {
  const s = st.seq;
  if (!s || !s.v.length) return;
  const n = s.v.length;
  let p = st.pos + 1;
  if (!st.released && s.rel >= 0 && p > s.rel) p = s.loop >= 0 && s.loop <= s.rel ? s.loop : s.rel;
  else if (p >= n) p = s.loop >= 0 && (!st.released || s.rel < 0 || s.loop > s.rel) ? s.loop : n - 1;
  st.pos = p;
}
function seqRelease(st) {
  st.released = true;
  const s = st.seq;
  if (s && s.rel >= 0) st.pos = Math.min(s.rel + 1, s.v.length - 1);
}

// Volume after the note's own volume scales the instrument's, as trackers do: never 0 unless one of them is.
export const mixVol = (a, b) => (a && b ? Math.max(1, Math.round(a * b / 15)) : 0);

// A playing note on one channel.
class Voice {
  constructor(inst, key, vol) {
    this.key = key; this.vol = vol;
    this.env = ["vol", "arp", "pitch", "duty"].map(k => seqStart(inst?.[k]));
    this.bend = 0;
    this.hasRelease = inst?.vol?.rel >= 0;
    this.done = false;
  }
  release() {
    // Without a release part, letting go of a note silences it.
    if (!this.hasRelease) { this.done = true; return; }
    this.env.forEach(seqRelease);
  }
  // Returns { key, vol, duty } for this frame, then moves the envelopes on.
  frame() {
    if (this.done) return null;
    const [v, a, p, d] = this.env;
    this.bend += seqValue(p, 0);
    const r = { key: this.key + seqValue(a, 0) + this.bend / 8, vol: mixVol(seqValue(v, 15), this.vol), duty: seqValue(d, 2) };
    this.env.forEach(seqNext);
    return r;
  }
}

// Everything that happens in a song, step by step: which notes start and stop on each channel.
function schedule(song) {
  const starts = new Map(), stops = new Map();
  song.channels.forEach((ch, ci) => {
    for (const n of ch.notes) {
      if (n.t >= song.length) continue;
      const k = n.t * 4 + ci;
      starts.set(k, n);
      const sk = Math.min(n.t + n.len, song.length) * 4 + ci;
      if (!stops.has(sk)) stops.set(sk, []);
      stops.get(sk).push(n);
    }
  });
  return { starts, stops };
}

// The frame each step starts on, for steps 0..length. Fractions accumulate, so a step is a whole number of frames.
export function stepFrames(song, chip) {
  const f = framesPerStep(song, chip), out = [];
  for (let s = 0; s <= song.length; s++) out.push(Math.round(s * f));
  return out;
}

// Renders a song. `opts.passes`: how many times through (with the loop, the later passes start at the loop point);
// `opts.fade`: seconds to fade out over at the end; `opts.from`: step to start at. Returns
// { samples, loopStart, loopEnd } in samples (loopStart is null if the song doesn't loop).
export function renderSong(project, song, opts = {}) {
  const chipDef = CHIPS[project.chip], chip = chipDef.make(RATE);
  if (opts.mute) chip.mute = opts.mute.slice();
  const sf = stepFrames(song, project.chip), spf = RATE / chipDef.frameHz;
  const { starts, stops } = schedule(song);
  const insts = new Map(project.instruments.map(i => [i.id, i]));
  const loop = song.loop ?? null;
  const passes = opts.passes ?? 1, from = opts.from ?? 0;

  // The list of steps to play, as [step] in order.
  const steps = [];
  for (let s = from; s < song.length; s++) steps.push(s);
  for (let p = 1; p < passes && loop !== null; p++) for (let s = loop; s < song.length; s++) steps.push(s);

  const voices = [null, null, null, null];
  const frames = [];
  for (const s of steps) {
    for (let ci = 0; ci < 4; ci++) {
      const k = s * 4 + ci;
      // A note's end lets go of it only if a later note hasn't already taken the channel.
      if (voices[ci] && stops.get(k)?.includes(voices[ci].note)) voices[ci].release();
      if (starts.has(k)) {
        const n = starts.get(k);
        voices[ci] = new Voice(insts.get(n.inst), n.key, n.vol ?? 15);
        voices[ci].note = n;
      }
    }
    for (let f = sf[s]; f < sf[s + 1]; f++) frames.push(voices.map(v => v && v.frame()));
  }
  const tail = Math.round((opts.fade ?? 0) * chipDef.frameHz);
  for (let f = 0; f < tail; f++) frames.push(voices.map(v => v && v.frame()));

  const total = Math.round(frames.length * spf), out = new Float32Array(total);
  let pos = 0;
  frames.forEach((fr, i) => {
    fr.forEach((r, ci) => (r ? chipDef.set(chip, ci, r.key, r.vol, r.duty) : chipDef.set(chip, ci, null, 0, 2)));
    const end = Math.round((i + 1) * spf);
    chip.render(out, pos, end - pos);
    pos = end;
  });
  if (opts.fade) {
    const n = Math.min(total, Math.round(opts.fade * RATE));
    for (let i = 0; i < n; i++) out[total - n + i] *= 1 - i / n;
  }
  let loopStart = null, loopEnd = null;
  if (loop !== null && loop >= from) {
    loopStart = Math.round((sf[loop] - sf[from]) * spf);
    loopEnd = Math.round((sf[song.length] - sf[from]) * spf);
  }
  return { samples: out, loopStart, loopEnd };
}

// A sound effect is drawn frame by frame: volume, pitch (a note, or a noise key on the noise channel) and duty.
export function renderSfx(project, sfx) {
  const chipDef = CHIPS[project.chip], chip = chipDef.make(RATE);
  const spf = RATE / chipDef.frameHz, total = Math.round(sfx.frames * spf);
  const out = new Float32Array(total + Math.round(spf * 2));
  let pos = 0;
  for (let i = 0; i < sfx.frames; i++) {
    const vol = sfx.vol[i] ?? 0;
    chipDef.set(chip, sfx.channel, vol ? sfx.pitch[i] : null, vol, sfx.duty[i] ?? 2);
    const end = Math.round((i + 1) * spf);
    chip.render(out, pos, end - pos);
    pos = end;
  }
  chipDef.set(chip, sfx.channel, null, 0, 2);
  chip.render(out, pos, out.length - pos); // let the filters settle
  return { samples: out, loopStart: null, loopEnd: null };
}

// One note on its own, to hear an instrument: held for `hold` seconds, then let go.
export function renderNote(project, inst, ci, key, hold = 0.4, vol = 15) {
  const chipDef = CHIPS[project.chip], chip = chipDef.make(RATE);
  const spf = RATE / chipDef.frameHz, v = new Voice(inst, key, vol);
  const held = Math.round(hold * chipDef.frameHz), max = held + Math.round(2 * chipDef.frameHz);
  const out = new Float32Array(Math.round(max * spf));
  let pos = 0, i = 0;
  for (; i < max; i++) {
    if (i === held) v.release();
    const r = v.frame();
    if (!r && i > held) break;
    r ? chipDef.set(chip, ci, r.key, r.vol, r.duty) : chipDef.set(chip, ci, null, 0, 2);
    const end = Math.round((i + 1) * spf);
    chip.render(out, pos, end - pos);
    pos = end;
  }
  return out.subarray(0, pos);
}
