const CACHE_PREFIX = "sawyer-tracker";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX))
          .map((key) => caches.delete(key))
      );
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
      clients.forEach((client) => client.navigate(client.url));
    })()
  );
});
