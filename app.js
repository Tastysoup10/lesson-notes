// Lesson Notes: handwritten notes on pages, with the lesson recorded alongside. Every pen stroke is timestamped on the
// lesson clock, which is the recording's own time (it pauses when the recording pauses), so a stroke can be matched
// to what was being said when it was written. Everything is stored in the browser (db.js) and works offline; Export
// saves a lesson as a .zip (lesson.json, a PNG per page and the audio); Summary sends it to Gemini (ai.js) for an AI
// summary, typed-up notes and a transcript.
import * as db from "./db.js";
import { makeZip } from "./zip.js";
import { summarise, testKey, AiError } from "./ai.js";
import { markdownToHtml } from "./markdown.js";
import * as drive from "./drive.js";

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

// --- Settings: theme (system / light / dark), paper (lined / grid / dots / blank) and the AI model, kept in this browser

const SETTINGS_KEY = "lesson-notes-settings";
const SETTING_CHOICES = {
  theme: ["system", "light", "dark"],
  paper: ["lined", "grid", "dots", "blank"],
  model: ["gemini-3.8-flash", "gemini-3.5-flash-lite"] // Best, Lighter (both on Gemini's free tier)
};
const settings = { theme: "system", paper: "lined", model: "gemini-3.8-flash" };
// the Gemini API key: on its own, so it never ends up anywhere the other settings go
const AI_KEY = "lesson-notes-gemini-key";
// the Google client ID for Drive backup (made by the student once, see the README)
const DRIVE_CLIENT_KEY = "lesson-notes-drive-client";
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  for (const key of Object.keys(SETTING_CHOICES)) {
    if (SETTING_CHOICES[key].includes(saved[key])) settings[key] = saved[key];
  }
} catch {}

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const dark = settings.theme === "dark" || (settings.theme === "system" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').content = dark ? "#1b1e25" : "#ffffff";
}
darkQuery.addEventListener("change", applyTheme);
applyTheme();

function changeSetting(key, value) {
  settings[key] = value;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
  applyTheme();
  showSettingChoices();
  redraw();
}

function showSettingChoices() {
  for (const key of Object.keys(SETTING_CHOICES)) {
    for (const b of $(key + "-choice").querySelectorAll("button")) b.classList.toggle("active", b.dataset.value === settings[key]);
  }
}

function stored(key) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
const aiKey = () => stored(AI_KEY);
const driveClientId = () => stored(DRIVE_CLIENT_KEY);

function openSettings() {
  showSettingChoices();
  $("ai-key").value = aiKey();
  $("ai-key-result").hidden = true;
  $("drive-client").value = driveClientId();
  $("drive-result").hidden = true;
  $("settings").showModal();
}

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
  $("summary-view").hidden = true;
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
    if (l.ai) meta.append(el("span", "chip good", "Summarised"));
    info.append(el("div", "name", l.title), meta);
    const actions = el("div", "actions");
    actions.append(
      button("Open", "folder-open", () => openLesson(l.id), "btn btn-ghost"),
      button("Summary", "sparkles", () => showSummary(l), "btn btn-ghost"),
      button("Export", "download", () => exportLesson(l), "btn btn-ghost"),
      button("", "trash-2", () => removeLesson(l), "btn btn-ghost btn-danger icon-only", "Delete")
    );
    li.append(thumb, info, actions);
    list.append(li);
  }
  showStorageNote();
  backUp();
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
  if (!confirm(`Delete "${l.title}" and its recording? This cannot be undone.` + (l.drive ? "\n\nThe copy in Google Drive is kept." : l.exported ? "" : "\n\nIt has not been exported."))) return;
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
  $("summary-view").hidden = true;
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

