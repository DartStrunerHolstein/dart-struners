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
const { spawn, execFile } = require('child_process');

const PORT = +process.env.PORT || 3000;
const PIN = String(process.env.ADMIN_PIN || '').trim();
const TPIN = String(process.env.TELLER_PIN || '').trim();
const BPIN = String(process.env.BORD_PIN || '').trim(); // optioneel: code die alleen pijlen van het bord mag doorgeven
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
const topView = () => ({ v: top.v, list: Object.entries(top.list).map(([k, x]) => ({ k, n: k.startsWith('p:') && spl.list[k.slice(2)] ? spl.list[k.slice(2)].n : x.n, s: x.s, d: x.d, p: k.startsWith('p:') ? 1 : 0 })).sort((a, b) => b.s - a.s || a.d - b.d).slice(0, 200) });
const topHits = new Map();
function topChanged() {
  top.v++; persistTop(); broadcast();
  for (const id of Object.keys(sess)) if ((sessWait.get(id) || []).length) sessBroadcast(id);
}

// ---------- statistieken checkout-spel (alleen voor spelers met een profiel) ----------
const SST_FILE = path.join(DATA_DIR, 'spelstats.json');
let sst = { v: 0, list: {} };
try {
  if (fs.existsSync(SST_FILE)) {
    const d = JSON.parse(fs.readFileSync(SST_FILE, 'utf8'));
    if (d && d.list && typeof d.list === 'object') sst = Object.assign(sst, d);
  }
} catch (e) { console.error('Kon de spelstatistieken niet lezen:', e.message); }
let sstTimer = null;
function persistSst() {
  clearTimeout(sstTimer);
  sstTimer = setTimeout(() => {
    const tmp = SST_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(sst), err => {
      if (err) return console.error('Spelstatistieken opslaan mislukt:', err.message);
      fs.rename(tmp, SST_FILE, e => e && console.error('Spelstatistieken opslaan mislukt:', e.message));
    });
  }, 300);
}
// ---------- dubbels per speler: hoe vaak gegooid op een dubbel en hoe vaak raak ----------
// Een pijl telt als "op een dubbel" als de rest op dat moment met één dubbel uit te gooien is (2–40 even, of 50 = bull)
const DDK = /^(D([1-9]|1[0-9]|20)|Bull)$/;
const labVal = l => { l = String(l || ''); if (l === 'Bull') return [50, true]; if (l === '25') return [25, false]; const m = /^([SDT]?)(\d{1,2})$/.exec(l); if (!m) return [0, false]; const n = +m[2]; return m[1] === 'T' ? [3 * n, false] : m[1] === 'D' ? [2 * n, true] : [n, false]; };
const ddTarget = r => r === 50 ? 'Bull' : (r >= 2 && r <= 40 && r % 2 === 0 ? 'D' + r / 2 : null);
function ddDarts(dd, rem, darts) { // darts = [[waarde, dubbel]]
  let r = rem;
  for (const [v, dbl] of darts) {
    const tg = ddTarget(r);
    if (tg) { const e = dd[tg] = dd[tg] || [0, 0]; e[0]++; if (r - v === 0 && dbl) { e[1]++; return; } }
    r -= v; if (r <= 1) return;
  }
}
function ddClean(o) { const out = {}; if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (DDK.test(k) && Array.isArray(v)) { const a = Math.max(0, Math.min(1e5, Math.floor(+v[0]) || 0)), h = Math.max(0, Math.min(a, Math.floor(+v[1]) || 0)); if (a) out[k] = [a, h]; } return out; }
function ddAdd(into, from) { for (const [k, v] of Object.entries(from || {})) { const e = into[k] = into[k] || [0, 0]; e[0] += v[0]; e[1] += v[1]; } }

// det = [{t: 41..60, ok: 0/1, d: pijlen, f: laatste pijl, r: [labels]}]
function sstAdd(pid, score, det) {
  const x = sst.list[pid] = sst.list[pid] || { g: 0, full: 0, sumFull: 0, best: 0, nums: {}, fin: {}, last: [] };
  const L = (Array.isArray(det) ? det : []).slice(0, 20).filter(a => a && Number.isInteger(a.t) && a.t >= 41 && a.t <= 60);
  if (!L.length) return false;
  x.g++; if (L.length >= 20) { x.full++; x.sumFull += score; }
  if (score > x.best) x.best = score;
  for (const a of L) {
    const k = String(a.t), n = x.nums[k] = x.nums[k] || [0, 0, 0], d = Math.max(1, Math.min(3, +a.d || 3));
    n[0]++; if (a.ok) { n[1]++; n[2] += d; const f = clean(a.f, 8); if (f) x.fin[f] = (x.fin[f] || 0) + 1; }
    if (Array.isArray(a.r)) { x.dd = x.dd || {}; ddDarts(x.dd, a.t, a.r.slice(0, 3).map(labVal)); }
  }
  x.last = (x.last || []).concat([{ s: score, n: L.length, at: Date.now() }]).slice(-10);
  sst.v++; persistSst(); return true;
}
const sstView = () => ({ v: sst.v, list: Object.fromEntries(Object.entries(sst.list).filter(([id]) => spl.list[id]).map(([id, x]) => [id, Object.assign({ n: spl.list[id].n }, x)])) });

// ---------- archief van toernooien (blijft bewaard, ook als de sessie verloopt) ----------
const TRN_FILE = path.join(DATA_DIR, 'toernooien.json');
let trn = { v: 0, list: {} };
try {
  if (fs.existsSync(TRN_FILE)) {
    const d = JSON.parse(fs.readFileSync(TRN_FILE, 'utf8'));
    if (d && d.list && typeof d.list === 'object') trn = Object.assign(trn, d);
  }
} catch (e) { console.error('Kon de toernooien niet lezen:', e.message); }
let trnTimer = null;
function persistTrn() {
  clearTimeout(trnTimer);
  trnTimer = setTimeout(() => {
    const tmp = TRN_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(trn), err => {
      if (err) return console.error('Toernooien opslaan mislukt:', err.message);
      fs.rename(tmp, TRN_FILE, e => e && console.error('Toernooien opslaan mislukt:', e.message));
    });
  }, 300);
}
const ST_KEYS = ['n', 'darts', 'sum', 'f9s', 'f9d', 't180', 't140', 't100', 'hi', 'hco', 'dAtt', 'dHit', 'best', 'wDarts', 'wLegs', 'mW', 'mL', 'lW', 'lL'];
function trnClean(b) {
  const pl = (Array.isArray(b.players) ? b.players : []).slice(0, 64).map(x => {
    const st = {}; for (const k of ST_KEYS) { const v = Number(x && x.s && x.s[k]); st[k] = Number.isFinite(v) && v >= 0 && v < 1e6 ? Math.round(v) : 0; }
    const pid = x && typeof x.pid === 'string' && spl.list[x.pid] ? x.pid : null;
    const dd = ddClean(x && x.s && x.s.dd); if (Object.keys(dd).length) st.dd = dd;
    return { n: clean(x && x.n, 24), pid, s: st };
  }).filter(x => x.n);
  const nm = v => clean(v, 24) || null;
  return { naam: clean(b.naam, 40), game: [101, 201, 301, 501].includes(+b.game) ? +b.game : 501, players: pl, p1: nm(b.p1), p2: nm(b.p2), p3: nm(b.p3) };
}

