const CACHE_NAME = "netsearch-cache-v1";

const urlsToCache = [
  "/",
  "/index.html",
  "/login.html",
  "/register.html",
  "/site.html",
  "/admin.html",
  "/user-panel.html",
  "/settings.html",
  "/manifest.json"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        return response || fetch(event.request);
      })
  );
});