// The paper's pattern (Settings → Paper), in page units
function renderPaper(c) {
  c.fillStyle = "#fff";
  c.fillRect(0, 0, PAGE_W, PAGE_H);
  c.strokeStyle = c.fillStyle = "#dbeafe";
  c.lineWidth = 1;
  c.beginPath();
  if (settings.paper === "lined") {
    for (let y = LINE_GAP * 2; y < PAGE_H; y += LINE_GAP) {
      c.moveTo(0, y);
      c.lineTo(PAGE_W, y);
    }
  } else if (settings.paper === "grid") {
    for (let y = LINE_GAP; y < PAGE_H; y += LINE_GAP) {
      c.moveTo(0, y);
      c.lineTo(PAGE_W, y);
    }
    for (let x = LINE_GAP; x < PAGE_W; x += LINE_GAP) {
      c.moveTo(x, 0);
      c.lineTo(x, PAGE_H);
    }
  } else if (settings.paper === "dots") {
    c.fillStyle = "#b6c8e8";
    for (let y = LINE_GAP; y < PAGE_H; y += LINE_GAP) {
      for (let x = LINE_GAP; x < PAGE_W; x += LINE_GAP) c.rect(x - 1.5, y - 1.5, 3, 3);
    }
    c.fill();
    return;
  }
  c.stroke();
}

// One page in page units: the paper, then highlighters under the ink
function renderPage(c, page) {
  renderPaper(c);
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
  $("summarise").disabled = active;
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
    const file = audioFile(take);
    files.push({ name: file, data: new Blob(chunks, { type: take.mime }) });
    takes.push({ ...take, file });
  }
  (await pageImages(l)).forEach((png, i) => files.push({ name: `page-${i + 1}.png`, data: png }));
  if (l.ai) {
    files.push({ name: "summary.md", data: l.ai.summary });
    if (l.ai.transcript) files.push({ name: "transcript.txt", data: l.ai.transcript });
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
    paper: settings.paper,
    pages: l.pages.map((p, i) => ({ image: `page-${i + 1}.png`, strokes: p.strokes }))
  };
  files.unshift({ name: "lesson.json", data: JSON.stringify(json) });
  const zip = await makeZip(files);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(zip);
  a.download = lessonFileName(l) + ".zip";
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

// "<date> <title>", for the export's file name and the Drive folder
function lessonFileName(l) {
  return `${l.created.slice(0, 10)} ${l.title.replace(/[\\/:*?"<>|]+/g, "-")}`;
}

function audioFile(take) {
  return `audio-${take.take}.${take.mime.includes("mp4") ? "m4a" : "webm"}`;
}

// A page as a full-size PNG
const pageCanvas = document.createElement("canvas");
pageCanvas.width = PAGE_W;
pageCanvas.height = PAGE_H;
function pageImage(page) {
  renderPage(pageCanvas.getContext("2d"), page);
  return new Promise((resolve) => pageCanvas.toBlob(resolve, "image/png"));
}

async function pageImages(l) {
  const images = [];
  for (const page of l.pages) images.push(await pageImage(page));
  return images;
}

// --- Google Drive backup (drive.js) ----------------------------------------------------------------------------------

let backingUp = false;
let backUpAgain = false;
const backup = { pending: null, progress: "", error: null }; // pending: lessons not yet in Drive (null: not counted yet)

// What a lesson's backup holds: [{ name, sig (changes when the contents do), blob() }]
async function backupFiles(l) {
  const { drive: _, ...data } = l;
  const json = JSON.stringify(data);
  const files = [{ name: "lesson.json", sig: drive.signature(json), blob: () => new Blob([json], { type: "application/json" }) }];
  l.pages.forEach((page, i) => files.push({
    name: `page-${i + 1}.png`,
    sig: drive.signature(settings.paper + JSON.stringify(page.strokes)),
    blob: () => pageImage(page)
  }));
  for (const take of l.takes) {
    // a recording only grows while its lesson is going on, and those are not backed up until they end
    if (await db.countAudioChunks(l.id, take.take) > 0) {
      files.push({ name: audioFile(take), sig: "final", blob: async () => new Blob(await db.getAudioChunks(l.id, take.take), { type: take.mime }) });
    }
  }
  if (l.ai) {
    files.push({ name: "summary.md", sig: drive.signature(l.ai.summary), blob: () => new Blob([l.ai.summary], { type: "text/markdown" }) });
    if (l.ai.transcript) files.push({ name: "transcript.txt", sig: drive.signature(l.ai.transcript), blob: () => new Blob([l.ai.transcript], { type: "text/plain" }) });
  }
  return files;
}

