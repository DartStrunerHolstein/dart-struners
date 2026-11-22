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
// Vaste kopie in de gebruikersmap: pak je de zip in een andere map uit, dan blijft de koppelcode toch hetzelfde
const CONFIG_VAST = path.join(require('os').homedir(), '.dart-struners-bord.json');
const args = process.argv.slice(2);
const TEST = args.includes('--test');
const START = Date.now();
const SITE = ((args.find(a => a.startsWith('--site=')) || '').slice(7) || 'https://dartstruners.alwaysdata.net').replace(/\/+$/, '');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lijnen = [], wachters = [];
rl.on('line', l => { const w = wachters.shift(); if (w) w(String(l || '').trim()); else lijnen.push(String(l || '').trim()); });
const ask = q => { process.stdout.write(q); return lijnen.length ? Promise.resolve(lijnen.shift()) : new Promise(r => wachters.push(r)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tijd = () => new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
// Alles wat in het venster komt, gaat ook naar bord-verbinding.txt (handig om achteraf te zien waarom iets wegviel)
const VLOG = path.join(__dirname, 'bord-verbinding.txt');
const log = (...a) => {
  console.log(`[${tijd()}]`, ...a);
  try {
    if (fs.existsSync(VLOG) && fs.statSync(VLOG).size > 2e6) fs.renameSync(VLOG, VLOG.replace('.txt', '-oud.txt'));
    fs.appendFileSync(VLOG, `[${new Date().toLocaleString('nl-NL')}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`);
  } catch (e) {}
};

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
    body: JSON.stringify({ events, status, t0: START }),
    signal: AbortSignal.timeout(8000)
  });
  if (r.status === 401 || r.status === 404) {
    // Alleen als de website zelf zegt dat dit bord onbekend is; een 404 van een tussenstation (bijv. tijdens het bijwerken) telt niet
    const t = await r.text().catch(() => '');
    const e = new Error('website antwoordt ' + r.status + (/Onbekend bord|Onjuist geheim/.test(t) ? ' (koppeling onbekend)' : '')); if (/Onbekend bord|Onjuist geheim/.test(t)) e.code = 404; throw e;
  }
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
  // Autodarts v2 geeft coordsX/coordsY (1 = buitenrand dubbel); oudere versies coords: {x, y}
  const c = t.coords && typeof t.coords === 'object' ? t.coords : null;
  const cx = getal(t.coordsX) !== null ? getal(t.coordsX) : c ? getal(c.x) : null, cy = getal(t.coordsY) !== null ? getal(t.coordsY) : c ? getal(c.y) : null;
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
let onbekendSinds = 0, onbekendGemeld = false, queue = [], bezig = false, laatsteStatus = null, fouten = 0, telefoon = null, fotoGewild = false;
async function verstuur(cfg, force) {
  if (bezig || (!queue.length && !force)) return;
  bezig = true;
  const batch = queue.slice(0, 20);
  try {
    const d = await stuur(cfg, batch, laatsteStatus);
    queue = queue.slice(batch.length);
    if (d && typeof d.foto === 'boolean') fotoGewild = d.foto;
    if (d && d.oud) { log('Er draait een nieuwer doorgeefprogramma met dezelfde koppelcode. Dit venster stopt nu.'); process.exit(0); }
    if (d && typeof d.telefoon === 'boolean' && d.telefoon !== telefoon) { const was = telefoon; telefoon = d.telefoon; if (telefoon) log('Telefoon gekoppeld ✓ De pijlen tellen mee.'); else if (was) log('Geen telefoon meer gekoppeld. Koppelcode: ' + cfg.code); }
    if (fouten) log('Weer verbonden met de website ✓ (na ' + fouten + ' mislukte pogingen)');
    fouten = 0; onbekendSinds = 0;
  } catch (e) {
    // Nooit zomaar stoppen: blijven proberen. Alleen als de website een kwartier lang zegt dat de koppeling onbekend is, een duidelijke melding.
    if (e.code === 404) { if (!onbekendSinds) onbekendSinds = Date.now(); if (Date.now() - onbekendSinds > 15 * 60e3 && !onbekendGemeld) { onbekendGemeld = true; log('De website kent deze koppeling niet meer. Sluit dit venster en start opnieuw met: START-BORD.bat --opnieuw'); } }
    else onbekendSinds = 0;
    if (fouten++ % 10 === 0) log('Website niet bereikbaar (' + e.message + '). Ik probeer het steeds opnieuw…');
  }
  bezig = false;
  if (queue.length) setTimeout(() => verstuur(cfg), fouten ? 2000 : 0);
}
// Elke pijl krijgt een eigen nummer, zodat de website hem niet dubbel telt als hij opnieuw verstuurd wordt
const RUN = Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, 'x').padEnd(6, 'x'); let evNr = 0;
function pijl(cfg, ev) { ev.u = RUN + '-' + (++evNr); queue.push(ev); verstuur(cfg); }

