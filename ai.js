// The AI summary, made by Google's Gemini straight from this browser with the student's own (free) API key. The key
// is kept in this browser only (Settings) and never goes into exports or the repository.
//
// The recording goes up through Gemini's Files API (a lesson is too big to send inside the request), the pages go
// inline as PNGs, and one generateContent request returns the summary, the typed-up notes and a transcript.
const API = "https://generativelanguage.googleapis.com";
export const TRANSCRIPT_MARK = "===TRANSCRIPT===";

export class AiError extends Error {}

function networkError() {
  return new AiError(navigator.onLine === false
    ? "You're offline. Summarise the lesson when you have internet."
    : "Couldn't reach Gemini. The network (for example school Wi-Fi) may block it; try again at home.");
}

async function failure(response) {
  let message = "";
  try {
    message = (await response.json()).error?.message ?? "";
  } catch {}
  const s = response.status;
  if (/api key/i.test(message) && (s === 400 || s === 401 || s === 403)) return new AiError("Gemini didn't accept the API key. Check it in Settings.");
  if (s === 403) return new AiError("Gemini refused: " + message + " (school Google accounts often have Gemini turned off; use a personal account's key.)");
  if (s === 429) return new AiError("The free Gemini limit is used up for now. Try again later (it resets daily), or choose Lighter in Settings → AI model.");
  if (s >= 500) return new AiError("Gemini is busy or having problems right now. Try again in a few minutes.");
  return new AiError("Gemini: " + (message || "error " + s));
}

async function call(key, path, options = {}) {
  let response;
  try {
    response = await fetch(API + path, { ...options, headers: { "x-goog-api-key": key, ...options.headers } });
  } catch {
    throw networkError();
  }
  if (!response.ok) throw await failure(response);
  return response;
}

// A cheap request that checks the key works and Gemini can be reached from here
export async function testKey(key) {
  await call(key, "/v1beta/models?pageSize=1");
}

// Uploads one recording (resumable upload in one go) and waits until Gemini has processed it
async function uploadFile(key, blob, name, onProgress, onProcessing) {
  const mime = blob.type.split(";")[0];
  const start = await call(key, "/upload/v1beta/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(blob.size),
      "X-Goog-Upload-Header-Content-Type": mime
    },
    body: JSON.stringify({ file: { display_name: name } })
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new AiError("Gemini didn't return an upload address.");
  // XMLHttpRequest rather than fetch, for the upload progress
  let file = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl);
    xhr.setRequestHeader("X-Goog-Upload-Command", "upload, finalize");
    xhr.setRequestHeader("X-Goog-Upload-Offset", "0");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 && xhr.response?.file
      ? resolve(xhr.response.file)
      : reject(new AiError("Uploading the recording failed (" + (xhr.response?.error?.message || "error " + xhr.status) + ").")));
    xhr.onerror = () => reject(networkError());
    xhr.send(blob);
  });
  if (file.state === "PROCESSING") onProcessing();
  for (let tries = 0; file.state === "PROCESSING"; tries++) {
    if (tries > 150) throw new AiError("Gemini took too long to process the recording. Try again later.");
    await new Promise((r) => setTimeout(r, 2000));
    file = await (await call(key, "/v1beta/" + file.name)).json();
  }
  if (file.state === "FAILED") throw new AiError("Gemini couldn't read the recording.");
  return { name: file.name, uri: file.uri, mime };
}