// Backs up every lesson that changed since its last backup. signIn: called from a button press, so Google's sign-in
// window may open. Without a sign-in it only counts what is waiting. Resolves with the error, if there was one.
async function backUp(signIn = false) {
  const clientId = driveClientId();
  if (!clientId) return showBackupStatus();
  if (backingUp) {
    backUpAgain = true;
    return null;
  }
  backingUp = true;
  backup.error = null;
  try {
    if (signIn && !drive.connected()) await drive.signIn(clientId);
    do {
      backUpAgain = false;
      const todo = [];
      for (const l of await db.getLessons()) {
        if (lesson?.id === l.id && lessonActive()) continue; // still going on: backed up once it ends
        const files = await backupFiles(l);
        if (drive.needsBackup(l.drive, lessonFileName(l), files)) todo.push({ l, files });
      }
      backup.pending = todo.length;
      showBackupStatus();
      if (todo.length == 0 || !drive.connected()) break;
      for (let i = 0; i < todo.length; i++) {
        const { l, files } = todo[i];
        const label = todo.length > 1 ? `Backing up ${i + 1} of ${todo.length}` : "Backing up";
        backup.progress = label + "…";
        showBackupStatus();
        const state = await drive.backUpLesson(l.id, l.drive, lessonFileName(l), files, (k, n) => {
          backup.progress = `${label}… ${Math.round((k / n) * 100)}%`;
          showBackupStatus();
        });
        // stored on the copy being edited if the lesson is open, otherwise on the latest saved copy
        const target = lesson?.id === l.id ? lesson : await db.getLesson(l.id);
        if (target == null) continue; // deleted meanwhile
        target.drive = state;
        await db.putLesson(target);
        backup.pending--;
      }
    } while (backUpAgain);
  } catch (e) {
    backup.error = e;
  }
  backingUp = false;
  backup.progress = "";
  showBackupStatus();
  return backup.error;
}

// The button next to Settings on the home screen
function showBackupStatus() {
  const b = $("drive-status");
  b.hidden = !driveClientId() || backup.pending == null;
  if (b.hidden) return;
  const n = backup.pending;
  const lessons = n == 1 ? "1 lesson" : n + " lessons";
  let state;
  if (backingUp && backup.progress) state = ["cloud-upload", backup.progress, "", "Copying lessons to Google Drive"];
  else if (n > 0 && backup.error && backup.error.code !== "signed-out") state = ["cloud-off", `Not backed up (${n})`, "error", backup.error.message + " Press to try again."];
  else if (n > 0) state = ["cloud-upload", `Back up (${n})`, "pending", `${lessons} not in Google Drive yet. Press to back up.`];
  else state = ["cloud-check", "Backed up", "done", "Every lesson is in Google Drive"];
  const [iconName, text, className, title] = state;
  $("drive-status-icon").setAttribute("href", "assets/icons.svg#" + iconName);
  $("drive-status-text").textContent = text;
  b.className = "btn btn-ghost " + className;
  b.title = title;
  b.disabled = backingUp;
}

// Brings back the lessons that are in Drive but not on this Chromebook. Resolves with what to tell the student.
async function restoreFromDrive(report) {
  if (!drive.connected()) await drive.signIn(driveClientId());
  report("Looking in Google Drive…");
  const here = new Set((await db.getLessons()).map((l) => l.id));
  const missing = (await drive.listBackups()).filter((b) => !here.has(b.lessonId));
  if (missing.length == 0) return "Every lesson in Google Drive is already on this Chromebook.";
  if (!confirm(`Restore ${missing.length == 1 ? "1 lesson" : missing.length + " lessons"} from Google Drive onto this Chromebook?`)) return "";
  let restored = 0;
  for (let i = 0; i < missing.length; i++) {
    report(`Restoring ${i + 1} of ${missing.length}…`);
    const files = await drive.folderFiles(missing[i].folder);
    const json = files.find((f) => f.name === "lesson.json");
    if (json == null) continue;
    const l = JSON.parse(await (await drive.download(json.id)).text());
    if (l.format !== FORMAT || !l.id) continue;
    for (const take of l.takes) {
      const audio = files.find((f) => f.name === audioFile(take));
      if (audio) await db.putAudioChunk(l.id, take.take, 0, await drive.download(audio.id));
    }
    // it came from Drive, so it is already backed up
    l.drive = { folder: missing[i].folder, name: missing[i].name, files: Object.fromEntries(files.map((f) => [f.name, { id: f.id, sig: f.sig }])) };
    await db.putLesson(l);
    restored++;
  }
  if (!$("home").hidden) showHome();
  return `Restored ${restored == 1 ? "1 lesson" : restored + " lessons"}.`;
}

