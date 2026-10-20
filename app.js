// ChipSmith: make music and sound effects for the NES or Master System sound chips, and export them as WAV or OGG.

import { CHIPS } from "./chips.js";
import { renderSong, renderSfx, renderNote, stepFrames, RATE } from "./render.js";
import { newProject, emptySong, makeSfx, mutateSfx, SFX_KINDS, seq, uid, checkProject, switchChip } from "./project.js";
import { Roll } from "./roll.js";
import { Graph } from "./graph.js";
import { play, ogg, audioContext } from "./audio.js";
import { addComments } from "./oggtags.js";
import { wav, zip } from "./files.js";
import { el, field, select, num, midiName } from "./ui.js";

const $ = id => document.getElementById(id);
const STORE = "chipsmith-project";

let project = null;
let sel = null;           // { type: "song" | "sfx" | "inst", id }
let undoStack = [], redoStack = [];
let player = null;        // what's playing: { h (audio.js handle), kind, id, sf, spf }
let roll = null;          // the piano roll, while a song is open
let graphs = [];          // the graphs on screen
let laneInst = {};        // the instrument new notes get, per channel

// ---- storage and history

function load() {
  try {
    const s = localStorage.getItem(STORE);
    if (s) { project = checkProject(JSON.parse(s)); return true; }
  } catch { /* storage blocked or the saved project is damaged: start fresh */ }
  project = newProject("nes");
  return false;
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(project)); } catch { } }, 300);
}

// Every change goes through here. `begin` takes an undo snapshot first (a drag passes it only on its first move);
// `end` marks the end of a drag, when the sound is brought up to date.
function edit(fn, begin = true, end = false) {
  if (begin) {
    undoStack.push(JSON.stringify(project));
    if (undoStack.length > 300) undoStack.shift();
    redoStack = [];
  }
  if (fn) fn(project);
  tidy();
  save();
  updateHistory();
  redraw();
  renderLists();
  if (end || (begin && fn)) replay();
}

function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(project));
  project = checkProject(JSON.parse(from.pop()));
  if (sel && !findSel()) sel = null;
  save(); updateHistory(); renderAll(); replay();
}
const undo = () => restore(undoStack, redoStack);
const redo = () => restore(redoStack, undoStack);
function updateHistory() { $("undo").disabled = !undoStack.length; $("redo").disabled = !redoStack.length; }

// Keeps songs in order: notes sorted, one per step on each channel.
function tidy() {
  for (const s of project.songs) for (const ch of s.channels) {
    // Where two notes land on the same step, the one being edited wins.
    const at = new Map();
    for (const n of ch.notes) if (!at.has(n.t) || n === roll?.sel) at.set(n.t, n);
    ch.notes = [...at.values()].sort((a, b) => a.t - b.t);
  }
}

const findSel = () => sel && { song: project.songs, sfx: project.sfx, inst: project.instruments }[sel.type].find(x => x.id === sel.id);
const chip = () => CHIPS[project.chip];

// ---- lists

function renderLists() {
  const list = (ul, type, items, playable) => {
    ul.replaceChildren(...items.map(it => {
      const cur = sel?.type === type && sel.id === it.id;
      return el("li", { className: cur ? "current" : "" },
        el("button", { className: "pick", textContent: it.name || "(untitled)", on: { click: () => open(type, it.id) } }),
        playable && el("button", { className: "quick", textContent: player?.id === it.id ? "■" : "▶", title: "Play", on: { click: () => togglePlay(type, it.id) } }));
    }));
  };
  list($("songs"), "song", project.songs, true);
  list($("sfxs"), "sfx", project.sfx, true);
  list($("insts"), "inst", project.instruments, false);
  $("project-name").value = project.name;
  const it = findSel();
  $("cur-name").textContent = it ? it.name : "";
  $("chip-name").textContent = chip().long;
}

const phone = () => matchMedia("(max-width: 760px)").matches;

function open(type, id) {
  if (sel?.type !== type || sel?.id !== id) stop();
  sel = { type, id };
  if (phone()) $("lists").open = false; // on a phone the list folds away to make room for the editor
  renderAll();
}

