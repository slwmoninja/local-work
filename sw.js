// App shell is cached and served cache-first with a background network refresh
// (stale-while-revalidate). manifest.json/icons are network-first so Android's
// WebAPK icon-update check (which diffs manifest icon URLs) never gets stuck on
// a stale cached manifest. data/*.json is ALSO network-first (not precached) —
// job data changes independently of app-shell deploys and must never be served
// stale from a months-old cache.
const CACHE_NAME = 'localwork-shell-ffc7913f7779';
const PRECACHE_URLS = [
  './index.html', './app.js', './manifest.json',
  './icon-192.png', './icon-512.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS)).catch(()=>{}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if(req.method !== 'GET' || url.origin !== location.origin){
    e.respondWith(fetch(req));
    return;
  }
  // /api/refresh/status is polled every few seconds while a refresh runs --
  // never let the cache-first app-shell handler below serve a stale answer
  // for it (or, worse, cache a 404 from a plain static host and keep serving
  // that once local_server.py starts answering it for real).
  if(/\/api\//.test(url.pathname)){
    e.respondWith(fetch(req));
    return;
  }
  if(/\/(manifest\.json|icon-(192|512)\.png)$/.test(url.pathname) || /\/data\/.*\.json$/.test(url.pathname)){
    e.respondWith((async () => {
      try{
        const res = await fetch(req);
        if(res && res.ok){ const cache = await caches.open(CACHE_NAME); cache.put(req, res.clone()); }
        return res;
      }catch(err){
        const cached = await caches.match(req);
        return cached || Response.error();
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = req.mode === 'navigate' ? './index.html' : req;
    const cached = await cache.match(cacheKey);
    const networkFetch = fetch(req).then(res => {
      if(res && res.ok) cache.put(cacheKey, res.clone());
      return res;
    }).catch(() => null);
    if(cached){ e.waitUntil(networkFetch); return cached; }
    return (await networkFetch) || Response.error();
  })());
});
