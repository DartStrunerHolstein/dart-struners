// De Dart Struners – doorgeefprogramma voor Autodarts
// Leest de pijlen die Autodarts op deze computer (of in het netwerk) herkent
// en stuurt ze door naar de website. Geen extra pakketten nodig (Node.js 18+).
//
// Starten:   node bord.js           (eerste keer stelt hij een paar vragen)
//            node bord.js --opnieuw (vragen opnieuw beantwoorden)
//            node bord.js --test    (zonder camera's: typ zelf pijlen, bijv. T20)

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const CONFIG = path.join(__dirname, 'bord-instellingen.json');
const args = process.argv.slice(2);
const TEST = args.includes('--test');

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
function siteInfo(link) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(link) ? link : 'https://' + link); } catch (e) { return null; }
  const m = /^\/s\/([a-z0-9]{6})/i.exec(u.pathname);
  return { base: u.origin, sid: m ? m[1].toLowerCase() : '', api: u.origin + (m ? '/api/s/' + m[1].toLowerCase() + '/bord' : '/api/bord') };
}
async function stuur(cfg, events, status) {
  const r = await fetch(cfg.api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pin': cfg.code },
    body: JSON.stringify({ events, status }),
    signal: AbortSignal.timeout(8000)
  });
  if (r.status === 401) { const e = new Error('code'); e.code = 401; throw e; }
  if (r.status === 429) { const e = new Error('Te vaak een verkeerde code. Wacht 5 minuten.'); e.code = 429; throw e; }
  if (!r.ok) throw new Error('website antwoordt ' + r.status);
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

// ---------- instellingen ----------
async function instellen(oud) {
  console.log('\n=== Instellen ===\n');
  let cfg = {};
  for (;;) {
    const link = await ask(`Link van de website${oud && oud.site ? ' [' + oud.site + ']' : ''}:\n  (bijv. dartstruners.alwaysdata.net, of een sessielink zoals …/s/abc123)\n> `) || (oud && oud.site) || '';
    const s = siteInfo(link);
    if (!s) { console.log('Dat is geen geldige link.\n'); continue; }
    cfg = { site: link, ...s };
    break;
  }
  for (;;) {
    cfg.code = await ask(`\nCode ${cfg.sid ? '(de sessiecode)' : '(je beheerderscode, of de bordcode als je die hebt)'}:\n> `);
    if (!cfg.code) continue;
    try { await stuur(cfg, [], { connected: false, running: false, status: 'Instellen' }); console.log('Code klopt ✓'); break; }
    catch (e) {
      if (e.code === 401) console.log('Deze code klopt niet. Probeer het opnieuw.');
      else if (e.code === 429) { console.log(e.message); await sleep(5000); }
      else { console.log('Kan de website niet bereiken (' + e.message + '). Controleer de link en je internet.'); return instellen(cfg); }
    }
  }
  if (TEST) { cfg.board = 'test'; return cfg; }
  for (;;) {
    console.log('\nWaar draait Autodarts?\n  1) Op deze computer\n  2) Zoeken in het netwerk\n  3) Zelf een adres invullen');
    const k = await ask('> ');
    if (k === '1') {
      if (await isAutodarts('http://127.0.0.1:3180')) { cfg.board = 'http://127.0.0.1:3180'; console.log('Autodarts gevonden op deze computer ✓'); break; }
      console.log('Autodarts antwoordt niet op deze computer. Staat het Autodarts-programma aan?');
    } else if (k === '2') {
      const g = await zoekInNetwerk();
      if (!g.length) { console.log('Geen Autodarts gevonden in het netwerk.'); continue; }
      g.forEach((b, i) => console.log(`  ${i + 1}) ${b}`));
      const c = g.length === 1 ? '1' : await ask('Welk bord? > ');
      const b = g[Number(c) - 1];
      if (b) { cfg.board = b; console.log('Gekozen: ' + b + ' ✓'); break; }
    } else if (k === '3') {
      let a = await ask('Adres (bijv. 192.168.1.50): > ');
      if (!/^https?:\/\//.test(a)) a = 'http://' + a;
      if (!/:\d+$/.test(a)) a += ':3180';
      if (await isAutodarts(a)) { cfg.board = a; console.log('Autodarts gevonden ✓'); break; }
      console.log('Op dat adres antwoordt Autodarts niet.');
    }
  }
  return cfg;
}

// ---------- pijlen omzetten ----------
// Autodarts-segment: { name: 'T20', number: 20, multiplier: 3, bed: 'Triple' }
function omzet(t) {
  const sg = (t && t.segment) || {};
  let n = Number(sg.number) || 0, m = Number(sg.multiplier);
  const name = String(sg.name || '');
  if (!Number.isFinite(m)) m = 1;
  if (/^(bull|db|bullseye|d?bull50)$/i.test(name) || (n === 25 && m >= 2) || n === 50) { n = 25; m = 2; }
  if (t && t.bouncer) { n = 0; m = 0; }
  if (m === 0) n = 0;
  return { n, m, name: n === 0 ? 'Mis' : n === 25 ? (m === 2 ? 'Bull' : '25') : (m === 3 ? 'T' : m === 2 ? 'D' : '') + n };
}

// ---------- hoofdlus ----------
let queue = [], bezig = false, laatsteStatus = null, fouten = 0;
async function verstuur(cfg, force) {
  if (bezig || (!queue.length && !force)) return;
  bezig = true;
  const batch = queue.slice(0, 20);
  try {
    await stuur(cfg, batch, laatsteStatus);
    queue = queue.slice(batch.length);
    if (fouten) log('Weer verbonden met de website ✓');
    fouten = 0;
  } catch (e) {
    if (e.code === 401) { log('De code klopt niet meer. Start opnieuw met: node bord.js --opnieuw'); process.exit(1); }
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
      const throws = Array.isArray(d.throws) ? d.throws : [];
      const num = Number.isFinite(d.numThrows) ? d.numThrows : throws.length;
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
  let cfg = null;
  try { if (!args.includes('--opnieuw')) cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) {}
  if (cfg && cfg.site) { Object.assign(cfg, siteInfo(cfg.site)); }
  if (!cfg || !cfg.code || (!cfg.board && !TEST)) {
    cfg = await instellen(cfg);
    if (!TEST) { fs.writeFileSync(CONFIG, JSON.stringify({ site: cfg.site, code: cfg.code, board: cfg.board }, null, 2)); console.log('\nInstellingen bewaard. Volgende keer start hij meteen.'); }
  }
  console.log(`\nWebsite: ${cfg.base}${cfg.sid ? '  (sessie ' + cfg.sid + ')' : ''}`);
  console.log('Zet op je telefoon in de wedstrijd de knop "Camera" aan. Laat dit venster open zolang je speelt.\n');
  setInterval(() => verstuur(cfg, true), 10000); // teken van leven voor de status op de telefoon
  verstuur(cfg, true);
  if (TEST) return testModus(cfg);
  rl.close();
  luisterNaarBord(cfg);
})();
