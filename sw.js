// Cache-first so the app works offline. build.sh stamps the cache name, so each
// deploy starts a fresh cache and the old one is dropped.
const CACHE = "chipsmith-a05c7755748e";
const SHELL = ["./", "index.html", "app.js", "app.css", "chips.js", "render.js", "project.js", "roll.js", "graph.js", "audio.js",
  "oggtags.js", "files.js", "ui.js", "manifest.webmanifest", "icon.svg", "icon-180.png",
  "vendor/WasmMediaEncoder.min.js", "vendor/ogg.wasm"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok) cache.put(e.request, res.clone());
    return res;
  }));
});