function renderAll() {
  renderLists();
  renderPane();
}

// ---- panes

function redraw() {
  if (roll) roll.draw();
  graphs.forEach(g => g.draw());
  refreshInspector?.();
}
let refreshInspector = null;

function renderPane() {
  const pane = $("pane");
  graphs = []; roll = null; refreshInspector = null;
  const it = findSel();
  if (!it) {
    pane.replaceChildren(el("div", { className: "empty" },
      el("p", { textContent: "Pick a song, a sound effect or an instrument from the list, or make a new one with +." })));
    return;
  }
  if (sel.type === "song") songPane(pane, it);
  else if (sel.type === "sfx") sfxPane(pane, it);
  else instPane(pane, it);
}

function nameInput(it) {
  return el("input", { className: "name", value: it.name, spellcheck: false, "aria-label": "Name",
    on: { change: e => edit(() => { it.name = e.target.value.trim() || it.name; }) } });
}

function itemBar(it, kind, extra = []) {
  const playable = kind !== "inst";
  return el("div", { className: "songbar" },
    nameInput(it),
    el("div", { className: "songbar-actions" },
      playable && el("button", { id: "play", className: "primary", textContent: player?.id === it.id ? "Stop" : "Play", title: "Play (Space)", on: { click: () => togglePlay(kind, it.id) } }),
      playable && el("button", { textContent: "Export…", on: { click: () => exportDialog([{ kind, it }]) } }),
      ...extra,
      el("button", { textContent: "Duplicate", on: { click: () => duplicate(kind, it) } }),
      el("button", { textContent: "Delete", on: { click: () => remove(kind, it) } })));
}

function duplicate(kind, it) {
  const copy = JSON.parse(JSON.stringify(it));
  copy.id = uid(); copy.name = it.name + " copy";
  const arr = { song: project.songs, sfx: project.sfx, inst: project.instruments }[kind];
  edit(() => arr.splice(arr.indexOf(it) + 1, 0, copy));
  open(kind, copy.id);
}

function remove(kind, it) {
  const arr = { song: project.songs, sfx: project.sfx, inst: project.instruments }[kind];
  if (kind === "inst") {
    const used = project.songs.some(s => s.channels.some(c => c.notes.some(n => n.inst === it.id)));
    if (used && !confirm(`Songs use "${it.name}". Their notes will play with no envelopes (full volume, held). Delete it anyway?`)) return;
  } else if (!confirm(`Delete "${it.name}"? (Undo brings it back.)`)) return;
  stop();
  const i = arr.indexOf(it);
  edit(() => arr.splice(i, 1));
  const next = arr[Math.min(i, arr.length - 1)];
  sel = next ? { type: kind, id: next.id } : null;
  renderAll();
}

// -- song

