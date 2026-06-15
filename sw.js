const CACHE_NAME = "seawater-tank-mvp-v34";
const APP_SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "app.module.js",
  "version.json",
  "manifest.webmanifest",
  "modules/tankModule.js",
  "modules/additiveLogModule.js",
  "modules/bioLoadModule.js",
  "modules/feedingLogModule.js",
  "modules/measurementModule.js",
  "modules/measurementSopModule.js",
  "modules/dosingModule.js",
  "modules/eventTimelineModule.js",
  "services/formatService.js",
  "services/backupService.js",
  "services/retentionService.js",
  "services/storageService.js",
  "services/tankStore.js",
  "engines/safetyEngine.js",
  "engines/analysisEngine.js",
  "engines/eventRecoveryEngine.js",
  "engines/stabilityEngine.js",
  "components/aiExplanationModule.js",
  "components/dashboardModule.js",
  "components/measurementSopComponent.js",
  "types/domainTypes.js",
  "icons/icon-192.svg",
  "icons/icon-512.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.pathname.endsWith("/version.json")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("index.html"))),
  );
});