// --- AI summary ------------------------------------------------------------------------------------------------------

let summaryLesson = null; // the lesson on the summary screen
let summaryFrom = "home"; // the screen Back returns to
let summarising = false;

async function showSummary(target) {
  if (target === lesson && lessonActive()) {
    toast("End the lesson first, so the recording is complete.");
    return;
  }
  if (target === lesson) await saveNow();
  summaryFrom = $("lesson").hidden ? "home" : "lesson";
  summaryLesson = lesson?.id === target.id ? lesson : await db.getLesson(target.id);
  $("home").hidden = $("lesson").hidden = true;
  $("summary-view").hidden = false;
  $("summary-title").textContent = summaryLesson.title;
  renderSummary();
}

function leaveSummary() {
  if (summaryFrom === "lesson" && lesson != null) {
    $("summary-view").hidden = true;
    $("lesson").hidden = false;
    fit();
  } else {
    showHome();
  }
}

function renderSummary(error = null) {
  const ai = summaryLesson.ai;
  $("summary-status").hidden = !summarising;
  $("summary-error").hidden = summarising || error == null;
  $("summary-error-text").textContent = error ?? "";
  $("summary-start").hidden = summarising || error != null || ai != null;
  $("summary-body").hidden = $("summary-transcript").hidden = summarising || ai == null;
  $("summary-copy").disabled = $("summary-again").disabled = summarising || ai == null;
  $("summary-meta").textContent = "";
  if (ai == null) {
    $("summary-start-text").textContent = aiKey()
      ? "Gemini listens to the recording and reads your pages, then writes a summary, your notes typed up and a transcript."
      : "Gemini can summarise your lessons for free. First paste your Gemini API key in Settings.";
    $("summary-go").lastChild.textContent = aiKey() ? "Summarise" : "Open Settings";
    return;
  }
  $("summary-body").innerHTML = markdownToHtml(ai.summary);
  $("summary-transcript").hidden ||= !ai.transcript;
  const lines = $("summary-transcript-text");
  lines.replaceChildren();
  for (const line of ai.transcript.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*\[([\d:]+)\]\s*(.*)$/);
    const p = el("p");
    if (m) p.append(el("time", "", m[1]), m[2]);
    else p.textContent = line;
    lines.append(p);
  }
  $("summary-meta").textContent = `Made by ${ai.model} on ${new Date(ai.made).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.` +
    (ai.truncated ? " Gemini's reply was cut short, so the end may be missing; Redo may give a complete one." : "");
}