function songPane(pane, song) {
  const c = chip();
  if (!laneInst.song || laneInst.song !== song.id) {
    // Each channel starts with the instrument it uses most.
    laneInst = { song: song.id };
    song.channels.forEach((ch, i) => {
      const count = {};
      for (const n of ch.notes) count[n.inst] = (count[n.inst] || 0) + 1;
      const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0];
      laneInst[i] = best && project.instruments.some(x => x.id === best) ? best : project.instruments[Math.min(i, project.instruments.length - 1)]?.id;
    });
  }
  const lanes = el("div", { className: "seg", id: "lanes" });
  const instSel = el("select", { title: "Instrument for new notes", on: { change: e => {
    laneInst[roll.lane] = e.target.value;
    if (roll.sel) edit(() => { roll.sel.inst = e.target.value; });
  } } });
  const fillInst = () => {
    instSel.replaceChildren(...project.instruments.map(i => el("option", { value: i.id, textContent: i.name })));
    instSel.value = roll?.sel?.inst ?? laneInst[roll?.lane ?? 0] ?? "";
  };
  const grid = select([[1, "Grid: 1 step"], [2, "Grid: 2 steps"], [4, "Grid: 4 steps"], [song.steps, "Grid: 1 beat"]].filter((v, i, a) => a.findIndex(x => x[0] === v[0]) === i), 1, v => { roll.grid = +v; roll.draw(); });
  const tools = el("div", { className: "tools" }, lanes,
    el("label", { className: "inline" }, "Instrument", instSel), grid,
    el("span", { className: "seg" },
      el("button", { textContent: "−", title: "Zoom out", on: { click: () => roll.zoomBy(1 / 1.4) } }),
      el("button", { textContent: "+", title: "Zoom in", on: { click: () => roll.zoomBy(1.4) } })));
  const canvas = el("canvas", { id: "roll" });
  const inspector = el("div", { id: "inspector" });
  pane.replaceChildren(itemBar(song, "song"), tools, el("div", { id: "roll-wrap" }, canvas), inspector);

  roll = new Roll(canvas, {
    edit,
    select: () => { fillInst(); refreshInspector?.(); },
    seek: step => { if (player?.id === song.id) playSong(song, step); },
    add: (lane, t, key, len) => {
      const n = { t, len: Math.min(len, song.length - t), key, inst: laneInst[lane], vol: 15 };
      edit(() => song.channels[lane].notes.push(n));
      return n;
    },
    preview: (lane, n) => previewNote(lane, n.key, project.instruments.find(i => i.id === n.inst), n.vol),
  });
  const drawLanes = () => lanes.replaceChildren(...c.channels.map((ch, i) => el("button", {
    "aria-pressed": String(i === roll.lane), title: ch.name,
    on: { click: () => { roll.setLane(i); drawLanes(); fillInst(); } },
  }, el("span", { className: "dot", style: `background:${ch.color}` }), ch.short)));
  roll.setSong(song, c);
  drawLanes(); fillInst();

  refreshInspector = () => {
    const n = roll.sel;
    if (n) {
      const ch = c.channels[roll.lane];
      inspector.replaceChildren(
        el("h3", {}, "Note ", el("small", { textContent: `${ch.kind === "noise" ? c.noiseKeys[n.key].label : midiName(n.key)} · step ${n.t + 1}` })),
        field("Volume", num(1, 15, n.vol ?? 15, v => edit(() => { n.vol = v; }))),
        field("Length (steps)", num(1, song.length - n.t, n.len, v => edit(() => { n.len = v; roll.len = v; }))),
        el("button", { textContent: "Delete note", on: { click: deleteNote } }),
        el("p", { className: "hint", textContent: "Drag a note to move it, or its right edge to change its length. Tap an empty spot to deselect." }));
    } else {
      const bar = song.steps * song.beats, bars = Math.ceil(song.length / bar);
      const loopOpts = [["off", "No loop"], ...Array.from({ length: bars }, (_, i) => [i * bar, `Bar ${i + 1}`])];
      inspector.replaceChildren(
        el("h3", {}, "Song"),
        field("Tempo (BPM)", num(20, 400, song.bpm, v => edit(() => { song.bpm = v; }))),
        field("Steps per beat", num(1, 8, song.steps, v => edit(() => resizeGrid(song, v, song.beats)))),
        field("Beats per bar", num(1, 12, song.beats, v => edit(() => resizeGrid(song, song.steps, v)))),
        field("Bars", num(1, 256, bars, v => edit(() => setLength(song, v * bar)))),
        field("Loop from", select(loopOpts, song.loop === null ? "off" : song.loop, v => edit(() => { song.loop = v === "off" ? null : +v; }))),
        el("p", { className: "hint", textContent: "Tap the grid to add a note with the instrument above. Drag to scroll, pinch or use −/+ to zoom. Tap the ruler to choose where Play starts." }));
    }
  };
  refreshInspector();
}

// Changing steps per beat or beats per bar keeps the notes where they are in steps and the song a whole number of bars.
function resizeGrid(song, steps, beats) {
  const bars = Math.ceil(song.length / (song.steps * song.beats));
  song.steps = steps; song.beats = beats;
  setLength(song, bars * steps * beats);
}
function setLength(song, len) {
  song.length = len;
  if (song.loop !== null && song.loop >= len) song.loop = 0;
  for (const ch of song.channels) {
    ch.notes = ch.notes.filter(n => n.t < len);
    for (const n of ch.notes) n.len = Math.min(n.len, len - n.t);
  }
}