function deleteFile(key, name) {
  call(key, "/v1beta/" + name, { method: "DELETE" }).catch(() => {});
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function instructions(lesson, hasAudio, formatTime) {
  const marks = lesson.marks ?? [];
  const markList = marks.map((m) => `[${formatTime(m.clock)}] ${m.kind === "confused" ? "Confused" : "Important"} (while on page ${m.page + 1})`).join("\n");
  return `You are helping a school student review a lesson. ${hasAudio
    ? "You have the recording of the lesson (one or more parts) and"
    : "There is no recording, only"} the student's handwritten notes, one image per page.

Lesson: "${lesson.title}", ${new Date(lesson.created).toDateString()}.
Times are lesson time (m:ss or h:mm:ss). The recording pauses when the lesson clock pauses, so a moment t seconds into a recording part is at that part's start time + t. Each page lists when the student was writing on it, so you can match notes to what was being said. Highlighter marks things the student thought important.
${marks.length ? `
During the lesson the student pressed a button to mark these moments: "Important" means they want to remember it, "Confused" means they didn't understand what was being explained just then (the minute or so before the mark).
${markList}
` : ""}
Write in the language the lesson was taught in. Start with one line "TITLE: " followed by a short title naming what the lesson was about (2 to 6 words, like "Photosynthesis and chlorophyll" or "Solving quadratic equations"). Then reply in Markdown with these sections, in this order:
# Summary
3–6 sentences on what the lesson covered.
## Key points
The main ideas, as bullet points.
${marks.length ? `## Moments I marked
One "### [time] Important" or "### [time] Confused" heading per marked moment, in time order. Say what was being taught at that moment${hasAudio ? " (from the recording)" : " (from the notes written around then)"}. For Important: the point itself, clearly, and why it matters. For Confused: explain it again from the start, simply and step by step, with a worked example or an everyday comparison, as a patient tutor would.
` : ""}## My notes, typed up
The handwriting typed up page by page ("### Page 1" …), keeping the student's structure. Fix obvious spelling slips, write [?] for anything unreadable, describe diagrams briefly in [brackets]. ${hasAudio ? "If a note disagrees with what the teacher said, add a short ⚠ note under it." : ""}
${hasAudio ? "## Missed in my notes\nImportant things the teacher said that are not in the notes, each with its time.\n" : ""}## To do and review
Homework, deadlines and tests mentioned${hasAudio ? " (with times)" : ""}, then anything that looked confusing or worth revising. Write "Nothing mentioned." if there is none.
## Key terms
**Term**: short definition, for the subject's important words.
${hasAudio ? `
After the Key terms, write a line containing only ${TRANSCRIPT_MARK} and then a transcript of the whole lesson: one line every sentence or few sentences, each starting with its lesson time in square brackets, like "[12:05] So the next step is…". Mark the speaker only when it changes from the teacher (for example "Student:"). Write [inaudible] for parts you cannot hear.` : ""}`;
}

// Writing times on a page: stroke times grouped into stretches (a gap of more than a minute starts a new one)
function writingTimes(page, formatTime) {
  const times = page.strokes.filter((s) => !s.beforeStart).map((s) => [s.points[0][3], s.points[s.points.length - 1][3]]).sort((a, b) => a[0] - b[0]);
  const ranges = [];
  for (const [a, b] of times) {
    const last = ranges[ranges.length - 1];
    if (last && a - last[1] < 60000) last[1] = Math.max(last[1], b);
    else ranges.push([a, b]);
  }
  if (ranges.length === 0) return page.strokes.length > 0 ? "written before the lesson started" : "empty page";
  return "written at " + ranges.map(([a, b]) => (b - a < 30000 ? formatTime(a) : formatTime(a) + "–" + formatTime(b))).join(", ");
}

// lesson: the stored lesson; recordings: [{ take, clockStart, blob }]; pages: PNG blobs, one per page.
// onStatus(text, fraction or null) reports progress. Resolves with { title, summary, transcript, truncated, model }.
export async function summarise({ key, model, lesson, recordings, pages, formatTime, onStatus }) {
  const uploaded = [];
  try {
    for (let i = 0; i < recordings.length; i++) {
      const r = recordings[i];
      const label = recordings.length > 1 ? `Uploading recording ${i + 1} of ${recordings.length}` : "Uploading the recording";
      onStatus(label + "…", 0);
      const file = await uploadFile(key, r.blob, `${lesson.title} (part ${r.take})`, (f) => onStatus(label + "…", f), () => onStatus("Gemini is getting the recording ready…", null));
      uploaded.push({ ...file, take: r.take, clockStart: r.clockStart });
    }
    onStatus("Preparing your pages…", null);
    const parts = [{ text: instructions(lesson, uploaded.length > 0, formatTime) }];
    uploaded.forEach((f, i) => {
      parts.push({ text: `Recording part ${i + 1}, starting at lesson time ${formatTime(f.clockStart)}:` });
      parts.push({ file_data: { mime_type: f.mime, file_uri: f.uri } });
    });
    for (let i = 0; i < pages.length; i++) {
      parts.push({ text: `Notes page ${i + 1} of ${pages.length} (${writingTimes(lesson.pages[i], formatTime)}):` });
      parts.push({ inline_data: { mime_type: "image/png", data: await blobToBase64(pages[i]) } });
    }
    onStatus(uploaded.length > 0 ? "Gemini is listening to the lesson and reading your notes…" : "Gemini is reading your notes…", null);
    const response = await call(key, `/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }] })
    });
    const data = await response.json();
    const candidate = data.candidates?.[0];
    let text = (candidate?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
    if (!text) {
      const reason = data.promptFeedback?.blockReason || candidate?.finishReason || "no reply";
      throw new AiError("Gemini didn't write a summary (" + reason + "). Try again, or try the other model in Settings.");
    }
    // the suggested title: the TITLE: line, which is not part of the summary itself
    let title = "";
    text = text.replace(/^\s*\**TITLE:\**\s*(.+)\n?/i, (_, t) => {
      title = t.replace(/[*_#"“”]/g, "").trim().slice(0, 80);
      return "";
    });
    const at = text.indexOf(TRANSCRIPT_MARK);
    return {
      title,
      summary: (at < 0 ? text : text.slice(0, at)).trim(),
      transcript: at < 0 ? "" : text.slice(at + TRANSCRIPT_MARK.length).trim(),
      truncated: candidate.finishReason === "MAX_TOKENS",
      model: data.modelVersion || model
    };
  } finally {
    // Gemini deletes uploads after two days anyway; this removes them now
    for (const f of uploaded) deleteFile(key, f.name);
  }
}

// A practice quiz from a lesson's summary and transcript (text only, so it is quick and light on the free limit).
// Resolves with [{ question, choices: [4 strings], answer (index), explanation }].
export async function makeQuiz({ key, model, title, summary, transcript }) {
  const prompt = `Write a practice quiz for a school student revising this lesson, "${title}". Use only what the lesson covered.

Write 8 multiple-choice questions (fewer if the lesson was short), from easy to harder, mixing facts, meanings of key terms and understanding (why/how). Each has 4 choices with exactly one correct, and plausible wrong ones. Write in the language of the lesson.

Reply with only JSON: an array of objects like
{"question": "…", "choices": ["…", "…", "…", "…"], "answer": 0, "explanation": "one or two sentences on why the right answer is right"}
where "answer" is the index (0–3) of the correct choice. Vary which position the correct choice is in.

The lesson summary and notes:
${summary}
${transcript ? "\nThe lesson transcript:\n" + transcript : ""}`;
  const response = await call(key, `/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } })
  });
  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
  let questions;
  try {
    questions = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
    if (!Array.isArray(questions)) questions = questions.questions;
  } catch {
    questions = null;
  }
  questions = (questions ?? []).filter((q) =>
    typeof q?.question === "string" && Array.isArray(q.choices) && q.choices.length >= 2 && q.choices.every((c) => typeof c === "string") &&
    Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length);
  if (questions.length === 0) throw new AiError("Gemini didn't write a usable quiz. Try again.");
  return questions.map((q) => ({ question: q.question, choices: q.choices, answer: q.answer, explanation: String(q.explanation ?? "") }));
}
