// A bar graph you draw on with a finger or the mouse: one bar per frame, for envelopes and sound effects.
// Drag across it to paint values. Two fingers (or the wheel) scroll it sideways when it's wider than the screen.

const AXIS_W = 40, MARK_H = 14;

export class Graph {
  // opts: { min, max, step, color, height, label(v) for the axis, ticks: [values], center (a value drawn as a line) }
  // cb: { get() -> values, edit(fn, begin, end), marks() -> { loop, rel } or null }
  constructor(opts, cb) {
    this.o = { step: 1, color: "#4dabf7", height: 120, ...opts };
    this.cb = cb;
    this.wrap = document.createElement("div");
    this.wrap.className = "graph";
    this.cv = document.createElement("canvas");
    this.wrap.append(this.cv);
    this.cx = this.cv.getContext("2d");
    this.sx = 0;
    this.pointers = new Map();
    this.cv.addEventListener("pointerdown", e => this.down(e));
    this.cv.addEventListener("pointermove", e => this.move(e));
    this.cv.addEventListener("pointerup", e => this.up(e));
    this.cv.addEventListener("pointercancel", e => this.up(e));
    this.cv.addEventListener("wheel", e => { if (this.maxScroll() > 0) { e.preventDefault(); this.sx += e.deltaX || e.deltaY; this.clampScroll(); this.draw(); } }, { passive: false });
    new ResizeObserver(() => this.resize()).observe(this.wrap);
  }

  get el() { return this.wrap; }
  get barW() { return matchMedia("(pointer: coarse)").matches ? 12 : 10; }
  // Bars stretch to fill the width, but don't get thinner than a finger can manage.
  get bw() { const n = Math.max(1, this.cb.get().length); return Math.max(this.barW, Math.min(28, (this.w - AXIS_W) / n)); }
  maxScroll() { return Math.max(0, this.cb.get().length * this.bw - (this.w - AXIS_W)); }
  clampScroll() { this.sx = Math.max(0, Math.min(this.maxScroll(), this.sx)); }

  resize() {
    const w = this.wrap.getBoundingClientRect().width, h = this.o.height + MARK_H, dpr = devicePixelRatio || 1;
    if (!w) return;
    this.w = w; this.h = h;
    this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
    this.cv.style.width = w + "px"; this.cv.style.height = h + "px";
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.clampScroll();
    this.draw();
  }

  y(v) { const { min, max } = this.o; return 4 + (1 - (v - min) / (max - min)) * (this.o.height - 8); }
  valueAt(y) {
    const { min, max, step } = this.o;
    const v = min + (1 - (y - 4) / (this.o.height - 8)) * (max - min);
    return Math.max(min, Math.min(max, Math.round(v / step) * step));
  }
  indexAt(x) { return Math.floor((x - AXIS_W + this.sx) / this.bw); }

