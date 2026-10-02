/* Balatro PWA service worker.
 *
 * Small files (page, scripts, manifest, icons): NETWORK-FIRST. Every open checks the server
 * (cache:'no-cache' = revalidate, so GitHub Pages' 10-minute browser cache can't serve stale files).
 * If you're offline or the network is slow, the cached copy is used. So editing those files on
 * GitHub needs no version bump.
 *
 * Big files (game.data, love.wasm = ~15 MB): CACHE-FIRST in their own cache, so small updates never
 * re-download them. They almost never change; if you ever replace one, bump BIG_VERSION.
 */
const SMALL_CACHE = 'balatro-small';
const BIG_VERSION = 'v1';
const BIG_CACHE = 'balatro-big-' + BIG_VERSION;
const NETWORK_TIMEOUT_MS = 4000;

const BIG = ['app/game.data', 'app/love.wasm'];
const SMALL = [
  './', 'index.html', 'manifest.webmanifest',
  'js/boot.js', 'js/loader.js', 'app/love.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'
];

const isBig = (url) => BIG.some((p) => url.pathname.endsWith('/' + p));

function timedFetch(input, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(input, Object.assign({}, init, { signal: ctrl.signal }))
    .finally(() => clearTimeout(timer));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const small = await caches.open(SMALL_CACHE);
    await Promise.all(SMALL.map(async (p) => {
      const res = await fetch(new Request(p, { cache: 'reload' }));
      if (!res.ok) throw new Error('precache failed: ' + p);
      await small.put(p, res);
    }));
    const big = await caches.open(BIG_CACHE);
    for (const p of BIG) {
      if (await big.match(p)) continue;               // already have it from an earlier install
      const res = await fetch(new Request(p, { cache: 'reload' }));
      if (!res.ok) throw new Error('precache failed: ' + p);
      await big.put(p, res);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SMALL_CACHE, BIG_CACHE];
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function bigCacheFirst(req) {
  const cache = await caches.open(BIG_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req.url, { cache: 'reload' });
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function smallNetworkFirst(req) {
  const cache = await caches.open(SMALL_CACHE);
  try {
    const res = await timedFetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }, NETWORK_TIMEOUT_MS);
    if (res.ok) { cache.put(req, res.clone()); return res; }
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || res;
  } catch (err) {
    const hit = (await cache.match(req, { ignoreSearch: true })) ||
                (req.mode === 'navigate' ? await cache.match('index.html') : null);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(isBig(url) ? bigCacheFirst(req) : smallNetworkFirst(req));
});
