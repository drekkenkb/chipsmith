// The two sound chips, emulated at the register level: the NES APU (2A03) and the Master System's SN76489.
// The sequencer sets each channel once a frame, as a game's sound driver would, and asks for the samples in between.
// Each channel's output is integrated over the span of a sample (a box filter), which keeps the aliasing down
// without stepping every clock one at a time.

export const NES_CPU = 1789773;
export const SMS_CLOCK = 3579545;

const NES_DUTY = [
  [0, 1, 0, 0, 0, 0, 0, 0], [0, 1, 1, 0, 0, 0, 0, 0], [0, 1, 1, 1, 1, 0, 0, 0], [1, 0, 0, 1, 1, 1, 1, 1],
];
const TRI_SEQ = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
export const NES_NOISE_PERIODS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];

const hz = key => 440 * 2 ** ((key - 69) / 12);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// First-order filters, as the NES's output stage has (and a DC block for the SMS).
class HighPass {
  constructor(rate, cutoff) { this.a = 1 / (1 + 2 * Math.PI * cutoff / rate); this.x = 0; this.y = 0; }
  run(x) { this.y = this.a * (this.y + x - this.x); this.x = x; return this.y; }
}
class LowPass {
  constructor(rate, cutoff) { const rc = 1 / (2 * Math.PI * cutoff); this.a = (1 / rate) / (rc + 1 / rate); this.y = 0; }
  run(x) { this.y += this.a * (x - this.y); return this.y; }
}

// A channel's timer: `left` clocks until the next step of its sequence. Returns the channel's average output over
// `clocks`, calling `step` each time the timer runs out and `out` for the level in between.
function integrate(ch, clocks, period, step, out) {
  let acc = 0, rem = clocks;
  while (rem > 0) {
    const d = Math.min(rem, ch.left);
    acc += out() * d;
    ch.left -= d; rem -= d;
    if (ch.left <= 0) { step(); ch.left += period; }
  }
  return acc / clocks;
}

export class NesApu {
  constructor(rate) {
    this.rate = rate;
    this.cps = NES_CPU / rate; // CPU clocks per sample
    this.pulse = [0, 1].map(() => ({ period: 0, duty: 2, vol: 0, step: 0, left: 1 }));
    this.tri = { period: 0, on: false, step: 0, left: 1 };
    this.noise = { period: 0, mode: 0, vol: 0, lfsr: 1, left: 1 };
    this.hp1 = new HighPass(rate, 90); this.hp2 = new HighPass(rate, 440); this.lp = new LowPass(rate, 14000);
    this.mute = [false, false, false, false];
  }

  // `key` is a MIDI note number (fractions bend it), `vol` 0-15, `duty` 0-3.
  setPulse(i, key, vol, duty) {
    const p = this.pulse[i];
    p.period = key === null ? 0 : clamp(Math.round(NES_CPU / (16 * hz(key)) - 1), 0, 2047);
    p.vol = key === null ? 0 : vol; p.duty = duty & 3;
  }
  setTri(key, on) {
    this.tri.period = key === null ? 0 : clamp(Math.round(NES_CPU / (32 * hz(key)) - 1), 0, 2047);
    this.tri.on = on && key !== null;
  }
  // `index` 0-15 into the period table (0 is the highest), `mode` 1 for the short, metallic sequence.
  setNoise(index, mode, vol) {
    const n = this.noise;
    n.period = NES_NOISE_PERIODS[clamp(index, 0, 15)]; n.mode = mode; n.vol = vol;
  }

  render(out, from, n) {
    const c = this.cps;
    for (let s = 0; s < n; s++) {
      const p = this.pulse.map((ch, i) => {
        // Periods under 8 silence a pulse channel on the real chip.
        if (ch.period < 8 || !ch.vol || this.mute[i]) return 0;
        return integrate(ch, c, 2 * (ch.period + 1), () => { ch.step = (ch.step + 1) & 7; },
          () => NES_DUTY[ch.duty][ch.step] * ch.vol);
      });
      const t = this.tri;
      let tv;
      if (t.on && t.period >= 2) tv = integrate(t, c, t.period + 1, () => { t.step = (t.step + 1) & 31; }, () => TRI_SEQ[t.step]);
      else tv = TRI_SEQ[t.step]; // a stopped triangle holds its level
      if (this.mute[2]) tv = 0;
      const ns = this.noise;
      const nv = this.mute[3] || !ns.vol ? 0 : integrate(ns, c, ns.period, () => {
        const fb = (ns.lfsr & 1) ^ ((ns.lfsr >> (ns.mode ? 6 : 1)) & 1);
        ns.lfsr = (ns.lfsr >> 1) | (fb << 14);
      }, () => (ns.lfsr & 1 ? 0 : ns.vol));
      // The APU's non-linear mixer.
      const ps = p[0] + p[1];
      const pulseOut = ps ? 95.88 / (8128 / ps + 100) : 0;
      const tnd = tv / 8227 + nv / 12241;
      const tndOut = tnd ? 159.79 / (1 / tnd + 100) : 0;
      const v = this.lp.run(this.hp2.run(this.hp1.run(pulseOut + tndOut)));
      out[from + s] = v * 1.6;
    }
  }
}

// 2dB per attenuation step; 15 is off.
const SMS_VOL = Array.from({ length: 16 }, (_, i) => (i === 15 ? 0 : 10 ** (-0.1 * i)));

