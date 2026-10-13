// Mangia Mangia service worker: caches the app so it opens with no signal. Recipes come from Firestore's own offline cache.
const VERSION = "mm-v2";
const SHELL = ["./", "index.html", "guide.html", "logo.svg", "icon-64.png", "icon-180.png", "icon-512.png", "manifest.json", "qrcode.js"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Firestore talks over its own channel; leave it alone.
  if (url.hostname.includes("googleapis.com") && !url.hostname.startsWith("fonts")) return;
  const cacheable = url.origin === location.origin || url.hostname === "www.gstatic.com" || url.hostname.startsWith("fonts.");
  if (!cacheable) return;
  // Network first for our own pages (so updates arrive), cache first for libraries and fonts.
  const ownPage = url.origin === location.origin && (url.pathname.endsWith("/") || url.pathname.endsWith(".html"));
  e.respondWith(ownPage
    ? fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
    : caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); } return r; })));
});