function deleteNote() {
  const n = roll?.sel;
  if (!n) return;
  edit(() => { for (const ch of findSel().channels) ch.notes = ch.notes.filter(x => x !== n); });
  roll.select(null);
}

// -- sound effect

function sfxPane(pane, fx) {
  const c = chip();
  const kinds = el("div", { className: "kinds" }, ...SFX_KINDS.map(([k, label]) => el("button", { textContent: label, title: `Make a new ${label.toLowerCase()} sound`, on: { click: () => {
    edit(() => {
      const made = makeSfx(project, k);
      const keepName = !SFX_KINDS.some(x => x[1] === fx.name);
      Object.assign(fx, made, { id: fx.id, name: keepName ? fx.name : made.name });
    });
    renderPane(); playSfx(fx);
  } } })), el("button", { textContent: "Mutate", title: "Change it a little", on: { click: () => { edit(() => mutateSfx(project, fx)); playSfx(fx); } } }));
  const chSel = select(c.channels.map((ch, i) => [i, ch.name]), fx.channel, v => {
    edit(() => moveSfx(fx, +v));
    renderPane(); playSfx(fx);
  });
  const lenInput = num(1, 600, fx.frames, v => { edit(() => setFrames(fx, v)); renderPane(); });
  const info = el("span", { className: "hint" });
  const tools = el("div", { className: "tools" }, el("label", { className: "inline" }, "Channel", chSel), el("label", { className: "inline" }, "Frames", lenInput), info);
  const ch = c.channels[fx.channel], noise = ch.kind === "noise";
  const body = el("div", { className: "graphs" });
  const addGraph = (title, key, opts) => {
    const g = new Graph(opts, {
      get: () => fx[key],
      edit: (fn, begin, end) => edit(fn && (() => fn(fx[key])), begin, end),
    });
    graphs.push(g);
    body.append(el("div", { className: "graph-head" }, el("b", { textContent: title })), g.el);
  };
  addGraph("Volume", "vol", { min: 0, max: 15, color: "#69db7c", ticks: [5, 10] });
  if (noise) addGraph("Noise", "pitch", { min: ch.lo, max: ch.hi, color: ch.color, label: k => c.noiseKeys[Math.round(k)]?.label ?? "" });
  else addGraph("Pitch", "pitch", { min: ch.lo, max: ch.hi, step: 0.25, color: ch.color, label: k => midiName(Math.round(k)), ticks: range(Math.ceil(ch.lo / 12) * 12, ch.hi, 12) });
  if (ch.kind === "pulse") addGraph("Duty", "duty", { min: 0, max: 3, color: "#ffa94d", label: v => c.duties[v] ?? "", ticks: [1, 2] });
  pane.replaceChildren(itemBar(fx, "sfx"), tools, el("div", { className: "sfx-kinds" }, el("span", { className: "hint", textContent: "Start from:" }), kinds), body,
    el("p", { className: "hint pad", textContent: "Draw on the graphs with a finger or the mouse; each bar is one frame (1/60 s). Two fingers scroll a long sound sideways." }));
  refreshInspector = () => { info.textContent = `${Math.round(fx.frames / c.frameHz * 1000)} ms`; };
  refreshInspector();
}

const range = (a, b, step) => { const r = []; for (let v = a; v <= b; v += step) r.push(v); return r; };

function setFrames(fx, n) {
  const pad = (arr, v) => { arr.length = Math.min(arr.length, n); while (arr.length < n) arr.push(arr.length ? arr[arr.length - 1] : v); };
  pad(fx.vol, 0); pad(fx.pitch, 60); pad(fx.duty, 2);
  fx.frames = n;
}

// Moving a sound effect between a note channel and the noise channel maps its pitch curve across.
function moveSfx(fx, to) {
  const c = chip(), a = c.channels[fx.channel], b = c.channels[to];
  if ((a.kind === "noise") !== (b.kind === "noise"))
    fx.pitch = fx.pitch.map(p => Math.round((b.lo + (p - a.lo) / (a.hi - a.lo) * (b.hi - b.lo)) * (b.kind === "noise" ? 1 : 4)) / (b.kind === "noise" ? 1 : 4));
  fx.pitch = fx.pitch.map(p => Math.max(b.lo, Math.min(b.hi, p)));
  fx.channel = to;
}

