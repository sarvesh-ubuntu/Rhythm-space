/**
 * Rhythm Space — Service Worker
 *
 * Offline shell caching with safe network fallback.
 * Never returns undefined from respondWith(), preventing
 * Chrome's mysterious net::ERR_FAILED navigation errors.
 *
 * ─── Navigation handling (fixed) ─────────────────────────────────────────
 * Real page navigations (index.html / login.html / editor.html) are no
 * longer routed through the cache-populating handleRequest() path. This
 * app is three separate documents, not a single-page app shell, so there
 * was no benefit to caching navigation responses on every load — and doing
 * so raced the browser's own navigation commit: response.clone() tees the
 * same network stream the browser is simultaneously trying to commit as
 * the new document, which can lose the race and kill the load with
 * net::ERR_FAILED. Navigations now go straight to the network, falling
 * back to a cached copy of that same page (or the shell's index.html as
 * a last resort) only if the network truly fails.
 * ──────────────────────────────────────────────────────────────────────
 *
 * ─── Update lifecycle (fixed) ────────────────────────────────────────────
 * This used to call self.skipWaiting() on install and self.clients.claim()
 * on activate, which together force a newly-installed worker to seize
 * control of every already-open tab immediately. If that takeover landed
 * while a tab had a navigation in flight (e.g. clicking a link to another
 * page), the in-flight request got handed off to a worker mid-transition
 * and Chrome killed it with net::ERR_FAILED — recoverable only by a hard
 * reload. Removing both calls means a new worker installs and activates
 * quietly in the background and only starts controlling pages on their
 * NEXT normal navigation/reload, which is when a handoff is actually safe.
 * ──────────────────────────────────────────────────────────────────────
 */

const CACHE_NAME = 'rymspace-shell-v3';

const APP_SHELL = [
  './index.html',
  './login.html',
  './editor.html',
  './css/style.css',
  './css/auth.css',
  './css/dashboard.css',
  './js/engine.js',
  './js/playback.js',
  './js/musicxml.js',
  './js/app.js',
  './js/auth.js',
  './manifest.json',
  './fonts/Bravura.woff2',
  './icon-192.png',
  './shortcuts.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        // cache.addAll() is all-or-nothing: one 404'd/renamed asset would
        // reject the whole install and leave the app with no service
        // worker at all. Cache each asset independently instead, so a
        // single bad entry just gets skipped (and logged) rather than
        // sinking the rest of the shell.
        Promise.all(
          APP_SHELL.map((url) =>
            cache.add(url).catch((err) => {
              console.warn('[sw] Failed to cache shell asset:', url, err);
            })
          )
        )
      )
    // No self.skipWaiting() here — see update-lifecycle note above.
    // The new worker finishes installing and simply waits.
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
    // No self.clients.claim() here — see update-lifecycle note above.
    // Already-open tabs keep their current controller (or none) until
    // their own next navigation/reload, so no request is ever handed
    // off mid-flight.
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  // Let real page navigations go straight to the network. This app is
  // multiple separate documents (index/login/editor), not a single SPA
  // shell being reused for client-side routing, so there's no benefit to
  // routing navigations through the cache-write path — and doing so races
  // the browser's own navigation commit: cloning + cache.put()'ing a
  // navigation response tees the same underlying stream the browser is
  // simultaneously trying to commit as the new document, which can lose
  // the race and kill the load with net::ERR_FAILED. Only static shell
  // assets (CSS/JS/fonts/manifest/icons) are cache-managed below.
  // handleNavigate() falls back to a cached copy of the same page (not
  // always index.html) so an offline user stays on the page they were on.
  if (event.request.mode === 'navigate') {
    event.respondWith(handleNavigate(event.request));
    return;
  }

  event.respondWith(handleRequest(event));
});

async function handleNavigate(request) {
  try {
    return await fetch(request);
  } catch (err) {
    // Offline: prefer the cached copy of the exact page the user was
    // trying to reach (e.g. editor.html) so they aren't bounced to
    // index.html mid-session. Fall back to the shell's index.html only
    // if that specific page was never cached, and finally to a plain
    // 503 so respondWith() is never handed undefined.
    const samePage = await caches.match(request);
    if (samePage) {
      return samePage;
    }

    const shellFallback = await caches.match('./index.html');
    if (shellFallback) {
      return shellFallback;
    }

    return new Response(
      'Offline',
      {
        status: 503,
        statusText: 'Service Unavailable',
        headers: {
          'Content-Type': 'text/plain'
        }
      }
    );
  }
}

async function handleRequest(event) {
  const request = event.request;

  const cached = await caches.match(request);

  try {
    const response = await fetch(request);

    // Cache successful responses.
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }

    // Prefer cached version if we already have one.
    return cached || response;

  } catch (err) {

    // Offline: use cache if available.
    if (cached) {
      return cached;
    }

    // Note: navigation requests (mode === 'navigate') never reach this
    // function — they're handled directly in the fetch listener above,
    // with their own simple network-then-cached-shell-fallback logic.

    // Never allow respondWith(undefined).
    return new Response(
      'Offline',
      {
        status: 503,
        statusText: 'Service Unavailable',
        headers: {
          'Content-Type': 'text/plain'
        }
      }
    );
  }
}
