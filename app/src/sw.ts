/**
 * The service worker.
 *
 * Copied from the Andrea & Mathieu app. Three jobs: make the app open with no
 * connection, never stand in the way of an update (see updates.ts for the
 * whole picture), and show the 21:00 reminder once Phase 5 sends it.
 *
 * Only the app's own files go through here. Supabase (REST, the media
 * function, signed image URLs) is a different origin and is left alone: the
 * data lives in IndexedDB and the images as blobs (images.ts), so the cache
 * below never fills up with cards or slides.
 */

/// <reference lib="webworker" />

// A module of its own, so the line below describes this worker's `self`
// instead of clashing with the page's. Changes nothing in the built file.
export {};

declare const self: ServiceWorkerGlobalScope;

/** Replaced at build time. Changing it is what makes a new cache. */
const BUILD_ID = '__BUILD_ID__';

const CACHE = `studyflow-${BUILD_ID}`;

/** Everything needed to draw the first screen with no connection (and the demo). */
const SHELL = [
  './',
  './index.html',
  './app.js',
  './app.css',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './demo/placeholder.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // One by one, so one missing file cannot fail the whole install.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Every cache except the one for this exact build.
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Network first, cache as the safety net.
 *
 * Cache first is faster, but it is exactly how a PWA ends up frozen on an old
 * version. Here the phone tries the network and falls back to the cache only
 * when there is no answer. Offline still works; stale screens do not.
 */
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          // Stored without the query: the personal link (?k=…) must not end up
          // as a separate cache entry, and the shell is the same for every key.
          void caches.open(CACHE).then((cache) => cache.put(withoutQuery(request), copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(withoutQuery(request));
        if (cached) return cached;
        // A navigation with nothing cached for that exact URL still gets the
        // app shell, so the app opens rather than showing a browser error.
        if (request.mode === 'navigate') {
          const shell = (await caches.match('./index.html')) ?? (await caches.match('./'));
          if (shell) return shell;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }),
  );
});

/** The same address without ?query and #hash: what the cache keys on. */
function withoutQuery(request: Request): string {
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** The page telling a freshly installed worker not to sit and wait. */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') void self.skipWaiting();
});

/**
 * A notification from the server (Phase 5: the 21:00 reminder).
 *
 * Every push must end in something on the screen. iOS withdraws the right to
 * send more from an app that receives one and shows nothing, so even a message
 * that cannot be read is still shown, as the app's name.
 */
self.addEventListener('push', (event) => {
  let message: { title?: string; body?: string; tag?: string } = {};
  try {
    message = event.data ? (event.data.json() as typeof message) : {};
  } catch {
    message = { body: event.data?.text() ?? '' };
  }

  event.waitUntil(
    self.registration.showNotification(message.title || 'StudyFlow', {
      body: message.body || '',
      tag: message.tag || 'studyflow',
      icon: './icons/icon-192.png',
    }),
  );
});

/**
 * Tapping a notification brings the app forward. It never opens a bare
 * address: the open window (or the Home Screen icon) carries the personal
 * link, a fresh window would not.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./');
    })(),
  );
});