// -- instrument

let instChannel = 0;
function instPane(pane, inst) {
  const c = chip();
  const ch = () => c.channels[instChannel];
  const keys = el("div", { className: "keys" });
  const drawKeys = () => {
    const list = ch().kind === "noise"
      ? range(0, ch().hi, Math.max(1, Math.round(ch().hi / 7))).map(k => [k, c.noiseKeys[k].label])
      : [48, 52, 55, 60, 64, 67, 72, 76, 79, 84].filter(k => k >= ch().lo && k <= ch().hi).map(k => [k, midiName(k)]);
    keys.replaceChildren(...list.map(([k, label]) => el("button", { textContent: label, on: { click: () => previewNote(instChannel, k, inst) } })));
  };
  const chSel = select(c.channels.map((x, i) => [i, x.name]), instChannel, v => { instChannel = +v; drawKeys(); });
  drawKeys();
  const body = el("div", { className: "graphs" });
  const env = (title, key, opts, help) => {
    const s = inst[key];
    const g = new Graph(opts, {
      get: () => s.v,
      edit: (fn, begin, end) => edit(fn && (() => fn(s.v)), begin, end),
      marks: () => ({ loop: s.loop, rel: s.rel }),
    });
    graphs.push(g);
    const marks = n => [["-1", "off"], ...Array.from({ length: n }, (_, i) => [String(i), String(i)])];
    const head = el("div", { className: "graph-head" });
    const drawHead = () => head.replaceChildren(
      el("b", { textContent: title }),
      el("label", { className: "inline" }, "Frames", num(0, 255, s.v.length, n => {
        edit(() => {
          while (s.v.length < n) s.v.push(s.v.length ? s.v[s.v.length - 1] : opts.fill);
          s.v.length = n;
          if (s.loop >= n) s.loop = -1;
          if (s.rel >= n) s.rel = -1;
        });
        drawHead(); g.resize();
      })),
      el("label", { className: "inline" }, "Loop", select(marks(s.v.length), s.loop, v => { edit(() => { s.loop = +v; }); })),
      el("label", { className: "inline" }, "Release", select(marks(s.v.length), s.rel, v => { edit(() => { s.rel = +v; }); })),
      el("small", { className: "hint", textContent: help }));
    drawHead();
    body.append(head, g.el);
  };
  env("Volume", "vol", { min: 0, max: 15, color: "#69db7c", ticks: [5, 10], fill: 15 },
    "Empty means full volume. With a release point, the note holds there and plays the rest when let go; without one, letting go cuts it.");
  env("Arpeggio", "arp", { min: -12, max: 12, color: "#4dabf7", center: 0, ticks: [-7, 7], fill: 0 }, "Semitones added to the note, each frame. Loop it for chords.");
  env("Pitch", "pitch", { min: -8, max: 8, color: "#ff6b6b", center: 0, fill: 0 }, "Bends up or down by this many eighths of a semitone each frame, adding up. Loop + and − for vibrato.");
  if (c.duties) env("Duty", "duty", { min: 0, max: 3, color: "#ffa94d", label: v => c.duties[v] ?? "", ticks: [1, 2], fill: 2 }, "The pulse channels' tone: 12.5% is thin, 50% is hollow and square.");
  pane.replaceChildren(itemBar(inst, "inst"),
    el("div", { className: "tools" }, el("label", { className: "inline" }, "Try on", chSel), keys),
    body);
}

// ---- sound

function previewNote(ci, key, inst, vol = 15) {
  if (player && player.kind !== "note") return; // don't talk over a song that's playing
  player?.h.stop();
  const s = renderNote(project, inst, ci, key, 0.25, vol);
  const h = play(s);
  player = { h, kind: "note" };
  h.onended = () => { if (player?.h === h) player = null; };
}

