const DEFAULT_APP_URL = "./?tab=today";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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
