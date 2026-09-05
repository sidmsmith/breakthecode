const CACHE_NAME = "breakthecode-cache-v1";
const APP_SHELL_URLS = ["/breakthecode.css", "/manifest.json", "/bc-192.png", "/bc-512.png"];

async function warmAppShellCache() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    APP_SHELL_URLS.map(async (url) => {
      try {
        const response = await fetch(url, { cache: "no-cache" });
        if (response && response.ok) {
          await cache.put(url, response.clone());
        }
      } catch (error) {
        // Ignore individual cache failures to avoid blocking install.
      }
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(warmAppShellCache());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    return;
  }

  if (request.mode === "navigate") {
    // Never intercept page navigations. A service worker cannot safely re-fetch
    // a navigation request (Chrome forces redirect:"manual" on it, and any
    // redirect in the chain then comes back as an opaque redirect, which
    // respondWith() cannot use to satisfy a navigation -> net::ERR_FAILED,
    // "This site can't be reached"). Letting the browser handle navigations
    // natively avoids that failure mode entirely.
    return;
  }

  // Network-first for static assets: always prefer the latest deployed CSS/JS/icons
  // when online (avoids serving a stale cached file alongside freshly deployed HTML
  // while this worker is still updating). Cache is only a fallback for offline use.
  event.respondWith(
    (async () => {
      try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.ok) {
          const responseClone = networkResponse.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, responseClone))
            .catch(() => {
              // Ignore cache write issues.
            });
        }
        return networkResponse;
      } catch (error) {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
          return cachedResponse;
        }
        return new Response("", { status: 204 });
      }
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "warm-cache") {
    return;
  }

  event.waitUntil(
    warmAppShellCache().then(() => {
      if (event.source) {
        event.source.postMessage({ type: "cache-warmed", cacheName: CACHE_NAME });
      }
    })
  );
});
