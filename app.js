// Lesson Notes: handwritten notes on pages, with the lesson recorded alongside. Every pen stroke is timestamped on the
// lesson clock, which is the recording's own time (it pauses when the recording pauses), so a stroke can be matched
// to what was being said when it was written. Everything is stored in the browser (db.js) and works offline; Export
// saves a lesson as a .zip (lesson.json, a PNG per page and the audio) for the AI summary at home.
import * as db from "./db.js";
import { makeZip } from "./zip.js";

const FORMAT = "lesson-notes/1";
// Pages are drawn in these units whatever the screen size (16:10, like most Chromebook screens)
const PAGE_W = 1600;
const PAGE_H = 1000;
const LINE_GAP = 50; // ruled lines
const ERASER_RADIUS = 12;
const COLORS = { black: "#111827", blue: "#1d4ed8", red: "#dc2626", green: "#15803d" };
// the highlighter in each colour (black highlights yellow)
const HIGHLIGHTS = { black: "#fde047", blue: "#bfdbfe", red: "#fecaca", green: "#bbf7d0" };
const AUDIO_CHUNK_MS = 5000; // the recording is saved every 5 s, so a crash loses at most that much

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");

let lesson = null;
let pageIndex = 0;
let tool = "pen";
let color = "black";
let size = 4;
let undoStack = [];
let redoStack = [];
let viewScale = 1;
let current = null; // the stroke being drawn
let erasing = null; // the strokes removed by the current eraser gesture
let saveTimer = null;

// --- The lesson clock: milliseconds of lesson time, paused when the lesson is paused ---------------------------------
const clock = {
  base: 0,
  since: null,
  get running() {
    return this.since != null;
  },
  now() {
    return this.base + (this.since != null ? performance.now() - this.since : 0);
  },
  run() {
    if (this.since == null) this.since = performance.now();
  },
  stop() {
    this.base = this.now();
    this.since = null;
  }
};

// --- Lessons ---------------------------------------------------------------------------------------------------------

function newLessonData() {
  const now = new Date();
  return {
    format: FORMAT,
    id: crypto.randomUUID(),
    title: "Lesson " + now.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }),
    created: now.toISOString(),
    clockMs: 0, // lesson time so far
    started: false,
    running: false,
    ended: false,
    events: [], // { type: start | pause | resume | end | interrupted, clock (ms), wall (ISO time) }
    takes: [], // recordings: { take, clockStart (ms), mime }; a new take starts after the app was reopened mid-lesson
    mic: null, // "ok", or why recording was not possible
    page: { width: PAGE_W, height: PAGE_H },
    pages: [{ strokes: [] }]
  };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (lesson == null) return;
  lesson.clockMs = Math.round(clock.now());
  lesson.running = clock.running;
  try {
    await db.putLesson(lesson);
  } catch (e) {
    toast("Could not save: " + e.message);
  }
}

// --- Home screen -----------------------------------------------------------------------------------------------------

async function showHome() {
  lesson = null;
  $("lesson").hidden = true;
  $("home").hidden = false;
  const lessons = (await db.getLessons()).sort((a, b) => b.created.localeCompare(a.created));
  const list = $("lesson-list");
  list.replaceChildren();
  $("empty").hidden = lessons.length > 0;
  for (const l of lessons) {
    const li = document.createElement("li");
    li.className = "lesson-card";
    const thumb = el("div", "thumb");
    thumb.append(icon("notebook-pen"));
    const info = el("div", "info");
    info.title = "Open";
    info.addEventListener("click", () => openLesson(l.id));
    const meta = el("div", "meta");
    meta.append(
      metaItem("clock-3", new Date(l.created).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })),
      metaItem("play", formatTime(l.clockMs)),
      metaItem("file-plus", l.pages.length + (l.pages.length == 1 ? " page" : " pages")),
      metaItem(l.takes.length > 0 ? "mic" : "mic-off", l.takes.length > 0 ? "Recorded" : "No recording"),
      el("span", "chip " + (l.exported ? "good" : "warn"), l.exported ? "Exported" : "Not exported")
    );
    info.append(el("div", "name", l.title), meta);
    const actions = el("div", "actions");
    actions.append(
      button("Open", "folder-open", () => openLesson(l.id), "btn btn-ghost"),
      button("Export", "download", () => exportLesson(l), "btn btn-ghost"),
      button("", "trash-2", () => removeLesson(l), "btn btn-ghost btn-danger icon-only", "Delete")
    );
    li.append(thumb, info, actions);
    list.append(li);
  }
  showStorageNote();
}

