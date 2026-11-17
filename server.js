// De Dart Struners – online server
// Geen extra pakketten nodig: alleen Node.js (versie 18 of nieuwer).
//
// Instellingen (omgevingsvariabelen):
//   ADMIN_PIN  verplicht: de beheerderscode (alles beheren)
//   TELLER_PIN optioneel: code voor tellers (alleen scores invoeren)
//   PORT       poort (Render vult dit zelf in), standaard 3000
//   DATA_DIR   map waar de stand wordt bewaard, standaard ./data
//   TUNNEL     zet op 1 om automatisch een gratis Cloudflare-link te maken
//              (cloudflared.exe moet dan in deze map staan of in het pad)

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = +process.env.PORT || 3000;
const PIN = String(process.env.ADMIN_PIN || '').trim();
const TPIN = String(process.env.TELLER_PIN || '').trim();
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

// ---------- chat voor kijkers ----------
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
let chat = { v: 0, on: true, seq: 0, msgs: [] };
try {
  if (fs.existsSync(CHAT_FILE)) {
    const d = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
    if (d && Array.isArray(d.msgs)) chat = Object.assign(chat, d);
  }
} catch (e) { console.error('Kon de chat niet lezen:', e.message); }
let chatTimer = null;
function persistChat() {
  clearTimeout(chatTimer);
  chatTimer = setTimeout(() => {
    const tmp = CHAT_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(chat), err => {
      if (err) return console.error('Chat opslaan mislukt:', err.message);
      fs.rename(tmp, CHAT_FILE, e => e && console.error('Chat opslaan mislukt:', e.message));
    });
  }, 300);
}
const clean = (t, max) => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const chatHits = new Map(); // ip -> [tijden]
function chatSpam(ip) {
  const now = Date.now(), l = (chatHits.get(ip) || []).filter(t => now - t < 30000);
  if (l.length >= 5) { chatHits.set(ip, l); return true; }
  l.push(now); chatHits.set(ip, l);
  if (chatHits.size > 2000) chatHits.clear();
  return false;
}
function chatChanged() { chat.v++; persistChat(); broadcast(); }
// Een speeldag loopt van 06:00 tot 06:00 (Nederlandse tijd); daarna begint de chat leeg
const speeldag = t => new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t - 6 * 3600 * 1000));
function chatPrune() {
  const nu = speeldag(Date.now()), n = chat.msgs.length;
  chat.msgs = chat.msgs.filter(m => speeldag(m.at) === nu);
  return chat.msgs.length !== n;
}
setInterval(() => { if (chatPrune()) chatChanged(); }, 60000);
chatPrune();