function togglePlay(kind, id) {
  if (player?.id === id) { stop(); return; }
  const it = (kind === "song" ? project.songs : project.sfx).find(x => x.id === id);
  if (kind === "song") playSong(it, roll && sel?.id === id ? roll.cursor : 0);
  else playSfx(it);
}

function playSong(song, step = 0) {
  stop(true);
  const r = renderSong(project, song);
  const sf = stepFrames(song, project.chip), spf = RATE / chip().frameHz;
  const h = play(r.samples, r.loopStart, r.loopEnd, Math.round(sf[step] * spf) / RATE);
  player = { h, kind: "song", id: song.id, sf, spf };
  h.onended = () => { if (player?.h === h) stop(); };
  playUi();
  tick();
}

function playSfx(fx) {
  stop(true);
  const h = play(renderSfx(project, fx).samples);
  player = { h, kind: "sfx", id: fx.id };
  h.onended = () => { if (player?.h === h) stop(); };
  playUi();
}

function stop(quiet) {
  if (!player) return;
  player.h.stop();
  player = null;
  if (roll) { roll.playhead = null; roll.draw(); }
  if (!quiet) playUi();
}

function playUi() {
  const b = $("play");
  const it = findSel();
  if (b && it) b.textContent = player?.id === it.id ? "Stop" : "Play";
  renderLists();
}

// Moves the playhead along with the sound.
function tick() {
  if (!player || player.kind !== "song") return;
  if (roll && sel?.id === player.id) {
    const frame = player.h.position() * RATE / player.spf, sf = player.sf;
    let lo = 0, hi = sf.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (sf[m] <= frame) lo = m; else hi = m - 1; }
    const step = lo + Math.min(1, (frame - sf[lo]) / Math.max(1, (sf[lo + 1] ?? sf[lo] + 1) - sf[lo]));
    roll.playhead = step;
    if (!roll.drag) roll.follow(step);
    roll.draw();
  }
  requestAnimationFrame(tick);
}

// After an edit, what's playing is rendered again and carries on from where it was.
let replayTimer = 0;
function replay() {
  if (!player || player.kind !== "song") return;
  clearTimeout(replayTimer);
  replayTimer = setTimeout(() => {
    if (!player || player.kind !== "song") return;
    const song = project.songs.find(s => s.id === player.id);
    if (!song) { stop(); return; }
    const step = Math.floor(roll?.playhead ?? 0);
    playSong(song, Math.min(step, song.length - 1));
  }, 200);
}

// ---- export

