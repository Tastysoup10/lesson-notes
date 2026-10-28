// Keeps a copy of the app so it opens with no internet. Pages come from the copy straight away while a fresh one is
// fetched in the background when online, so an update shows up the next time the app is opened.
const CACHE = "lesson-notes-v2";
const FILES = ["./", "index.html", "style.css", "app.js", "db.js", "zip.js", "manifest.webmanifest", "icon.svg", "assets/icons.svg", "assets/inter.woff2"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const fresh = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached ?? fresh;
    })
  );
});