// ---------- leaderboard checkout-spel (voor iedereen, hoogste score per naam) ----------
const TOP_FILE = path.join(DATA_DIR, 'spel.json');
let top = { v: 0, list: {} };
try {
  if (fs.existsSync(TOP_FILE)) {
    const d = JSON.parse(fs.readFileSync(TOP_FILE, 'utf8'));
    if (d && d.list && typeof d.list === 'object') top = Object.assign(top, d);
  }
} catch (e) { console.error('Kon het leaderboard niet lezen:', e.message); }
let topTimer = null;
function persistTop() {
  clearTimeout(topTimer);
  topTimer = setTimeout(() => {
    const tmp = TOP_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(top), err => {
      if (err) return console.error('Leaderboard opslaan mislukt:', err.message);
      fs.rename(tmp, TOP_FILE, e => e && console.error('Leaderboard opslaan mislukt:', e.message));
    });
  }, 300);
}
const topView = () => ({ v: top.v, list: Object.entries(top.list).map(([k, x]) => ({ k, n: x.n, s: x.s, d: x.d })).sort((a, b) => b.s - a.s || a.d - b.d).slice(0, 200) });
const topHits = new Map();
function topChanged() {
  top.v++; persistTop(); broadcast();
  for (const id of Object.keys(sess)) if ((sessWait.get(id) || []).length) sessBroadcast(id);
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
function viewOf(st) {
  const S = st.S ? Object.assign({}, st.S) : null;
  const open = st.live && st.live.openId;
  if (S && S.turns) S.turns = open && S.turns[open] ? { [open]: S.turns[open] } : {};
  return { v: st.v, by: st.by, S, live: st.live, top: topView() };
}
function publicView() {
  return Object.assign(viewOf(state), { chat: { v: chat.v, on: chat.on, msgs: chat.msgs } });
}

// ---------- sessies van vrienden (eigen link + code, los van de hoofdstand) ----------
const SESS_FILE = path.join(DATA_DIR, 'sessies.json');
const SESS_DAYS = 30, SESS_MAX = 300;
let sess = {}; // id -> { v, S, live, by, h, c, u }
try {
  if (fs.existsSync(SESS_FILE)) {
    const d = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8'));
    if (d && typeof d === 'object') sess = d;
  }
} catch (e) { console.error('Kon de sessies niet lezen:', e.message); }
const sessWait = new Map(); // id -> [waiters]
let sessTimer = null;
function persistSess() {
  clearTimeout(sessTimer);
  sessTimer = setTimeout(() => {
    const tmp = SESS_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(sess), err => {
      if (err) return console.error('Sessies opslaan mislukt:', err.message);
      fs.rename(tmp, SESS_FILE, e => e && console.error('Sessies opslaan mislukt:', e.message));
    });
  }, 300);
}
function sessClean() {
  const old = Date.now() - SESS_DAYS * 864e5; let n = 0;
  for (const [id, x] of Object.entries(sess)) if ((x.u || x.c || 0) < old) { delete sess[id]; n++; }
  if (n) persistSess();
}
setInterval(sessClean, 3600 * 1000); sessClean();
const hashCode = c => crypto.createHash('sha256').update(String(c || '')).digest('hex');
function sessOk(x, given) {
  const a = Buffer.from(hashCode(given), 'hex'), b = Buffer.from(String(x.h || ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sessBroadcast(id) {
  const x = sess[id]; if (!x) return;
  const view = viewOf(x), w = sessWait.get(id) || [];
  sessWait.set(id, []);
  for (const y of w) { clearTimeout(y.t); try { send(y.res, 200, view); } catch (e) {} }
}
const newHits = new Map();
function newId() {
  const ch = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (;;) { let id = ''; for (let i = 0; i < 6; i++) id += ch[crypto.randomInt(ch.length)]; if (!sess[id]) return id; }
}

// ---------- live verbindingen ----------
const clients = new Set();
let waiters = [];
function broadcast() {
  const view = publicView();
  const msg = 'data: ' + JSON.stringify(view) + '\n\n';
  for (const res of clients) {
    try { res.write(msg); } catch (e) { clients.delete(res); }
  }
  const w = waiters; waiters = [];
  for (const x of w) { clearTimeout(x.t); try { send(x.res, 200, view); } catch (e) {} }
}
setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); }
  }
}, 25000);