function el(tag, className = "", text = null) {
  const e = document.createElement(tag);
  e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// A Lucide icon from assets/icons.svg
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "assets/icons.svg#" + name);
  svg.append(use);
  return svg;
}

function metaItem(iconName, text) {
  const span = el("span");
  span.append(icon(iconName), text);
  return span;
}

function button(text, iconName, onClick, className, title = text) {
  const b = el("button", className);
  b.title = title;
  b.append(icon(iconName));
  if (text) b.append(text);
  b.addEventListener("click", onClick);
  return b;
}

async function removeLesson(l) {
  if (!confirm(`Delete "${l.title}" and its recording? This cannot be undone.` + (l.exported ? "" : "\n\nIt has not been exported."))) return;
  await db.deleteLesson(l.id);
  showHome();
}

async function showStorageNote() {
  const note = $("storage-note");
  if (!navigator.storage?.estimate) return;
  const persisted = await navigator.storage.persisted?.();
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  note.textContent = `Saved in this browser: ${formatBytes(usage)} used of ${formatBytes(quota)} available. ` +
    (persisted ? "Chrome will keep it." : "Chrome could clear it if the disk gets full, so export lessons you want to keep.");
}

// --- Lesson screen ---------------------------------------------------------------------------------------------------

async function openLesson(id) {
  lesson = await db.getLesson(id);
  if (lesson.started && !lesson.ended) {
    // the app was closed mid-lesson (recording or paused): the recording up to the last saved chunk is kept, and
    // Continue lesson starts a new one
    if (lesson.running) toast("This lesson was interrupted. Press Continue lesson to carry on recording.");
    lesson.running = false;
    lesson.ended = true;
    lesson.events.push({ type: "interrupted", clock: lesson.clockMs, wall: new Date().toISOString() });
  }
  clock.base = lesson.clockMs;
  clock.since = null;
  pageIndex = lesson.pages.length - 1;
  undoStack = [];
  redoStack = [];
  $("home").hidden = true;
  $("lesson").hidden = false;
  $("title").value = lesson.title;
  updateRecordingUi();
  updatePageUi();
  fit();
}

function lessonActive() {
  return lesson.started && !lesson.ended;
}

async function leaveLesson() {
  if (lessonActive()) {
    if (!confirm("End the lesson? Recording will stop.")) return;
    await endLesson();
  }
  await saveNow();
  showHome();
}

// --- Drawing ---------------------------------------------------------------------------------------------------------

function fit() {
  const stage = $("stage");
  // leave a margin round the page, and room below it for the page switcher (the stage's bottom padding)
  const margin = 24;
  const below = parseFloat(getComputedStyle(stage).paddingBottom) || 0;
  viewScale = Math.min((stage.clientWidth - margin) / PAGE_W, (stage.clientHeight - below - margin) / PAGE_H);
  if (!(viewScale > 0)) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = PAGE_W * viewScale + "px";
  canvas.style.height = PAGE_H * viewScale + "px";
  canvas.width = Math.round(PAGE_W * viewScale * dpr);
  canvas.height = Math.round(PAGE_H * viewScale * dpr);
  ctx.setTransform(viewScale * dpr, 0, 0, viewScale * dpr, 0, 0);
  redraw();
}

