// De Dart Struners – service worker
// Pagina: altijd eerst van het netwerk (zodat "Website bijwerken" meteen zichtbaar is),
// alleen zonder verbinding de laatst bewaarde versie. /api wordt nooit bewaard.
const CACHE = 'ds-v1';
const VAST = ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(VAST)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(r => {
        if (r.ok) { const k = r.clone(); caches.open(CACHE).then(c => c.put('/__pagina', k)); }
        return r;
      }).catch(() => caches.match('/__pagina').then(r => r || new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#1a0512;color:#ffeaf4;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center"><div><h2>Geen verbinding</h2><p>Controleer je internet en probeer het opnieuw.</p><button onclick="location.reload()" style="padding:12px 20px;border-radius:12px;border:0;background:#ff2d8a;color:#fff;font-weight:700">Opnieuw</button></div>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
    );
    return;
  }

  if (url.pathname.startsWith('/icons/')) {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
  }
});
