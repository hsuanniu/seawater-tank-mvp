const CACHE_NAME = "seawater-tank-mvp-v24";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./app.module.js",
  "./manifest.webmanifest",
  "./modules/tankModule.js",
  "./modules/additiveLogModule.js",
  "./modules/bioLoadModule.js",
  "./modules/feedingLogModule.js",
  "./modules/measurementModule.js",
  "./modules/dosingModule.js",
  "./modules/eventTimelineModule.js",
  "./services/formatService.js",
  "./services/backupService.js",
  "./services/storageService.js",
  "./services/tankStore.js",
  "./engines/safetyEngine.js",
  "./engines/analysisEngine.js",
  "./components/aiExplanationModule.js",
  "./components/dashboardModule.js",
  "./types/domainTypes.js",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html"))),
  );
});
