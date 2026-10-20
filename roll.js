// The piano roll: a song's notes on one channel at a time, which you can add, move, resize and delete. The other
// channels show dimmed behind it (except the noise channel, whose rows aren't notes).

import { midiName } from "./ui.js";

const KEYS_W = 44, RULER_H = 22;

export class Roll {
  constructor(canvas, cb) {
    this.cv = canvas;
    this.cx = canvas.getContext("2d");
    this.cb = cb; // { edit(fn, begin, end), select(note), seek(step), add(lane, t, key, len) -> note, preview(lane, note) }
    this.coarse = matchMedia("(pointer: coarse)").matches;
    this.zoom = this.coarse ? 16 : 14; // pixels per step
    this.rowH = this.coarse ? 18 : 14;
    this.sx = 0; this.sy = 0;
    this.grid = 1;
    this.len = 2; // the length a new note gets
    this.song = null;
    this.chip = null; // CHIPS entry
    this.lane = 0;
    this.sel = null; // a note
    this.playhead = null;
    this.cursor = 0; // where Play starts
    this.pointers = new Map();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", e => this.down(e));
    canvas.addEventListener("pointermove", e => this.move(e));
    canvas.addEventListener("pointerup", e => this.up(e));
    canvas.addEventListener("pointercancel", e => this.up(e, true));
    canvas.addEventListener("wheel", e => this.wheel(e), { passive: false });
  }