function strokeWidth(stroke, pressure) {
  if (stroke.tool === "highlighter") return stroke.size * 5;
  return stroke.size * (0.3 + 1.4 * Math.max(0.05, Math.min(1, pressure)));
}

function strokeColor(stroke) {
  return stroke.tool === "highlighter" ? HIGHLIGHTS[stroke.color] : COLORS[stroke.color];
}

function drawSegment(c, stroke, a, b) {
  c.strokeStyle = strokeColor(stroke);
  c.lineWidth = strokeWidth(stroke, (a[2] + b[2]) / 2);
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(a[0], a[1]);
  c.lineTo(b[0], b[1]);
  c.stroke();
}

// One page in page units: white paper, ruled lines, highlighters under the ink
function renderPage(c, page) {
  c.fillStyle = "#fff";
  c.fillRect(0, 0, PAGE_W, PAGE_H);
  c.strokeStyle = "#dbeafe";
  c.lineWidth = 1;
  c.beginPath();
  for (let y = LINE_GAP * 2; y < PAGE_H; y += LINE_GAP) {
    c.moveTo(0, y);
    c.lineTo(PAGE_W, y);
  }
  c.stroke();
  for (const s of page.strokes) {
    if (s.tool !== "highlighter") continue;
    // one path, so the overlapping parts of a highlighter stroke do not darken
    c.strokeStyle = strokeColor(s);
    c.lineWidth = strokeWidth(s, 0.5);
    c.lineCap = c.lineJoin = "round";
    c.beginPath();
    c.moveTo(s.points[0][0], s.points[0][1]);
    for (const p of s.points) c.lineTo(p[0], p[1]);
    c.stroke();
  }
  for (const s of page.strokes) {
    if (s.tool === "highlighter") continue;
    for (let i = 1; i < s.points.length; i++) drawSegment(c, s, s.points[i - 1], s.points[i]);
  }
}

function redraw() {
  if (lesson == null) return;
  ctx.save();
  renderPage(ctx, lesson.pages[pageIndex]);
  ctx.restore();
}

// [x, y, pressure, lesson time in ms]
function pointFrom(e) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(((e.clientX - rect.left) / viewScale) * 10) / 10;
  const y = Math.round(((e.clientY - rect.top) / viewScale) * 10) / 10;
  const pressure = e.pointerType === "mouse" ? 0.5 : e.pressure || 0.5;
  return [x, y, Math.round(pressure * 100) / 100, Math.round(clock.now())];
}

canvas.addEventListener("pointerdown", (e) => {
  if (lesson == null || (e.pointerType === "mouse" && e.button !== 0)) return;
  canvas.setPointerCapture(e.pointerId);
  const p = pointFrom(e);
  if (tool === "eraser") {
    erasing = [];
    eraseAt(p);
    return;
  }
  // beforeStart: drawn before the lesson clock was started, so its times say nothing about the recording
  current = { tool, color, size, beforeStart: !lesson.started, points: [p] };
  if (tool === "highlighter") ctx.globalCompositeOperation = "multiply";
  drawSegment(ctx, current, p, p);
});

canvas.addEventListener("pointermove", (e) => {
  if (current == null && erasing == null) return;
  for (const ev of e.getCoalescedEvents?.() ?? [e]) {
    const p = pointFrom(ev);
    if (erasing != null) {
      eraseAt(p);
    } else {
      const last = current.points[current.points.length - 1];
      if (p[0] === last[0] && p[1] === last[1]) continue;
      current.points.push(p);
      drawSegment(ctx, current, last, p);
    }
  }
});

function finishGesture() {
  if (current != null) {
    const stroke = current;
    current = null;
    ctx.globalCompositeOperation = "source-over";
    if (stroke.points.length == 1) stroke.points.push([...stroke.points[0]]);
    lesson.pages[pageIndex].strokes.push(stroke);
    pushUndo({ type: "add", page: pageIndex, stroke });
    if (stroke.tool === "highlighter") redraw();
    scheduleSave();
  }
  if (erasing != null) {
    if (erasing.length > 0) {
      pushUndo({ type: "erase", page: pageIndex, items: erasing });
      scheduleSave();
    }
    erasing = null;
  }
}
canvas.addEventListener("pointerup", finishGesture);
canvas.addEventListener("pointercancel", finishGesture);

