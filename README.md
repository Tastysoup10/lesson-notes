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
4. While the lesson runs, press **☆ Important** (`I`) to mark something to remember, or **? Confused** (`C`) when
   you don't follow what's being explained. The AI summary explains each marked moment, and goes over the confusing
   ones again step by step.
5. **Pause** / **Resume** pauses both the clock and the recording. **End lesson** when class is over.
6. Notes save automatically. **Export** (in the lesson, or on the list) saves `<date> <title>.zip` to Downloads.

**Listening back:** after the lesson, choose the **🎧 Listen** tool (`L`) and tap anything you wrote: the recording
plays from a few seconds before you wrote it. The player has a slider for the whole lesson and buttons for your marked
moments, and the page fades what you hadn't written yet, so the ink follows the recording.

## AI summary (Gemini, free)

1. Get a free API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) with a **personal** Google
   account (school accounts usually have it turned off; under 18, a parent needs to make it).
2. In the app: **Settings → AI summaries**, paste the key, press **Test**.
3. After a lesson, press **Summary** (in the lesson, or on the list), then **Summarise**. The recording is uploaded
   to Gemini with the pages; a lesson takes a few minutes. The summary is saved with the lesson and included in
   exports (`summary.md`, `transcript.txt`). **Copy** puts it on the clipboard for a document.
4. **Quiz** (on the summary) has Gemini write multiple-choice practice questions on the lesson. Each answer shows why
   it's right; your best score is kept. **Try again** reuses the questions in a new order; **New questions** asks for
   a fresh set.

The key is kept in this browser only, never in exports or this repository. Free-tier limits are per day: if they
run out, try later or choose **Lighter** in Settings. On the free tier Google may use what is sent to improve its
products, so only summarise lessons you are allowed to share. If the school network blocks Gemini, summarise at home.

## Backup (Dropbox or Google Drive)

Lessons are always saved on the Chromebook first (so class works without internet), and the app can copy each one to
**Dropbox** or **Google Drive** (**Settings → Backup**): one folder per lesson with `lesson.json`, a PNG per page,
the recording, and the summary if there is one. Only what changed is uploaded again. A lesson that is going on is
backed up once it ends. Deleting a lesson in the app keeps its backup copy.

The button next to the gear shows the state: **Backed up**, or **Back up (2)** when lessons are waiting.
**Settings → Restore** brings back any lessons that are in the backup but not on this Chromebook (a new or cleared
one). Each lesson remembers what it has in each place, so switching between Dropbox and Google Drive is safe: the
first backup to the other one copies everything there.

| | Dropbox | Google Drive |
|---|---|---|
| Signing in | once, on dropbox.com; stays connected | Google's sign-in window, about once an hour |
| On a school Chromebook | works (it is a website login) | needs a personal Google account in Chrome; school accounts block it |
| Free space | 2 GB (about 100 hours of lessons) | 15 GB |
| What the app can see | only its own folder (Apps → your app) | only the files it made |

### Dropbox: setting it up (once, about 5 minutes, free)

Dropbox needs every app that uses it to be registered, which gives it an **app key**:

1. Make a free account at [dropbox.com](https://www.dropbox.com) (or sign in).
2. Go to [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) and press **Create app**.
3. Choose **Scoped access**, then **App folder**, and give it a name (it must be unique on Dropbox, for example
   `Lesson Notes Tasty`). Press **Create app**.
4. On the **Permissions** tab, tick `files.metadata.read`, `files.content.write` and `files.content.read`, then
   press **Submit** at the bottom.
5. On the **Settings** tab, under **OAuth 2 → Redirect URIs**, add `https://tastysoup10.github.io/lesson-notes/`
   (exactly the address the app is at; Settings in the app shows it) and press **Add**. Leave **Allow public clients**
   on **Allow**.
6. Copy the **App key** from the Settings tab (not the App secret).
7. In Lesson Notes: **Settings → Backup → Dropbox**, paste the app key, press **Connect Dropbox**, sign in to Dropbox
   and press **Allow**. You come back to the app and it starts backing up.

If the permissions are changed after connecting, press **Sign out** and connect again.

### Google Drive: setting it up (once, about 10 minutes, free)

Google needs every app that uses Drive to have its own **client ID**. Make it with a **personal** Google account
(school accounts usually block this, and a school Chromebook may not let you sign in with another account):

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project called `Lesson Notes`.
2. **APIs & Services → Library**, search for **Google Drive API**, and press **Enable**.
3. **Google Auth Platform** (or **APIs & Services → OAuth consent screen**) → **Get started**. App name
   `Lesson Notes`, your email as support email, Audience **External**, your email as contact, agree, **Create**.
4. **Audience → Test users → Add users**: add your own Gmail address. Leave the app in **Testing**.
5. **Clients → Create client**: Application type **Web application**. Under **Authorized JavaScript origins** add
   `https://tastysoup10.github.io`. Press **Create** and copy the **Client ID** (it ends in
   `.apps.googleusercontent.com`).
6. In Lesson Notes: **Settings → Backup → Google Drive**, paste the client ID, press **Sign in to Google Drive**.
   Google will say it "hasn't verified this app": that is expected for your own app, so press **Continue** and allow
   access.

If Chrome blocks the sign-in window, allow pop-ups for the site (the icon at the right of the address bar).

**Settings** (the gear button): Theme (System, which follows the Chromebook, Light or Dark) and Paper (Lined, Grid,
Dots or Blank). The paper stays white in dark mode. Settings are kept in this browser.

Keys: `P` pen, `H` highlighter, `E` eraser, `L` listen, `I` important, `C` confused, `Space` play / pause, `Ctrl+Z` undo, `Ctrl+Y` redo, `←` / `→` pages.

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

`index.html`, `style.css`, `app.js` (drawing, clock, recording, export, summary screen), `ai.js` (Gemini), `dropbox.js` and `drive.js` (backup),
`markdown.js` (shows the summary), `db.js` (browser storage), `zip.js` (zip writer), `sw.js` (offline copy), `manifest.webmanifest` and `icon.svg` (installable app). No build step, no
libraries.

`assets/` holds the open-source assets, stored with the app so it works offline: icons from
[Lucide](https://lucide.dev) (ISC License) in `assets/icons.svg`, and the [Inter](https://rsms.me/inter) font (SIL Open
Font License) in `assets/inter.woff2`. Their licences are in `assets/LICENSES.md`.
