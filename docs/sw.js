// Offline shell + map tiles you have already seen (useful where the slope has weak signal).
const SHELL = 'ekipa-shell-v4', TILES = 'ekipa-tiles-v1', MAX_TILES = 2500;
const ASSETS = ['./', 'index.html', 'app.js', 'net.js', 'stats.js', 'social.js', 'manifest.webmanifest', 'icon.svg',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/mqtt.min.js', 'vendor/capacitor.js'];

self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k)))));
  self.clients.claim();
});

const isTile = u => /tile\.opentopomap\.org|tile\.openstreetmap\.org|arcgisonline\.com/.test(u);
let n = 0;
async function trim() {
  const c = await caches.open(TILES), keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = req.url;
  if (isTile(url)) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok || r.type === 'opaque') { c.put(req, r.clone()); if (++n % 100 === 0) trim(); } return r; }
      catch { return hit || Response.error(); }
    }));
    return;
  }
  if (url.includes('/api/interpreter') || url.startsWith('wss:')) return;
  // App files: network first (fresh updates), cache as fallback for no signal.
  e.respondWith(fetch(req).then(r => { if (r.ok) caches.open(SHELL).then(c => c.put(req, r.clone())); return r; })
    .catch(() => caches.match(req, { ignoreSearch: true }).then(h => h || caches.match('index.html'))));
});
