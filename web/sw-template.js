// Photoshop.eth service worker (generated at build time by vite.config.ts from web/sw-template.js).
// Lookups use ignoreVary: servers send Vary: Origin, and module scripts carry an Origin header the precache requests lacked.
// Precaches the app shell and the pixel engine (.wasm) so the app starts offline; the heavy, optional pieces
// (onnxruntime for Select Subject, the u2netp model, libheif) are cached the first time they are used.
const VERSION = __VERSION__;
const PRECACHE = __PRECACHE__;
const KNOWN = new Set(__KNOWN__);
const SHELL = 'pseth-shell-' + VERSION, RUNTIME = 'pseth-runtime';
const scopeURL = new URL(self.registration.scope);
const rel = url => url.pathname.slice(scopeURL.pathname.length);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE.map(p => new Request(p, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('pseth-shell-') && key !== SHELL) await caches.delete(key);
    // Hashed assets from older builds are never asked for again.
    const rt = await caches.open(RUNTIME);
    for (const req of await rt.keys()) { const p = rel(new URL(req.url)); if (p.startsWith('assets/') && !KNOWN.has(p)) await rt.delete(req); }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== scopeURL.origin || !url.pathname.startsWith(scopeURL.pathname)) return;
  if (req.mode === 'navigate') {
    // Network first so a new deploy shows up straight away; the cached shell when offline.
    event.respondWith(fetch(req).then(res => { if (res.ok) caches.open(SHELL).then(c => c.put('./', res.clone())); return res; })
      .catch(async () => (await caches.match(req, { ignoreSearch: true, ignoreVary: true })) || (await caches.match('./', { ignoreVary: true })) || (await caches.match('index.html')) || Response.error()));
    return;
  }
  const path = rel(url);
  if (path.startsWith('assets/')) {
    // Content-hashed: cache first, forever.
    event.respondWith((async () => {
      const hit = await caches.match(req, { ignoreVary: true }); if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(RUNTIME)).put(req, res.clone());
      return res;
    })());
    return;
  }
  if (path === 'sw.js') return;
  // Everything else (icons, the model, the manifest): stale-while-revalidate.
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreVary: true });
    const net = fetch(req).then(async res => { if (res.ok) (await caches.open(RUNTIME)).put(req, res.clone()); return res; });
    if (hit) { event.waitUntil(net.catch(() => {})); return hit; }
    return net;
  })());
});