export class Sn76489 {
  constructor(rate) {
    this.rate = rate;
    this.cps = SMS_CLOCK / 16 / rate; // counter clocks per sample
    this.tone = [0, 1, 2].map(() => ({ period: 1, vol: 0, out: 1, left: 1 }));
    this.noise = { rate: 0, white: true, vol: 0, lfsr: 0x8000, flip: 0, left: 1, cfg: -1 };
    this.hp = new HighPass(rate, 20);
    this.mute = [false, false, false, false];
  }

  // `vol` is 0-15 with 15 loudest (the chip's attenuation turned around).
  setTone(i, key, vol) {
    const t = this.tone[i];
    t.period = key === null ? 1 : clamp(Math.round(SMS_CLOCK / (32 * hz(key))), 1, 1023);
    t.vol = key === null ? 0 : vol;
  }
  // `rate` 0-2 for clock/512, /1024, /2048; 3 follows tone 3's period.
  setNoise(rate, white, vol) {
    const n = this.noise, cfg = rate | (white ? 4 : 0);
    if (cfg !== n.cfg) { n.lfsr = 0x8000; n.cfg = cfg; } // writing the noise register resets the shift register
    n.rate = rate; n.white = white; n.vol = vol;
  }

  render(out, from, n) {
    const c = this.cps;
    for (let s = 0; s < n; s++) {
      let sum = 0;
      this.tone.forEach((t, i) => {
        const v = integrate(t, c, t.period, () => { t.out = -t.out; }, () => t.out);
        if (t.vol && !this.mute[i]) sum += (t.period <= 1 ? 1 : v) * SMS_VOL[15 - t.vol];
      });
      const ns = this.noise;
      const period = ns.rate === 3 ? this.tone[2].period : 0x10 << ns.rate;
      const nv = integrate(ns, c, period, () => {
        ns.flip ^= 1;
        if (!ns.flip) return; // the register shifts once per full cycle of the counter's output
        const fb = ns.white ? ((ns.lfsr & 1) ^ ((ns.lfsr >> 3) & 1)) : ns.lfsr & 1;
        ns.lfsr = (ns.lfsr >> 1) | (fb << 15);
      }, () => (ns.lfsr & 1 ? 1 : -1));
      if (ns.vol && !this.mute[3]) sum += nv * SMS_VOL[15 - ns.vol];
      out[from + s] = this.hp.run(sum) * 0.22;
    }
  }
}

// What each chip offers: its channels, the notes they reach, and the noise channel's "keys".
// Noise keys run low to high so the piano roll reads naturally.
const nesNoiseKeys = [];
for (let mode = 0; mode < 2; mode++)
  for (let i = 15; i >= 0; i--) nesNoiseKeys.push({ label: (mode ? "M" : "N") + (15 - i).toString(16).toUpperCase(), index: i, mode });
const smsNoiseKeys = [];
for (const white of [false, true])
  for (const rate of [2, 1, 0, 3]) smsNoiseKeys.push({ label: (white ? "W" : "P") + (rate === 3 ? "T3" : ["Hi", "Md", "Lo"][rate]), rate, white });

export const CHIPS = {
  nes: {
    name: "NES",
    long: "NES (2A03)",
    frameHz: NES_CPU / 29780.5,
    channels: [
      { name: "Pulse 1", short: "P1", kind: "pulse", lo: 33, hi: 108, color: "#ff6b6b" },
      { name: "Pulse 2", short: "P2", kind: "pulse", lo: 33, hi: 108, color: "#ffa94d" },
      { name: "Triangle", short: "TRI", kind: "tri", lo: 21, hi: 96, color: "#4dabf7" },
      { name: "Noise", short: "NOI", kind: "noise", lo: 0, hi: nesNoiseKeys.length - 1, color: "#b197fc" },
    ],
    noiseKeys: nesNoiseKeys,
    duties: ["12.5%", "25%", "50%", "75%"],
    make: rate => new NesApu(rate),
    // Sets channel `ci`. `key` null means silent. For noise, key is an index into noiseKeys.
    set(chip, ci, key, vol, duty) {
      if (ci < 2) chip.setPulse(ci, key, vol, duty);
      else if (ci === 2) chip.setTri(key, vol > 0);
      else if (key === null) chip.setNoise(0, 0, 0);
      else { const k = nesNoiseKeys[clamp(Math.round(key), 0, nesNoiseKeys.length - 1)]; chip.setNoise(k.index, k.mode, vol); }
    },
  },
  sms: {
    name: "Master System",
    long: "Master System (SN76489)",
    frameHz: 59.922743,
    channels: [
      { name: "Tone 1", short: "T1", kind: "tone", lo: 45, hi: 108, color: "#ff6b6b" },
      { name: "Tone 2", short: "T2", kind: "tone", lo: 45, hi: 108, color: "#ffa94d" },
      { name: "Tone 3", short: "T3", kind: "tone", lo: 45, hi: 108, color: "#4dabf7" },
      { name: "Noise", short: "NOI", kind: "noise", lo: 0, hi: smsNoiseKeys.length - 1, color: "#b197fc" },
    ],
    noiseKeys: smsNoiseKeys,
    duties: null,
    make: rate => new Sn76489(rate),
    set(chip, ci, key, vol) {
      if (ci < 3) chip.setTone(ci, key, vol);
      else if (key === null) chip.setNoise(0, true, 0);
      else { const k = smsNoiseKeys[clamp(Math.round(key), 0, smsNoiseKeys.length - 1)]; chip.setNoise(k.rate, k.white, vol); }
    },
  },
};
