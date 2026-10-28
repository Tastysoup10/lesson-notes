// Lesson Notes: handwritten notes on pages, with the lesson recorded alongside. Every pen stroke is timestamped on the
// lesson clock, which is the recording's own time (it pauses when the recording pauses), so a stroke can be matched
// to what was being said when it was written. Everything is stored in the browser (db.js) and works offline; Export
// saves a lesson as a .zip (lesson.json, a PNG per page and the audio); Summary sends it to Gemini (ai.js) for an AI
// summary, typed-up notes and a transcript.
import * as db from "./db.js";
import { makeZip } from "./zip.js";
import { summarise, makeQuiz, testKey, AiError } from "./ai.js";
import { markdownToHtml } from "./markdown.js";
import * as dropbox from "./dropbox.js";
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

// --- Settings: theme (system / light / dark), paper (lined / grid / dots / blank), the AI model and where lessons are
// backed up (off / Dropbox / Google Drive), kept in this browser

const SETTINGS_KEY = "lesson-notes-settings";
const SETTING_CHOICES = {
  theme: ["system", "light", "dark"],
  paper: ["lined", "grid", "dots", "blank"],
  model: ["gemini-3.8-flash", "gemini-3.5-flash-lite"], // Best, Lighter (both on Gemini's free tier)
  backupTo: ["off", "dropbox", "drive"]
};
const settings = { theme: "system", paper: "lined", model: "gemini-3.8-flash", backupTo: "off" };
// the Gemini API key: on its own, so it never ends up anywhere the other settings go
const AI_KEY = "lesson-notes-gemini-key";
// Where lessons can be backed up. Each needs a key the student makes once (see the README); each lesson keeps its own
// backup state for each (lesson.backups.dropbox, lesson.backups.drive), so switching between them is safe.
const BACKUPS = {
  dropbox: { cloud: dropbox, name: "Dropbox", keyStore: "lesson-notes-dropbox-app", keyName: "Dropbox app key", readme: "dropbox-setting-it-up-once-about-5-minutes-free" },
  drive: { cloud: drive, name: "Google Drive", keyStore: "lesson-notes-drive-client", keyName: "Google client ID", readme: "google-drive-setting-it-up-once-about-10-minutes-free" }
};
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  for (const key of Object.keys(SETTING_CHOICES)) {
    if (SETTING_CHOICES[key].includes(saved[key])) settings[key] = saved[key];
  }
  // from before there was a choice: Dropbox was the only backup
  if (saved.backupTo == null && localStorage.getItem(BACKUPS.dropbox.keyStore)) settings.backupTo = "dropbox";
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
  if (key === "backupTo") backupChanged();
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
// the chosen backup ({ cloud, name, … } from BACKUPS), or null when backup is off, and its key
const backupTarget = () => BACKUPS[settings.backupTo] ?? null;
const backupKey = () => (backupTarget() ? stored(backupTarget().keyStore) : "");