// ---------- archief van 1 tegen 1-wedstrijden (geen solo) ----------
const WED_FILE = path.join(DATA_DIR, 'wedstrijden.json');
let wed = { v: 0, list: {} };
try {
  if (fs.existsSync(WED_FILE)) {
    const d = JSON.parse(fs.readFileSync(WED_FILE, 'utf8'));
    if (d && d.list && typeof d.list === 'object') wed = Object.assign(wed, d);
  }
} catch (e) { console.error('Kon de wedstrijden niet lezen:', e.message); }
let wedTimer = null;
function persistWed() {
  clearTimeout(wedTimer);
  wedTimer = setTimeout(() => {
    const tmp = WED_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(wed), err => {
      if (err) return console.error('Wedstrijden opslaan mislukt:', err.message);
      fs.rename(tmp, WED_FILE, e => e && console.error('Wedstrijden opslaan mislukt:', e.message));
    });
  }, 300);
}

// ---------- spelersprofielen (naam + 4-cijferige pincode, geen e-mail) ----------
const SPL_FILE = path.join(DATA_DIR, 'spelers.json');
let spl = { v: 0, geheim: '', list: {} };
try {
  if (fs.existsSync(SPL_FILE)) {
    const d = JSON.parse(fs.readFileSync(SPL_FILE, 'utf8'));
    if (d && d.list && typeof d.list === 'object') spl = Object.assign(spl, d);
  }
} catch (e) { console.error('Kon de spelers niet lezen:', e.message); }
if (!spl.geheim) spl.geheim = crypto.randomBytes(32).toString('hex');
let splTimer = null;
function persistSpl() {
  clearTimeout(splTimer);
  splTimer = setTimeout(() => {
    const tmp = SPL_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(spl), err => {
      if (err) return console.error('Spelers opslaan mislukt:', err.message);
      fs.rename(tmp, SPL_FILE, e => e && console.error('Spelers opslaan mislukt:', e.message));
    });
  }, 300);
}
if (!fs.existsSync(SPL_FILE)) persistSpl();
const pinHash = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const splToken = id => { const x = spl.list[id]; return x ? crypto.createHmac('sha256', spl.geheim).update(id + ':' + (x.pv || 0)).digest('hex').slice(0, 32) : ''; };
const splOk = (id, t) => typeof id === 'string' && typeof t === 'string' && !!spl.list[id] && t.length === 32 && same(t, splToken(id));
const splKey = n => String(n || '').trim().toLowerCase();
// Zoekt een profiel op naam (ook oude namen na hernoemen/samenvoegen)
function splByName(n) {
  const k = splKey(n); if (!k) return null;
  for (const [id, x] of Object.entries(spl.list)) if (splKey(x.n) === k || (x.alias || []).some(a => splKey(a) === k)) return id;
  return null;
}
const splView = () => ({ v: spl.v, list: Object.entries(spl.list).map(([id, x]) => ({ id, n: x.n, a: (x.alias || []).slice(0, 10) })).sort((a, b) => a.n.localeCompare(b.n, 'nl')) });
function splChanged() { spl.v++; persistSpl(); }
const splNew = new Map(), splFail = new Map(); // ip -> tijden ; profiel -> {n, until}
// Een score van een gast mag niet onder de naam van een profiel komen
function topMoveToProfile(id) {
  const x = spl.list[id]; if (!x) return;
  const names = [x.n].concat(x.alias || []).map(splKey); let best = top.list['p:' + id] || null, ch = false;
  for (const k of names) { const o = top.list[k]; if (o) { if (!best || o.s > best.s) best = { n: x.n, s: o.s, d: o.d }; delete top.list[k]; ch = true; } }
  if (best) { best.n = x.n; top.list['p:' + id] = best; }
  if (ch || best) topChanged();
}

let writeTimer = null;
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state, noCam), err => {
      if (err) return console.error('Opslaan mislukt:', err.message);
      fs.rename(tmp, STATE_FILE, e => e && console.error('Opslaan mislukt:', e.message));
    });
  }, 300);
}

// ---------- camera's (Autodarts via het doorgeefprogramma) ----------
// Elke kamer (hoofdstand of sessie) krijgt een rij met de laatste pijlen; niet opgeslagen op schijf
const noCam = (k, v) => (k === 'cam' ? undefined : v);
// BOOT verandert bij elke herstart van de server: de telefoon weet dan dat de pijl-nummers opnieuw beginnen
const BOOT = crypto.randomBytes(4).toString('hex');
function camOf(room) { if (!room.cam) room.cam = { seq: 0, at: 0, st: null, ev: [], uids: [] }; if (!room.cam.uids) room.cam.uids = []; return room.cam; }
function camView(room, own) { const c = camOf(room); const v = { b: BOOT, seq: c.seq, at: c.at, now: Date.now(), st: c.st, ev: c.ev.slice(-40), own: own || '' }; if (c.foto) v.foto = { v: c.foto.v, n: c.foto.n, at: c.foto.at, p: c.foto.p }; return v; }
function camPush(room, events, st) {
  const c = camOf(room), now = Date.now();
  c.at = now;
  if (st && typeof st === 'object') c.st = { connected: !!st.connected, running: !!st.running, status: String(st.status || '').slice(0, 40),
    gz: ['ok', 'hangt', 'kalib', 'weg', 'dubbel'].includes(st.gz) ? st.gz : 'ok', gm: String(st.gm || '').slice(0, 160), kb: ['bezig', 'gestart', 'klaar', 'mislukt'].includes(st.kb) ? st.kb : '' };
  for (const e of Array.isArray(events) ? events.slice(0, 20) : []) {
    if (!e || typeof e !== 'object') continue;
    const k = String(e.k || '');
    if (!['dart', 'takeout', 'fix'].includes(k)) continue;
    // Dezelfde pijl twee keer ontvangen (laptop stuurde opnieuw omdat het antwoord niet aankwam)? Dan negeren
    const u = typeof e.u === 'string' && /^[a-z0-9]{4,12}-\d{1,9}$/.test(e.u) ? e.u : null;
    if (u) { if (c.uids.includes(u)) continue; c.uids.push(u); if (c.uids.length > 300) c.uids = c.uids.slice(-300); }
    const n = Math.max(0, Math.min(25, Math.floor(Number(e.n) || 0))), m = Math.max(0, Math.min(3, Math.floor(Number(e.m) || 0)));
    const ev = { id: ++c.seq, k, n, m, i: Math.max(0, Math.min(2, Math.floor(Number(e.i) || 0))), name: String(e.name || '').slice(0, 12), at: now };
    const x = Number(e.x), y = Number(e.y);
    if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 3 && Math.abs(y) < 3) { ev.x = Math.round(x * 1e4) / 1e4; ev.y = Math.round(y * 1e4) / 1e4; }
    c.ev.push(ev);
  }
  if (c.ev.length > 40) c.ev = c.ev.slice(-40);
  c.seq++; // ook een 'ping' telt als verandering, zodat de status live bijwerkt
}

