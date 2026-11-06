// Офлайн-кэш «Колесо!»: свои файлы — заранее, three.js с CDN — при первом запросе.
const CACHE = 'koleso-v1';
const CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/';
const OWN = ['./', 'index.html', 'game.js', 'manifest.webmanifest', 'koleso_derevo.glb', 'koleso_avto.glb',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const LIBS = ['build/three.module.js', 'examples/jsm/loaders/GLTFLoader.js', 'examples/jsm/utils/BufferGeometryUtils.js',
  'examples/jsm/environments/RoomEnvironment.js'].map(p => CDN + p);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(OWN);
    await Promise.all(LIBS.map(u => c.add(u).catch(() => {})));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === location.origin;
  if (!own && !req.url.startsWith(CDN)) return;
  if (own && (req.mode === 'navigate' || /\.(js|html|webmanifest)$/.test(url.pathname))) {
    // свой код: сначала сеть (чтобы обновления доходили), без сети — кэш
    e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
    return;
  }
  // модели, иконки, three.js — сначала кэш
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
    if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
    return res;
  })));
});
