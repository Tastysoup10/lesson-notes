# Lesson Notes

Handwritten lesson notes in the browser, with the lesson recorded alongside. Made for a school Chromebook and a USB
drawing tablet: it runs as a plain website (GitHub Pages), works offline after the first visit, and keeps everything
in the browser. **Summary** has Google's Gemini (free) write a summary, your notes typed up and a transcript.

## Using it

1. Open the site and press **+ New lesson**.
2. When class starts, press **● Start lesson**. The lesson clock starts, and the lesson is recorded if Chrome is
   allowed to use the microphone. If the microphone is blocked, notes and the clock still work.
3. Write with the tablet. Tools: Pen, Highlight, Eraser (removes whole strokes), 4 colours, 3 sizes, Undo / Redo.
   Use **+ New page** for more pages.
4. **Pause** / **Resume** pauses both the clock and the recording. **End lesson** when class is over.
5. Notes save automatically. **Export** (in the lesson, or on the list) saves `<date> <title>.zip` to Downloads.

## AI summary (Gemini, free)

1. Get a free API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) with a **personal** Google
   account (school accounts usually have it turned off; under 18, a parent needs to make it).
2. In the app: **Settings → AI summaries**, paste the key, press **Test**.
3. After a lesson, press **Summary** (in the lesson, or on the list), then **Summarise**. The recording is uploaded
   to Gemini with the pages; a lesson takes a few minutes. The summary is saved with the lesson and included in
   exports (`summary.md`, `transcript.txt`). **Copy** puts it on the clipboard for a document.

The key is kept in this browser only, never in exports or this repository. Free-tier limits are per day: if they
run out, try later or choose **Lighter** in Settings. On the free tier Google may use what is sent to improve its
products, so only summarise lessons you are allowed to share. If the school network blocks Gemini, summarise at home.

**Settings** (the gear button): Theme (System, which follows the Chromebook, Light or Dark) and Paper (Lined, Grid,
Dots or Blank). The paper stays white in dark mode. Settings are kept in this browser.

Keys: `P` pen, `H` highlighter, `E` eraser, `Ctrl+Z` undo, `Ctrl+Y` redo, `←` / `→` pages.

If Chrome is closed in the middle of a lesson, the recording is kept up to the last 5 seconds; open the lesson and
press **● Continue lesson** to carry on (it becomes a second recording file).

## Putting it on GitHub Pages

1. Create a new repository on GitHub (for example `lesson-notes`).
2. Upload the files in this folder to it (on github.com: **Add file → Upload files**, or with git).
3. In the repository: **Settings → Pages**, Source: **Deploy from a branch**, Branch: `main`, folder `/ (root)`, Save.
4. After a minute the site is at `https://<your-username>.github.io/lesson-notes/`.
5. Open it once on the Chromebook while online. After that it opens offline too. Chrome may offer to install it as an
   app (the install icon in the address bar), which also makes Chrome more willing to keep its data.

The site itself is public, but your notes and recordings never leave the Chromebook unless you export them.

**Changing the app:** whenever you change any of its files, also raise `VERSION` in `sw.js` (3 → 4 …) before
pushing. That tells Chrome there is a new version: it downloads the complete new set of files, then the app reloads
itself once the next time it is opened (or, during a lesson, the time after). Without it, Chrome keeps using the copy
it has.

## What's in an export

| File | Contents |
|---|---|
| `lesson.json` | title, dates, lesson length, timeline (`events`), recordings, and every stroke |
| `page-1.png`, `page-2.png`, … | each page as an image (1600 × 1000) |
| `audio-1.webm`, … | the recording (Opus audio, about 20 MB per hour) |
| `summary.md`, `transcript.txt` | the AI summary and transcript, if made |

In `lesson.json`, each stroke is `{ tool, color, size, beforeStart, points }` and each point is
`[x, y, pressure, time]`: page units (1600 × 1000), pen pressure 0–1, and the lesson time in milliseconds. Lesson
time is the recording's time (it stops while paused), so a point with time `t` was drawn `t - clockStart` ms into
the recording that starts at `clockStart` (see `recordings`). Strokes with `beforeStart: true` were drawn before the
lesson was started.

## Files

`index.html`, `style.css`, `app.js` (drawing, clock, recording, export, summary screen), `ai.js` (Gemini),
`markdown.js` (shows the summary), `db.js` (browser storage), `zip.js` (zip writer), `sw.js` (offline copy), `manifest.webmanifest` and `icon.svg` (installable app). No build step, no
libraries.

`assets/` holds the open-source assets, stored with the app so it works offline: icons from
[Lucide](https://lucide.dev) (ISC License) in `assets/icons.svg`, and the [Inter](https://rsms.me/inter) font (SIL Open
Font License) in `assets/inter.woff2`. Their licences are in `assets/LICENSES.md`.