// ---------- koppelen: laptop met camera's <-> telefoon met een korte code ----------
// Het doorgeefprogramma vraagt één keer een code (bijv. K7P2) en stuurt daarna zijn pijlen hierheen.
// De telefoon die die code intypt, luistert mee en verwerkt de pijlen in de wedstrijd die daar open staat.
const KOP_FILE = path.join(DATA_DIR, 'koppel.json');
let kop = {}; // id -> { h (hash van het geheim), code, c, u }
try { if (fs.existsSync(KOP_FILE)) { const d = JSON.parse(fs.readFileSync(KOP_FILE, 'utf8')); if (d && typeof d === 'object') kop = d; } } catch (e) {}
const kopRoom = new Map(), kopWait = new Map(), kopSeen = new Map(), kopHits = new Map(), kopOwn = new Map();
// Camerafoto's na elke pijl (alleen in het geheugen): id -> { v, n, at, p, cams: [Buffer] }; kopFotoWil: wanneer de monitor-weergave er laatst om vroeg
const kopFoto = new Map(), kopFotoNieuw = new Map(), kopFotoWil = new Map(), kopRuns = new Map();
let kopTimer = null;
function persistKop() {
  clearTimeout(kopTimer);
  kopTimer = setTimeout(() => { const tmp = KOP_FILE + '.tmp'; fs.writeFile(tmp, JSON.stringify(kop), e => { if (!e) fs.rename(tmp, KOP_FILE, () => {}); }); }, 500);
}
function kopClean() { const old = Date.now() - 90 * 864e5; let n = 0; for (const [id, x] of Object.entries(kop)) if ((x.u || x.c || 0) < old) { delete kop[id]; n++; } if (n) persistKop(); }
setInterval(kopClean, 6 * 3600e3); kopClean();
const roomOfKop = id => { if (!kopRoom.has(id)) kopRoom.set(id, {}); return kopRoom.get(id); };
const kopByCode = c => { c = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); for (const [id, x] of Object.entries(kop)) if (x.code === c) return id; return null; };
// Opdrachten van de telefoon naar het doorgeefprogramma (bijv. Autodarts resetten)
const kopCmd = new Map(), kopCmdWait = new Map(), kopCmdHits = new Map();
const kopCmdView = id => kopCmd.get(id) || { n: 0, cmd: '' };
function kopCmdNotify(id) { const w = kopCmdWait.get(id) || []; kopCmdWait.set(id, []); for (const y of w) { clearTimeout(y.t); try { send(y.res, 200, kopCmdView(id)); } catch (e) {} } }
function kopNotify(id) { const w = kopWait.get(id) || []; kopWait.set(id, []); for (const y of w) { try { if (y.done) y.done(); else clearTimeout(y.t); const v = y.view ? y.view() : camView(roomOfKop(id), (kopOwn.get(id) || {}).d); send(y.res, 200, v); } catch (e) {} } }
function newKopCode() { const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += ch[crypto.randomInt(ch.length)]; if (!kopByCode(c)) return c; } }

// Voor meekijkers alleen de beurten van de wedstrijd die nu bezig is
function viewOf(st) {
  const S = st.S ? Object.assign({}, st.S) : null;
  const open = st.live && st.live.openId;
  if (S && S.turns) S.turns = open && S.turns[open] ? { [open]: S.turns[open] } : {};
  return { v: st.v, by: st.by, S, live: st.live, top: topView(), cam: camView(st) };
}
function publicView() {
  return Object.assign(viewOf(state), { chat: { v: chat.v, on: chat.on, msgs: chat.msgs } });
}

