/**
 * Prahari offline cache.
 *
 * The console claims to keep working when the link drops. Without a service
 * worker that claim ended at the first reload: the queue held the writes, and
 * then the operator refreshed and got a browser error page, because every
 * byte of the application itself still came from the network. The map went
 * blank for the same reason — Leaflet fetches its tiles from openstreetmap.org
 * on every pan.
 *
 * Three strategies, because the three kinds of request fail differently:
 *
 *   - **Navigations**: network first, cache second. The station should always
 *     get the current console when it can reach it; the cached copy is what
 *     stops a reload during an outage being a dead end.
 *   - **Build assets and map tiles**: cache first. Both are immutable in
 *     practice — Next fingerprints its chunks, and a tile at a given z/x/y is
 *     the same tile tomorrow — so going to the network for them during an
 *     outage is a guaranteed wait for a guaranteed failure.
 *   - **The API**: never cached. Stock levels, positions and accountability
 *     counts are the things an operator must not be shown a stale copy of,
 *     and the offline queue already holds the writes. A console that answered
 *     "6 of 6 accounted for" from a cache during an incident would be worse
 *     than one that said it could not reach the station.
 */

const VERSION = 'v1';
const SHELL_CACHE = `prahari-shell-${VERSION}`;
const ASSET_CACHE = `prahari-assets-${VERSION}`;
const TILE_CACHE = `prahari-tiles-${VERSION}`;

// Tiles are the one thing worth a hard cap: a few minutes of panning can pull
// thousands, and a station's disk is not the place to discover that.
const MAX_TILES = 600;

const OFFLINE_FALLBACK = '/';

/**
 * Every module route, precached on install.
 *
 * Falling back to `/` for any route would serve the dashboard's shell under
 * a `/cargo` URL — the router then hydrates the wrong page while the address
 * bar says otherwise, which is a worse answer than an error. The route list
 * is fixed and small, so each one gets its own shell and an operator who has
 * never opened Cargo online still gets Cargo offline.
 */
const ROUTES = [
  '/', '/expedition', '/cargo', '/inventory', '/personnel', '/emergency', '/scenario',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // Individually, not addAll: one route failing to precache must not
      // discard the other six.
      .then((cache) => Promise.all(
        ROUTES.map((route) => cache.add(route).catch(() => undefined)),
      ))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, ASSET_CACHE, TILE_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name.startsWith('prahari-') && !keep.has(name))
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

/** Keep a cache from growing without bound, oldest entry first. */
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map((key) => cache.delete(key)));
}

async function cacheFirst(request, cacheName, { max } = {}) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // Opaque responses (cross-origin, no CORS) are cacheable and are exactly
  // what a tile is; only failures are worth refusing to store.
  if (response && (response.ok || response.type === 'opaque')) {
    await cache.put(request, response.clone());
    if (max) void trim(cacheName, max);
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request) || await cache.match(OFFLINE_FALLBACK);
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never the API, and never the telemetry socket. See the header.
  if (url.origin === self.location.origin
      && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws'))) {
    return;
  }

  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith(cacheFirst(request, TILE_CACHE, { max: MAX_TILES }));
    return;
  }

  if (url.origin === self.location.origin
      && (url.pathname.startsWith('/_next/static/')
          || url.pathname.startsWith('/fonts/')
          || url.pathname === '/manifest.webmanifest'
          || url.pathname === '/icon.svg')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});
