// Backup to the student's own Google Drive. Lessons are always saved in the browser first (db.js); this copies each
// one into a folder in "Lesson Notes" on Drive (lesson.json, a PNG per page, the recording, the AI summary), and brings
// lessons back onto a new or cleared Chromebook. Sign-in is Google Identity Services with the drive.file scope, so the
// app can only see the files it created itself.
//
// Each uploaded file carries a signature of its contents (appProperties.sig), stored with the lesson too, so only what
// changed is uploaded again, and a restored lesson knows it is already backed up.
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const API = "https://www.googleapis.com";
const FOLDER = "application/vnd.google-apps.folder";
const ROOT_NAME = "Lesson Notes";
const TOKEN_KEY = "lesson-notes-drive-token";
const ROOT_KEY = "lesson-notes-drive-root";
const SMALL = 5 * 1024 * 1024; // up to this size a file goes up in one request (multipart); bigger ones are resumable

export class DriveError extends Error {
  constructor(message, code = "") {
    super(message);
    this.code = code; // "signed-out", "missing", "offline" or ""
  }
}

// --- Signing in ------------------------------------------------------------------------------------------------------

let token = null;
try {
  token = JSON.parse(localStorage.getItem(TOKEN_KEY));
} catch {}

export function connected() {
  return token != null && token.expires - 60000 > Date.now();
}

function setToken(value) {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, JSON.stringify(value));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

let loading = null;
// Loads Google's sign-in library (from Google, so only when online). Loading it early keeps the sign-in window
// connected to the button press, which Chrome needs to allow the popup.
export function preload() {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.onload = resolve;
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new DriveError("Couldn't load Google sign-in. Check the internet connection; the network may block it.", "offline"));
    };
    document.head.append(script);
  });
  return loading;
}

// Call from a button press: opens Google's sign-in window (it closes by itself if access was already given)
export async function signIn(clientId) {
  await preload();
  return new Promise((resolve, reject) => {
    const done = (response) => {
      if (response.error) return reject(new DriveError("Google sign-in failed: " + (response.error_description || response.error)));
      if (!google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) return reject(new DriveError("Google Drive access wasn't allowed, so lessons can't be backed up."));
      setToken({ value: response.access_token, expires: Date.now() + Number(response.expires_in) * 1000 });
      resolve();
    };
    const failed = (e) => reject(new DriveError(e.type === "popup_failed_to_open"
      ? "Chrome blocked the Google sign-in window. Allow pop-ups for this site, then try again."
      : "Google sign-in was closed before it finished."));
    let client;
    try {
      client = google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: SCOPE, callback: done, error_callback: failed });
    } catch (e) {
      return reject(new DriveError("Google didn't accept the client ID: " + e.message));
    }
    client.requestAccessToken({ prompt: "" });
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.value, () => {});
  setToken(null);
  try {
    localStorage.removeItem(ROOT_KEY);
  } catch {}
}

// --- Drive requests --------------------------------------------------------------------------------------------------

async function call(path, options = {}) {
  if (!connected()) throw new DriveError("Sign in to Google Drive to back up.", "signed-out");
  let response;
  try {
    response = await fetch(API + path, { ...options, headers: { Authorization: "Bearer " + token.value, ...options.headers } });
  } catch {
    throw new DriveError(navigator.onLine === false
      ? "You're offline. Lessons will be backed up when you're online."
      : "Couldn't reach Google Drive. The network may block it; it will try again later.", "offline");
  }
  if (response.ok) return response;
  let message = "";
  try {
    message = (await response.json()).error?.message ?? "";
  } catch {}
  if (response.status === 401) {
    setToken(null);
    throw new DriveError("Sign in to Google Drive again to back up.", "signed-out");
  }
  if (response.status === 404) throw new DriveError("Not found in Google Drive.", "missing");
  if (response.status === 403 && /storage|quota/i.test(message)) throw new DriveError("Your Google Drive is full.");
  throw new DriveError("Google Drive: " + (message || "error " + response.status));
}

const getJson = async (path) => (await call(path)).json();
const quote = (s) => "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

async function list(q, fields) {
  const files = [];
  let page = "";
  do {
    const r = await getJson(`/drive/v3/files?q=${encodeURIComponent(q + " and trashed=false")}&fields=${encodeURIComponent("nextPageToken,files(" + fields + ")")}&pageSize=1000${page ? "&pageToken=" + page : ""}`);
    files.push(...r.files);
    page = r.nextPageToken;
  } while (page);
  return files;
}

async function createFolder(name, parent, appProperties = {}) {
  const r = await call("/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: parent ? [parent] : undefined, appProperties })
  });
  return (await r.json()).id;
}

