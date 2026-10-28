// Keeps a copy of the app so it opens with no internet.
//
// Each version of the app is one complete set of files in its own cache. A new version (any change to this file,
// so change VERSION whenever you change any of the app's files) downloads the whole set fresh from the server,
// skipping the browser's HTTP cache (GitHub Pages lets browsers keep files for 10 minutes), and only then takes over.
// The page is always served from one set, so a new index.html never meets an old style.css.
const VERSION = 6;
const CACHE = "lesson-notes-v" + VERSION;
const FILES = ["./", "index.html", "style.css", "app.js", "db.js", "zip.js", "ai.js", "markdown.js", "drive.js", "manifest.webmanifest", "icon.svg", "assets/icons.svg", "assets/inter.woff2"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("lesson-notes-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => (await cache.match(event.request, { ignoreSearch: true })) ?? fetch(event.request))
  );
});