// ---------- beveiliging ----------
function same(given, real) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}
// Geeft 'admin', 'teller' of null terug
function roleOf(given) {
  if (same(given, PIN)) return 'admin';
  if (TPIN.length >= 4 && same(given, TPIN)) return 'teller';
  return null;
}
// Een teller mag alleen uitslagen, beurten en speel-instellingen wijzigen
const TELLER_KEYS = ['single', 'inmode', 'sound', 'voice', 'game', 'dout'];
function mergeTeller(oldS, newS) {
  const out = Object.assign({}, oldS);
  for (const k of TELLER_KEYS) if (k in newS) out[k] = newS[k];
  for (const k of ['results', 'turns']) {
    const inc = newS[k] && typeof newS[k] === 'object' ? newS[k] : {};
    const merged = Object.assign({}, oldS[k] || {}, inc);
    if (!('X' in inc)) delete merged.X; // 'nog een wedstrijd' bij 1 tegen 1
    out[k] = merged;
  }
  return out;
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
    if (req.method === 'GET' && (p === '/' || p === '/monitor' || p === '/kijk' || p === '/spel' || /^\/s\/[a-z0-9]{6}(\/monitor|\/kijk)?$/.test(p))) {
      return send(res, 200, page(), 'text/html; charset=utf-8');
    }

    // Nieuwe vriendensessie: geeft een eigen link en code terug
    if (req.method === 'POST' && p === '/api/sessie') {
      const now = Date.now(), l = (newHits.get(ip) || []).filter(t => now - t < 3600e3);
      if (l.length >= 10) return send(res, 429, { error: 'Te veel sessies gemaakt. Probeer het later opnieuw.' });
      sessClean();
      if (Object.keys(sess).length >= SESS_MAX) return send(res, 503, { error: 'Er zijn nu te veel sessies. Probeer het later opnieuw.' });
      l.push(now); newHits.set(ip, l);
      const id = newId(), code = String(crypto.randomInt(1000, 10000));
      sess[id] = { v: 1, S: null, live: null, by: null, h: hashCode(code), c: now, u: now };
      persistSess();
      return send(res, 200, { id, code });
    }

    const sm = /^\/api\/s\/([a-z0-9]{6})\/(state|wait|login)$/.exec(p);
    if (sm) {
      const id = sm[1], x = sess[id], what = sm[2];
      if (!x) return send(res, 404, { error: 'Deze sessie bestaat niet (meer)' });
      if (req.method === 'GET' && what === 'state') return send(res, 200, viewOf(x));
      if (req.method === 'GET' && what === 'wait') {
        const kt = url.searchParams.get('tv');
        if (Number(url.searchParams.get('v')) !== x.v || (kt !== null && Number(kt) !== top.v)) return send(res, 200, viewOf(x));
        const w = sessWait.get(id) || []; sessWait.set(id, w);
        if (w.length > 100) return send(res, 200, viewOf(x));
        const y = { res, t: setTimeout(() => { sessWait.set(id, (sessWait.get(id) || []).filter(z => z !== y)); send(res, 200, viewOf(x)); }, 25000) };
        w.push(y);
        req.on('close', () => { clearTimeout(y.t); sessWait.set(id, (sessWait.get(id) || []).filter(z => z !== y)); });
        return;
      }
      if (req.method === 'POST' && (what === 'login' || what === 'state')) {
        if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
        const b = await readBody(req);
        const given = what === 'login' ? b.pin : req.headers['x-pin'];
        if (!sessOk(x, given)) { failed(ip); return send(res, 401, { error: 'Onjuiste sessiecode' }); }
        if (what === 'login') { fails.delete(ip); x.u = Date.now(); persistSess(); return send(res, 200, { ok: true, role: 'admin' }); }
        if (!b || typeof b.S !== 'object' || !b.S || !Array.isArray(b.S.players)) return send(res, 400, { error: 'Ongeldige stand' });
        if (JSON.stringify(b).length > 1024 * 1024) return send(res, 413, { error: 'Te groot' });
        Object.assign(x, { v: x.v + 1, S: b.S, live: b.live && typeof b.live === 'object' ? b.live : null, by: typeof b.by === 'string' ? b.by.slice(0, 40) : null, u: Date.now() });
        persistSess();
        sessBroadcast(id);
        return send(res, 200, { ok: true, v: x.v });
      }
    }
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

    if (req.method === 'GET' && p === '/api/state') return send(res, 200, state);
    if (req.method === 'GET' && p === '/api/info') return send(res, 200, { publicUrl });

    // Live bijwerken via 'long polling': werkt ook via de gratis Cloudflare-tunnel
    if (req.method === 'GET' && p === '/api/wait') {
      const known = Number(url.searchParams.get('v'));
      const kc = url.searchParams.get('cv');
      const kt = url.searchParams.get('tv');
      if (known !== state.v || (kc !== null && Number(kc) !== chat.v) || (kt !== null && Number(kt) !== top.v)) return send(res, 200, publicView());
      if (waiters.length > 500) return send(res, 200, publicView());
      const x = { res, t: setTimeout(() => { waiters = waiters.filter(y => y !== x); send(res, 200, publicView()); }, 25000) };
      waiters.push(x);
      req.on('close', () => { clearTimeout(x.t); waiters = waiters.filter(y => y !== x); });
      return;
    }

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
      const role = roleOf(b.pin);
      if (role) { fails.delete(ip); return send(res, 200, { ok: true, role }); }
      failed(ip);
      return send(res, 401, { error: 'Onjuiste code' });
    }

    if (req.method === 'GET' && p === '/api/spel/top') return send(res, 200, topView());
    if (req.method === 'POST' && p === '/api/spel/score') {
      const b = await readBody(req);
      const n = clean(b.name, 24), sc = Number(b.score);
      if (!n || !Number.isInteger(sc) || sc < 0 || sc > 20) return send(res, 400, { error: 'Ongeldige score' });
      const now = Date.now(), l = (topHits.get(ip) || []).filter(t => now - t < 3600e3);
      if (l.length >= 60) return send(res, 429, { error: 'Te veel scores. Probeer het later opnieuw.' });
      l.push(now); topHits.set(ip, l); if (topHits.size > 2000) topHits.clear();
      const k = n.toLowerCase(), o = top.list[k], rec = !o || sc > o.s;
      if (rec) { top.list[k] = { n: o ? o.n : n, s: sc, d: now }; topChanged(); }
      return send(res, 200, { ok: true, record: rec, best: rec ? sc : o.s });
    }
    if (req.method === 'POST' && p === '/api/spel/beheer') {
      if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
      if (roleOf(req.headers['x-pin']) !== 'admin') { failed(ip); return send(res, 401, { error: 'Onjuiste code' }); }
      const b = await readBody(req);
      if (typeof b.del === 'string') delete top.list[b.del];
      if (b.clear === true) top.list = {};
      topChanged();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/chat') {
      if (!chat.on) return send(res, 403, { error: 'De chat staat uit' });
      if (chatPrune()) chat.v++;
      const b = await readBody(req);
      const n = clean(b.name, 20), t = clean(b.text, 200);
      if (!n || !t) return send(res, 400, { error: 'Vul je naam en een bericht in' });
      if (chatSpam(ip)) return send(res, 429, { error: 'Even rustig aan, probeer het zo opnieuw' });
      chat.msgs.push({ id: ++chat.seq, n, t, at: Date.now() });
      if (chat.msgs.length > 100) chat.msgs = chat.msgs.slice(-100);
      chatChanged();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/chat/beheer') {
      if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
      if (roleOf(req.headers['x-pin']) !== 'admin') { failed(ip); return send(res, 401, { error: 'Onjuiste code' }); }
      const b = await readBody(req);
      if (b.del != null) chat.msgs = chat.msgs.filter(m => m.id !== Number(b.del));
      if (b.clear === true) chat.msgs = [];
      if (typeof b.on === 'boolean') chat.on = b.on;
      chatChanged();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/state') {
      if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
      const role = roleOf(req.headers['x-pin']);
      if (!role) { failed(ip); return send(res, 401, { error: 'Onjuiste code' }); }
      const b = await readBody(req);
      if (!b || typeof b.S !== 'object' || !b.S || !Array.isArray(b.S.players)) return send(res, 400, { error: 'Ongeldige stand' });
      if (role === 'teller' && !state.S) return send(res, 403, { error: 'Nog niets om te tellen' });
      state = {
        v: state.v + 1,
        S: role === 'admin' ? b.S : mergeTeller(state.S, b.S),
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

// ---------- gratis Cloudflare-tunnel ----------
let publicUrl = null;
function startTunnel() {
  const local = path.join(__dirname, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const bin = process.env.CLOUDFLARED || (fs.existsSync(local) ? local : 'cloudflared');
  console.log('Tunnel starten…');
  let child;
  try {
    child = spawn(bin, ['tunnel', '--no-autoupdate', '--protocol', process.env.TUNNEL_PROTOCOL || 'http2', '--url', 'http://127.0.0.1:' + PORT], { windowsHide: true });
  } catch (e) { console.error('Kon cloudflared niet starten:', e.message); return; }
  let shownErr = 0;
  const scan = buf => {
    const txt = String(buf);
    for (const line of txt.split(/\r?\n/)) {
      if (/Registered tunnel connection/i.test(line)) console.log('Tunnel verbonden met Cloudflare ✓');
      else if (/\b(ERR|error)\b/i.test(line) && shownErr < 15) { shownErr++; console.log('Tunnel-melding: ' + line.replace(/^\S+\s+/, '').slice(0, 200)); }
    }
    const m = txt.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m && m[0] !== publicUrl) {
      publicUrl = m[0];
      const line = '='.repeat(64);
      console.log('\n' + line);
      console.log('  De Dart Struners staat online!');
      console.log('');
      console.log('  Beheer (telefoon):  ' + publicUrl);
      console.log('  Meekijken:          ' + publicUrl + '/kijk');
      console.log('  Monitor (hier):     http://localhost:' + PORT + '/monitor');
      console.log(line + '\n');
      try { fs.writeFileSync(path.join(__dirname, 'link.txt'), publicUrl + '\r\n' + publicUrl + '/kijk\r\n'); } catch (e) {}
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('error', e => console.error('Kon cloudflared niet starten:', e.message));
  child.on('exit', code => {
    console.log('Tunnel gestopt (' + code + '). Over 5 seconden opnieuw…');
    publicUrl = null;
    setTimeout(startTunnel, 5000);
  });
  const stop = () => { try { child.kill(); } catch (e) {} process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

// Met de tunnel alleen lokaal luisteren: dan vraagt Windows niet om de firewall
// alwaysdata geeft het adres door via HOST of IP
const HOST = process.env.HOST || process.env.IP || (process.env.TUNNEL === '1' ? '127.0.0.1' : undefined);
server.listen(PORT, HOST, () => {
  console.log('De Dart Struners draait op poort ' + PORT);
  console.log('Op deze computer: http://localhost:' + PORT);
  if (process.env.TUNNEL === '1') startTunnel();
});