  resize() {
    const box = this.cv.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    this.w = Math.max(100, box.width); this.h = Math.max(120, box.height);
    this.cv.width = Math.round(this.w * dpr); this.cv.height = Math.round(this.h * dpr);
    this.cv.style.width = this.w + "px"; this.cv.style.height = this.h + "px";
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.needCenter) this.centerOnNotes();
    this.clamp();
    this.draw();
  }

  setSong(song, chip, keepView) {
    const changed = this.song?.id !== song.id || this.chip !== chip;
    this.song = song; this.chip = chip;
    if (this.sel && !song.channels[this.lane].notes.includes(this.sel)) this.select(null);
    if (changed && !keepView) { this.sx = 0; this.cursor = 0; this.select(null); this.centerOnNotes(); }
    this.clamp();
    this.draw();
  }

  setLane(i) {
    this.lane = i;
    this.select(null);
    this.centerOnNotes();
    this.draw();
  }

  get ch() { return this.chip.channels[this.lane]; }
  get lo() { return this.ch.lo; }
  get hi() { return this.ch.hi; }
  get beat() { return this.song.steps; }
  get bar() { return this.song.steps * this.song.beats; }
  get rollH() { return this.h - RULER_H; }
  rows() { return this.hi - this.lo + 1; }
  rowY(key) { return RULER_H + (this.hi - key) * this.rowH - this.sy; }
  keyAt(y) { return Math.max(this.lo, Math.min(this.hi, this.hi - Math.floor((y - RULER_H + this.sy) / this.rowH))); }
  x(t) { return KEYS_W + t * this.zoom - this.sx; }
  stepAt(x) { return Math.max(0, (x - KEYS_W + this.sx) / this.zoom); }
  snap(t) { return Math.max(0, Math.round(t / this.grid) * this.grid); }
  label(k) { return this.ch.kind === "noise" ? this.chip.noiseKeys[k].label : midiName(k); }

  clamp() {
    if (!this.song || !this.w) return;
    const maxX = Math.max(0, this.song.length * this.zoom + 120 - (this.w - KEYS_W));
    const maxY = Math.max(0, this.rows() * this.rowH - this.rollH);
    this.sx = Math.max(0, Math.min(maxX, this.sx));
    this.sy = Math.max(0, Math.min(maxY, this.sy));
  }

  centerOnNotes() {
    if (!this.song) return;
    if (!this.h) { this.needCenter = true; return; } // not laid out yet: resize() does it
    this.needCenter = false;
    const keys = this.song.channels[this.lane].notes.map(n => n.key);
    const mid = keys.length ? (Math.min(...keys) + Math.max(...keys)) / 2 : this.ch.kind === "noise" ? this.hi / 2 : 64;
    this.sy = (this.hi - mid) * this.rowH - this.rollH / 2;
    this.clamp();
  }

  select(note) {
    this.sel = note;
    this.cb.select(note);
    this.draw();
  }

  draw() {
    if (!this.song || !this.w) return;
    const c = this.cx, w = this.w, h = this.h, z = this.zoom, noise = this.ch.kind === "noise";
    c.fillStyle = "#0b0c10"; c.fillRect(0, 0, w, h);
    const t0 = Math.floor(this.stepAt(KEYS_W)), t1 = Math.ceil(this.stepAt(w));
    for (let k = this.lo; k <= this.hi; k++) {
      const y = this.rowY(k);
      if (y + this.rowH < RULER_H || y > h) continue;
      const black = !noise && [1, 3, 6, 8, 10].includes(k % 12);
      c.fillStyle = black ? "#101218" : (noise && k % 2) ? "#12141b" : "#151821";
      c.fillRect(KEYS_W, y, w - KEYS_W, this.rowH);
      if (!noise && k % 12 === 0) { c.fillStyle = "#262a34"; c.fillRect(KEYS_W, y + this.rowH - 1, w - KEYS_W, 1); }
    }
    // the song's end, and its loop
    const end = this.x(this.song.length);
    if (this.song.loop !== null) { c.fillStyle = "rgba(77,171,247,.06)"; c.fillRect(this.x(this.song.loop), RULER_H, (this.song.length - this.song.loop) * z, this.rollH); }
    c.fillStyle = "rgba(0,0,0,.5)"; c.fillRect(end, RULER_H, w, this.rollH);
    // grid
    const step = this.grid * z < 6 ? (this.beat * z < 6 ? this.bar : this.beat) : this.grid;
    for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
      c.fillStyle = t % this.bar === 0 ? "#3a3f4d" : t % this.beat === 0 ? "#272b36" : "#1a1d25";
      c.fillRect(Math.round(this.x(t)), RULER_H, 1, this.rollH);
    }
    // notes: the other note channels dimmed, then the current one
    const lanes = [0, 1, 2, 3].filter(i => i !== this.lane && !noise && this.chip.channels[i].kind !== "noise").concat(this.lane);
    for (const i of lanes) {
      const cur = i === this.lane;
      c.globalAlpha = cur ? 1 : 0.25;
      c.fillStyle = this.chip.channels[i].color;
      for (const n of this.song.channels[i].notes) {
        const x = this.x(n.t), nw = Math.max(2, n.len * z - 1), y = this.rowY(n.key);
        if (x > w || x + nw < KEYS_W || y > h || y + this.rowH < RULER_H) continue;
        // Quieter notes are drawn fainter.
        if (cur) c.globalAlpha = 0.45 + 0.55 * (n.vol ?? 15) / 15;
        c.fillRect(x, y + 1, nw, this.rowH - 2);
        if (cur && nw > 4) { c.fillStyle = "rgba(0,0,0,.35)"; c.fillRect(x + nw - 1, y + 1, 1, this.rowH - 2); c.fillStyle = this.chip.channels[i].color; }
        if (cur && this.sel === n) { c.globalAlpha = 1; c.strokeStyle = "#fff"; c.lineWidth = 2; c.strokeRect(x - 1, y, nw + 2, this.rowH); }
      }
    }
    c.globalAlpha = 1;
    // keys
    c.fillStyle = "#1e2129"; c.fillRect(0, RULER_H, KEYS_W, this.rollH);
    c.font = "10px ui-monospace, monospace"; c.textBaseline = "middle";
    for (let k = this.lo; k <= this.hi; k++) {
      const y = this.rowY(k);
      if (y + this.rowH < RULER_H || y > h) continue;
      if (noise) { c.fillStyle = "#9aa0ad"; c.fillText(this.label(k), 5, y + this.rowH / 2); continue; }
      if ([1, 3, 6, 8, 10].includes(k % 12)) { c.fillStyle = "#0b0c10"; c.fillRect(0, y, KEYS_W * 0.6, this.rowH); }
      if (k % 12 === 0) { c.fillStyle = "#9aa0ad"; c.fillText(midiName(k), 5, y + this.rowH / 2); }
    }
    // ruler: bar numbers, loop and end marks, and where Play starts
    c.fillStyle = "#1e2129"; c.fillRect(0, 0, w, RULER_H);
    c.fillStyle = "#9aa0ad";
    const barStep = this.bar * z < 30 ? this.bar * 4 : this.bar;
    for (let t = Math.floor(t0 / barStep) * barStep; t <= t1; t += barStep) {
      const x = this.x(t);
      if (x < KEYS_W - 1) continue;
      c.fillRect(x, 12, 1, 10);
      c.fillText(String(t / this.bar + 1), x + 3, 9);
    }
    c.fillStyle = "#e5484d"; c.fillRect(end, 0, 2, h);
    if (this.song.loop !== null) { c.fillStyle = "#4dabf7"; c.fillRect(this.x(this.song.loop), RULER_H, 2, this.rollH); }
    c.fillStyle = "#e5484d";
    const cx = this.x(this.cursor);
    if (cx >= KEYS_W) { c.beginPath(); c.moveTo(cx - 5, 12); c.lineTo(cx + 5, 12); c.lineTo(cx, 21); c.fill(); }
    if (this.playhead !== null) { c.fillStyle = "#fff"; c.fillRect(Math.round(this.x(this.playhead)), 0, 1, h); }
  }

  // ---- input

  hitNote(x, y) {
    const notes = this.song.channels[this.lane].notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i], nx = this.x(n.t), nw = Math.max(4, n.len * this.zoom), ny = this.rowY(n.key);
      if (x >= nx && x <= nx + nw && y >= ny && y < ny + this.rowH) {
        const edge = Math.min(this.coarse ? 14 : 10, nw / 3);
        return { n, resize: x > nx + nw - edge };
      }
    }
    return null;
  }

  down(e) {
    if (!this.song) return;
    this.cv.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 2) { // pinch: zoom in time
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.abs(a.x - b.x) || 1, zoom: this.zoom, mid: (a.x + b.x) / 2, step: this.stepAt((a.x + b.x) / 2) };
      if (this.drag?.started) this.cb.edit(null, false, true);
      this.drag = null;
      return;
    }
    const x = e.offsetX, y = e.offsetY;
    this.drag = { x0: x, y0: y, sx: this.sx, sy: this.sy, moved: false, mode: "pan" };
    if (y < RULER_H) { this.drag.mode = "seek"; this.seekTo(x); return; }
    const hit = x > KEYS_W && this.hitNote(x, y);
    if (hit) {
      this.drag = { ...this.drag, mode: hit.resize ? "resize" : "move", n: hit.n, key0: hit.n.key, t0: hit.n.t, len0: hit.n.len, started: false };
      if (this.sel !== hit.n) this.select(hit.n);
      this.cb.preview(this.lane, hit.n);
    }
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.offsetX; p.y = e.offsetY;
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.zoom = Math.max(2, Math.min(60, this.pinch.zoom * (Math.abs(a.x - b.x) || 1) / this.pinch.d));
      this.sx = this.pinch.step * this.zoom - (this.pinch.mid - KEYS_W);
      this.clamp(); this.draw();
      return;
    }
    const d = this.drag;
    if (!d) return;
    const dx = e.offsetX - d.x0, dy = e.offsetY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) > 6) d.moved = true;
    if (!d.moved) return;
    if (d.mode === "seek") { this.seekTo(e.offsetX); return; }
    if (d.mode === "pan") {
      this.sx = d.sx - dx; this.sy = d.sy - dy;
      this.clamp(); this.draw();
      return;
    }
    const n = d.n;
    if (d.mode === "move") {
      const t = Math.min(this.song.length - 1, this.snap(d.t0 + dx / this.zoom));
      const key = Math.max(this.lo, Math.min(this.hi, d.key0 + Math.round(-dy / this.rowH)));
      const newKey = key !== n.key;
      this.cb.edit(() => { n.t = t; n.key = key; }, !d.started);
      if (newKey) this.cb.preview(this.lane, n);
    } else {
      const endT = Math.max(d.t0 + 1, this.snap(d.t0 + d.len0 + dx / this.zoom));
      this.cb.edit(() => { n.len = endT - d.t0; this.len = n.len; }, !d.started);
    }
    d.started = true;
  }

  up(e, cancel) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.started) this.cb.edit(null, false, true);
    if (cancel) return;
    if (d.mode === "pan" && !d.moved && e.offsetX > KEYS_W) {
      // A tap on an empty spot adds a note there (or just clears the selection, if a note was selected).
      if (this.sel) { this.select(null); return; }
      const t = Math.floor(this.stepAt(e.offsetX) / this.grid) * this.grid;
      if (t >= this.song.length) return;
      const n = this.cb.add(this.lane, t, this.keyAt(e.offsetY), this.len);
      this.select(n);
      this.cb.preview(this.lane, n);
    }
  }

  seekTo(x) {
    this.cursor = Math.min(this.song.length - 1, Math.floor(this.stepAt(x) / this.beat) * this.beat);
    this.cb.seek(this.cursor);
    this.draw();
  }

  wheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const step = this.stepAt(e.offsetX);
      this.zoom = Math.max(2, Math.min(60, this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      this.sx = step * this.zoom - (e.offsetX - KEYS_W);
    } else if (e.shiftKey) this.sx += e.deltaY || e.deltaX;
    else { this.sx += e.deltaX; this.sy += e.deltaY; }
    this.clamp(); this.draw();
  }

  zoomBy(f) {
    const mid = KEYS_W + (this.w - KEYS_W) / 2, step = this.stepAt(mid);
    this.zoom = Math.max(2, Math.min(60, this.zoom * f));
    this.sx = step * this.zoom - (mid - KEYS_W);
    this.clamp(); this.draw();
  }

  follow(step) {
    const x = this.x(step);
    if (x < KEYS_W + 10 || x > this.w - 30) { this.sx = Math.max(0, step * this.zoom - (this.w - KEYS_W) * 0.2); this.clamp(); }
  }
}
