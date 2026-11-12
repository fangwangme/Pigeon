const CACHE_NAME = "pigeon-cache-v3";

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data && event.data.type === "SET_LOCALE" && event.data.locale) {
    caches.open("pigeon-settings").then((cache) => cache.put("/__locale", new Response(event.data.locale))).catch(() => {});
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Bypass WebSocket and API requests
  if (url.pathname.startsWith("/ws") || url.pathname.startsWith("/api/")) {
    return;
  }

  // Network-First for Navigation / HTML documents:
  // Always fetch latest server code first; fallback to cache if offline
  if (event.request.mode === "navigate" || event.request.destination === "document") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((res) => res || caches.match("/")))
    );
    return;
  }

  // Stale-While-Revalidate for icons and static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networked = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networked;
    })
  );
});

async function getStoredLocale() {
  try {
    const cache = await caches.open("pigeon-settings");
    const res = await cache.match("/__locale");
    if (res) {
      const text = (await res.text()).trim();
      if (text === "en" || text === "zh") return text;
    }
  } catch {}
  return "zh";
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data ? event.data.json() : {};
      } catch {
        data = {};
      }
      const locale = await getStoredLocale();
      const isZh = locale === "zh";
      const agent = data.agent ? String(data.agent) : "";
      const agentLabel =
        agent === "claude"
          ? "Claude Code"
          : agent === "codex"
            ? "Codex"
            : agent === "opencode"
              ? "OpenCode"
              : agent === "pi"
                ? "Pi"
                : agent === "agy"
                  ? "Antigravity"
                  : agent || "Agent";
      const title =
        data.event === "done"
          ? (isZh ? `${agentLabel} 已完成` : `${agentLabel} completed`)
          : (isZh ? `${agentLabel} 等你确认` : `${agentLabel} waiting for confirmation`);
      const parts = [];
      if (data.workspace) parts.push(data.workspace);
      if (data.tab) parts.push(data.tab);
      const body = parts.join(" · ");
      const options = {
        body,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        data: { paneId: data.paneId, url: data.paneId ? `/?pane=${encodeURIComponent(data.paneId)}` : "/" },
        tag: data.paneId ? `pane:${data.paneId}` : undefined,
      };
      await self.registration.showNotification(title, options);
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          if (client.url.includes(self.location.origin)) {
            if ("navigate" in client && event.notification.data?.url) {
              client.navigate(event.notification.data.url);
            }
            return client.focus();
          }
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(urlToOpen);
      }
    })
  );
});