// ---------- sessies van vrienden (eigen link + code, los van de hoofdstand) ----------
const SESS_FILE = path.join(DATA_DIR, 'sessies.json');
const SESS_DAYS = 3, SESS_MAX = 300; // een sessie die 3 dagen niet gebruikt wordt, verdwijnt
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
    fs.writeFile(tmp, JSON.stringify(sess, noCam), err => {
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
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > max) { reject(new Error('te groot')); req.destroy(); return; } parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
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

// ---------- versie ----------
let VERSIE = '';
let bijwerkenBezig = false;
execFile('git', ['log', '-1', '--format=%h %cd', '--date=format:%d-%m-%Y %H:%M'], { cwd: __dirname, timeout: 5000 }, (e, out) => { if (!e) VERSIE = String(out).trim(); });

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const ip = ipOf(req);

  try {
    if (req.method === 'GET' && (p === '/' || p === '/beheer' || p === '/spelen' || p === '/monitor' || p === '/kijk' || p === '/spel' || /^\/s\/[a-z0-9]{6}(\/monitor|\/kijk)?$/.test(p))) {
      return send(res, 200, page(), 'text/html; charset=utf-8');
    }

    // App-bestanden (installeerbare app): manifest, service worker, iconen
    if (req.method === 'GET' && (p === '/manifest.webmanifest' || p === '/sw.js' || /^\/icons\/[a-z0-9-]+\.png$/.test(p) || p === '/favicon.ico')) {
      const f = p === '/favicon.ico' ? '/icons/favicon-32.png' : p;
      const type = f.endsWith('.png') ? 'image/png' : f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/manifest+json; charset=utf-8';
      let buf; try { buf = fs.readFileSync(path.join(PUBLIC, f)); } catch { return send(res, 404, { error: 'Niet gevonden' }); }
      res.writeHead(200, Object.assign({ 'Content-Type': type, 'Cache-Control': f.endsWith('.png') ? 'public, max-age=604800' : 'no-cache' }, HEADERS));
      return res.end(buf);
    }

    // Nieuwe vriendensessie: geeft een eigen link en code terug
    if (req.method === 'POST' && p === '/api/sessie') {
      const now = Date.now(), l = (newHits.get(ip) || []).filter(t => now - t < 3600e3);
      if (l.length >= 10) return send(res, 429, { error: 'Te veel sessies gemaakt. Probeer het later opnieuw.' });
      sessClean();
      if (Object.keys(sess).length >= SESS_MAX) return send(res, 503, { error: 'Er zijn nu te veel sessies. Probeer het later opnieuw.' });
      l.push(now); newHits.set(ip, l);
      // De vorige sessie(s) van dit apparaat opruimen (alleen met de juiste code)
      let b = {}; try { b = await readBody(req); } catch (e) {}
      for (const o of Array.isArray(b.oud) ? b.oud.slice(0, 5) : []) {
        const oid = String(o && o.id || '').toLowerCase();
        if (/^[a-z0-9]{6}$/.test(oid) && sess[oid] && sessOk(sess[oid], o.code)) { delete sess[oid]; sessBroadcast(oid); }
      }
      const id = newId(), code = String(crypto.randomInt(1000, 10000));
      sess[id] = { v: 1, S: null, live: null, by: null, h: hashCode(code), c: now, u: now };
      persistSess();
      return send(res, 200, { id, code });
    }

    const sm = /^\/api\/s\/([a-z0-9]{6})\/(state|wait|login|bord|toernooi|wedstrijd)$/.exec(p);
    if (sm) {
      const id = sm[1], x = sess[id], what = sm[2];
      if (!x) return send(res, 404, { error: 'Deze sessie bestaat niet (meer)' });
      if (req.method === 'GET' && what === 'state') return send(res, 200, { v: x.v, by: x.by, S: x.S, live: x.live, top: topView(), cam: camView(x) }); // volledig, zodat een tweede apparaat niets kwijtraakt
      if (req.method === 'GET' && what === 'wait') {
        const kt = url.searchParams.get('tv');
        const kb = url.searchParams.get('bv');
        if (Number(url.searchParams.get('v')) !== x.v || (kt !== null && Number(kt) !== top.v) || (kb !== null && Number(kb) !== camOf(x).seq)) return send(res, 200, viewOf(x));
        const w = sessWait.get(id) || []; sessWait.set(id, w);
        if (w.length > 100) return send(res, 200, viewOf(x));
        const y = { res, t: setTimeout(() => { sessWait.set(id, (sessWait.get(id) || []).filter(z => z !== y)); send(res, 200, viewOf(x)); }, 25000) };
        w.push(y);
        req.on('close', () => { clearTimeout(y.t); sessWait.set(id, (sessWait.get(id) || []).filter(z => z !== y)); });
        return;
      }
      if (req.method === 'POST' && what === 'wedstrijd') {
        if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
        if (!sessOk(x, req.headers['x-pin'])) { failed(ip); return send(res, 401, { error: 'Onjuiste sessiecode' }); }
        const b = await readBody(req);
        const mid = typeof b.mid === 'string' && /^[a-z0-9]{6,12}$/.test(b.mid) ? b.mid : null;
        if (!mid) return send(res, 400, { error: 'Ongeldige wedstrijd' });
        const c = trnClean(b), soort = ['1v1', '3', '2v2'].includes(b.soort) ? b.soort : '1v1';
        const need = { '1v1': 2, '3': 3, '2v2': 4 }[soort], ns = soort === '3' ? 3 : 2;
        if (c.players.length !== need) return send(res, 400, { error: 'Verkeerd aantal spelers' });
        c.players.forEach((p, i) => { const t = Number(b.players[i] && b.players[i].t); p.t = Number.isInteger(t) && t >= 0 && t < ns ? t : (soort === '2v2' ? i >> 1 : i); });
        const win = Number.isInteger(b.win) && b.win >= 0 && b.win < ns ? b.win : null;
        if (win === null) return send(res, 400, { error: 'Wedstrijd is nog niet klaar' });
        const legs = Array.isArray(b.legs) ? b.legs.slice(0, ns).map(v => Math.max(0, Math.min(20, Math.floor(+v) || 0))) : null;
        const key = id + ':' + mid, old = wed.list[key];
        wed.list[key] = { at: old ? old.at : Date.now(), u: Date.now(), sid: id, soort, game: c.game, win, legs, players: c.players };
        const keys = Object.keys(wed.list);
        if (keys.length > 5000) keys.sort((a, z) => wed.list[a].at - wed.list[z].at).slice(0, keys.length - 5000).forEach(k => delete wed.list[k]);
        wed.v++; persistWed();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && what === 'toernooi') {
        if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
        if (!sessOk(x, req.headers['x-pin'])) { failed(ip); return send(res, 401, { error: 'Onjuiste sessiecode' }); }
        const b = await readBody(req);
        const tid = typeof b.tid === 'string' && /^[a-z0-9]{6,12}$/.test(b.tid) ? b.tid : null;
        if (!tid) return send(res, 400, { error: 'Ongeldig toernooi' });
        const c = trnClean(b);
        if (c.players.length < 2 || !c.p1) return send(res, 400, { error: 'Toernooi is nog niet klaar' });
        const key = id + ':' + tid, old = trn.list[key];
        trn.list[key] = Object.assign({ at: old ? old.at : Date.now(), sid: id }, c, { u: Date.now() });
        const keys = Object.keys(trn.list);
        if (keys.length > 500) keys.sort((a, z) => trn.list[a].at - trn.list[z].at).slice(0, keys.length - 500).forEach(k => delete trn.list[k]);
        trn.v++; persistTrn();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && what === 'bord') {
        if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
        if (!sessOk(x, req.headers['x-pin'])) { failed(ip); return send(res, 401, { error: 'Onjuiste sessiecode' }); }
        const b = await readBody(req);
        camPush(x, b.events, b.status);
        sessBroadcast(id);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (what === 'login' || what === 'state')) {
        if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
        const b = await readBody(req);
        const given = what === 'login' ? b.pin : req.headers['x-pin'];
        if (!sessOk(x, given)) { failed(ip); return send(res, 401, { error: 'Onjuiste sessiecode' }); }
        if (what === 'login') { fails.delete(ip); x.u = Date.now(); persistSess(); return send(res, 200, { ok: true, role: 'admin' }); }
        if (!b || typeof b.S !== 'object' || !b.S || !Array.isArray(b.S.players)) return send(res, 400, { error: 'Ongeldige stand' });
        if (JSON.stringify(b).length > 1024 * 1024) return send(res, 413, { error: 'Te groot' });
        Object.assign(x, { v: x.v + 1, S: b.S, live: b.live && typeof b.live === 'object' ? b.live : null, by: typeof b.by === 'string' ? b.by.slice(0, 40) : null, u: Date.now(), lt: Date.now() });
        persistSess();
        sessBroadcast(id);
        return send(res, 200, { ok: true, v: x.v });
      }
    }
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

    if (req.method === 'GET' && p === '/api/state') return send(res, 200, state);
    // Alle beurten van de competitie (voor de statistieken), zonder bordcoördinaten
    if (req.method === 'GET' && p === '/api/comp/beurten') {
      const T = (state.S && state.S.turns) || {}, out = {};
      for (const [k, t] of Object.entries(T)) if (k[0] === 'C' && t && Array.isArray(t.list))
        out[k] = { a: t.a, b: t.b, list: t.list.map(x => ({ leg: x.leg, side: x.side, score: x.score, bust: x.bust, out: x.out, d: Array.isArray(x.d) ? x.d.map(q => ({ lab: q.lab, v: q.v, dbl: q.dbl })) : null })) };
      return send(res, 200, { v: state.v, turns: out });
    }
    if (req.method === 'GET' && p === '/api/info') return send(res, 200, { publicUrl, versie: VERSIE });

    // Website bijwerken vanaf GitHub (alleen beheerder): git pull, daarna herstart de server zichzelf
    if (req.method === 'POST' && p === '/api/bijwerken') {
      if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
      if (roleOf(req.headers['x-pin']) !== 'admin') { failed(ip); return send(res, 401, { error: 'Onjuiste code' }); }
      if (bijwerkenBezig) return send(res, 409, { error: 'Er wordt al bijgewerkt' });
      bijwerkenBezig = true;
      execFile('git', ['pull', '--ff-only'], { cwd: __dirname, timeout: 60000 }, (err, stdout, stderr) => {
        bijwerkenBezig = false;
        const uit = (String(stdout || '') + String(stderr || '')).trim().slice(-1500);
        if (err) return send(res, 500, { error: 'Bijwerken mislukt', uit });
        const nieuw = !/Already up.to.date|Al bijgewerkt/i.test(uit);
        send(res, 200, { ok: true, nieuw, uit });
        if (nieuw) {
          console.log('Bijgewerkt vanaf GitHub, de server herstart…');
          setTimeout(() => {
            persist(); // laatste stand wegschrijven
            setTimeout(() => {
              // Stoppen: alwaysdata start de site bij het volgende bezoek vanzelf opnieuw, nu met de nieuwe versie
              process.exit(0);
            }, 800);
          }, 300);
        }
      });
      return;
    }

    // Live bijwerken via 'long polling': werkt ook via de gratis Cloudflare-tunnel
    if (req.method === 'GET' && p === '/api/wait') {
      const known = Number(url.searchParams.get('v'));
      const kc = url.searchParams.get('cv');
      const kt = url.searchParams.get('tv');
      const kb = url.searchParams.get('bv');
      if (known !== state.v || (kc !== null && Number(kc) !== chat.v) || (kt !== null && Number(kt) !== top.v) || (kb !== null && Number(kb) !== camOf(state).seq)) return send(res, 200, publicView());
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

    if (req.method === 'POST' && p === '/api/koppel/nieuw') {
      const now = Date.now(), l = (kopHits.get(ip) || []).filter(t => now - t < 3600e3);
      if (l.length >= 10) return send(res, 429, { error: 'Te vaak een nieuwe code gevraagd. Probeer het later opnieuw.' });
      l.push(now); kopHits.set(ip, l);
      if (Object.keys(kop).length > 2000) kopClean();
      const id = crypto.randomBytes(9).toString('hex'), secret = crypto.randomBytes(18).toString('hex'), code = newKopCode();
      kop[id] = { h: hashCode(secret), code, c: now, u: now };
      persistKop();
      return send(res, 200, { id, secret, code });
    }
    const km = /^\/api\/koppel\/([a-f0-9]{18})$/.exec(p);
    if (km && req.method === 'POST') {
      const id = km[1], x = kop[id];
      if (!x) return send(res, 404, { error: 'Onbekend bord' });
      if (!sessOk(x, req.headers['x-secret'])) return send(res, 401, { error: 'Onjuist geheim' });
      const b = await readBody(req);
      // Twee doorgeefprogramma's met dezelfde code (oud venster nog open)? Alleen het nieuwst gestarte telt, anders telt elke pijl dubbel
      const now = Date.now(), t0 = Math.max(0, Number(b.t0) || Number(b.status && b.status.t0) || 0), runs = (kopRuns.get(id) || []).filter(r => now - r.at < 45000 && r.t0 !== t0);
      runs.push({ t0, at: now }); kopRuns.set(id, runs);
      const nieuwste = Math.max(...runs.map(r => r.t0)), oud = t0 < nieuwste;
      if (oud) return send(res, 200, { ok: true, code: x.code, oud: true });
      const st = b.status && typeof b.status === 'object' ? Object.assign({}, b.status) : b.status;
      if (st && runs.some(r => r.t0 !== t0 && now - r.at < 25000)) { st.gz = 'dubbel'; st.gm = 'Er draaien twee doorgeefprogramma\'s met deze code op de laptop. Alleen het nieuwste telt; sluit het oude zwarte venster.'; }
      camPush(roomOfKop(id), b.events, st);
      if (now - (x.u || 0) > 3600e3) { x.u = now; persistKop(); }
      kopNotify(id);
      return send(res, 200, { ok: true, code: x.code, telefoon: Date.now() - (kopSeen.get(id) || 0) < 35000, foto: Date.now() - (kopFotoWil.get(id) || 0) < 60000 });
    }
    // De laptop stuurt na een pijl de beelden van de camera's (één JPEG per verzoek; ?b=reeks&c=camera&n=aantal&p=pijl)
    const kf = /^\/api\/koppel\/([a-f0-9]{18})\/foto$/.exec(p);
    if (kf && req.method === 'POST') {
      const id = kf[1], x = kop[id];
      if (!x) return send(res, 404, { error: 'Onbekend bord' });
      if (!sessOk(x, req.headers['x-secret'])) return send(res, 401, { error: 'Onjuist geheim' });
      const b = Math.floor(Number(url.searchParams.get('b'))), c = Math.floor(Number(url.searchParams.get('c'))), n = Math.floor(Number(url.searchParams.get('n')));
      if (!Number.isFinite(b) || !(c >= 0 && c < 6) || !(n >= 1 && n <= 6) || c >= n) return send(res, 400, { error: 'Onjuist' });
      const fr = kopRuns.get(id) || [], ft0 = Math.max(0, Number(url.searchParams.get('t0')) || 0);
      if (fr.length > 1 && ft0 < Math.max(...fr.map(r => r.t0))) { req.resume(); return send(res, 200, { ok: true, oud: true }); }
      let buf;
      try { buf = await readRaw(req, 1024 * 1024); } catch (e) { return send(res, 413, { error: 'Te groot' }); }
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return send(res, 400, { error: 'Geen JPEG' });
      let nw = kopFotoNieuw.get(id);
      if (!nw || nw.b !== b) { nw = { b, n, cams: [], p: String(url.searchParams.get('p') || '').slice(0, 12) }; kopFotoNieuw.set(id, nw); }
      nw.cams[c] = buf;
      if (nw.cams.filter(Boolean).length >= nw.n) {
        kopFotoNieuw.delete(id);
        const old = kopFoto.get(id), room = roomOfKop(id), cm = camOf(room);
        const f = { v: (old ? old.v : 0) + 1, n: nw.n, at: Date.now(), p: nw.p, cams: nw.cams };
        kopFoto.set(id, f); cm.foto = { v: f.v, n: f.n, at: f.at, p: f.p }; cm.seq++;
        kopNotify(id);
      }
      return send(res, 200, { ok: true });
    }
    const kg = /^\/api\/koppel\/code\/([A-Za-z0-9]{4})\/foto\/(\d)$/.exec(p);
    if (kg && req.method === 'GET') {
      const id = kopByCode(kg[1]), f = id && kopFoto.get(id), buf = f && f.cams[+kg[2]];
      if (!buf) return send(res, 404, { error: 'Geen foto' });
      res.writeHead(200, Object.assign({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=600', 'Content-Length': buf.length }, HEADERS));
      return res.end(buf);
    }
    // De laptop wacht hier op opdrachten van de telefoon
    const ko = /^\/api\/koppel\/([a-f0-9]{18})\/opdracht$/.exec(p);
    if (ko && req.method === 'GET') {
      const id = ko[1], x = kop[id];
      if (!x) return send(res, 404, { error: 'Onbekend bord' });
      if (!sessOk(x, req.headers['x-secret'])) return send(res, 401, { error: 'Onjuist geheim' });
      const n = Number(url.searchParams.get('n'));
      if (!Number.isFinite(n) || n !== kopCmdView(id).n) return send(res, 200, kopCmdView(id));
      const w = kopCmdWait.get(id) || []; kopCmdWait.set(id, w);
      if (w.length > 5) return send(res, 200, kopCmdView(id));
      const y = { res, t: setTimeout(() => { kopCmdWait.set(id, (kopCmdWait.get(id) || []).filter(z => z !== y)); send(res, 200, kopCmdView(id)); }, 25000) };
      w.push(y);
      req.on('close', () => { clearTimeout(y.t); kopCmdWait.set(id, (kopCmdWait.get(id) || []).filter(z => z !== y)); });
      return;
    }
    // De telefoon vraagt de laptop om Autodarts te resetten (beurt in de app afgerond, Autodarts wacht nog op pijlen)
    const kr = /^\/api\/koppel\/code\/([A-Za-z0-9]{4})\/(reset)$/.exec(p);
    if (kr && req.method === 'POST') {
      const id = kopByCode(kr[1]);
      if (!id) return send(res, 404, { error: 'Deze koppelcode bestaat niet' });
      const now = Date.now(), l = (kopCmdHits.get(id) || []).filter(t => now - t < 60000);
      if (l.length >= 20) return send(res, 429, { error: 'Te vaak' });
      l.push(now); kopCmdHits.set(id, l);
      kopCmd.set(id, { n: kopCmdView(id).n + 1, cmd: kr[2], at: now });
      kopCmdNotify(id);
      return send(res, 200, { ok: true });
    }
    const kw = /^\/api\/koppel\/code\/([A-Za-z0-9]{4})\/wait$/.exec(p);
    if (kw && req.method === 'GET') {
      const id = kopByCode(kw[1]);
      if (!id) return send(res, 404, { error: 'Deze koppelcode bestaat niet' });
      kopSeen.set(id, Date.now());
      if (url.searchParams.get('f') === '1') kopFotoWil.set(id, Date.now());
      // Maar één apparaat per camera telt de pijlen (anders tellen twee telefoons/laptops dezelfde pijl allebei)
      const dv = /^[a-z0-9]{6,16}$/.test(url.searchParams.get('d') || '') ? url.searchParams.get('d') : '';
      // Eén apparaat telt (anders telt een beurt dubbel). Het meldt steeds tot welke pijl het geteld heeft (ap).
      // Valt het weg, dan neemt een ander apparaat het over en telt de gemiste pijlen alsnog (vanaf ap).
      const room = roomOfKop(id), cmr = camOf(room), now = Date.now(), maxId = cmr.ev.length ? cmr.ev[cmr.ev.length - 1].id : 0;
      const rel = url.searchParams.get('rel'), ap = Math.floor(Number(url.searchParams.get('ap'))), wasOwn = (kopOwn.get(id) || {}).d || '';
      let o = kopOwn.get(id);
      if (o && (o.d === dv || o.d === rel) && Number.isFinite(ap) && ap >= 0 && ap <= maxId) o.ap = Math.max(o.ap || 0, ap);
      if (rel && o && o.d === rel) { kopOwn.delete(id); o = null; }   // wedstrijd verlaten / achtergrond: pijlen daarna tellen niet voor die wedstrijd
      const stale = x => !x || (x.pend <= 0 && now - (x.last || x.at) > 6000) || now - x.at > 30000;
      if (dv) {
        if (o && o.d === dv) o.at = now;
        else if (!o || stale(o) || url.searchParams.get('claim') === '1') {
          // nieuwe teller: vanaf welke pijl moet hij tellen? Vorige teller: vanaf zijn laatste getelde pijl; anders alleen nieuwe pijlen
          const from = o ? (o.ap || 0) : maxId;
          o = { d: dv, at: now, ap: Math.min(from, maxId), pend: 0, last: now, from: Math.min(from, maxId), boot: BOOT }; kopOwn.set(id, o);
        }
      }
      const ownOf = () => (kopOwn.get(id) || {}).d || '';
      if (ownOf() !== wasOwn) kopNotify(id);
      const view = () => { const v = camView(room, ownOf()), x = kopOwn.get(id); if (x) v.from = x.from || 0; return v; };
      const kb = url.searchParams.get('bv'), kbb = url.searchParams.get('bb');
      if (kb === null || Number(kb) !== cmr.seq || kbb !== BOOT || url.searchParams.get('claim') === '1' || (url.searchParams.has('ow') && url.searchParams.get('ow') !== ownOf())) return send(res, 200, view());
      const w = kopWait.get(id) || []; kopWait.set(id, w);
      if (w.length > 50) return send(res, 200, view());
      const mine = dv && o && o.d === dv; if (mine) o.pend = (o.pend || 0) + 1;
      let klaar = false;
      const done = () => { if (klaar) return; klaar = true; clearTimeout(y.t); kopWait.set(id, (kopWait.get(id) || []).filter(z => z !== y)); if (mine) { const x = kopOwn.get(id); if (x && x.d === dv) { x.pend = Math.max(0, (x.pend || 0) - 1); x.last = Date.now(); } } };
      const y = { res, t: setTimeout(() => { done(); if (mine) { const x = kopOwn.get(id); if (x && x.d === dv) x.at = Date.now(); } send(res, 200, view()); }, dv ? 15000 : 25000), own: ownOf, done, view };
      w.push(y);
      res.on('close', () => done());
      return;
    }

    if (req.method === 'POST' && p === '/api/bord') {
      if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
      const given = req.headers['x-pin'];
      if (!(roleOf(given) === 'admin' || (BPIN.length >= 4 && same(given, BPIN)))) { failed(ip); return send(res, 401, { error: 'Onjuiste code' }); }
      const b = await readBody(req);
      camPush(state, b.events, b.status);
      broadcast();
      return send(res, 200, { ok: true });
    }

    // Alle wedstrijden die nu bezig zijn: de hoofdstand + zichtbare sessies (laatste 20 minuten actief)
    if (req.method === 'GET' && p === '/api/live') {
      const now = Date.now(), out = [];
      const sumOf = (st, sid) => {
        const sm = st.live && st.live.sum;
        if (!sm || typeof sm !== 'object' || !(now - (st.lt || 0) < 20 * 60e3)) return null;
        const t = v => String(v == null ? '' : v).slice(0, 40);
        return { sid, t: t(sm.t), a: t(sm.a), b: t(sm.b), sc: t(sm.sc), lt: st.lt || 0 };
      };
      const m = sumOf(state, ''); if (m) out.push(m);
      for (const [id, x] of Object.entries(sess)) { if (x.S && x.S.zichtbaar === false) continue; const e = sumOf(x, id); if (e) out.push(e); }
      out.sort((a, b) => (a.sid === '' ? -1 : b.sid === '' ? 1 : b.lt - a.lt));
      return send(res, 200, { now, list: out.slice(0, 30) });
    }

    // ---------- spelersprofielen ----------
    if (req.method === 'GET' && p === '/api/spelers') return send(res, 200, splView());
    if (req.method === 'POST' && p === '/api/spelers/nieuw') {
      const b = await readBody(req);
      const n = clean(b.naam, 20), pin = String(b.pin || '');
      if (n.length < 2) return send(res, 400, { error: 'Vul een naam in van minstens 2 tekens' });
      if (!/^\d{4}$/.test(pin)) return send(res, 400, { error: 'Kies een pincode van 4 cijfers' });
      if (splByName(n)) return send(res, 409, { error: 'Er is al een profiel met deze naam. Is het van jou? Kies dan "Ik heb al een profiel".' });
      const now = Date.now(), l = (splNew.get(ip) || []).filter(t => now - t < 3600e3);
      if (l.length >= 10) return send(res, 429, { error: 'Te veel profielen gemaakt. Probeer het later opnieuw.' });
      l.push(now); splNew.set(ip, l); if (splNew.size > 2000) splNew.clear();
      let id; do { id = crypto.randomBytes(5).toString('hex'); } while (spl.list[id]);
      const salt = crypto.randomBytes(12).toString('hex');
      spl.list[id] = { n, salt, h: pinHash(pin, salt), pv: 0, at: now, alias: [] };
      topMoveToProfile(id);
      splChanged();
      return send(res, 200, { id, n, t: splToken(id) });
    }
    if (req.method === 'POST' && p === '/api/spelers/login') {
      if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
      const b = await readBody(req);
      const id = typeof b.id === 'string' && spl.list[b.id] ? b.id : splByName(b.naam);
      const x = id && spl.list[id];
      if (!x) return send(res, 404, { error: 'Dit profiel bestaat niet (meer)' });
      const f = splFail.get(id) || { n: 0, until: 0 };
      if (f.until > Date.now()) return send(res, 429, { error: 'Te vaak een verkeerde pincode. Probeer het over 15 minuten opnieuw.' });
      if (!/^\d{4}$/.test(String(b.pin || '')) || !same(pinHash(b.pin, x.salt), x.h)) {
        failed(ip); f.n++; if (f.n >= 5) { f.until = Date.now() + 15 * 60e3; f.n = 0; } splFail.set(id, f);
        return send(res, 401, { error: 'Onjuiste pincode' });
      }
      splFail.delete(id);
      return send(res, 200, { id, n: x.n, t: splToken(id) });
    }
    // Controleert de profielen die op een apparaat bewaard zijn (naam bijwerken, verwijderde eruit)
    if (req.method === 'POST' && p === '/api/spelers/check') {
      const b = await readBody(req);
      const out = (Array.isArray(b.list) ? b.list.slice(0, 20) : []).filter(x => x && splOk(x.id, x.t)).map(x => ({ id: x.id, n: spl.list[x.id].n, t: x.t }));
      return send(res, 200, { list: out });
    }
    if (req.method === 'POST' && p === '/api/spelers/beheer') {
      if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
      if (roleOf(req.headers['x-pin']) !== 'admin') { failed(ip); return send(res, 401, { error: 'Onjuiste code' }); }
      const b = await readBody(req);
      const x = typeof b.id === 'string' && spl.list[b.id];
      if (!x) return send(res, 404, { error: 'Profiel niet gevonden' });
      if (b.actie === 'hernoem') {
        const n = clean(b.naam, 20);
        if (n.length < 2) return send(res, 400, { error: 'Naam te kort' });
        const o = splByName(n); if (o && o !== b.id) return send(res, 409, { error: 'Die naam is al van een ander profiel' });
        if (splKey(n) !== splKey(x.n)) { x.alias = (x.alias || []).filter(a => splKey(a) !== splKey(n)); x.alias.push(x.n); x.alias = x.alias.slice(-10); }
        x.n = n; topChanged();
      } else if (b.actie === 'pin') {
        if (!/^\d{4}$/.test(String(b.pin || ''))) return send(res, 400, { error: 'Pincode moet 4 cijfers zijn' });
        x.salt = crypto.randomBytes(12).toString('hex'); x.h = pinHash(b.pin, x.salt); x.pv = (x.pv || 0) + 1; splFail.delete(b.id);
      } else if (b.actie === 'samen') {
        const y = typeof b.naar === 'string' && b.naar !== b.id && spl.list[b.naar];
        if (!y) return send(res, 400, { error: 'Kies het profiel om mee samen te voegen' });
        y.alias = Array.from(new Set((y.alias || []).concat([x.n], x.alias || []))).slice(-10);
        const a = top.list['p:' + b.id], c = top.list['p:' + b.naar];
        if (a && (!c || a.s > c.s)) top.list['p:' + b.naar] = Object.assign({}, a, { n: y.n });
        delete top.list['p:' + b.id]; delete spl.list[b.id]; topChanged();
        const sa = sst.list[b.id];
        if (sa) { const sb = sst.list[b.naar] || { g: 0, full: 0, sumFull: 0, best: 0, nums: {}, fin: {}, last: [] };
          sb.g += sa.g; sb.full += sa.full; sb.sumFull += sa.sumFull; sb.best = Math.max(sb.best, sa.best);
          for (const [k, n] of Object.entries(sa.nums)) { const m = sb.nums[k] = sb.nums[k] || [0, 0, 0]; m[0] += n[0]; m[1] += n[1]; m[2] += n[2]; }
          for (const [k, n] of Object.entries(sa.fin)) sb.fin[k] = (sb.fin[k] || 0) + n;
          if (sa.dd) { sb.dd = sb.dd || {}; ddAdd(sb.dd, sa.dd); }
          sb.last = sb.last.concat(sa.last).sort((a, c) => a.at - c.at).slice(-10);
          sst.list[b.naar] = sb; delete sst.list[b.id]; sst.v++; persistSst(); }
      } else if (b.actie === 'weg') {
        const a = top.list['p:' + b.id];
        if (a) { top.list[splKey(x.n)] = { n: x.n, s: a.s, d: a.d }; delete top.list['p:' + b.id]; topChanged(); }
        delete spl.list[b.id]; if (sst.list[b.id]) { delete sst.list[b.id]; sst.v++; persistSst(); }
      } else return send(res, 400, { error: 'Onbekende actie' });
      splChanged();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/toernooien') {
      const L = Object.entries(trn.list).map(([k, x]) => Object.assign({ k }, x, { players: x.players.map(y => Object.assign({}, y, { n: y.pid && spl.list[y.pid] ? spl.list[y.pid].n : y.n })) })).sort((a, b) => b.at - a.at);
      return send(res, 200, { v: trn.v, list: L });
    }
    // Dubbels per speler uit alle onderdelen (competitie, enkele wedstrijden, toernooien, checkout-spel)
    if (req.method === 'GET' && p === '/api/dubbels') {
      const out = {}, key = n => { const id = splByName(n); return id ? 'p:' + id : 'n:' + String(n || '').trim().toLowerCase(); };
      const put = (n, dd) => { if (!n || !dd) return; const k = key(n), e = out[k] = out[k] || { n: n, dd: {} }; if (k.startsWith('p:')) e.n = spl.list[k.slice(2)].n; ddAdd(e.dd, dd); };
      const S0 = state.S || {}, P = (S0.comp && S0.comp.players) || [], game = +S0.game || 501;
      if (S0.dout !== 0) for (const [k, t] of Object.entries(S0.turns || {})) {
        if (k[0] !== 'C' || !t || !Array.isArray(t.list)) continue;
        const side = [t.a, t.b], legs = {};
        for (const x of t.list) if (x && Number.isInteger(x.leg)) (legs[x.leg] = legs[x.leg] || []).push(x);
        for (const L of Object.values(legs)) { const rem = [game, game], dd = [{}, {}];
          for (const x of L) { const sd = x.side === 1 ? 1 : 0;
            if (Array.isArray(x.d) && x.d.length) ddDarts(dd[sd], rem[sd], x.d.map(q => [+q.v || 0, !!q.dbl]));
            if (!x.bust) rem[sd] -= +x.score || 0; }
          [0, 1].forEach(i => { if (Number.isInteger(side[i]) && P[side[i]]) put(P[side[i]], dd[i]); }); }
      }
      for (const x of Object.values(wed.list)) for (const p of x.players || []) if (p.s && p.s.dd) put(p.pid && spl.list[p.pid] ? spl.list[p.pid].n : p.n, p.s.dd);
      for (const x of Object.values(trn.list)) for (const p of x.players || []) if (p.s && p.s.dd) put(p.pid && spl.list[p.pid] ? spl.list[p.pid].n : p.n, p.s.dd);
      for (const [id, x] of Object.entries(sst.list)) if (x.dd && spl.list[id]) put(spl.list[id].n, x.dd);
      return send(res, 200, { list: out });
    }
    if (req.method === 'GET' && p === '/api/wedstrijden') {
      const L = Object.entries(wed.list).map(([k, x]) => ({ k, at: x.at, soort: x.soort || '1v1', legs: x.legs || null, game: x.game, win: x.win, players: x.players.map(y => Object.assign({}, y, { n: y.pid && spl.list[y.pid] ? spl.list[y.pid].n : y.n })) })).sort((a, b) => a.at - b.at);
      return send(res, 200, { v: wed.v, list: L });
    }
    if (req.method === 'POST' && p === '/api/wedstrijden/beheer') {
      if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
      if (roleOf(req.headers['x-pin']) !== 'admin') { failed(ip); return send(res, 401, { error: 'Onjuiste code' }); }
      const b = await readBody(req);
      if (typeof b.del === 'string' && wed.list[b.del]) { delete wed.list[b.del]; wed.v++; persistWed(); }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/toernooien/beheer') {
      if (blocked(ip)) return send(res, 429, { error: 'Te vaak geprobeerd. Wacht 5 minuten.' });
      if (roleOf(req.headers['x-pin']) !== 'admin') { failed(ip); return send(res, 401, { error: 'Onjuiste code' }); }
      const b = await readBody(req);
      if (typeof b.del === 'string' && trn.list[b.del]) { delete trn.list[b.del]; trn.v++; persistTrn(); }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/spel/stats') return send(res, 200, sstView());
    if (req.method === 'GET' && p === '/api/spel/top') return send(res, 200, topView());
    if (req.method === 'POST' && p === '/api/spel/score') {
      const b = await readBody(req);
      const n = clean(b.name, 24), sc = Number(b.score);
      if (!n || !Number.isInteger(sc) || sc < 0 || sc > 20) return send(res, 400, { error: 'Ongeldige score' });
      const now = Date.now(), l = (topHits.get(ip) || []).filter(t => now - t < 3600e3);
      if (l.length >= 60) return send(res, 429, { error: 'Te veel scores. Probeer het later opnieuw.' });
      l.push(now); topHits.set(ip, l); if (topHits.size > 2000) topHits.clear();
      let k = n.toLowerCase(), nn = n;
      if (b.pid) {
        if (!splOk(b.pid, b.t)) return send(res, 403, { error: 'Log opnieuw in met je pincode' });
        k = 'p:' + b.pid; nn = spl.list[b.pid].n;
      } else if (splByName(n)) return send(res, 403, { error: 'Deze naam hoort bij een profiel. Log in met de pincode of kies een andere naam.', profiel: true });
      const o = top.list[k], rec = !o || sc > o.s;
      if (rec) { top.list[k] = { n: nn, s: sc, d: now }; topChanged(); }
      if (b.pid) sstAdd(b.pid, sc, b.det);
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
        at: new Date().toISOString(),
        lt: Date.now(),
        cam: state.cam
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
