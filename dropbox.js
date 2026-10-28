// Backup to the student's own Dropbox. Lessons are always saved in the browser first (db.js); this copies each one
// into a folder in the app's own Dropbox folder (Apps/<app name>): lesson.json, a PNG per page, the recording and the
// AI summary, and brings lessons back onto a new or cleared Chromebook.
//
// Sign-in is Dropbox's OAuth with PKCE: the page goes to dropbox.com and comes back with a code, which becomes a
// refresh token kept in this browser, so the app stays connected without signing in again. The app is an "App folder"
// app: it can only see its own folder, not the rest of the Dropbox.
const AUTH = "https://www.dropbox.com/oauth2/authorize";
const TOKEN = "https://api.dropboxapi.com/oauth2/token";
const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
const TOKEN_KEY = "lesson-notes-dropbox-token";
const PENDING_KEY = "lesson-notes-dropbox-signin"; // the PKCE verifier while the page is away at dropbox.com

export class BackupError extends Error {
  constructor(message, code = "") {
    super(message);
    this.code = code; // "signed-out", "missing", "offline" or ""
  }
}

// --- Signing in ------------------------------------------------------------------------------------------------------

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function save(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

let token = load(TOKEN_KEY); // { appKey, access, expires, refresh }

export function connected(appKey) {
  return token?.refresh != null && token.appKey === appKey;
}

// This page's address without ?query or #hash: where dropbox.com sends the student back (it must be listed in the
// Dropbox app's Redirect URIs)
export const redirectUri = () => location.origin + location.pathname;

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Goes to dropbox.com to sign in; the page comes back to finishSignIn
export async function signIn(appKey) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = crypto.randomUUID();
  save(PENDING_KEY, { appKey, verifier, state });
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    token_access_type: "offline",
    redirect_uri: redirectUri(),
    state
  });
  location.assign(AUTH + "?" + params);
}

async function tokenRequest(params) {
  let response;
  try {
    response = await fetch(TOKEN, { method: "POST", body: new URLSearchParams(params) });
  } catch {
    throw offline();
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.error === "invalid_grant") throw new BackupError("Sign in to Dropbox again to back up.", "signed-out");
    throw new BackupError("Dropbox sign-in failed: " + (data.error_description || data.error || "error " + response.status));
  }
  return data;
}

// When the page has come back from dropbox.com (?code=… or ?error=…): finishes signing in and tidies the address.
// Resolves with true if it signed in, false if there was nothing to finish; throws if it failed.
export async function finishSignIn() {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return false;
  history.replaceState(null, "", redirectUri());
  const pending = load(PENDING_KEY);
  save(PENDING_KEY, null);
  if (params.has("error")) {
    throw new BackupError(params.get("error") === "access_denied" ? "Dropbox access wasn't allowed, so lessons can't be backed up." : "Dropbox sign-in failed: " + (params.get("error_description") || params.get("error")));
  }
  if (pending == null || pending.state !== params.get("state")) throw new BackupError("Dropbox sign-in didn't match. Try again.");
  const data = await tokenRequest({
    code: params.get("code"),
    grant_type: "authorization_code",
    code_verifier: pending.verifier,
    client_id: pending.appKey,
    redirect_uri: redirectUri()
  });
  token = { appKey: pending.appKey, access: data.access_token, expires: Date.now() + data.expires_in * 1000, refresh: data.refresh_token };
  save(TOKEN_KEY, token);
  return true;
}

export function signOut() {
  if (token?.access && token.expires > Date.now()) fetch(API + "/auth/token/revoke", { method: "POST", headers: { Authorization: "Bearer " + token.access } }).catch(() => {});
  token = null;
  save(TOKEN_KEY, null);
}

// A fresh access token (they last a few hours; the refresh token gets a new one)
async function accessToken() {
  if (token?.refresh == null) throw new BackupError("Sign in to Dropbox to back up.", "signed-out");
  if (token.expires - 60000 > Date.now()) return token.access;
  try {
    const data = await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh, client_id: token.appKey });
    token = { ...token, access: data.access_token, expires: Date.now() + data.expires_in * 1000 };
    save(TOKEN_KEY, token);
    return token.access;
  } catch (e) {
    if (e.code === "signed-out") signOut();
    throw e;
  }
}

// --- Dropbox requests ------------------------------------------------------------------------------------------------