function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Removes every stroke the eraser touches (whole strokes, so the notes stay clean for the AI)
function eraseAt(p) {
  const strokes = lesson.pages[pageIndex].strokes;
  let changed = false;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    const reach = ERASER_RADIUS + strokeWidth(s, 1) / 2;
    let hit = false;
    for (let k = 1; k < s.points.length && !hit; k++) hit = distanceToSegment(p, s.points[k - 1], s.points[k]) < reach;
    if (hit) {
      erasing.push({ stroke: s, index: i });
      strokes.splice(i, 1);
      changed = true;
    }
  }
  if (changed) redraw();
}

// --- Undo / redo -----------------------------------------------------------------------------------------------------

function pushUndo(action) {
  undoStack.push(action);
  redoStack = [];
  updateUndoUi();
}

function apply(action, undo) {
  const strokes = lesson.pages[action.page].strokes;
  if (action.type === "add") {
    if (undo) strokes.splice(strokes.lastIndexOf(action.stroke), 1);
    else strokes.push(action.stroke);
  } else if (undo) {
    // put erased strokes back where they were (lowest index first)
    for (const { stroke, index } of [...action.items].sort((a, b) => a.index - b.index)) strokes.splice(index, 0, stroke);
  } else {
    for (const { stroke } of action.items) strokes.splice(strokes.indexOf(stroke), 1);
  }
  pageIndex = action.page;
  updatePageUi();
  redraw();
  scheduleSave();
}

function undo() {
  const action = undoStack.pop();
  if (action == null) return;
  apply(action, true);
  redoStack.push(action);
  updateUndoUi();
}

function redo() {
  const action = redoStack.pop();
  if (action == null) return;
  apply(action, false);
  undoStack.push(action);
  updateUndoUi();
}

function updateUndoUi() {
  $("undo").disabled = undoStack.length == 0;
  $("redo").disabled = redoStack.length == 0;
}

// --- Pages -----------------------------------------------------------------------------------------------------------

function goToPage(i) {
  pageIndex = Math.max(0, Math.min(lesson.pages.length - 1, i));
  updatePageUi();
  redraw();
}

function addPage() {
  lesson.pages.push({ strokes: [] });
  goToPage(lesson.pages.length - 1);
  scheduleSave();
}

function updatePageUi() {
  $("page-label").textContent = `Page ${pageIndex + 1} / ${lesson.pages.length}`;
  $("prev-page").disabled = pageIndex == 0;
  $("next-page").disabled = pageIndex == lesson.pages.length - 1;
  updateUndoUi();
}

// --- Recording -------------------------------------------------------------------------------------------------------

let recorder = null;
let chunk = 0;
let wakeLock = null;
let clockTimer = null;

function recordingMime() {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (window.MediaRecorder?.isTypeSupported(type)) return type;
  }
  return "";
}

// Starts (or, after End or a reload, continues) the lesson: the clock and, if the microphone is allowed, a recording
async function startLesson() {
  $("rec-start").disabled = true;
  const take = { take: lesson.takes.length + 1, clockStart: Math.round(clock.now()), mime: recordingMime() };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
    recorder = new MediaRecorder(stream, { mimeType: take.mime || undefined, audioBitsPerSecond: 48000 });
    take.mime = recorder.mimeType;
    chunk = 0;
    const lessonId = lesson.id;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) db.putAudioChunk(lessonId, take.take, chunk++, e.data).catch((err) => toast("Could not save the recording: " + err.message));
    };
    recorder.onstop = () => stream.getTracks().forEach((t) => t.stop());
    recorder.start(AUDIO_CHUNK_MS);
    lesson.takes.push(take);
    lesson.mic = "ok";
  } catch (e) {
    recorder = null;
    lesson.mic = e.name === "NotAllowedError" ? "blocked" : e.name || "unavailable";
    toast(e.name === "NotAllowedError"
      ? "The microphone is blocked, so this lesson is not being recorded. Your notes and the lesson clock still work."
      : "No recording: " + (e.message || e.name) + ". Your notes and the lesson clock still work.");
  }
  lesson.started = true;
  lesson.ended = false;
  clock.run();
  lesson.events.push({ type: "start", clock: take.clockStart, wall: new Date().toISOString() });
  keepScreenOn();
  $("rec-start").disabled = false;
  updateRecordingUi();
  saveNow();
}

