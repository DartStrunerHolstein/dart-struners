// De Dart Struners – doorgeefprogramma voor Autodarts
// Leest de pijlen die Autodarts op deze computer (of in het netwerk) herkent
// en stuurt ze door naar de website. Geen extra pakketten nodig (Node.js 18+).
//
// Starten:   node bord.js            (zoekt Autodarts en toont een koppelcode)
//            node bord.js --opnieuw  (nieuwe koppelcode en Autodarts opnieuw zoeken)
//            node bord.js --test     (zonder camera's: typ zelf pijlen, bijv. T20)
//            node bord.js --site=https://…  (andere website, standaard dartstruners.alwaysdata.net)

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const CONFIG = path.join(__dirname, 'bord-instellingen.json');
const args = process.argv.slice(2);
const TEST = args.includes('--test');
const SITE = ((args.find(a => a.startsWith('--site=')) || '').slice(7) || 'https://dartstruners.alwaysdata.net').replace(/\/+$/, '');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lijnen = [], wachters = [];
rl.on('line', l => { const w = wachters.shift(); if (w) w(String(l || '').trim()); else lijnen.push(String(l || '').trim()); });
const ask = q => { process.stdout.write(q); return lijnen.length ? Promise.resolve(lijnen.shift()) : new Promise(r => wachters.push(r)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tijd = () => new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const log = (...a) => console.log(`[${tijd()}]`, ...a);

async function get(url, ms = 1500) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
}

// ---------- website ----------
async function nieuweCode() {
  const r = await fetch(SITE + '/api/koppel/nieuw', { method: 'POST', signal: AbortSignal.timeout(10000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error(d.error || 'website antwoordt ' + r.status);
  return d;
}
async function stuur(cfg, events, status) {
  const r = await fetch(SITE + '/api/koppel/' + cfg.id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Secret': cfg.secret },
    body: JSON.stringify({ events, status }),
    signal: AbortSignal.timeout(8000)
  });
  if (r.status === 401 || r.status === 404) { const e = new Error('koppeling'); e.code = 404; throw e; }
  if (!r.ok) throw new Error('website antwoordt ' + r.status);
  return r.json().catch(() => ({}));
}
function toonCode(code) {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║        KOPPELCODE:   ' + code.split('').join(' ') + '         ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('  Tik op je telefoon (of tablet/computer) in de wedstrijd op "Camera"');
  console.log('  en typ deze code. Dat hoeft maar één keer: hij wordt onthouden.\n');
}

// ---------- Autodarts zoeken ----------
async function isAutodarts(base) {
  try { const r = await get(base + '/api/state', 1200); const d = await r.json(); return d && typeof d === 'object' && ('numThrows' in d || 'status' in d || 'connected' in d); }
  catch (e) { return false; }
}
async function zoekInNetwerk() {
  const nets = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) {
    if (n.family === 'IPv4' && !n.internal && /^(10|172|192)\./.test(n.address)) nets.push(n.address.split('.').slice(0, 3).join('.'));
  }
  const uniek = [...new Set(nets)], gevonden = [];
  if (!uniek.length) return gevonden;
  console.log('Zoeken in ' + uniek.map(n => n + '.x').join(', ') + ' … (duurt hooguit een halve minuut)');
  for (const net of uniek) {
    const ips = Array.from({ length: 254 }, (_, i) => `${net}.${i + 1}`);
    for (let i = 0; i < ips.length; i += 64) {
      await Promise.all(ips.slice(i, i + 64).map(async ip => { if (await isAutodarts(`http://${ip}:3180`)) gevonden.push(`http://${ip}:3180`); }));
    }
  }
  return gevonden;
}

// ---------- Autodarts automatisch vinden ----------
async function vindBord(oud) {
  if (oud && await isAutodarts(oud)) return oud;
  for (const b of ['http://127.0.0.1:3180', 'http://localhost:3180']) if (await isAutodarts(b)) return b;
  const g = await zoekInNetwerk();
  if (g.length === 1) return g[0];
  if (g.length > 1) {
    console.log('Meerdere borden gevonden:');
    g.forEach((b, i) => console.log(`  ${i + 1}) ${b}`));
    const c = await ask('Welk bord? Typ het nummer: ');
    return g[Number(c) - 1] || g[0];
  }
  return null;
}

// ---------- pijlen omzetten ----------
// Autodarts geeft pijlen in verschillende vormen door, afhankelijk van de versie, bijv.
//   { segment: { name: 'T20', number: 20, multiplier: 3, bed: 'Triple' } }
//   { segmentName: 'T20', number: 20, multiplier: 3 }   of   { name: 'D16', score: 32 }
// We lezen alles wat er is en vallen terug op de naam van het vak.
const getal = v => { const x = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(x) ? null : x; };
function uitNaam(name) {
  const a = String(name || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!a) return null;
  if (/^(BULL|BULLSEYE|DB|D25|DBULL|INNERBULL|50)$/.test(a)) return { n: 25, m: 2 };
  if (/^(25|SB|OB|S25|SBULL|OUTERBULL|SINGLEBULL)$/.test(a)) return { n: 25, m: 1 };
  if (/^(M\d*|MISS|MIS|OUT|OUTSIDE|BOUNCE|BOUNCER|0)$/.test(a)) return { n: 0, m: 0 };
  let x = /^(SO|SI|S|D|T|TRIPLE|DOUBLE|SINGLE)?-?(\d{1,2})$/.exec(a);
  if (x && +x[2] >= 1 && +x[2] <= 20) { const p = x[1] || 'S'; return { n: +x[2], m: p[0] === 'T' ? 3 : p[0] === 'D' ? 2 : 1 }; }
  return null;
}
function uitBed(bed) {
  const b = String(bed || '').toLowerCase();
  if (!b) return null;
  if (b.includes('outside') || b.includes('miss')) return 0;
  if (b.includes('triple') || b.includes('treble')) return 3;
  if (b.includes('double')) return 2;
  if (b.includes('single')) return 1;
  return null;
}
function omzet(t) {
  t = t && typeof t === 'object' ? t : {};
  const sg = t.segment && typeof t.segment === 'object' ? t.segment : {};
  const naam = sg.name ?? sg.segmentName ?? t.segmentName ?? t.segment_name ?? (typeof t.segment === 'string' ? t.segment : undefined) ?? t.name ?? t.field ?? '';
  let n = getal(sg.number ?? t.number ?? t.segmentNumber ?? t.sector);
  let m = getal(sg.multiplier ?? t.multiplier ?? t.mult);
  if (m === null) m = uitBed(sg.bed ?? t.bed);
  const score = getal(t.score ?? sg.score ?? t.points ?? t.value);
  const vn = uitNaam(naam);
  if (vn && (n === null || m === null)) { if (n === null) n = vn.n; if (m === null) m = vn.m; }
  if (n !== null && m === null) m = n === 0 ? 0 : 1;
  if (n === null && score !== null && m) n = score / m;
  if (n === null && vn) { n = vn.n; m = vn.m; }
  if (n === null) { n = 0; m = 0; }
  if (n === 50) { n = 25; m = 2; }
  if (n === 25 && m >= 2) m = 2;
  if (t.bouncer === true || t.bounceOut === true) { n = 0; m = 0; }
  if (m === 0 || !(n === 25 || (n >= 1 && n <= 20))) { n = 0; m = 0; }
  const out = { n, m, name: n === 0 ? 'Mis' : n === 25 ? (m === 2 ? 'Bull' : '25') : (m === 3 ? 'T' : m === 2 ? 'D' : '') + n };
  // plek op het bord (voor het dartbord op de monitor): bull = (0,0), y omhoog = richting de 20
  const c = t.coords && typeof t.coords === 'object' ? t.coords : null, cx = c ? getal(c.x) : null, cy = c ? getal(c.y) : null;
  if (cx !== null && cy !== null && !(t.bouncer === true)) { out.x = cx; out.y = cy; }
  return out;
}
// Ruwe gegevens van de eerste pijlen bewaren, zodat we kunnen zien wat Autodarts precies stuurt
const LOGF = path.join(__dirname, 'bord-log.txt');
let gelogd = 0;
function bewaarRuw(t, p) {
  if (gelogd >= 60) return;
  gelogd++;
  try { fs.appendFileSync(LOGF, `[${new Date().toISOString()}] ${p.name}  <=  ${JSON.stringify(t)}\n`); } catch (e) {}
  if (gelogd <= 3 || p.name === 'Mis') console.log('   (Autodarts gaf: ' + JSON.stringify(t).slice(0, 220) + ')');
}

// ---------- hoofdlus ----------
let queue = [], bezig = false, laatsteStatus = null, fouten = 0, telefoon = null;
async function verstuur(cfg, force) {
  if (bezig || (!queue.length && !force)) return;
  bezig = true;
  const batch = queue.slice(0, 20);
  try {
    const d = await stuur(cfg, batch, laatsteStatus);
    queue = queue.slice(batch.length);
    if (d && typeof d.telefoon === 'boolean' && d.telefoon !== telefoon) { const was = telefoon; telefoon = d.telefoon; if (telefoon) log('Telefoon gekoppeld ✓ De pijlen tellen mee.'); else if (was) log('Geen telefoon meer gekoppeld. Koppelcode: ' + cfg.code); }
    if (fouten) log('Weer verbonden met de website ✓');
    fouten = 0;
  } catch (e) {
    if (e.code === 404) { log('De koppeling is verlopen. Start opnieuw met: START-BORD.bat --opnieuw'); process.exit(1); }
    if (fouten++ % 10 === 0) log('Website niet bereikbaar (' + e.message + '). Ik probeer het steeds opnieuw…');
  }
  bezig = false;
  if (queue.length) setTimeout(() => verstuur(cfg), fouten ? 2000 : 0);
}
function pijl(cfg, ev) { queue.push(ev); verstuur(cfg); }

async function luisterNaarBord(cfg) {
  let vorige = null, weg = 0;
  log('Luisteren naar Autodarts op ' + cfg.board + ' …');
  for (;;) {
    try {
      const d = await (await get(cfg.board + '/api/state', 2000)).json();
      if (weg) { log('Autodarts weer bereikbaar ✓'); weg = 0; }
      const throws = Array.isArray(d.throws) ? d.throws : Array.isArray(d.darts) ? d.darts : Array.isArray(d.data && d.data.throws) ? d.data.throws : [];
      const num = Math.max(Number.isFinite(d.numThrows) ? d.numThrows : 0, throws.length);
      const nu = { num, names: throws.map(t => omzet(t).name), status: d.status, event: d.event };
      laatsteStatus = { connected: d.connected !== false, running: d.running !== false, status: String(d.status || '') };
      if (vorige === null) {
        log(`Verbonden met Autodarts ✓ (status: ${d.status || 'onbekend'}). Gooi maar!`);
      } else {
        // verbeterde pijl (in Autodarts aangepast)
        for (let i = 0; i < Math.min(vorige.num, num); i++) {
          if (throws[i] && vorige.names[i] !== nu.names[i]) { const p = omzet(throws[i]); log(`Pijl ${i + 1} verbeterd: ${vorige.names[i]} → ${p.name}`); pijl(cfg, { k: 'fix', i, ...p }); }
        }
        // nieuwe pijlen
        for (let i = vorige.num; i < num; i++) {
          if (!throws[i]) continue;
          const p = omzet(throws[i]);
          log(`Pijl ${i + 1}: ${p.name}`);
          bewaarRuw(throws[i], p);
          pijl(cfg, { k: 'dart', i, ...p });
        }
        // pijlen uit het bord gehaald
        if (num === 0 && vorige.num > 0) { log('Pijlen eruit, volgende beurt'); pijl(cfg, { k: 'takeout' }); }
        if (vorige.status !== nu.status && nu.status && !/^Throw$|^Takeout/.test(nu.status)) log('Autodarts: ' + nu.status);
      }
      vorige = nu;
    } catch (e) {
      laatsteStatus = { connected: false, running: false, status: 'Niet bereikbaar' };
      if (weg++ % 25 === 0) log('Autodarts antwoordt niet op ' + cfg.board + '. Staat het programma aan?');
      await sleep(1000);
    }
    await sleep(150);
  }
}

// Testmodus: zelf pijlen typen
async function testModus(cfg) {
  laatsteStatus = { connected: true, running: true, status: 'Test' };
  console.log('\nTESTMODUS: typ een pijl en druk op Enter.');
  console.log('  Voorbeelden: 20  T20  D16  25  BULL  M (mis)   W = pijlen eruit   Q = stoppen\n');
  let i = 0;
  for (;;) {
    const a = (await ask('pijl> ')).toUpperCase();
    if (a === 'Q') process.exit(0);
    if (a === 'W') { pijl(cfg, { k: 'takeout' }); i = 0; continue; }
    let n, m;
    if (a === 'M' || a === '0') { n = 0; m = 0; }
    else if (a === 'BULL' || a === 'DB' || a === '50') { n = 25; m = 2; }
    else { const x = /^([SDT]?)(\d{1,2})$/.exec(a); if (!x) { console.log('Niet begrepen.'); continue; } n = +x[2]; m = x[1] === 'T' ? 3 : x[1] === 'D' ? 2 : 1; if (!((n >= 1 && n <= 20) || (n === 25 && m < 3))) { console.log('Bestaat niet.'); continue; } }
    const name = n === 0 ? 'Mis' : n === 25 ? (m === 2 ? 'Bull' : '25') : (m === 3 ? 'T' : m === 2 ? 'D' : '') + n;
    pijl(cfg, { k: 'dart', i: i, n, m, name });
    i = (i + 1) % 3;
  }
}

(async () => {
  console.log('\n  ===============================');
  console.log('    DE DART STRUNERS – BORD');
  console.log('  ===============================\n');
  if (typeof fetch !== 'function') { console.log('Deze Node.js is te oud. Gebruik START-BORD.bat, die regelt de juiste versie.'); process.exit(1); }
  let cfg = {};
  try { if (!args.includes('--opnieuw')) cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')) || {}; } catch (e) {}
  if (cfg.site && cfg.site !== SITE) cfg = { board: cfg.board };
  // koppelcode
  while (!cfg.id) {
    try { const d = await nieuweCode(); cfg = { ...cfg, id: d.id, secret: d.secret, code: d.code, site: SITE }; }
    catch (e) { console.log('Kan ' + SITE + ' niet bereiken (' + e.message + '). Heeft deze laptop internet? Ik probeer het over 5 seconden opnieuw…'); await sleep(5000); }
  }
  // Autodarts
  if (!TEST) {
    console.log('Autodarts zoeken…');
    let b = await vindBord(cfg.board);
    while (!b) { console.log('Autodarts niet gevonden. Start het Autodarts-programma; ik zoek over 10 seconden opnieuw…'); await sleep(10000); b = await vindBord(cfg.board); }
    cfg.board = b;
    console.log('Autodarts gevonden op ' + b + ' ✓');
  }
  try { fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2)); } catch (e) {}
  toonCode(cfg.code);
  console.log('Laat dit venster open zolang je speelt.\n');
  setInterval(() => verstuur(cfg, true), 10000); // teken van leven voor de status op de telefoon
  setInterval(() => { if (!telefoon) toonCode(cfg.code); }, 120000);
  verstuur(cfg, true);
  if (TEST) return testModus(cfg);
  rl.close();
  luisterNaarBord(cfg);
})();