  draw() {
    if (!this.w) return;
    const c = this.cx, vals = this.cb.get(), bw = this.bw, H = this.o.height;
    c.fillStyle = "#0b0c10"; c.fillRect(0, 0, this.w, this.h);
    c.save(); c.beginPath(); c.rect(AXIS_W, 0, this.w - AXIS_W, this.h); c.clip();
    const base = this.y(this.o.center ?? Math.max(this.o.min, 0));
    for (const t of this.o.ticks || []) { c.fillStyle = "#1a1d25"; c.fillRect(AXIS_W, Math.round(this.y(t)), this.w, 1); }
    c.fillStyle = "#262a34"; c.fillRect(AXIS_W, Math.round(base), this.w, 1);
    const marks = this.cb.marks?.();
    if (marks && marks.loop >= 0) { c.fillStyle = "rgba(77,171,247,.12)"; c.fillRect(AXIS_W + marks.loop * bw - this.sx, 0, Math.max(0, (marks.rel >= 0 && marks.rel >= marks.loop ? marks.rel + 1 : vals.length) - marks.loop) * bw, H); }
    vals.forEach((v, i) => {
      const x = AXIS_W + i * bw - this.sx;
      if (x + bw < AXIS_W || x > this.w) return;
      const y = this.y(v);
      c.fillStyle = (i % 2) ? "#14161c" : "#111318"; c.fillRect(x, 0, bw, H);
      c.fillStyle = this.o.color;
      c.fillRect(x + 1, Math.min(y, base), Math.max(1, bw - 2), Math.max(2, Math.abs(base - y)));
    });
    // markers strip: frame numbers, loop (L) and release (R)
    c.fillStyle = "#1e2129"; c.fillRect(AXIS_W, H, this.w, MARK_H);
    c.font = "9px ui-monospace, monospace"; c.textBaseline = "middle";
    const every = bw >= 16 ? 4 : 8;
    for (let i = 0; i < vals.length; i += every) { c.fillStyle = "#6c7280"; c.fillText(String(i), AXIS_W + i * bw - this.sx + 2, H + MARK_H / 2); }
    if (marks) {
      for (const [k, txt, col] of [["loop", "L", "#4dabf7"], ["rel", "R", "#ffd43b"]]) {
        if (marks[k] < 0) continue;
        const x = AXIS_W + marks[k] * bw - this.sx;
        c.fillStyle = col; c.fillRect(x, 0, 2, H + MARK_H);
        c.fillRect(x, H, 11, MARK_H); c.fillStyle = "#14161c"; c.fillText(txt, x + 2, H + MARK_H / 2);
      }
    }
    c.restore();
    // axis
    c.fillStyle = "#1e2129"; c.fillRect(0, 0, AXIS_W, this.h);
    c.fillStyle = "#9aa0ad"; c.font = "10px ui-monospace, monospace";
    const label = this.o.label || String;
    c.fillText(label(this.o.max), 4, 10);
    c.fillText(label(this.o.min), 4, H - 6);
    if (this.o.center !== undefined && this.o.center !== this.o.min) c.fillText(label(this.o.center), 4, this.y(this.o.center));
    if (this.hover) {
      c.fillStyle = "#ffd43b"; c.fillText(label(this.hover.v), 4, Math.max(20, Math.min(H - 16, this.y(this.hover.v))));
    }
  }

  paint(x, y) {
    const vals = this.cb.get();
    const i = Math.max(0, Math.min(vals.length - 1, this.indexAt(x))), v = this.valueAt(y);
    const last = this.last ?? { i, v };
    // Fill in the bars skipped between two moves, so a quick stroke leaves no gaps.
    const a = Math.min(i, last.i), b = Math.max(i, last.i);
    this.cb.edit(arr => {
      for (let k = a; k <= b; k++) {
        const f = b === a ? 1 : (k - last.i) / (i - last.i);
        arr[k] = b === a ? v : Math.round((last.v + (v - last.v) * f) / this.o.step) * this.o.step;
      }
    }, !this.started);
    this.started = true;
    this.last = { i, v };
    this.hover = { v };
  }

  down(e) {
    this.cv.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX });
    if (this.pointers.size === 2) {
      // Two fingers scroll instead of painting.
      if (this.started) this.cb.edit(null, false, true);
      this.started = false; this.last = null; this.hover = null;
      const [a, b] = [...this.pointers.values()];
      this.pan = { x: (a.x + b.x) / 2, sx: this.sx };
      return;
    }
    if (!this.cb.get().length || e.offsetX < AXIS_W || e.offsetY > this.o.height) return;
    this.painting = true; this.started = false; this.last = null;
    this.paint(e.offsetX, e.offsetY);
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.offsetX;
    if (this.pan && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.sx = this.pan.sx - ((a.x + b.x) / 2 - this.pan.x);
      this.clampScroll(); this.draw();
      return;
    }
    if (this.painting) this.paint(e.offsetX, e.offsetY);
  }

  up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pan = null;
    if (this.painting && this.pointers.size === 0) {
      this.painting = false;
      if (this.started) this.cb.edit(null, false, true);
      this.started = false; this.last = null; this.hover = null;
      this.draw();
    }
  }
}