function togglePause() {
  if (clock.running) {
    clock.stop();
    if (recorder?.state === "recording") recorder.pause();
    lesson.events.push({ type: "pause", clock: Math.round(clock.now()), wall: new Date().toISOString() });
  } else {
    clock.run();
    if (recorder?.state === "paused") recorder.resume();
    lesson.events.push({ type: "resume", clock: Math.round(clock.now()), wall: new Date().toISOString() });
  }
  updateRecordingUi();
  saveNow();
}

async function endLesson() {
  clock.stop();
  if (recorder != null && recorder.state !== "inactive") {
    // wait for the last chunk to be handed over before saving
    await new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
      recorder.stop();
    });
  }
  recorder = null;
  lesson.ended = true;
  lesson.events.push({ type: "end", clock: Math.round(clock.now()), wall: new Date().toISOString() });
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  updateRecordingUi();
  await saveNow();
}

async function keepScreenOn() {
  // a sleeping Chromebook would stop the recording
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    wakeLock = null;
  }
}

function updateRecordingUi() {
  const running = clock.running;
  const active = lessonActive();
  $("rec-start").hidden = active;
  $("rec-start-label").textContent = lesson.started ? "Continue lesson" : "Start lesson";
  $("rec-start").title = lesson.mic === "blocked" ? "The microphone was blocked last time" : "Start the lesson clock and recording";
  $("rec-live").hidden = !active;
  $("rec-pause").title = running ? "Pause" : "Resume";
  $("rec-pause-icon").setAttribute("href", "assets/icons.svg#" + (running ? "pause" : "play"));
  const status = $("rec-status");
  status.className = "rec-status" + (running ? " on" : "") + (recorder == null ? " nomic" : "");
  status.title = recorder == null ? "Not recording: no microphone. The lesson clock still runs." : "";
  $("rec-status-text").textContent = !running ? "PAUSED" : recorder != null ? "REC" : "NO MIC";
  $("export").disabled = active;
  updateClock();
  clearInterval(clockTimer);
  if (running) clockTimer = setInterval(updateClock, 250);
}

function updateClock() {
  $("clock").textContent = formatTime(clock.now());
}

// --- Export ----------------------------------------------------------------------------------------------------------

