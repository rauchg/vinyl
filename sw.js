// Bump APP_CACHE when shipping changed application code or bundled records.
// Commons downloads have a separate lifetime and survive application upgrades.
const APP_CACHE = 'vinyl-app-v3', COMMONS_CACHE = 'vinyl-commons-v1';
const SHELL = ['./', 'src/main.js', 'src/commons.js', 'src/render.js', 'src/gl-util.js',
  'src/shaders.js', 'src/dsp.js', 'src/geometry.js', 'src/records.js', 'src/label.js',
  'src/press.js', 'src/worklet.js', 'src/engine.js', 'src/engine-core.js', 'src/groove.js',
  'src/master-worker.js', 'src/cut.js', 'src/demo.js'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(APP_CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('vinyl-app-') && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

async function warnStorage() {
  for (const client of await self.clients.matchAll()) client.postMessage({ type: 'cache-error' });
}

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || !['http:', 'https:'].includes(url.protocol)) return;
  const local = url.origin === self.location.origin;
  const commons = url.hostname === 'commons.wikimedia.org' || url.hostname === 'upload.wikimedia.org';
  if (!local && !commons) return;
  event.respondWith((async () => {
    // One HTML document serves /, /index.html and query-string views such as ?og.
    const key = request.mode === 'navigate' ? new URL('./', self.registration.scope).href : request;
    let cache;
    try {
      cache = await caches.open(local ? APP_CACHE : COMMONS_CACHE);
      const cached = await cache.match(key);
      if (cached) return cached;
    } catch { await warnStorage(); }
    const response = await fetch(request);
    // Never persist failed/partial responses or API error payloads as valid music.
    if (response.ok && response.status !== 206 && cache) {
      let valid = true;
      if (url.hostname === 'commons.wikimedia.org' && url.pathname === '/w/api.php') {
        try { valid = !(await response.clone().json()).error; } catch { valid = false; }
      }
      if (valid) {
        try { await cache.put(key, response.clone()); }
        catch { await warnStorage(); }
      }
    }
    return response;
  })());
});