function offline() {
  return new BackupError(navigator.onLine === false
    ? "You're offline. Lessons will be backed up when you're online."
    : "Couldn't reach Dropbox. The network may block it; it will try again later.", "offline");
}

// Dropbox-API-Arg is an HTTP header, so everything outside ASCII is written as \uXXXX
const headerJson = (value) => JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

// host: API (JSON in and out) or CONTENT (arg in the header, data in the body)
async function call(host, path, { arg, body } = {}) {
  const headers = { Authorization: "Bearer " + (await accessToken()) };
  if (host === CONTENT) {
    headers["Dropbox-API-Arg"] = headerJson(arg);
    if (body != null) headers["Content-Type"] = "application/octet-stream";
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(arg ?? null);
  }
  let response;
  try {
    response = await fetch(host + path, { method: "POST", headers, body });
  } catch {
    throw offline();
  }
  if (response.ok) return response;
  const text = await response.text().catch(() => "");
  let summary = text;
  try {
    summary = JSON.parse(text).error_summary ?? text;
  } catch {}
  if (response.status === 401) {
    if (/expired_access_token/.test(summary) && token) {
      token.expires = 0; // try once more with a new access token
      return call(host, path, { arg, body });
    }
    signOut();
    throw new BackupError("Sign in to Dropbox again to back up.", "signed-out");
  }
  if (response.status === 409 && /not_found/.test(summary)) throw new BackupError("Not found in Dropbox.", "missing");
  if (response.status === 507 || /insufficient_space/.test(summary)) throw new BackupError("Your Dropbox is full.");
  if (response.status === 429) throw new BackupError("Dropbox says to slow down. It will try again later.", "offline");
  throw new BackupError("Dropbox: " + (summary || "error " + response.status));
}

async function list(path) {
  let r = await (await call(API, "/files/list_folder", { arg: { path } })).json();
  const entries = [...r.entries];
  while (r.has_more) {
    r = await (await call(API, "/files/list_folder/continue", { arg: { cursor: r.cursor } })).json();
    entries.push(...r.entries);
  }
  return entries;
}

async function exists(path) {
  try {
    await call(API, "/files/get_metadata", { arg: { path } });
    return true;
  } catch (e) {
    if (e.code === "missing") return false;
    throw e;
  }
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
  return state == null || state.name !== folderName || files.some((f) => state.files[f.name] !== f.sig);
}

// Uploads what changed into /<folderName>/; resolves with the new backup state { name, files: { name: sig } }.
// onFile(i, n) reports progress.
export async function backUpLesson(state, folderName, files, onFile) {
  let known = {};
  if (state != null) {
    if (state.name !== folderName && (await exists("/" + state.name))) {
      // renamed: the folder moves (if the new name is taken, Dropbox picks a free one, and the files go up again)
      await call(API, "/files/move_v2", { arg: { from_path: "/" + state.name, to_path: "/" + folderName, autorename: false } }).then(
        () => (known = state.files),
        () => {}
      );
    } else if (state.name === folderName && (await exists("/" + folderName))) {
      known = state.files;
    }
    // otherwise the folder was deleted from Dropbox: everything goes up again
  }
  const result = { name: folderName, files: { ...known } };
  const changed = files.filter((f) => known[f.name] !== f.sig);
  for (let i = 0; i < changed.length; i++) {
    const f = changed[i];
    onFile?.(i, changed.length);
    await call(CONTENT, "/files/upload", { arg: { path: `/${folderName}/${f.name}`, mode: "overwrite", mute: true }, body: await f.blob() });
    result.files[f.name] = f.sig;
  }
  return result;
}

// The lesson folders in Dropbox: [{ ref (the folder), name }]
export async function listBackups() {
  return (await list("")).filter((e) => e[".tag"] === "folder").map((e) => ({ ref: e.name, name: e.name }));
}

// The files in one lesson's folder: [{ name, ref (what download takes) }]
export async function folderFiles(folderName) {
  return (await list("/" + folderName)).filter((e) => e[".tag"] === "file").map((e) => ({ name: e.name, ref: `/${folderName}/${e.name}` }));
}

export async function download(path) {
  return (await call(CONTENT, "/files/download", { arg: { path } })).blob();
}

// The backup state of a restored lesson: these files are already there. sigOf(name) is the signature of each.
export function restoredState(backup, files, sigOf) {
  return { name: backup.name, files: Object.fromEntries(files.map((f) => [f.name, sigOf(f.name)])) };
}