async function runSummary() {
  const key = aiKey();
  if (!key) {
    openSettings();
    return;
  }
  if (summarising) return;
  const l = summaryLesson;
  if (l.ai && !confirm("Make a new summary? It replaces this one and uses one of your free Gemini requests.")) return;
  summarising = true;
  const status = (text, fraction) => {
    $("summary-status-text").textContent = text;
    $("summary-progress").hidden = fraction == null;
    $("summary-progress").firstElementChild.style.width = (fraction ?? 0) * 100 + "%";
  };
  status("Getting the lesson ready…", null);
  renderSummary();
  let error = null;
  try {
    const recordings = [];
    for (const take of l.takes) {
      const chunks = await db.getAudioChunks(l.id, take.take);
      if (chunks.length > 0) recordings.push({ take: take.take, clockStart: take.clockStart, blob: new Blob(chunks, { type: take.mime }) });
    }
    if (recordings.length == 0 && !l.pages.some((p) => p.strokes.length > 0)) throw new AiError("There's nothing to summarise yet: no recording and no notes.");
    const result = await summarise({ key, model: settings.model, lesson: l, recordings, pages: await pageImages(l), formatTime, onStatus: status });
    // the lesson may have been opened again meanwhile: store it on the copy that is being edited, if there is one
    const target = lesson?.id === l.id ? lesson : l;
    target.ai = l.ai = { ...result, made: new Date().toISOString() };
    await db.putLesson(target);
  } catch (e) {
    error = e instanceof AiError ? e.message : "Something went wrong: " + e.message;
  }
  summarising = false;
  if (summaryLesson === l && !$("summary-view").hidden) renderSummary(error);
  else toast(error ?? `The summary of "${l.title}" is ready.`);
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
for (const b of document.querySelectorAll(".open-settings")) b.addEventListener("click", openSettings);
$("settings").addEventListener("close", () => !$("summary-view").hidden && !summarising && renderSummary());
$("ai-key").addEventListener("input", (e) => {
  try {
    localStorage.setItem(AI_KEY, e.target.value.trim());
  } catch {}
  $("ai-key-result").hidden = true;
});
$("ai-key-test").addEventListener("click", async () => {
  const result = $("ai-key-result");
  const key = aiKey();
  result.hidden = false;
  result.className = "hint";
  if (!key) {
    result.textContent = "Paste your key first.";
    return;
  }
  result.textContent = "Testing…";
  try {
    await testKey(key);
    result.className = "hint good";
    result.textContent = "It works: Gemini can be reached from here.";
  } catch (e) {
    result.className = "hint bad";
    result.textContent = e.message;
  }
});
$("drive-client").addEventListener("input", (e) => {
  try {
    localStorage.setItem(DRIVE_CLIENT_KEY, e.target.value.trim());
  } catch {}
  drive.signOut(); // a different client ID needs a new sign-in
  if (driveClientId()) drive.preload().catch(() => {});
  backup.pending = null;
  showBackupStatus();
});
// the buttons in Settings → Google Drive backup report in the line under them
async function driveAction(work) {
  const result = $("drive-result");
  const report = (text, className = "hint") => {
    result.hidden = !text;
    result.className = className;
    result.textContent = text;
  };
  if (!driveClientId()) return report("Paste your Google client ID first (see the README for how to make one).", "hint bad");
  for (const b of document.querySelectorAll("#drive-backup, #drive-restore")) b.disabled = true;
  try {
    report(await work(report), "hint good");
  } catch (e) {
    report(e.message, "hint bad");
  }
  for (const b of document.querySelectorAll("#drive-backup, #drive-restore")) b.disabled = false;
}
$("drive-backup").addEventListener("click", () => driveAction(async (report) => {
  report("Backing up…");
  const error = await backUp(true);
  if (error) throw error;
  return "Every lesson is backed up to Google Drive.";
}));
$("drive-restore").addEventListener("click", () => driveAction(restoreFromDrive));
$("drive-signout").addEventListener("click", () => {
  drive.signOut();
  $("drive-result").hidden = false;
  $("drive-result").className = "hint";
  $("drive-result").textContent = "Signed out of Google Drive on this Chromebook.";
  backUp();
});
$("drive-status").addEventListener("click", () => backUp(true));
window.addEventListener("online", () => backUp());
if (driveClientId() && navigator.onLine) drive.preload().catch(() => {});
$("summarise").addEventListener("click", () => showSummary(lesson));
$("summary-back").addEventListener("click", leaveSummary);
$("summary-go").addEventListener("click", runSummary);
$("summary-again").addEventListener("click", runSummary);
$("summary-retry").addEventListener("click", runSummary);
$("summary-copy").addEventListener("click", async () => {
  const ai = summaryLesson.ai;
  const text = `# ${summaryLesson.title}\n\n${ai.summary}` + (ai.transcript ? `\n\n## Transcript\n\n${ai.transcript}` : "");
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied. Paste it into a document with Ctrl+V.");
  } catch {
    toast("Couldn't copy. Use Export to save the summary instead.");
  }
});
$("settings-close").addEventListener("click", () => $("settings").close());
// a click on the dimmed background closes it too
$("settings").addEventListener("click", (e) => e.target === $("settings") && $("settings").close());
for (const key of Object.keys(SETTING_CHOICES)) {
  $(key + "-choice").addEventListener("click", (e) => {
    const value = e.target.closest("button")?.dataset.value;
    if (value) changeSetting(key, value);
  });
}
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
  if (lesson == null || $("lesson").hidden || e.target.tagName === "INPUT" || $("settings").open) return;
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
  // sw.js is always checked on the server (never from the browser's cache), so a new version is found straight away
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  // When a new version has downloaded completely and taken over, reload once so the whole page is the new version.
  // Not in the middle of a lesson: then it waits until the app is next opened.
  const updating = navigator.serviceWorker.controller != null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!updating) return;
    if (lesson != null && lessonActive()) {
      toast("An update has downloaded. It will show next time you open the app.");
    } else {
      location.reload();
    }
  });
}

showHome();
