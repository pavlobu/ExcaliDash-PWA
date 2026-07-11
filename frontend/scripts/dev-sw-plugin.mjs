import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEV_SW = `
const CACHE = "excalidash-dev-shell-v2";
const SHELL_URLS = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg", "/apple-touch-icon.png"];

// Shown when the app shell itself is not cached yet (e.g. first offline launch
// before the SW finished precaching). Prevents the iOS "blank page" symptom.
const OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="UTF-8"/>' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"/>' +
  '<title>ExcaliDash</title><style>' +
  "html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}" +
  "main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:32px;padding-top:max(env(safe-area-inset-top),32px);padding-bottom:max(env(safe-area-inset-bottom),32px);padding-left:max(env(safe-area-inset-left),32px);padding-right:max(env(safe-area-inset-right),32px);text-align:center;background:#0f172a;color:#e2e8f0}" +
  "h1{font-size:20px;margin:0}p{font-size:14px;color:#94a3b8;margin:0;max-width:420px}" +
  "</style></head><body><main>" +
  "<h1>ExcaliDash is offline</h1>" +
  "<p>This device hasn\\'t cached the app yet. Connect to the internet, open ExcaliDash once so it caches, then return offline.</p>" +
  "</main></body></html>";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Cache each shell URL independently so a single 404 (e.g. an optional
      // icon) doesn't reject the whole precache batch and leave the app shell
      // uncached for offline launches.
      Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn("[dev-sw] precache miss", url, err && err.message);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    // Cache-first: serve the app shell immediately from cache. This makes
    // offline/airplane-mode launches instant — no waiting for a network fetch
    // to fail. The stale-while-revalidate pattern updates the cache in the
    // background when online.
    event.respondWith(
      (async () => {
        const cached = await caches.match("/index.html");
        const root = cached || (await caches.match("/"));
        if (root) {
          // Background update when online.
          if (navigator.onLine) {
            fetch(req)
              .then((res) => {
                if (res.ok) {
                  const copy = res.clone();
                  caches.open(CACHE).then((c) => c.put("/index.html", copy)).catch(() => {});
                }
              })
              .catch(() => {});
          }
          return root;
        }
        // No shell cached at all: return a readable offline page instead of
        // a blank screen (the classic iOS standalone blank-page failure).
        return new Response(OFFLINE_HTML, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      })()
    );
    return;
  }

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/")) {
    return;
  }

  // Stale-while-revalidate: serve cached immediately, update in background.
  // When offline, this returns cached assets instantly with no fetch delay.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (!navigator.onLine) {
        return cached || new Response("", { status: 503 });
      }
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
`;

export function devServiceWorkerPlugin() {
  return {
    name: "excalidash-dev-sw",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/sw.js" || req.url === "/sw.js?") {
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.end(DEV_SW);
          return;
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/sw.js" || req.url === "/sw.js?") {
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.end(DEV_SW);
          return;
        }
        next();
      });
    },
  };
}
