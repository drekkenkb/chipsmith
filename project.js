// A project: the chip it's for, its instruments, songs and sound effects. Saved as JSON.
//
//   { format: "chipsmith", version: 1, name, chip: "nes" | "sms",
//     instruments: [{ id, name, vol, arp, pitch, duty }]     each a Seq: { v: [numbers], loop, rel } (-1 = none)
//     songs: [{ id, name, bpm, steps (per beat), beats (per bar), length (steps), loop (step or null),
//               channels: [{ notes: [{ t, len, key, inst, vol }] } x4] }]
//     sfx:   [{ id, name, channel, frames, vol: [], pitch: [], duty: [] }] }
//
// Song keys are MIDI note numbers, except on the noise channel, where they index the chip's noise keys (chips.js).
// Instrument pitch envelopes add up frame by frame, in eighths of a semitone.

import { CHIPS } from "./chips.js";

export const seq = (v = [], loop = -1, rel = -1) => ({ v, loop, rel });
let counter = 0;
export const uid = () => Date.now().toString(36) + (counter++).toString(36) + Math.random().toString(36).slice(2, 6);

export function defaultInstruments() {
  const vib = [...Array(10).fill(0), 1, 1, -1, -1, -1, -1, 1, 1];
  return [
    { id: "lead", name: "Lead", vol: seq([15, 14, 13, 12, 12, 11, 11, 10, 8, 6, 4, 2, 0], -1, 7), arp: seq(), pitch: seq(vib, 10), duty: seq([2]) },
    { id: "pluck", name: "Pluck", vol: seq([15, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1, 0]), arp: seq(), pitch: seq(), duty: seq([1]) },
    { id: "bass", name: "Bass", vol: seq([15]), arp: seq(), pitch: seq(), duty: seq([2]) },
    { id: "major", name: "Major arp", vol: seq([12, 11, 10, 10, 9, 0], -1, 4), arp: seq([0, 0, 4, 4, 7, 7], 0), pitch: seq(), duty: seq([0]) },
    { id: "minor", name: "Minor arp", vol: seq([12, 11, 10, 10, 9, 0], -1, 4), arp: seq([0, 0, 3, 3, 7, 7], 0), pitch: seq(), duty: seq([0]) },
    { id: "kick", name: "Kick", vol: seq([15, 13, 10, 7, 4, 2, 0]), arp: seq([0, -1, -2, -3, -4, -5]), pitch: seq(), duty: seq() },
    { id: "snare", name: "Snare", vol: seq([15, 12, 10, 8, 6, 4, 3, 2, 1, 0]), arp: seq(), pitch: seq(), duty: seq() },
    { id: "hat", name: "Hat", vol: seq([9, 5, 2, 0]), arp: seq(), pitch: seq(), duty: seq() },
  ];
}

// Noise keys for the demo's drums, per chip.
const DRUMS = { nes: { kick: 6, snare: 11, hat: 14 }, sms: { kick: 4, snare: 5, hat: 6 } };

