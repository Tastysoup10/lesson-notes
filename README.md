# Lesson Notes

Handwritten lesson notes in the browser, with the lesson recorded alongside. Made for a school Chromebook and a USB
drawing tablet: it runs as a plain website (GitHub Pages), works offline after the first visit, and keeps everything
in the browser. At home, **Export** gives a `.zip` for the AI summary step.

## Using it

1. Open the site and press **+ New lesson**.
2. When class starts, press **● Start lesson**. The lesson clock starts, and the lesson is recorded if Chrome is
   allowed to use the microphone. If the microphone is blocked, notes and the clock still work.
3. Write with the tablet. Tools: Pen, Highlight, Eraser (removes whole strokes), 4 colours, 3 sizes, Undo / Redo.
   Use **+ New page** for more pages.
4. **Pause** / **Resume** pauses both the clock and the recording. **End lesson** when class is over.
5. Notes save automatically. **Export** (in the lesson, or on the list) saves `<date> <title>.zip` to Downloads.

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

## What's in an export

| File | Contents |
|---|---|
| `lesson.json` | title, dates, lesson length, timeline (`events`), recordings, and every stroke |
| `page-1.png`, `page-2.png`, … | each page as an image (1600 × 1000) |
| `audio-1.webm`, … | the recording (Opus audio, about 20 MB per hour) |

In `lesson.json`, each stroke is `{ tool, color, size, beforeStart, points }` and each point is
`[x, y, pressure, time]`: page units (1600 × 1000), pen pressure 0–1, and the lesson time in milliseconds. Lesson
time is the recording's time (it stops while paused), so a point with time `t` was drawn `t - clockStart` ms into
the recording that starts at `clockStart` (see `recordings`). Strokes with `beforeStart: true` were drawn before the
lesson was started.

## Files

`index.html`, `style.css`, `app.js` (drawing, clock, recording, export), `db.js` (browser storage), `zip.js` (zip
writer), `sw.js` (offline copy), `manifest.webmanifest` and `icon.svg` (installable app). No build step, no libraries.