async function exportLesson(target) {
  if (target === lesson && lessonActive()) {
    toast("End the lesson first, so the recording is complete.");
    return;
  }
  if (target === lesson) await saveNow();
  const l = await db.getLesson(target.id);
  toast("Exporting…");
  const files = [];
  const takes = [];
  for (const take of l.takes) {
    const chunks = await db.getAudioChunks(l.id, take.take);
    if (chunks.length == 0) continue;
    const file = `audio-${take.take}.${take.mime.includes("mp4") ? "m4a" : "webm"}`;
    files.push({ name: file, data: new Blob(chunks, { type: take.mime }) });
    takes.push({ ...take, file });
  }
  const pageCanvas = document.createElement("canvas");
  pageCanvas.width = PAGE_W;
  pageCanvas.height = PAGE_H;
  const pc = pageCanvas.getContext("2d");
  for (let i = 0; i < l.pages.length; i++) {
    renderPage(pc, l.pages[i]);
    files.push({ name: `page-${i + 1}.png`, data: await new Promise((resolve) => pageCanvas.toBlob(resolve, "image/png")) });
  }
  const json = {
    format: FORMAT,
    title: l.title,
    created: l.created,
    exported: new Date().toISOString(),
    durationMs: l.clockMs,
    mic: l.mic,
    events: l.events,
    // each recording file starts at clockStart on the lesson clock; stroke times (the 4th number of each point, ms)
    // are on the same clock, so a point at time t was drawn (t - clockStart) ms into that file
    recordings: takes,
    page: l.page,
    pages: l.pages.map((p, i) => ({ image: `page-${i + 1}.png`, strokes: p.strokes }))
  };
  files.unshift({ name: "lesson.json", data: JSON.stringify(json) });
  const zip = await makeZip(files);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(zip);
  a.download = `${l.created.slice(0, 10)} ${l.title.replace(/[\\/:*?"<>|]+/g, "-")}.zip`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  l.exported = json.exported;
  await db.putLesson(l);
  if (lesson?.id === l.id) lesson.exported = l.exported;
  toast(`Exported ${a.download} (${formatBytes(zip.size)}) to your Downloads.`);
  if (!$("home").hidden) showHome();
}

// --- Helpers ---------------------------------------------------------------------------------------------------------

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function formatBytes(n) {
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 ** 3).toFixed(1) + " GB";
}

let toastTimer = null;
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

// --- Wiring ----------------------------------------------------------------------------------------------------------

$("new-lesson").addEventListener("click", async () => {
  // ask Chrome to keep this site's data even when the disk runs low
  navigator.storage?.persist?.();
  const l = newLessonData();
  await db.putLesson(l);
  openLesson(l.id);
});
$("back").addEventListener("click", leaveLesson);
$("title").addEventListener("input", (e) => {
  lesson.title = e.target.value.trim() || "Untitled lesson";
  scheduleSave();
});
$("rec-start").addEventListener("click", startLesson);
$("rec-pause").addEventListener("click", togglePause);
$("rec-end").addEventListener("click", () => {
  if (confirm("End the lesson? Recording will stop. You can continue it later as a new recording.")) endLesson();
});
$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);
$("prev-page").addEventListener("click", () => goToPage(pageIndex - 1));
$("next-page").addEventListener("click", () => goToPage(pageIndex + 1));
$("add-page").addEventListener("click", addPage);
$("export").addEventListener("click", () => exportLesson(lesson));

function choose(groupId, attr, value) {
  for (const b of $(groupId).querySelectorAll("button")) b.classList.toggle("active", b.dataset[attr] === String(value));
}
$("tools").addEventListener("click", (e) => {
  const t = e.target.closest("button")?.dataset.tool;
  if (t) choose("tools", "tool", (tool = t));
});
$("colors").addEventListener("click", (e) => {
  const c = e.target.closest("button")?.dataset.color;
  if (c) choose("colors", "color", (color = c));
});
$("sizes").addEventListener("click", (e) => {
  const s = e.target.closest("button")?.dataset.size;
  if (s) choose("sizes", "size", (size = Number(s)));
});

document.addEventListener("keydown", (e) => {
  if (lesson == null || e.target.tagName === "INPUT") return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if ((e.ctrlKey || e.metaKey) && key === "y") {
    e.preventDefault();
    redo();
  } else if (key === "p") choose("tools", "tool", (tool = "pen"));
  else if (key === "h") choose("tools", "tool", (tool = "highlighter"));
  else if (key === "e") choose("tools", "tool", (tool = "eraser"));
  else if (e.key === "ArrowLeft") goToPage(pageIndex - 1);
  else if (e.key === "ArrowRight") goToPage(pageIndex + 1);
});

new ResizeObserver(() => lesson && fit()).observe($("stage"));

window.addEventListener("beforeunload", (e) => {
  if (clock.running) {
    saveNow();
    e.preventDefault();
    e.returnValue = "";
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveNow();
  else if (clock.running) keepScreenOn();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

showHome();