// ---------- camerafoto's: na een pijl de beelden van de camera's naar de monitor-weergave ----------
// Alleen als de monitor-weergave erom vraagt (fotoGewild), en bij snel achter elkaar gegooide pijlen alleen de laatste.
let fotoAantal = null, fotoGemeld = false, fotoReeks = 0, fotoBezig = false, fotoNog = null, fotoT = null;
async function telCameras(cfg) {
  // Autodarts geeft ook voor niet-bestaande camera's een (leeg) plaatje; vraag daarom eerst hoeveel camera's er zijn
  try { const d = await (await get(cfg.board + '/api/system', 2500)).json(), c = d && d.calibration && d.calibration.cams; if (Array.isArray(c) && c.length) return Math.min(6, c.length); } catch (e) {}
  let n = 0;
  for (let i = 0; i < 3; i++) { try { const r = await fetch(cfg.board + '/api/img/cams/' + i, { signal: AbortSignal.timeout(3000) }); await r.arrayBuffer(); if (!r.ok) break; n++; } catch (e) { break; } }
  return n;
}
function fotoNaPijl(cfg, naam) {
  if (!fotoGewild || TEST) return;
  fotoNog = naam; clearTimeout(fotoT);
  fotoT = setTimeout(() => stuurFotos(cfg), 250); // even wachten tot de pijl stil zit
}
async function stuurFotos(cfg) {
  if (fotoBezig || fotoNog === null) return;
  fotoBezig = true; const naam = fotoNog; fotoNog = null;
  try {
    if (fotoAantal === null) { const n = await telCameras(cfg); if (n) { fotoAantal = n; log('Camerabeelden gaan naar de monitor-weergave (' + n + ' camera\'s) ✓'); } else if (!fotoGemeld) { fotoGemeld = true; log('Geen camerabeelden gevonden bij Autodarts.'); } }
    if (fotoAantal) {
      const b = ++fotoReeks;
      // eerst alle beelden van hetzelfde moment ophalen, dan pas versturen
      const beelden = await Promise.all(Array.from({ length: fotoAantal }, async (_, i) => { const r = await fetch(cfg.board + '/api/img/cams/' + i, { signal: AbortSignal.timeout(3000), cache: 'no-store' }); if (!r.ok) throw new Error('camera ' + i); return Buffer.from(await r.arrayBuffer()); }));
      for (let i = 0; i < beelden.length; i++) {
        // pijlen gaan altijd voor: eerst wachten tot alle pijlberichten verstuurd zijn
        for (let w = 0; w < 30 && (bezig || queue.length); w++) await sleep(100);
        if (fotoNog !== null) break; // er is al een nieuwere pijl: deze beelden niet meer afmaken
        const r = await fetch(SITE + '/api/koppel/' + cfg.id + '/foto?b=' + b + '&c=' + i + '&n=' + beelden.length + '&t0=' + START + '&p=' + encodeURIComponent(naam), { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Secret': cfg.secret }, body: beelden[i], signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('website ' + r.status);
      }
    }
  } catch (e) { fotoAantal = null; }
  fotoBezig = false;
  if (fotoNog !== null) stuurFotos(cfg);
}

// Opdrachten van de telefoon: Autodarts resetten als de beurt in de app al klaar is
// (bijv. een gemiste pijl met de hand als Mis ingevuld), anders wacht Autodarts nog op die pijl.
let negeerTakeoutTot = 0;
async function resetBord(cfg) {
  for (const m of ['POST', 'PUT']) {
    try {
      const r = await fetch(cfg.board + '/api/reset', { method: m, signal: AbortSignal.timeout(3000) });
      if (r.ok) { negeerTakeoutTot = Date.now() + 5000; log('Autodarts gereset: de beurt is in de app afgerond ✓'); return; }
    } catch (e) {}
  }
  log('Autodarts resetten lukte niet. Druk zo nodig in Autodarts zelf op Reset.');
}
// ---------- Autodarts in de gaten houden (alleen meldingen, geen automatische acties) ----------
// gz = gezondheid: 'ok' | 'hangt' (blijft op oranje/takeout) | 'kalib' (Autodarts meldt zelf: niet gekalibreerd) | 'weg'
const gezond = { gz: 'ok', gm: '', kb: '', kbAt: 0, hangtSinds: 0 };
function zetGezond(gz, gm) { if (gezond.gz !== gz || gezond.gm !== gm) { gezond.gz = gz; gezond.gm = gm; if (gz !== 'ok') log('⚠ ' + gm); else log('Autodarts weer in orde ✓'); verstuurLater(); } }
let verstuurT = null;
function verstuurLater() { clearTimeout(verstuurT); verstuurT = setTimeout(() => { if (CFG) verstuur(CFG, true); }, 300); }
let CFG = null;
// Alleen kijken, nooit zelf ingrijpen: kalibreren doe je in Autodarts zelf; resetten alleen als iemand in de app op Reset drukt.
// Autodarts zegt zelf of de camera's gekalibreerd zijn (/api/system → calibration)
let sysAt = 0, kalStatus = 'ok';
async function checkSysteem(cfg) {
  if (Date.now() - sysAt < 30000) return; sysAt = Date.now();
  try {
    const d = await (await get(cfg.board + '/api/system', 2500)).json(), c = d && d.calibration;
    if (!c || typeof c !== 'object') return;
    const cams = Array.isArray(c.cams) ? c.cams : [], bezig = cams.some(x => x && x.calibrating);
    const fout = cams.map((x, i) => x && (x.calibrated === false || x.fitFailed) ? i + 1 : 0).filter(Boolean);
    const nu = bezig ? 'bezig' : (c.calibrated === false || fout.length) ? 'nee' : 'ok';
    if (nu === kalStatus) return; kalStatus = nu;
    if (nu === 'bezig') { gezond.kb = 'gestart'; verstuurLater(); }
    else if (nu === 'nee') zetGezond('kalib', fout.length ? 'Camera ' + fout.join(' en ') + ' meldt in Autodarts: niet gekalibreerd. Kalibreer in Autodarts zelf.' : 'Autodarts meldt: niet gekalibreerd. Kalibreer in Autodarts zelf.');
    else { if (gezond.kb === 'gestart' || gezond.kb === 'bezig') gezond.kb = 'klaar'; if (gezond.gz === 'kalib') zetGezond('ok', ''); else verstuurLater(); }
  } catch (e) {}
}
// Blijft Autodarts lang op takeout (oranje) staan terwijl er niets gebeurt? Dan alleen een melding.
function checkStatus(num, status) {
  const st = String(status || ''), take = /takeout/i.test(st), bezig = /progress|started/i.test(st);
  if (!(take && (bezig || num < 3))) { gezond.hangtSinds = 0; if (gezond.gz === 'hangt') zetGezond('ok', ''); return; }
  if (!gezond.hangtSinds) gezond.hangtSinds = Date.now();
  if (Date.now() - gezond.hangtSinds > 45000 && gezond.gz !== 'hangt') zetGezond('hangt', 'Autodarts staat al even op oranje en telt niet. Druk zo nodig op Reset.');
}

async function luisterNaarOpdrachten(cfg) {
  let n = null;
  for (;;) {
    try {
      const r = await fetch(SITE + '/api/koppel/' + cfg.id + '/opdracht?n=' + (n === null ? -1 : n), { headers: { 'X-Secret': cfg.secret }, signal: AbortSignal.timeout(35000), cache: 'no-store' });
      if (r.status === 404 || r.status === 401) { await sleep(10000); continue; }
      const d = await r.json();
      if (d && Number.isFinite(d.n)) {
        if (n !== null && d.n !== n && d.cmd === 'reset') { if (TEST) log('(test) Opdracht ontvangen: Autodarts resetten'); else await resetBord(cfg); }
        n = d.n;
      }
    } catch (e) { await sleep(3000); }
  }
}

async function luisterNaarBord(cfg) {
  let vorige = null, weg = 0;
  log('Luisteren naar Autodarts op ' + cfg.board + ' …');
  for (;;) {
    try {
      const d = await (await get(cfg.board + '/api/state', 2000)).json();
      if (weg) { if (weg > 3) log('Autodarts weer bereikbaar ✓'); weg = 0; }
      const throws = Array.isArray(d.throws) ? d.throws : Array.isArray(d.darts) ? d.darts : Array.isArray(d.data && d.data.throws) ? d.data.throws : [];
      const num = Math.max(Number.isFinite(d.numThrows) ? d.numThrows : 0, throws.length);
      const nu = { num, names: throws.map(t => omzet(t).name), status: d.status, event: d.event };
      laatsteStatus = { connected: d.connected !== false, running: d.running !== false, status: String(d.status || ''), gz: gezond.gz, gm: gezond.gm, kb: gezond.kb, t0: START };
      checkStatus(num, d.status);
      checkSysteem(cfg);
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
          fotoNaPijl(cfg, p.name);
        }
        // pijlen uit het bord gehaald
        if (num === 0 && vorige.num > 0) {
          if (Date.now() < negeerTakeoutTot) negeerTakeoutTot = 0; // dit kwam door onze eigen reset
          else { log('Pijlen eruit, volgende beurt'); pijl(cfg, { k: 'takeout' }); }
        }
        if (vorige.status !== nu.status && nu.status && !/^Throw$|^Takeout/.test(nu.status)) log('Autodarts: ' + nu.status);
      }
      vorige = nu;
    } catch (e) {
      // pas na een paar mislukte pogingen achter elkaar melden: één trage keer is geen storing
      if (weg >= 3) laatsteStatus = { connected: false, running: false, status: 'Niet bereikbaar', gz: 'weg', gm: 'Autodarts is niet bereikbaar op deze laptop. Staat Autodarts aan?', t0: START };
      if (weg++ % 25 === 3) log('Autodarts antwoordt niet op ' + cfg.board + '. Staat het programma aan?');
      await sleep(1000);
    }
    await sleep(150);
  }
}