// Whether a file or folder is still there and not in the bin; its name, or null
async function existing(id) {
  try {
    const f = await getJson(`/drive/v3/files/${id}?fields=name,trashed`);
    return f.trashed ? null : f.name;
  } catch (e) {
    if (e.code === "missing") return null;
    throw e;
  }
}

// The "Lesson Notes" folder (made by this app) at the top of My Drive
async function rootFolder() {
  let id = null;
  try {
    id = localStorage.getItem(ROOT_KEY);
  } catch {}
  if (id && (await existing(id)) != null) return id;
  id = (await list(`name=${quote(ROOT_NAME)} and mimeType='${FOLDER}' and 'root' in parents`, "id"))[0]?.id ?? (await createFolder(ROOT_NAME, "root"));
  try {
    localStorage.setItem(ROOT_KEY, id);
  } catch {}
  return id;
}

// Creates (no id) or replaces (id) a file's contents; resolves with its id
async function upload(name, blob, parent, sig, id) {
  const type = blob.type || "application/octet-stream";
  const metadata = { name, appProperties: { sig }, ...(id ? {} : { parents: [parent] }) };
  const path = "/upload/drive/v3/files" + (id ? "/" + id : "");
  const method = id ? "PATCH" : "POST";
  if (blob.size <= SMALL) {
    const boundary = "lesson-notes-" + crypto.randomUUID();
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: ${type}\r\n\r\n`, blob, `\r\n--${boundary}--`
    ]);
    const r = await call(path + "?uploadType=multipart&fields=id", { method, headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body });
    return (await r.json()).id;
  }
  const start = await call(path + "?uploadType=resumable&fields=id", {
    method,
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type },
    body: JSON.stringify(metadata)
  });
  const session = start.headers.get("Location");
  if (!session) throw new DriveError("Google Drive didn't return an upload address.");
  let r;
  try {
    r = await fetch(session, { method: "PUT", body: blob });
  } catch {
    throw new DriveError("The upload to Google Drive was interrupted. It will try again later.", "offline");
  }
  if (!r.ok) throw new DriveError("Uploading to Google Drive failed (error " + r.status + ").");
  return (await r.json()).id;
}

// --- Backing up and restoring ----------------------------------------------------------------------------------------

export function signature(text) {
  // FNV-1a, plus the length: enough to notice a change
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36) + "-" + text.length.toString(36);
}

// Whether anything in files ([{ name, sig, blob() }]) or the folder name differs from what was last backed up (state)
export function needsBackup(state, folderName, files) {
  return state == null || state.name !== folderName || files.some((f) => state.files[f.name]?.sig !== f.sig);
}

// Uploads what changed; resolves with the new backup state for the lesson. onFile(i, n) reports progress.
export async function backUpLesson(lessonId, state, folderName, files, onFile) {
  state = state ? { ...state, files: { ...state.files } } : null;
  const name = state ? await existing(state.folder) : null;
  if (name == null) {
    // never backed up, or the folder was deleted: start again
    state = { folder: await createFolder(folderName, await rootFolder(), { lessonId }), name: folderName, files: {} };
  } else if (name !== folderName) {
    await call(`/drive/v3/files/${state.folder}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: folderName }) });
  }
  state.name = folderName;
  const changed = files.filter((f) => state.files[f.name]?.sig !== f.sig);
  for (let i = 0; i < changed.length; i++) {
    const f = changed[i];
    onFile?.(i, changed.length);
    const blob = await f.blob();
    let id;
    try {
      id = await upload(f.name, blob, state.folder, f.sig, state.files[f.name]?.id);
    } catch (e) {
      if (e.code !== "missing") throw e;
      id = await upload(f.name, blob, state.folder, f.sig); // the file was deleted from Drive: make it again
    }
    state.files[f.name] = { id, sig: f.sig };
  }
  return state;
}

// The lessons in Drive: [{ lessonId, folder, name }]
export async function listBackups() {
  const root = await rootFolder();
  return (await list(`'${root}' in parents and mimeType='${FOLDER}'`, "id,name,appProperties"))
    .filter((f) => f.appProperties?.lessonId)
    .map((f) => ({ lessonId: f.appProperties.lessonId, folder: f.id, name: f.name }));
}

// The files in one lesson's folder, with what is needed to download them and to know they are backed up
export async function folderFiles(folder) {
  return (await list(`'${folder}' in parents`, "id,name,appProperties")).map((f) => ({ id: f.id, name: f.name, sig: f.appProperties?.sig ?? "" }));
}

export async function download(id) {
  return (await call(`/drive/v3/files/${id}?alt=media`)).blob();
}
