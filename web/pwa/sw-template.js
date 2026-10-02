// Photoshop.eth service worker (generated at build time from web/pwa/sw-template.js; do not edit dist/sw.js).
// Precaches the app shell, the pixel-engine wasm and the core chunks so the app opens offline and installs as a PWA.
// The heavy optional pieces (HEIC decoder, ONNX runtime and models) are cached the first time they're used instead.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `photoshop-eth-${VERSION}`;
const RUNTIME = 'photoshop-eth-runtime';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('photoshop-eth-') && key !== CACHE && key !== RUNTIME) await caches.delete(key);
    // Hashed files from older builds are dead weight once the new shell is in.
    const rt = await caches.open(RUNTIME);
    const keep = new Set(PRECACHE.map(p => new URL(p, self.registration.scope).href));
    for (const req of await rt.keys()) if (/\/assets\//.test(req.url) && !keep.has(req.url) && !/(libheif|ort)/.test(req.url)) await rt.delete(req);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.href.startsWith(self.registration.scope)) return;
  if (req.mode === 'navigate') {
    // Network first so a new deploy shows up straight away; the cached shell when offline.
    event.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./', copy)); }
      return res;
    }).catch(async () => (await caches.match(req, { ignoreVary: true })) || (await caches.match('./', { ignoreSearch: true, ignoreVary: true })) || Response.error()));
    return;
  }
  if (url.pathname.endsWith('/sw.js')) return;
  // Hashed assets never change: cache first. Everything else: stale-while-revalidate.
  const immutable = /\/assets\//.test(url.pathname) || /\/models\//.test(url.pathname);
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: !immutable, ignoreVary: true });
    const net = fetch(req).then(async res => {
      if (res.ok && res.type === 'basic') { const c = await caches.open(immutable && !hit ? RUNTIME : CACHE); await c.put(req, res.clone()); }
      return res;
    });
    if (hit) { if (!immutable) event.waitUntil(net.catch(() => {})); return hit; }
    return net;
  })());
});
