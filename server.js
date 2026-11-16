// De Dart Struners – online server
// Geen extra pakketten nodig: alleen Node.js (versie 18 of nieuwer).
//
// Instellingen (omgevingsvariabelen):
//   ADMIN_PIN  verplicht: de beheerderscode waarmee je scores mag invoeren
//   PORT       poort (Render vult dit zelf in), standaard 3000
//   DATA_DIR   map waar de stand wordt bewaard, standaard ./data

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const PIN = String(process.env.ADMIN_PIN || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'stand.json');
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 4 * 1024 * 1024;

if (!PIN || PIN.length < 4) {
  console.error('Stel ADMIN_PIN in (minimaal 4 tekens) voordat je de server start.');
  process.exit(1);
}

// ---------- opslag ----------
let state = { v: 0, S: null, live: null, by: null };
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (d && typeof d === 'object') state = Object.assign(state, d);
    console.log('Stand geladen, versie', state.v);
  }
} catch (e) {
  console.error('Kon de opgeslagen stand niet lezen:', e.message);
}

let writeTimer = null;
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state), err => {
      if (err) return console.error('Opslaan mislukt:', err.message);
      fs.rename(tmp, STATE_FILE, e => e && console.error('Opslaan mislukt:', e.message));
    });
  }, 300);
}

// Voor meekijkers alleen de beurten van de wedstrijd die nu bezig is
function publicView() {
  const S = state.S ? Object.assign({}, state.S) : null;
  const open = state.live && state.live.openId;
  if (S && S.turns) S.turns = open && S.turns[open] ? { [open]: S.turns[open] } : {};
  return { v: state.v, by: state.by, S, live: state.live };
}

// ---------- live verbindingen ----------
const clients = new Set();
function broadcast() {
  const msg = 'data: ' + JSON.stringify(publicView()) + '\n\n';
  for (const res of clients) {
    try { res.write(msg); } catch (e) { clients.delete(res); }
  }
}
setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); }
  }
}, 25000);

// ---------- beveiliging ----------
function pinOk(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(PIN).digest();
  return crypto.timingSafeEqual(a, b);
}
const fails = new Map(); // ip -> {n, until}
function blocked(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now();
}
function failed(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 5 * 60 * 1000; f.n = 0; }
  fails.set(ip, f);
}
const ipOf = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// ---------- helpers ----------
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN'
};
function send(res, code, body, type) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, HEADERS));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('te groot')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('geen geldige JSON')); }
    });
    req.on('error', reject);
  });
}
let pageCache = null;
function page() {
  if (!pageCache || process.env.NODE_ENV !== 'production') pageCache = fs.readFileSync(path.join(PUBLIC, 'index.html'));
  return pageCache;
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const ip = ipOf(req);

  try {
    if (req.method === 'GET' && (p === '/' || p === '/monitor' || p === '/kijk')) {
      return send(res, 200, page(), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

    if (req.method === 'GET' && p === '/api/state') return send(res, 200, state);

    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, Object.assign({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }, HEADERS));
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify(publicView()) + '\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'POST' && p === '/api/login') {
      if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
      const b = await readBody(req);
      if (pinOk(b.pin)) { fails.delete(ip); return send(res, 200, { ok: true }); }
      failed(ip);
      return send(res, 401, { error: 'Onjuiste code' });
    }

    if (req.method === 'POST' && p === '/api/state') {
      if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
      if (!pinOk(req.headers['x-pin'])) { failed(ip); return send(res, 401, { error: 'Onjuiste code' }); }
      const b = await readBody(req);
      if (!b || typeof b.S !== 'object' || !b.S || !Array.isArray(b.S.players)) return send(res, 400, { error: 'Ongeldige stand' });
      state = {
        v: state.v + 1,
        S: b.S,
        live: b.live && typeof b.live === 'object' ? b.live : null,
        by: typeof b.by === 'string' ? b.by.slice(0, 40) : null,
        at: new Date().toISOString()
      };
      persist();
      broadcast();
      return send(res, 200, { ok: true, v: state.v });
    }

    send(res, 404, { error: 'Niet gevonden' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => console.log('De Dart Struners draait op poort ' + PORT));