// Testmodus: zelf pijlen typen
async function testModus(cfg) {
  laatsteStatus = { connected: true, running: true, status: 'Test', t0: START };
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

// Maar één doorgeefprogramma tegelijk op deze computer (anders telt elke pijl dubbel)
function slot() {
  return new Promise(res => {
    const srv = require('net').createServer();
    srv.once('error', () => res(false));
    srv.listen(31801, '127.0.0.1', () => res(true));
    srv.unref();
  });
}
(async () => {
  console.log('\n  ===============================');
  console.log('    DE DART STRUNERS – BORD');
  console.log('  ===============================\n');
  if (!(await slot())) {
    console.log('Het doorgeefprogramma draait al in een ander venster op deze computer.');
    console.log('Gebruik dat venster, of sluit het eerst en start dan opnieuw. Dit venster sluit over 15 seconden.');
    await sleep(15000); process.exit(0);
  }
  if (typeof fetch !== 'function') { console.log('Deze Node.js is te oud. Gebruik START-BORD.bat, die regelt de juiste versie.'); process.exit(1); }
  let cfg = {};
  if (!args.includes('--opnieuw')) {
    for (const f of [CONFIG, CONFIG_VAST]) {
      try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (c && c.id && c.secret) { cfg = c; if (f === CONFIG_VAST) console.log('Koppeling van een eerdere map gevonden: de code blijft ' + c.code + '.'); break; } } catch (e) {}
    }
  }
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
  for (const f of [CONFIG, CONFIG_VAST]) { try { fs.writeFileSync(f, JSON.stringify(cfg, null, 2)); } catch (e) {} }
  toonCode(cfg.code);
  console.log('Laat dit venster open zolang je speelt.\n');
  setInterval(() => verstuur(cfg, true), 10000); // teken van leven voor de status op de telefoon
  setInterval(() => { if (!telefoon) toonCode(cfg.code); }, 120000);
  verstuur(cfg, true);
  CFG = cfg;
  luisterNaarOpdrachten(cfg);
  if (TEST) return testModus(cfg);
  rl.close();
  luisterNaarBord(cfg);
})();