// A short original tune in C, so there's something to hear and change straight away.
export function demoSong(chip) {
  const s = { id: uid(), name: "Demo tune", bpm: 132, steps: 4, beats: 4, length: 128, loop: 0, channels: [0, 1, 2, 3].map(() => ({ notes: [] })) };
  const add = (ci, bar, list, inst, vol = 15) => {
    for (const [t, len, key] of list) s.channels[ci].notes.push({ t: bar * 16 + t, len, key, inst, vol });
  };
  const melody = [
    [[0, 4, 76], [4, 2, 79], [6, 2, 76], [8, 4, 72], [12, 2, 74], [14, 2, 76]],
    [[0, 4, 69], [4, 2, 72], [6, 2, 76], [8, 6, 81], [14, 2, 79]],
    [[0, 4, 77], [4, 2, 81], [6, 2, 77], [8, 4, 72], [12, 2, 74], [14, 2, 77]],
    [[0, 6, 79], [6, 2, 77], [8, 2, 76], [10, 2, 74], [12, 4, 71]],
    [[0, 4, 76], [4, 2, 79], [6, 2, 76], [8, 4, 72], [12, 2, 74], [14, 2, 76]],
    [[0, 4, 69], [4, 2, 72], [6, 2, 76], [8, 4, 81], [12, 2, 83], [14, 2, 84]],
    [[0, 4, 86], [4, 2, 84], [6, 2, 81], [8, 4, 77], [12, 2, 81], [14, 2, 79]],
    [[0, 4, 79], [4, 2, 74], [6, 2, 71], [8, 8, 72]],
  ];
  const chords = [[64, 67], [64, 69], [65, 69], [62, 67]];
  const roots = chip === "sms" ? [48, 57, 53, 55] : [48, 45, 41, 43];
  const d = DRUMS[chip];
  for (let bar = 0; bar < 8; bar++) {
    add(0, bar, melody[bar], "lead");
    const [a, b] = chords[bar % 4];
    add(1, bar, [0, 2, 4, 6, 8, 10, 12, 14].map((t, i) => [t, 2, i % 2 ? b : a]), "pluck", 9);
    const r = roots[bar % 4];
    add(2, bar, [[0, 3, r], [4, 2, r + 12], [6, 2, r], [8, 3, r], [12, 2, r + 12], [14, 2, r + 7]], "bass");
    add(3, bar, [[0, 2, d.kick], [8, 2, d.kick]], "kick");
    add(3, bar, [[4, 2, d.snare], [12, 2, d.snare]], "snare");
    add(3, bar, [[2, 2, d.hat], [6, 2, d.hat], [10, 2, d.hat], [14, 2, d.hat]], "hat");
  }
  for (const ch of s.channels) ch.notes.sort((x, y) => x.t - y.t);
  return s;
}

export function emptySong(name) {
  return { id: uid(), name, bpm: 120, steps: 4, beats: 4, length: 64, loop: 0, channels: [0, 1, 2, 3].map(() => ({ notes: [] })) };
}

export function newProject(chip) {
  const p = { format: "chipsmith", version: 1, name: "My sounds", chip, instruments: defaultInstruments(), songs: [demoSong(chip)], sfx: [] };
  for (const kind of ["coin", "jump", "hit"]) p.sfx.push(makeSfx(p, kind));
  return p;
}

// ---- sound effects

const rnd = (a, b) => a + Math.random() * (b - a);
const irnd = (a, b) => Math.floor(rnd(a, b + 1));
export const SFX_KINDS = [
  ["coin", "Coin"], ["jump", "Jump"], ["laser", "Laser"], ["hit", "Hit"], ["explosion", "Explosion"],
  ["powerup", "Power-up"], ["blip", "Blip"], ["random", "Random"],
];

// Builds a sound effect of a kind, with a little randomness so each one differs.
export function makeSfx(project, kind) {
  const chip = CHIPS[project.chip], noiseHi = chip.channels[3].hi;
  if (kind === "random") kind = SFX_KINDS[irnd(0, SFX_KINDS.length - 2)][0];
  const name = SFX_KINDS.find(k => k[0] === kind)[1];
  const fx = { id: uid(), name, channel: 0, frames: 0, vol: [], pitch: [], duty: [] };
  const push = (vol, pitch, duty) => { fx.vol.push(Math.max(0, Math.min(15, Math.round(vol)))); fx.pitch.push(pitch); fx.duty.push(duty); };
  const q = v => Math.round(v * 4) / 4; // pitches to a quarter of a semitone
  const noise = f => Math.max(0, Math.min(noiseHi, Math.round(f * noiseHi)));
  switch (kind) {
    case "coin": {
      const base = irnd(81, 88), duty = irnd(0, 2), a = irnd(3, 6), b = irnd(14, 24);
      for (let i = 0; i < a; i++) push(14, base, duty);
      for (let i = 0; i < b; i++) push(14 * (1 - i / b), base + 5, duty);
      break;
    }
    case "jump": {
      const from = rnd(55, 64), to = from + rnd(10, 18), n = irnd(10, 16), duty = irnd(1, 2);
      for (let i = 0; i < n; i++) push(13 - 8 * i / n, q(from + (to - from) * Math.sqrt(i / n)), duty);
      break;
    }
    case "laser": {
      const from = rnd(90, 100), to = from - rnd(20, 34), n = irnd(10, 18);
      for (let i = 0; i < n; i++) push(15 - 10 * i / n, q(from + (to - from) * i / n), i & 1);
      break;
    }
    case "hit": {
      fx.channel = 3;
      const n = irnd(8, 14), hi = rnd(0.6, 0.9);
      for (let i = 0; i < n; i++) push(15 * (1 - i / n), noise(hi - 0.4 * i / n), 0);
      break;
    }
    case "explosion": {
      fx.channel = 3;
      const n = irnd(30, 50), lo = rnd(0.05, 0.3);
      for (let i = 0; i < n; i++) push(15 * (1 - i / n) ** 1.5, noise(lo + 0.2 * (1 - i / n)), 0);
      break;
    }
    case "powerup": {
      const base = irnd(60, 67), steps = [0, 4, 7, 12, 16, 19, 24], per = irnd(3, 5), duty = irnd(0, 2);
      for (const s of steps) for (let i = 0; i < per; i++) push(13 - i, base + s, duty);
      for (let i = 0; i < 8; i++) push(10 * (1 - i / 8), base + 24, duty);
      break;
    }
    case "blip": {
      const key = irnd(72, 90), n = irnd(4, 8), duty = irnd(0, 2);
      for (let i = 0; i < n; i++) push(12, key, duty);
      break;
    }
  }
  fx.frames = fx.vol.length;
  // Sounds made for the NES's triangle or the SMS's tone channels don't use duty; it's kept so switching chips back works.
  return fx;
}

