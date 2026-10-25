// Service Worker: App-Shell offline verfügbar machen und angesehene Kartenkacheln zwischenspeichern.
// VERSION muss sich bei jedem Deployment ändern, sonst bekommen installierte Apps die neuen Dateien nicht.
// Der GitHub-Pages-Workflow setzt sie automatisch auf den Commit-Hash; bei anderem Hosting von Hand erhöhen.
const VERSION = 'v2';
const SHELL_CACHE = `refill-shell-${VERSION}`;
const TILE_CACHE = 'refill-tiles';
const TILE_LIMIT = 500;
const TILE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/api.js',
  'js/geo.js',
  'js/hours.js',
  'js/store.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('refill-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(shell(request));
  } else if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith(tile(request, event));
  }
  // API- und Geocoder-Anfragen gehen direkt ins Netz; die App hat eigene Offline-Daten in IndexedDB.
});

async function shell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch (err) {
    if (request.mode === 'navigate') return cache.match('index.html');
    throw err;
  }
}

async function tile(request, event) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  const age = cached ? Date.now() - Number(cached.headers.get('x-cached-at') || 0) : Infinity;

  const update = fetch(request).then(async response => {
    if (response.ok) {
      const body = await response.blob();
      const headers = new Headers(response.headers);
      headers.set('x-cached-at', String(Date.now()));
      await cache.put(request, new Response(body, { status: response.status, headers }));
      trimTiles(cache);
      return new Response(body, { status: response.status, headers: response.headers });
    }
    return response;
  });

  if (cached) {
    if (age > TILE_MAX_AGE) event.waitUntil(update.catch(() => {}));
    return cached;
  }
  return update;
}

let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (const key of keys.slice(0, Math.max(0, keys.length - TILE_LIMIT))) await cache.delete(key);
  } finally {
    trimming = false;
  }
}