const slug = s => (s || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";

function download(blob, name) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// Renders and encodes one item. Songs go once through (so they loop seamlessly in a game, with the loop marked in the
// file), or twice and fade out, for listening.
async function encode(kind, it, format, listen) {
  const r = kind === "song" ? renderSong(project, it, listen ? { passes: it.loop === null ? 1 : 2, fade: it.loop === null ? 0 : 6 } : {}) : renderSfx(project, it);
  const loop = !listen && r.loopStart !== null;
  let data;
  if (format === "wav") data = wav(r.samples, RATE, loop ? r.loopStart : null, loop ? r.loopEnd : null);
  else {
    data = await ogg(r.samples);
    const tags = { TITLE: it.name };
    if (loop) Object.assign(tags, { LOOPSTART: r.loopStart, LOOPLENGTH: r.loopEnd - r.loopStart });
    data = addComments(data, tags);
  }
  return { data, samples: r.samples.length, loopStart: loop ? r.loopStart : null, loopEnd: loop ? r.loopEnd : null };
}

function dialog(title, build, okLabel = "OK") {
  const d = $("dlg"), form = $("dlg-form");
  return new Promise(resolve => {
    const values = {};
    form.replaceChildren(el("h2", { textContent: title }), ...build(values).filter(Boolean),
      el("div", { className: "dlg-actions" },
        el("button", { value: "cancel", textContent: "Cancel", formNoValidate: true }),
        okLabel && el("button", { value: "ok", className: "primary", textContent: okLabel })));
    d.onclose = () => resolve(d.returnValue === "ok" ? values : null);
    d.returnValue = "";
    d.showModal();
  });
}

const radio = (values, key, options, initial) => {
  values[key] = initial;
  return el("div", { className: "radios" }, ...options.map(([v, label, sub]) => el("label", {},
    el("input", { type: "radio", name: key, value: v, checked: v === initial, on: { change: () => { values[key] = v; } } }),
    el("span", {}, label, sub && el("small", { textContent: sub })))));
};

async function exportDialog(items) {
  const songs = items.some(i => i.kind === "song");
  const v = await dialog(items.length > 1 ? "Export everything" : `Export "${items[0].it.name}"`, values => [
    radio(values, "format", [["ogg", "OGG", "Small. Games and browsers play it."], ["wav", "WAV", "Uncompressed, for editing or engines without OGG."]], "ogg"),
    songs && radio(values, "listen", [["game", "Once through", "For a game: the file loops seamlessly from the loop point, which is written into it."], ["listen", "Twice, then fade out", "For listening or sharing."]], "game"),
    items.length > 1 && el("p", { className: "hint", textContent: "You get a ZIP with every song and sound effect, a sounds.json listing their loop points, and the project file." }),
  ], "Export");
  if (!v) return;
  const listen = v.listen === "listen";
  toast("Exporting…", 0);
  try {
    if (items.length === 1) {
      const { kind, it } = items[0], r = await encode(kind, it, v.format, listen);
      download(new Blob([r.data], { type: v.format === "ogg" ? "audio/ogg" : "audio/wav" }), `${slug(it.name)}.${v.format}`);
    } else {
      const files = [], manifest = { rate: RATE, chip: project.chip, music: [], sfx: [] }, used = new Set();
      for (const { kind, it } of items) {
        const r = await encode(kind, it, v.format, listen);
        let base = `${kind === "song" ? "music" : "sfx"}/${slug(it.name)}`, name = base, n = 2;
        while (used.has(name)) name = `${base}-${n++}`;
        used.add(name);
        files.push({ name: `${name}.${v.format}`, data: r.data });
        (kind === "song" ? manifest.music : manifest.sfx).push({ name: it.name, file: `${name}.${v.format}`, samples: r.samples, loopStart: r.loopStart, loopEnd: r.loopEnd });
      }
      const enc = new TextEncoder();
      files.push({ name: "sounds.json", data: enc.encode(JSON.stringify(manifest, null, 2)) });
      files.push({ name: `${slug(project.name)}.chipsmith.json`, data: enc.encode(JSON.stringify(project)) });
      download(zip(files), `${slug(project.name)}-${v.format}.zip`);
    }
    toast("Exported.");
  } catch (e) {
    toast(e.message || String(e));
  }
}

// ---- file menu

async function newDialog(first) {
  const v = await dialog(first ? "Welcome to ChipSmith" : "New project", values => [
    first && el("p", { className: "hint", textContent: "Make music and sound effects for a retro sound chip, then export them as OGG or WAV for your game." }),
    el("p", { textContent: "Which sound chip?" }),
    radio(values, "chip", [["nes", "NES", "Two pulse waves, a triangle and noise."], ["sms", "Master System", "Three square waves and noise (the Game Gear and Genesis have the same chip)."]], "nes"),
    !first && el("p", { className: "hint", textContent: "This replaces the project in this browser. Save it first if you want to keep it." }),
  ], first ? "Start" : "Create");
  if (!v) return;
  stop();
  undoStack.push(JSON.stringify(project)); redoStack = [];
  project = newProject(v.chip);
  sel = { type: "song", id: project.songs[0].id };
  save(); updateHistory(); renderAll();
}

async function chipDialog() {
  const other = project.chip === "nes" ? "sms" : "nes";
  const v = await dialog(`Switch to ${CHIPS[other].name}?`, () => [
    el("p", { className: "hint", textContent: `The channels carry over one for one, and notes out of the ${CHIPS[other].name}'s range move by octaves. ${other === "sms" ? "The SMS has no duty or triangle wave, so those parts sound different." : "The NES's triangle can't change volume."} Undo switches back.` }),
  ], "Switch");
  if (!v) return;
  stop();
  edit(() => switchChip(project, other));
  renderAll();
}

function saveProject() {
  download(new Blob([JSON.stringify(project, null, 1)], { type: "application/json" }), `${slug(project.name)}.chipsmith.json`);
}

async function openProject(file) {
  try {
    const p = checkProject(JSON.parse(await file.text()));
    stop();
    undoStack.push(JSON.stringify(project)); redoStack = [];
    project = p;
    sel = p.songs[0] ? { type: "song", id: p.songs[0].id } : p.sfx[0] ? { type: "sfx", id: p.sfx[0].id } : null;
    save(); updateHistory(); renderAll();
    toast(`Opened "${p.name}".`);
  } catch (e) {
    toast(e instanceof SyntaxError ? "That file isn't a ChipSmith project." : e.message);
  }
}

function help() {
  dialog("How ChipSmith works", () => [
    el("p", { textContent: "A project is for one sound chip, and holds songs, sound effects and the instruments the songs use. It's kept in this browser as you work; use File → Save project to keep a copy." }),
    el("p", { textContent: "Songs: pick a channel, pick an instrument, and tap the grid to place notes. Each channel plays one note at a time, like the real chip. Set the tempo, length and loop below the grid when no note is selected." }),
    el("p", { textContent: "Instruments shape each note frame by frame: volume, arpeggio (fast note changes for chords), pitch bends and the pulse duty. Draw the graphs and try them on the keys." }),
    el("p", { textContent: "Sound effects are drawn frame by frame. Start from one of the kinds (each tap makes a new variation), then draw or Mutate it." }),
    el("p", { textContent: "Export gives OGG or WAV. Music exported once through loops seamlessly in a game: the loop point is in the file (LOOPSTART/LOOPLENGTH tags in OGG, a smpl chunk in WAV)." }),
  ], null);
}

// ---- misc UI

let toastTimer = 0;
function toast(msg, ms = 3000) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function addItem(type) {
  stop();
  let it;
  if (type === "song") it = emptySong(`Song ${project.songs.length + 1}`);
  else if (type === "sfx") it = makeSfx(project, "blip");
  else it = { id: uid(), name: `Instrument ${project.instruments.length + 1}`, vol: seq([15, 13, 11, 9], -1, 3), arp: seq(), pitch: seq(), duty: seq([2]) };
  edit(() => ({ song: project.songs, sfx: project.sfx, inst: project.instruments })[type].push(it));
  open(type, it.id);
}

function setup() {
  $("undo").onclick = undo;
  $("redo").onclick = redo;
  $("project-name").onchange = e => edit(() => { project.name = e.target.value.trim() || "My sounds"; });
  const menu = $("menu");
  $("menu-btn").onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("click", e => { if (!menu.contains(e.target)) menu.hidden = true; });
  menu.addEventListener("click", e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    menu.hidden = true;
    ({
      new: () => newDialog(false), save: saveProject, chip: chipDialog, help,
      "export-all": () => exportDialog([...project.songs.map(it => ({ kind: "song", it })), ...project.sfx.map(it => ({ kind: "sfx", it }))]),
    })[act]();
  });
  $("open-file").onchange = e => { menu.hidden = true; if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ""; };
  for (const b of document.querySelectorAll("[data-add]")) b.onclick = () => addItem(b.dataset.add);
  document.addEventListener("keydown", e => {
    if (e.target.closest("input, select, textarea") || $("dlg").open) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveProject(); }
    else if (e.key === " " && sel && sel.type !== "inst") { e.preventDefault(); togglePlay(sel.type, sel.id); }
    else if ((e.key === "Delete" || e.key === "Backspace") && roll?.sel) { e.preventDefault(); deleteNote(); }
  });
  // iOS only lets sound start from a tap; waking the audio on the first one makes later previews immediate.
  document.addEventListener("pointerdown", () => audioContext(), { once: true });

  if (phone()) $("lists").open = false;
  const had = load();
  sel = project.songs[0] ? { type: "song", id: project.songs[0].id } : null;
  updateHistory();
  renderAll();
  if (!had) newDialog(true);
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");
}

setup();