// Small random changes to a sound effect's curves.
export function mutateSfx(project, fx) {
  const ch = CHIPS[project.chip].channels[fx.channel];
  const shift = rnd(-2, 2), scale = rnd(0.85, 1.15);
  fx.pitch = fx.pitch.map(p => Math.max(ch.lo, Math.min(ch.hi, ch.kind === "noise" ? Math.round(p + rnd(-1, 1)) : Math.round((p + shift) * 4) / 4)));
  fx.vol = fx.vol.map(v => Math.max(0, Math.min(15, Math.round(v * scale + rnd(-1, 1) * 0.6))));
}

// ---- loading and switching chips

const isSeq = s => s && Array.isArray(s.v) && s.v.every(Number.isFinite) && Number.isInteger(s.loop) && Number.isInteger(s.rel);

// Checks a project read from a file. Throws with a readable message.
export function checkProject(p) {
  const bad = what => { throw new Error(`This doesn't look like a ChipSmith project (${what}).`); };
  if (!p || p.format !== "chipsmith") bad("no format marker");
  if (!CHIPS[p.chip]) bad("unknown chip");
  if (!Array.isArray(p.instruments) || !p.instruments.every(i => i.id && ["vol", "arp", "pitch", "duty"].every(k => isSeq(i[k])))) bad("instruments");
  if (!Array.isArray(p.songs) || !p.songs.every(s => s.id && s.bpm > 0 && s.steps > 0 && s.length > 0 && s.channels?.length === 4 &&
    s.channels.every(c => Array.isArray(c.notes) && c.notes.every(n => [n.t, n.len, n.key].every(Number.isFinite))))) bad("songs");
  if (!Array.isArray(p.sfx) || !p.sfx.every(f => f.id && f.frames >= 0 && ["vol", "pitch", "duty"].every(k => Array.isArray(f[k])))) bad("sound effects");
  p.name ||= "My sounds";
  for (const s of p.songs) { s.beats ||= 4; if (s.loop === undefined) s.loop = 0; }
  return p;
}

// Moves a project to the other chip: the channels line up one for one, and the noise keys are spread over the new
// chip's range.
export function switchChip(p, chip) {
  const from = CHIPS[p.chip].channels, to = CHIPS[chip].channels;
  const fit = (ci, k) => {
    if (to[ci].kind === "noise") return Math.round(k * to[3].hi / from[3].hi);
    let key = k;
    while (key < to[ci].lo) key += 12;
    while (key > to[ci].hi) key -= 12;
    return key;
  };
  for (const s of p.songs) s.channels.forEach((c, ci) => c.notes.forEach(n => { n.key = fit(ci, n.key); }));
  for (const f of p.sfx) f.pitch = f.pitch.map(k => fit(f.channel, k));
  p.chip = chip;
}