function openSettings() {
  showSettingChoices();
  $("ai-key").value = aiKey();
  $("ai-key-result").hidden = true;
  $("backup-result").hidden = true;
  showBackupSettings();
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

// The title a new lesson gets ("Lesson Wed, 28 Oct"); while a lesson still has it (or one the AI gave it), a summary
// renames it to what the lesson was about
function defaultTitle(created) {
  return "Lesson " + new Date(created).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function newLessonData() {
  const now = new Date();
  return {
    format: FORMAT,
    id: crypto.randomUUID(),
    title: defaultTitle(now),
    created: now.toISOString(),
    clockMs: 0, // lesson time so far
    started: false,
    running: false,
    ended: false,
    events: [], // { type: start | pause | resume | end | interrupted, clock (ms), wall (ISO time) }
    takes: [], // recordings: { take, clockStart (ms), mime }; a new take starts after the app was reopened mid-lesson
    mic: null, // "ok", or why recording was not possible
    marks: [], // moments marked during the lesson: { kind: important | confused, clock (ms), page }
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

let selecting = null; // Select mode: the ids of the ticked lessons, or null when not selecting

async function showHome() {
  closePlayer();
  lesson = null;
  $("lesson").hidden = true;
  $("summary-view").hidden = true;
  $("home").hidden = false;
  const lessons = (await db.getLessons()).sort((a, b) => b.created.localeCompare(a.created));
  const list = $("lesson-list");
  list.replaceChildren();
  $("empty").hidden = lessons.length > 0;
  if (lessons.length == 0) selecting = null;
  $("select-lessons").hidden = lessons.length == 0 || selecting != null;
  $("select-bar").hidden = selecting == null;
  for (const l of lessons) {
    const li = document.createElement("li");
    li.className = "lesson-card";
    const thumb = el("div", "thumb");
    thumb.append(icon("notebook-pen"));
    if (selecting != null) {
      // the whole card ticks and unticks it
      const box = el("input", "select-box");
      box.type = "checkbox";
      box.tabIndex = -1;
      box.checked = selecting.has(l.id);
      thumb.replaceChildren(box);
      li.classList.add("selectable");
      li.classList.toggle("selected", box.checked);
      li.addEventListener("click", () => {
        if (selecting.has(l.id)) selecting.delete(l.id);
        else selecting.add(l.id);
        box.checked = selecting.has(l.id);
        li.classList.toggle("selected", box.checked);
        showSelectBar(lessons);
      });
    }
    const info = el("div", "info");
    info.title = selecting ? "" : "Open";
    info.addEventListener("click", () => selecting == null && openLesson(l.id));
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
  if (selecting != null) showSelectBar(lessons);
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

function showSelectBar(lessons) {
  const n = selecting.size;
  $("select-count").textContent = n == 0 ? "Tap lessons to choose them" : n == 1 ? "1 lesson chosen" : n + " lessons chosen";
  $("select-delete").disabled = n == 0;
  $("select-all").textContent = n == lessons.length ? "Select none" : "Select all";
}

function setSelecting(on) {
  selecting = on ? new Set() : null;
  showHome();
}

async function deleteSelected() {
  const chosen = (await db.getLessons()).filter((l) => selecting.has(l.id));
  if (chosen.length == 0) return;
  const unsaved = chosen.filter((l) => !l.exported && !l.backups && !l.backup).length;
  const what = chosen.length == 1 ? `"${chosen[0].title}" and its recording` : `these ${chosen.length} lessons and their recordings`;
  if (!confirm(`Delete ${what}? This cannot be undone.` +
    (unsaved ? `\n\n${unsaved == chosen.length ? (chosen.length == 1 ? "It has" : "They have") : unsaved + " of them " + (unsaved == 1 ? "has" : "have")} not been exported or backed up.` : "") +
    (chosen.some((l) => l.backups || l.backup) ? "\n\nBackup copies are kept." : ""))) return;
  for (const l of chosen) await db.deleteLesson(l.id);
  selecting = null;
  toast(chosen.length == 1 ? "Deleted 1 lesson." : `Deleted ${chosen.length} lessons.`);
  showHome();
}

async function removeLesson(l) {
  if (!confirm(`Delete "${l.title}" and its recording? This cannot be undone.` + (l.backups || l.backup ? "\n\nThe backup copy is kept." : l.exported ? "" : "\n\nIt has not been exported."))) return;
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
  closePlayer();
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
  closeTextEditor(true);
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

// One page in page units: the paper, then highlighters under the ink. fadeAfter (lesson time): strokes written later
// are faded, so while listening back the ink follows the recording.
function renderPage(c, page, fadeAfter = null) {
  renderPaper(c);
  const faded = (s) => fadeAfter != null && !s.beforeStart && s.points[0][3] > fadeAfter;
  const fade = (s) => (c.globalAlpha = faded(s) ? 0.18 : 1);
  for (const s of page.strokes) {
    if (s.tool !== "highlighter") continue;
    fade(s);
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
    if (s.tool === "highlighter" || s === typing?.old) continue; // (typed text being changed shows in its editor)
    fade(s);
    if (s.tool === "text") {
      drawText(c, s);
      continue;
    }
    if (faded(s)) {
      // one path, so the see-through segments do not show their overlaps
      c.strokeStyle = strokeColor(s);
      c.lineWidth = strokeWidth(s, 0.5);
      c.lineCap = c.lineJoin = "round";
      c.beginPath();
      c.moveTo(s.points[0][0], s.points[0][1]);
      for (const p of s.points) c.lineTo(p[0], p[1]);
      c.stroke();
      continue;
    }
    for (let i = 1; i < s.points.length; i++) drawSegment(c, s, s.points[i - 1], s.points[i]);
  }
}

function redraw() {
  if (lesson == null) return;
  ctx.save();
  renderPage(ctx, lesson.pages[pageIndex], player.at);
  ctx.restore();
}

// --- Typed text: { tool: "text", text, fontSize, w, h (its box), color, points: [[x, y (top left), 0.5, time]] } -------

const TEXT_SIZES = { 2: 30, 4: 42, 8: 60 }; // font size in page units for each size button
const textFont = (px) => `500 ${px}px Inter, system-ui, sans-serif`;
const measurer = document.createElement("canvas").getContext("2d");

function drawText(c, s) {
  c.fillStyle = COLORS[s.color];
  c.font = textFont(s.fontSize);
  c.textBaseline = "top";
  s.text.split("\n").forEach((line, i) => c.fillText(line, s.points[0][0], s.points[0][1] + i * s.fontSize * 1.3));
}

function textBox(text, fontSize) {
  measurer.font = textFont(fontSize);
  const lines = text.split("\n");
  return { w: Math.ceil(Math.max(...lines.map((l) => measurer.measureText(l).width))), h: Math.ceil(lines.length * fontSize * 1.3) };
}

// The text being typed: { box (the textarea), x, y, fontSize, color, time, beforeStart, old (the text item being changed) }
let typing = null;

function openTextEditor(p, old = null) {
  closeTextEditor(true);
  const fontSize = old?.fontSize ?? TEXT_SIZES[size];
  // a tap puts the middle of the first line there
  const [x, y] = old ? old.points[0] : [p[0], Math.max(0, p[1] - fontSize * 0.65)];
  const box = el("textarea", "text-editor");
  box.value = old?.text ?? "";
  box.rows = 1;
  box.style.font = textFont(fontSize * viewScale);
  box.style.color = COLORS[old?.color ?? color];
  const page = canvas.getBoundingClientRect();
  const stage = $("stage").getBoundingClientRect();
  box.style.left = page.left - stage.left + x * viewScale + "px";
  box.style.top = page.top - stage.top + y * viewScale + "px";
  box.style.maxWidth = (PAGE_W - x) * viewScale + "px";
  typing = { box, x, y, fontSize, color: old?.color ?? color, time: old?.points[0][3] ?? Math.round(clock.now()), beforeStart: old?.beforeStart ?? !lesson.started, old };
  box.addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing is not a shortcut
    if (e.key === "Escape") {
      e.preventDefault();
      closeTextEditor(false);
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      closeTextEditor(true);
    }
  });
  box.addEventListener("blur", () => closeTextEditor(true));
  $("stage").append(box);
  redraw();
  setTimeout(() => box.focus());
}

// save: keep what was typed (an empty box removes the text); otherwise put back what was there
function closeTextEditor(save) {
  if (typing == null) return;
  const t = typing;
  typing = null;
  t.box.remove();
  const text = t.box.value.replace(/\s+$/, "");
  const strokes = lesson.pages[pageIndex].strokes;
  if (save && text !== (t.old?.text ?? "")) {
    const item = text ? { tool: "text", color: t.color, size, fontSize: t.fontSize, text, beforeStart: t.beforeStart, points: [[t.x, t.y, 0.5, t.time]], ...textBox(text, t.fontSize) } : null;
    if (t.old) {
      const index = strokes.indexOf(t.old);
      strokes.splice(index, 1, ...(item ? [item] : []));
      pushUndo({ type: "edit", page: pageIndex, before: t.old, after: item, index });
    } else if (item) {
      strokes.push(item);
      pushUndo({ type: "add", page: pageIndex, stroke: item });
    }
    scheduleSave();
  }
  redraw();
}

// --- Straight lines: snapped to level, upright or 45° when close -------------------------------------------------------

function snapLine(a, p) {
  const dx = p[0] - a[0];
  const dy = p[1] - a[1];
  const angle = Math.atan2(dy, dx);
  const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  if (Math.abs(angle - snapped) > 0.12) return [p[0], p[1], 0.5, p[3]];
  const length = Math.hypot(dx, dy);
  return [Math.round((a[0] + Math.cos(snapped) * length) * 10) / 10, Math.round((a[1] + Math.sin(snapped) * length) * 10) / 10, 0.5, p[3]];
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
  const p = pointFrom(e);
  if (tool === "text") {
    // tapping typed text changes it; anywhere else starts new text
    e.preventDefault();
    const old = lesson.pages[pageIndex].strokes.findLast((s) => s.tool === "text" && distanceTo(s, p) < 6);
    openTextEditor(p, old ?? null);
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  if (tool === "line") {
    current = { tool: "pen", color, size, beforeStart: !lesson.started, points: [[p[0], p[1], 0.5, p[3]], [p[0], p[1], 0.5, p[3]]], line: true };
    return;
  }
  if (tool === "listen") {
    listenAt(p);
    return;
  }
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
  if (current?.line) {
    // the line so far, drawn over the page
    current.points[1] = snapLine(current.points[0], pointFrom(e));
    redraw();
    ctx.save();
    drawSegment(ctx, current, current.points[0], current.points[1]);
    ctx.restore();
    return;
  }
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
    if (stroke.line) {
      delete stroke.line;
      const [a, b] = stroke.points;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 3) return redraw(); // a tap, not a line
    }
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

// How far p is from what a stroke drew (0 inside typed text's box)
function distanceTo(s, p) {
  if (s.tool === "text") {
    const [x, y] = s.points[0];
    return Math.hypot(Math.max(x - p[0], 0, p[0] - x - s.w), Math.max(y - p[1], 0, p[1] - y - s.h));
  }
  let d = Infinity;
  for (let k = 1; k < s.points.length; k++) d = Math.min(d, distanceToSegment(p, s.points[k - 1], s.points[k]));
  return d - strokeWidth(s, 1) / 2;
}

// Removes every stroke the eraser touches (whole strokes, so the notes stay clean for the AI)
function eraseAt(p) {
  const strokes = lesson.pages[pageIndex].strokes;
  let changed = false;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    if (distanceTo(s, p) < ERASER_RADIUS) {
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
  } else if (action.type === "edit") {
    // typed text changed (or emptied): swap one version for the other
    const [from, to] = undo ? [action.after, action.before] : [action.before, action.after];
    const i = from ? strokes.indexOf(from) : -1;
    if (i >= 0) strokes.splice(i, 1, ...(to ? [to] : []));
    else if (to) strokes.splice(action.index, 0, to);
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
  closeTextEditor(true);
  const action = undoStack.pop();
  if (action == null) return;
  apply(action, true);
  redoStack.push(action);
  updateUndoUi();
}

function redo() {
  closeTextEditor(true);
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
  closeTextEditor(true);
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
  closePlayer(); // not while recording
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
    recorder.onstop = () => {
      stopMicWatch();
      stream.getTracks().forEach((t) => t.stop());
    };
    recorder.start(AUDIO_CHUNK_MS);
    watchMic(stream);
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

// --- Microphone check: a level meter while recording, and a warning if it hears nothing ---------------------------------

const MIC_QUIET_MS = 30000; // this long without sound (while the clock runs) and the student is warned
const mic = { context: null, timer: null, quietSince: 0, warned: false };

function watchMic(stream) {
  stopMicWatch();
  let analyser;
  try {
    mic.context = new AudioContext();
    analyser = mic.context.createAnalyser();
    analyser.fftSize = 1024;
    mic.context.createMediaStreamSource(stream).connect(analyser);
  } catch {
    return; // no meter, but the recording itself is fine
  }
  const samples = new Float32Array(analyser.fftSize);
  mic.quietSince = performance.now();
  mic.warned = false;
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => {
      if (lesson == null || !lessonActive()) return;
      setMicWarning(true);
      toast("The microphone stopped (unplugged or turned off?). Press End lesson, then Continue lesson to start recording again.");
    });
  }
  mic.timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += v * v;
    // loudness from -60 dB (silence) to -15 dB (someone talking nearby) as 0 to 1
    const level = Math.max(0, Math.min(1, (20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9) + 60) / 45));
    $("mic-level-bar").style.width = Math.round(level * 100) + "%";
    const now = performance.now();
    if (!clock.running || level > 0.12) {
      mic.quietSince = now;
      if (mic.warned) {
        mic.warned = false;
        setMicWarning(false);
      }
    } else if (!mic.warned && now - mic.quietSince > MIC_QUIET_MS) {
      mic.warned = true;
      setMicWarning(true);
      toast("The microphone hasn't heard anything for 30 seconds. Check it isn't muted, covered or unplugged.");
    }
  }, 100);
}

function stopMicWatch() {
  clearInterval(mic.timer);
  mic.context?.close().catch(() => {});
  mic.context = null;
  $("mic-level-bar").style.width = "0";
  setMicWarning(false);
}

function setMicWarning(on) {
  $("mic-level").classList.toggle("quiet", on);
  $("mic-level").title = on ? "The microphone isn't hearing anything" : "Microphone level: it moves when the microphone hears sound";
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
  $("mic-level").hidden = recorder == null;
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

// --- Marks: Important / Confused, pressed during the lesson ------------------------------------------------------------

function addMark(kind) {
  if (lesson == null || !lessonActive()) return;
  const t = Math.round(clock.now());
  (lesson.marks ??= []).push({ kind, clock: t, page: pageIndex });
  const b = $("mark-" + kind);
  b.classList.remove("flash");
  void b.offsetWidth; // restart the animation
  b.classList.add("flash");
  toast(kind === "important"
    ? `Marked as important at ${formatTime(t)}.`
    : `Marked as confusing at ${formatTime(t)}. The summary will explain this part again.`);
  scheduleSave();
}

// --- Replay: tap the writing to hear what was being said when it was written -------------------------------------------

// takes: the lesson's recordings as playable files ({ clockStart, url }); index: the one in audio; at: the lesson time
// being played (the page fades what was written after it), or null when the player is closed
const player = { lessonId: null, takes: [], index: -1, audio: null, at: null, seeking: false };

async function loadReplay() {
  if (player.lessonId === lesson.id) return player.takes;
  closePlayer();
  for (const take of lesson.takes) {
    const chunks = await db.getAudioChunks(lesson.id, take.take);
    if (chunks.length > 0) player.takes.push({ clockStart: take.clockStart, url: URL.createObjectURL(new Blob(chunks, { type: take.mime })) });
  }
  player.lessonId = lesson.id;
  return player.takes;
}

function closePlayer() {
  player.audio?.pause();
  for (const take of player.takes) URL.revokeObjectURL(take.url);
  Object.assign(player, { lessonId: null, takes: [], index: -1, audio: null, at: null });
  $("player").hidden = true;
  if (lesson != null && !$("lesson").hidden) redraw();
}

// Opens the player at lesson time t (ms), playing unless play is false
async function playAt(t, play = true) {
  if (lessonActive()) {
    toast("End the lesson to listen back.");
    return;
  }
  const takes = await loadReplay();
  if (takes.length == 0) {
    toast(lesson.takes.length ? "The recording of this lesson is missing." : "This lesson has no recording to listen to.");
    return;
  }
  t = Math.max(0, Math.min(t, lesson.clockMs));
  const i = Math.max(0, takes.findLastIndex((take) => take.clockStart <= t));
  await playTake(i, t - takes[i].clockStart, play);
}

async function playTake(i, offsetMs, play) {
  if (player.index !== i) {
    player.audio?.pause();
    const audio = new Audio(player.takes[i].url);
    await new Promise((resolve) => {
      audio.onloadedmetadata = resolve;
      audio.onerror = resolve;
    });
    if (!Number.isFinite(audio.duration)) {
      // a recording saved in chunks doesn't say how long it is, so Chrome can't jump around in it until it has
      // looked through it: asking for a time far past the end makes it do that
      audio.currentTime = 1e101;
      await Promise.race([new Promise((r) => audio.addEventListener("durationchange", r, { once: true })), new Promise((r) => setTimeout(r, 3000))]);
    }
    audio.ontimeupdate = audio.onplay = audio.onpause = updatePlayer;
    // one recording ends: the next one (after an interruption) carries on
    audio.onended = () => (i + 1 < player.takes.length ? playTake(i + 1, 0, true) : updatePlayer());
    player.audio = audio;
    player.index = i;
  }
  player.audio.currentTime = Math.max(0, offsetMs / 1000);
  $("player").hidden = false;
  showMarkChips();
  if (play) await player.audio.play().catch(() => {});
  updatePlayer();
}

function playerTime() {
  return player.takes[player.index].clockStart + player.audio.currentTime * 1000;
}

function updatePlayer() {
  if (player.audio == null) return;
  const t = Math.min(playerTime(), lesson.clockMs);
  $("player-time").textContent = formatTime(t);
  $("player-length").textContent = formatTime(lesson.clockMs);
  if (!player.seeking) $("player-seek").value = Math.round((t / Math.max(1, lesson.clockMs)) * 1000);
  $("player-play-icon").setAttribute("href", "assets/icons.svg#" + (player.audio.paused ? "play" : "pause"));
  player.at = t;
  redraw();
}

// The marked moments as buttons in the player: a little before each, to hear what led up to it
function showMarkChips() {
  const chips = $("player-marks");
  chips.replaceChildren();
  for (const m of lesson.marks ?? []) {
    const label = (m.kind === "confused" ? "Confused " : "Important ") + formatTime(m.clock);
    chips.append(button(label, m.kind === "confused" ? "circle-help" : "star", () => {
      goToPage(m.page);
      playAt(m.clock - (m.kind === "confused" ? 30000 : 10000));
    }, "mark-chip " + m.kind, "Listen to the moment you marked"));
  }
}

// The Listen tool: the stroke nearest the tap, and the recording from a few seconds before it was written
function listenAt(p) {
  let best = null;
  let bestDistance = 24;
  for (const s of lesson.pages[pageIndex].strokes) {
    const d = distanceTo(s, p);
    if (d < bestDistance) {
      best = s;
      bestDistance = d;
    }
  }
  if (best == null) toast("Tap on something you wrote to hear that moment.");
  else if (best.beforeStart) toast("That was written before the lesson started, so there's nothing to hear.");
  else playAt(best.points[0][3] - 3000);
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
    marks: l.marks ?? [],
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

// "<date> <title>", for the export's file name and the backup folder
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

// --- Backup to Dropbox (dropbox.js) or Google Drive (drive.js) ------------------------------------------------------

let backingUp = false;
let backUpAgain = false;
const backup = { pending: null, progress: "", error: null }; // pending: lessons not backed up yet (null: not counted yet)

// What a lesson's backup holds: [{ name, sig (changes when the contents do), blob() }]
async function backupFiles(l) {
  // without the backup states, which change when it is backed up
  const { backups: _, backup: _old, drive: _older, ...data } = l;
  const json = JSON.stringify(data);
  const files = [{ name: "lesson.json", sig: dropbox.signature(json), blob: () => new Blob([json], { type: "application/json" }) }];
  l.pages.forEach((page, i) => files.push({
    name: `page-${i + 1}.png`,
    sig: dropbox.signature(settings.paper + JSON.stringify(page.strokes)),
    blob: () => pageImage(page)
  }));
  for (const take of l.takes) {
    // a recording only grows while its lesson is going on, and those are not backed up until they end
    if (await db.countAudioChunks(l.id, take.take) > 0) {
      files.push({ name: audioFile(take), sig: "final", blob: async () => new Blob(await db.getAudioChunks(l.id, take.take), { type: take.mime }) });
    }
  }
  if (l.ai) {
    files.push({ name: "summary.md", sig: dropbox.signature(l.ai.summary), blob: () => new Blob([l.ai.summary], { type: "text/markdown" }) });
    if (l.ai.transcript) files.push({ name: "transcript.txt", sig: dropbox.signature(l.ai.transcript), blob: () => new Blob([l.ai.transcript], { type: "text/plain" }) });
  }
  return files;
}

// A lesson's backup state in one place (lessons from before the choice have their Dropbox one in lesson.backup)
function backupState(l, id) {
  return l.backups?.[id] ?? (id === "dropbox" ? l.backup : undefined);
}

function setBackupState(l, id, state) {
  l.backups = { ...l.backups, [id]: state };
  if (l.backup) {
    l.backups.dropbox ??= l.backup;
    delete l.backup;
  }
}

const connected = () => backupTarget()?.cloud.connected(backupKey()) ?? false;

// Signs in to the chosen backup. Dropbox leaves the page for dropbox.com (so not in the middle of a lesson); Google
// opens its sign-in window, so this must come straight from a button press.
async function connectBackup() {
  const target = backupTarget();
  if (target === BACKUPS.dropbox) {
    if (lesson != null && lessonActive()) throw new Error("End the lesson first, then connect Dropbox.");
    if (lesson != null) await saveNow();
    await dropbox.signIn(backupKey());
    return "Going to Dropbox…";
  }
  await drive.signIn(backupKey());
  showBackupSettings();
  const error = await backUp();
  if (error) throw error;
  return "Signed in. Every lesson is backed up to Google Drive.";
}

// Backs up every lesson that changed since its last backup (only counts them when not signed in).
// Resolves with the error, if there was one.
async function backUp() {
  const target = backupTarget();
  if (!backupKey()) return showBackupStatus();
  if (backingUp) {
    backUpAgain = true;
    return null;
  }
  backingUp = true;
  backup.error = null;
  try {
    do {
      backUpAgain = false;
      const todo = [];
      for (const l of await db.getLessons()) {
        if (lesson?.id === l.id && lessonActive()) continue; // still going on: backed up once it ends
        const files = await backupFiles(l);
        if (target.cloud.needsBackup(backupState(l, settings.backupTo), lessonFileName(l), files)) todo.push({ l, files });
      }
      backup.pending = todo.length;
      showBackupStatus();
      if (todo.length == 0 || !connected()) break;
      for (let i = 0; i < todo.length; i++) {
        const { l, files } = todo[i];
        const label = todo.length > 1 ? `Backing up ${i + 1} of ${todo.length}` : "Backing up";
        backup.progress = label + "…";
        showBackupStatus();
        const state = await target.cloud.backUpLesson(backupState(l, settings.backupTo), lessonFileName(l), files, (k, n) => {
          backup.progress = `${label}… ${Math.round((k / n) * 100)}%`;
          showBackupStatus();
        }, l.id);
        // stored on the copy being edited if the lesson is open, otherwise on the latest saved copy
        const copy = lesson?.id === l.id ? lesson : await db.getLesson(l.id);
        if (copy == null) continue; // deleted meanwhile
        setBackupState(copy, settings.backupTo, state);
        await db.putLesson(copy);
        backup.pending--;
      }
    } while (backUpAgain && backupTarget() === target);
  } catch (e) {
    backup.error = e;
  }
  backingUp = false;
  backup.progress = "";
  showBackupStatus();
  // switched to a different backup meanwhile: count (and back up) for that one
  if (backupTarget() !== target) backUp();
  return backup.error;
}

// The button next to Settings on the home screen
function showBackupStatus() {
  const b = $("backup-status");
  const target = backupTarget();
  b.hidden = !backupKey() || backup.pending == null;
  if (b.hidden) return;
  const n = backup.pending;
  const lessons = n == 1 ? "1 lesson" : n + " lessons";
  const signIn = target === BACKUPS.dropbox ? "Connect Dropbox" : "Sign in to Drive";
  let state;
  if (backingUp && backup.progress) state = ["cloud-upload", backup.progress, "", `Copying lessons to ${target.name}`];
  else if (n > 0 && !connected()) state = ["cloud-upload", `${signIn} (${n})`, "pending", `${lessons} not in ${target.name} yet. Press to sign in and back up.`];
  else if (n > 0 && backup.error) state = ["cloud-off", `Not backed up (${n})`, "error", backup.error.message + " Press to try again."];
  else if (n > 0) state = ["cloud-upload", `Back up (${n})`, "pending", `${lessons} not in ${target.name} yet. Press to back up.`];
  else state = ["cloud-check", "Backed up", "done", `Every lesson is in ${target.name}`];
  const [iconName, text, className, title] = state;
  $("backup-status-icon").setAttribute("href", "assets/icons.svg#" + iconName);
  $("backup-status-text").textContent = text;
  b.className = "btn btn-ghost " + className;
  b.title = title;
  b.disabled = backingUp;
}

// Brings back the lessons that are in the backup but not on this Chromebook. Resolves with what to tell the student.
async function restoreLessons(report) {
  const target = backupTarget();
  if (!connected()) {
    const signedIn = await connectBackup();
    if (target === BACKUPS.dropbox) return signedIn; // the page is going to dropbox.com
  }
  report(`Looking in ${target.name}…`);
  const here = new Set((await db.getLessons()).map((l) => l.id));
  const found = [];
  for (const folder of await target.cloud.listBackups()) {
    if (here.has(folder.lessonId)) continue; // Google Drive knows which lesson a folder is without downloading it
    const files = await target.cloud.folderFiles(folder.ref);
    const json = files.find((f) => f.name === "lesson.json");
    if (json == null) continue;
    const l = JSON.parse(await (await target.cloud.download(json.ref)).text());
    if (l.format === FORMAT && l.id && !here.has(l.id)) found.push({ l, folder, files });
  }
  if (found.length == 0) return `Every lesson in ${target.name} is already on this Chromebook.`;
  if (!confirm(`Restore ${found.length == 1 ? "1 lesson" : found.length + " lessons"} from ${target.name} onto this Chromebook?`)) return "";
  for (let i = 0; i < found.length; i++) {
    const { l, folder, files } = found[i];
    report(`Restoring ${i + 1} of ${found.length}…`);
    for (const take of l.takes) {
      const audio = files.find((f) => f.name === audioFile(take));
      if (audio) await db.putAudioChunk(l.id, take.take, 0, await target.cloud.download(audio.ref));
    }
    // it came from the backup, so what is there is already backed up
    const sigs = Object.fromEntries((await backupFiles(l)).map((f) => [f.name, f.sig]));
    const present = files.filter((f) => sigs[f.name] != null);
    l.backups = {};
    delete l.backup;
    setBackupState(l, settings.backupTo, target.cloud.restoredState(folder, present, (name) => sigs[name]));
    await db.putLesson(l);
  }
  if (!$("home").hidden) showHome();
  return `Restored ${found.length == 1 ? "1 lesson" : found.length + " lessons"}.`;
}

// Settings → Backup: the key box, the buttons and the setup hint for the chosen backup
function showBackupSettings() {
  const target = backupTarget();
  $("backup-setup").hidden = target == null;
  if (target == null) return;
  const key = $("backup-key");
  key.placeholder = "Paste your " + target.keyName;
  key.setAttribute("aria-label", target.keyName);
  key.value = backupKey();
  const on = connected();
  $("backup-connect").hidden = on;
  $("backup-connect-label").textContent = target === BACKUPS.dropbox ? "Connect Dropbox" : "Sign in to Google Drive";
  $("backup-now").hidden = $("backup-signout").hidden = !on;
  const hint = $("backup-hint");
  const link = el("a", "", "the steps in the README");
  link.href = "https://github.com/Tastysoup10/lesson-notes#" + target.readme;
  link.target = "_blank";
  link.rel = "noopener";
  if (target === BACKUPS.dropbox) {
    hint.replaceChildren(
      "Copies every lesson to your Dropbox (Apps → your app's folder) whenever you're online, and stays connected. The app can only see its own folder. To set it up once, follow ",
      link, ". The Redirect URI to add is ", el("code", "", dropbox.redirectUri())
    );
  } else {
    hint.replaceChildren(
      "Copies every lesson to a \"Lesson Notes\" folder in your Google Drive. Google's sign-in lasts about an hour, then the button asks again. School Google accounts usually block this, so use a personal one. To set it up once, follow ",
      link, ". The JavaScript origin to add is ", el("code", "", location.origin)
    );
  }
}

function backupChanged() {
  backup.pending = null;
  backup.error = null;
  $("backup-result").hidden = true;
  if (settings.backupTo === "drive" && backupKey() && navigator.onLine) drive.preload().catch(() => {});
  showBackupSettings();
  showBackupStatus();
  backUp();
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
  $("summary-copy").disabled = $("summary-again").disabled = $("summary-quiz").disabled = summarising || ai == null;
  $("quiz").hidden = true;
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

// --- Quiz: practice questions from the summary ------------------------------------------------------------------------

let quiz = null; // { questions, i (current), score, answered } while a quiz is shown

// fresh: new questions from Gemini (otherwise the lesson's saved quiz, if it has one)
async function startQuiz(fresh) {
  const l = summaryLesson;
  if (l.ai == null) return;
  if (fresh || l.quiz == null) {
    if (!aiKey()) return openSettings();
    for (const id of ["summary-error", "summary-start", "summary-body", "summary-transcript", "quiz"]) $(id).hidden = true;
    $("summary-status").hidden = false;
    $("summary-status-text").textContent = "Gemini is writing your quiz…";
    $("summary-progress").hidden = true;
    $("summary-quiz").disabled = true;
    try {
      const questions = await makeQuiz({ key: aiKey(), model: settings.model, title: l.title, summary: l.ai.summary, transcript: l.ai.transcript });
      const copy = lesson?.id === l.id ? lesson : l;
      copy.quiz = l.quiz = { made: new Date().toISOString(), questions, best: null };
      await db.putLesson(copy);
    } catch (e) {
      $("summary-status").hidden = true;
      if (summaryLesson === l) renderSummary(e instanceof AiError ? e.message : "Something went wrong: " + e.message);
      return;
    }
    $("summary-status").hidden = true;
    $("summary-quiz").disabled = false;
    if (summaryLesson !== l || $("summary-view").hidden) return;
  }
  // the questions in a new order each time
  const questions = [...l.quiz.questions].sort(() => Math.random() - 0.5);
  quiz = { questions, i: 0, score: 0, answered: false };
  showQuiz();
}

function showQuiz() {
  for (const id of ["summary-status", "summary-error", "summary-start", "summary-body", "summary-transcript"]) $(id).hidden = true;
  $("summary-meta").textContent = "";
  $("quiz").hidden = false;
  const choices = $("quiz-choices");
  const actions = $("quiz-actions");
  choices.replaceChildren();
  actions.replaceChildren();
  $("quiz-explanation").hidden = true;
  const n = quiz.questions.length;
  const q = quiz.questions[quiz.i];
  if (q == null) {
    // the end
    const l = summaryLesson;
    const first = l.quiz.best == null;
    const improved = !first && quiz.score > l.quiz.best;
    if (first || improved) {
      l.quiz.best = quiz.score;
      db.putLesson(lesson?.id === l.id ? Object.assign(lesson, { quiz: l.quiz }) : l);
    }
    $("quiz-progress").textContent = "Quiz finished";
    $("quiz-question").textContent = quiz.score == n ? "Perfect, every answer right!" : quiz.score >= n * 0.7 ? "Well done!" : "Keep going: try it again after rereading the summary.";
    choices.append(el("p", "quiz-score", `${quiz.score} / ${n}`));
    if (improved) choices.append(el("p", "hint good", "Your best score on this lesson."));
    else if (!first) choices.append(el("p", "hint", `Your best: ${l.quiz.best} / ${n}`));
    actions.append(
      button("Try again", "refresh-cw", () => startQuiz(false), "btn btn-primary"),
      button("New questions", "sparkles", () => startQuiz(true), "btn btn-secondary"),
      button("Back to summary", "arrow-left", () => renderSummary(), "btn btn-ghost")
    );
    return;
  }
  $("quiz-progress").textContent = `Question ${quiz.i + 1} of ${n} · ${quiz.score} right`;
  $("quiz-question").textContent = q.question;
  q.choices.forEach((text, k) => {
    const b = el("button", "", text);
    b.addEventListener("click", () => answerQuiz(k));
    choices.append(b);
  });
  actions.append(button("Back to summary", "arrow-left", () => renderSummary(), "btn btn-ghost"));
}

function answerQuiz(k) {
  const q = quiz.questions[quiz.i];
  const buttons = [...$("quiz-choices").children];
  for (const b of buttons) b.disabled = true;
  buttons[q.answer].classList.add("right");
  if (k === q.answer) quiz.score++;
  else buttons[k].classList.add("wrong");
  const explanation = $("quiz-explanation");
  explanation.hidden = false;
  explanation.textContent = (k === q.answer ? "Right! " : "Not quite. ") + q.explanation;
  $("quiz-progress").textContent = `Question ${quiz.i + 1} of ${quiz.questions.length} · ${quiz.score} right`;
  const last = quiz.i + 1 == quiz.questions.length;
  $("quiz-actions").replaceChildren(button(last ? "See my score" : "Next question", "chevron-right", () => {
    quiz.i++;
    showQuiz();
  }, "btn btn-primary"));
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
    const { title, ...ai } = result;
    target.ai = l.ai = { ...ai, made: new Date().toISOString() };
    const renamed = title && target.titleBy !== "student" && (target.titleBy === "ai" || target.title === defaultTitle(target.created));
    if (renamed) {
      target.title = l.title = title;
      target.titleBy = l.titleBy = "ai";
      if (lesson?.id === target.id) $("title").value = title;
      $("summary-title").textContent = title;
    }
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
$("select-lessons").addEventListener("click", () => setSelecting(true));
$("select-cancel").addEventListener("click", () => setSelecting(false));
$("select-delete").addEventListener("click", deleteSelected);
$("select-all").addEventListener("click", async () => {
  const ids = (await db.getLessons()).map((l) => l.id);
  selecting = new Set(selecting.size == ids.length ? [] : ids);
  showHome();
});
document.addEventListener("keydown", (e) => e.key === "Escape" && selecting != null && !$("home").hidden && setSelecting(false));
for (const b of document.querySelectorAll(".open-settings")) b.addEventListener("click", openSettings);
$("settings").addEventListener("close", () => !$("summary-view").hidden && !summarising && $("quiz").hidden && renderSummary());
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
$("backup-key").addEventListener("input", (e) => {
  const target = backupTarget();
  try {
    localStorage.setItem(target.keyStore, e.target.value.trim());
  } catch {}
  if (target === BACKUPS.drive) drive.signOut(); // a sign-in belongs to one client ID
  backupChanged();
});
// the buttons in Settings → Backup report in the line under them
async function backupAction(work) {
  const result = $("backup-result");
  const report = (text, className = "hint") => {
    result.hidden = !text;
    result.className = className;
    result.textContent = text;
  };
  if (!backupKey()) return report(`Paste your ${backupTarget().keyName} first (see the README for how to make one).`, "hint bad");
  const buttons = document.querySelectorAll("#backup-connect, #backup-now, #backup-restore");
  for (const b of buttons) b.disabled = true;
  try {
    report(await work(report), "hint good");
  } catch (e) {
    report(e.message, "hint bad");
  }
  for (const b of buttons) b.disabled = false;
  showBackupSettings();
}
$("backup-connect").addEventListener("click", () => backupAction(connectBackup));
$("backup-now").addEventListener("click", () => backupAction(async (report) => {
  report("Backing up…");
  const error = await backUp();
  if (error) throw error;
  return `Every lesson is backed up to ${backupTarget().name}.`;
}));
$("backup-restore").addEventListener("click", () => backupAction(restoreLessons));
$("backup-signout").addEventListener("click", () => {
  const target = backupTarget();
  target.cloud.signOut();
  showBackupSettings();
  $("backup-result").hidden = false;
  $("backup-result").className = "hint";
  $("backup-result").textContent = `Signed out of ${target.name} on this Chromebook. Your lessons stay in ${target.name}.`;
  backUp();
});
$("backup-status").addEventListener("click", () => {
  if (connected()) backUp();
  else connectBackup().catch((e) => toast(e.message));
});
window.addEventListener("online", () => backUp());
if (settings.backupTo === "drive" && backupKey() && navigator.onLine) drive.preload().catch(() => {});
$("summarise").addEventListener("click", () => showSummary(lesson));
$("summary-back").addEventListener("click", leaveSummary);
$("summary-go").addEventListener("click", runSummary);
$("summary-again").addEventListener("click", runSummary);
$("summary-retry").addEventListener("click", runSummary);
$("summary-quiz").addEventListener("click", () => startQuiz(false));
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
  lesson.titleBy = "student"; // a title typed in is never replaced
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
function chooseTool(t) {
  closeTextEditor(true);
  choose("tools", "tool", (tool = t));
  canvas.style.cursor = { listen: "pointer", text: "text" }[t] ?? "";
  // the Listen tool opens the player (paused) with the marked moments
  if (t === "listen" && $("player").hidden && !lessonActive() && lesson.takes.length > 0) playAt(0, false);
}
$("tools").addEventListener("click", (e) => {
  const t = e.target.closest("button")?.dataset.tool;
  if (t) chooseTool(t);
});
$("mark-important").addEventListener("click", () => addMark("important"));
$("mark-confused").addEventListener("click", () => addMark("confused"));
$("player-play").addEventListener("click", () => {
  if (player.audio == null) return;
  if (player.audio.paused) player.audio.play().catch(() => {});
  else player.audio.pause();
});
$("player-close").addEventListener("click", closePlayer);
$("player-seek").addEventListener("input", (e) => {
  player.seeking = true;
  $("player-time").textContent = formatTime((e.target.value / 1000) * lesson.clockMs);
});
$("player-seek").addEventListener("change", (e) => {
  player.seeking = false;
  playAt((e.target.value / 1000) * lesson.clockMs, !player.audio?.paused);
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
  if (lesson == null || $("lesson").hidden || /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || $("settings").open) return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if ((e.ctrlKey || e.metaKey) && key === "y") {
    e.preventDefault();
    redo();
  } else if (key === "p") chooseTool("pen");
  else if (key === "h") chooseTool("highlighter");
  else if (key === "e") chooseTool("eraser");
  else if (key === "l") chooseTool("listen");
  else if (key === "t") chooseTool("text");
  else if (key === "n") chooseTool("line");
  else if (key === "i") addMark("important");
  else if (key === "c") addMark("confused");
  else if (key === " " && player.audio != null) {
    e.preventDefault();
    $("player-play").click();
  }
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

// back from signing in at dropbox.com?
dropbox.finishSignIn()
  .then((done) => done && toast("Dropbox is connected. Your lessons will be backed up to it."), (e) => toast(e.message))
  .finally(showHome);
