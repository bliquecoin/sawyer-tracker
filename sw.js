const DEFAULT_APP_URL = "./?tab=today";
const CACHE_NAME = "sawyer-tracker-shell-89";
const SHELL = ["./", "./index.html", "./styles.css", "./config.js", "./app.js", "./lib/tracker-core.js",
  "./lib/tracker-storage.js", "./lib/tracker-sync.js", "./lib/tracker-drafts.js", "./manifest.webmanifest",
  "./assets/icons/icon-192.png", "./assets/icons/icon-512.png", "./assets/icons/favicon-64.png",
  "./assets/icons/sawyer-welcome-8bit-v4.png", "./assets/icons/apple-touch-icon.png"];
const LIBRARIES = ["https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0",
  "https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js"];

async function fetchAsset(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try { return await fetch(request, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL.map((path) => new Request(new URL(path, self.registration.scope), { cache: "reload" })));
    await Promise.allSettled(LIBRARIES.map(async (url) => {
      const response = await fetchAsset(url);
      if (response.ok) await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("sawyer-tracker-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const shellUrls = SHELL.map((path) => new URL(path, self.registration.scope).href);
  const canonical = `${url.origin}${url.pathname}`;
  const isShell = shellUrls.includes(canonical);
  if (!isShell && !LIBRARIES.includes(event.request.url)) return;
  // Only static assets are cached; household API responses never enter Cache Storage.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const key = isShell ? canonical : event.request.url;
    const cached = await cache.match(key);
    if (cached && !self.navigator.onLine) return cached;
    try {
      const response = await fetchAsset(event.request);
      if (!response.ok && cached) return cached;
      if (response.ok) await cache.put(key, response.clone());
      return response;
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
  })());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = { body: event.data?.text() || "Sawyer Tracker has an update." };
  }

  const title = payload.title || "Sawyer Tracker";
  const options = {
    body: payload.body || "Sawyer Tracker has an update.",
    icon: payload.icon || "./assets/icons/icon-192.png",
    badge: payload.badge || "./assets/icons/favicon-64.png",
    tag: payload.tag || payload.eventKey || "sawyer-update",
    renotify: false,
    data: {
      url: payload.url || DEFAULT_APP_URL,
      eventKey: payload.eventKey || "",
      kind: payload.kind || ""
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL(
    event.notification.data?.url || DEFAULT_APP_URL,
    self.registration.scope
  ).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true
      });
      const existing = windows.find((client) => new URL(client.url).origin === new URL(destination).origin);
      if (existing) {
        if ("navigate" in existing) await existing.navigate(destination);
        return existing.focus();
      }
      return self.clients.openWindow(destination);
    })()
  );
});
