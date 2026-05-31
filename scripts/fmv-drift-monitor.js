#!/usr/bin/env node
// scripts/fmv-drift-monitor.js
// ---------------------------------------------------------------------------
// Backlog #193 — Historical FMV Drift Monitor
//
// Maintains cache/fmv-snapshots.json with FMV history for ~20 benchmark coins.
// On each run, re-prices every benchmark and compares against the most recent
// prior snapshot. Flags:
//   • bullion drift   > 5%  beyond accompanying spot movement
//   • numismatic drift > 15%
// Premium classification uses src/data/dealerPremiums.js (#196).
//
// Usage:
//   node scripts/fmv-drift-monitor.js                # take snapshot + diff
//   node scripts/fmv-drift-monitor.js --no-save      # diagnostic only
//   node scripts/fmv-drift-monitor.js --base-url http://localhost:3000
//   node scripts/fmv-drift-monitor.js --json         # machine-readable output
//
// Exit code: 0 = OK / yellow only, 2 = at least one RED drift flag.
// ---------------------------------------------------------------------------
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const { lookupPremiumRange, classifyPremium, computePremium } =
  require('../src/data/dealerPremiums');

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function opt(name, dflt = null) {
  const eq = args.find(a => a.startsWith(name + '='));
  if (eq) return eq.split('=').slice(1).join('=');
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return dflt;
}

const BASE_URL = opt('--base-url', process.env.BASE_URL || 'http://localhost:3000');
const SNAPSHOT_FILE = opt('--file', path.join(__dirname, '..', 'cache', 'fmv-snapshots.json'));
const NO_SAVE = flag('--no-save');
const JSON_OUT = flag('--json');
const CONCURRENCY = parseInt(opt('--concurrency', '4'), 10);
const BULLION_DRIFT_THRESHOLD = 0.05;      // 5%
const NUMISMATIC_DRIFT_THRESHOLD = 0.15;   // 15%

// ── Benchmark set ─────────────────────────────────────────────────────────
// Mix of bullion (premium-tracked) + numismatic (raw-drift tracked).
const BENCHMARKS = [
  // -- US Bullion --
  { query: '2024 American Silver Eagle 1 oz',    metal: 'silver',   weightOz: 1,        series: 'American Silver Eagle',     form: 'coin',  category: 'bullion' },
  { query: '2023 American Silver Eagle 1 oz',    metal: 'silver',   weightOz: 1,        series: 'American Silver Eagle',     form: 'coin',  category: 'bullion' },
  { query: '2024 American Gold Eagle 1 oz',      metal: 'gold',     weightOz: 1,        series: 'American Gold Eagle',       form: 'coin',  category: 'bullion' },
  { query: '2024 American Gold Eagle 1/10 oz',   metal: 'gold',     weightOz: 0.1,      series: 'American Gold Eagle',       form: 'coin',  category: 'bullion' },
  { query: '2024 American Gold Buffalo 1 oz',    metal: 'gold',     weightOz: 1,        series: 'American Gold Buffalo',     form: 'coin',  category: 'bullion' },
  { query: '2024 American Platinum Eagle 1 oz',  metal: 'platinum', weightOz: 1,        series: 'American Platinum Eagle',   form: 'coin',  category: 'bullion' },

  // -- World Bullion --
  { query: '2024 Canadian Silver Maple Leaf 1 oz', metal: 'silver', weightOz: 1,        series: 'Canadian Silver Maple Leaf', form: 'coin', category: 'bullion' },
  { query: '2024 Canadian Gold Maple Leaf 1 oz',   metal: 'gold',   weightOz: 1,        series: 'Canadian Gold Maple Leaf',   form: 'coin', category: 'bullion' },
  { query: '2024 Gold Krugerrand 1 oz',            metal: 'gold',   weightOz: 1,        series: 'Gold Krugerrand',            form: 'coin', category: 'bullion' },
  { query: '2024 Silver Krugerrand 1 oz',          metal: 'silver', weightOz: 1,        series: 'Silver Krugerrand',          form: 'coin', category: 'bullion' },
  { query: '2024 British Silver Britannia 1 oz',   metal: 'silver', weightOz: 1,        series: 'British Silver Britannia',   form: 'coin', category: 'bullion' },
  { query: '2024 Mexican Silver Libertad 1 oz',    metal: 'silver', weightOz: 1,        series: 'Mexican Silver Libertad',    form: 'coin', category: 'bullion' },

  // -- Bars --
  { query: '1 oz silver bar',                      metal: 'silver', weightOz: 1,        series: null,                          form: 'bar',  category: 'bullion' },
  { query: '10 oz silver bar',                     metal: 'silver', weightOz: 10,       series: null,                          form: 'bar',  category: 'bullion' },
  { query: '1 oz gold bar',                        metal: 'gold',   weightOz: 1,        series: null,                          form: 'bar',  category: 'bullion' },

  // -- Numismatic (raw-drift tracked) --
  { query: '1921 Morgan Silver Dollar',                                            category: 'numismatic' },
  { query: '1964 Kennedy Half Dollar',                                             category: 'numismatic' },
  { query: '1960-D Lincoln Cent',                                                  category: 'numismatic' },
  { query: '1881-S Morgan Silver Dollar MS-63',                                    category: 'numismatic' },
  { query: '1916-D Mercury Dime',                                                  category: 'numismatic' },
];

// ── HTTP helper (mirrors style of scripts/pricing-health-full.js) ─────────
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const ADMIN_PATH_PREFIXES = ['/api/admin', '/api/clear-cache', '/api/terapeak'];
function isAdminPath(pathname) {
  return ADMIN_PATH_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'));
}
function httpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (ADMIN_API_KEY && isAdminPath(url.pathname)) headers['x-api-key'] = ADMIN_API_KEY;
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method, headers, timeout: 60000,
    };
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ _raw: data, _status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout: ${method} ${urlPath}`)); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Parallel limiter ──────────────────────────────────────────────────────
async function parallelMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i], i); }
      catch (err) { results[i] = { error: err.message }; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// ── Spot prices ───────────────────────────────────────────────────────────
async function fetchSpot() {
  const out = { XAU: null, XAG: null, XPT: null, XPD: null };
  try {
    const res = await httpRequest('GET', '/api/metals?metals=XAU,XAG,XPT,XPD');
    if (res && res.ok && Array.isArray(res.prices)) {
      for (const p of res.prices) {
        if (p && p.metal && Number.isFinite(p.price)) out[p.metal] = p.price;
      }
    }
  } catch (e) {
    console.warn(`[spot] warning: ${e.message}`);
  }
  return out;
}
function meltValueFor(parsed, spot) {
  if (!parsed || !parsed.weightOz) return null;
  const key = { gold: 'XAU', silver: 'XAG', platinum: 'XPT', palladium: 'XPD' }[parsed.metal];
  if (!key || !Number.isFinite(spot[key])) return null;
  return parsed.weightOz * spot[key];
}
function spotKeyFor(metal) {
  return { gold: 'XAU', silver: 'XAG', platinum: 'XPT', palladium: 'XPD' }[metal] || null;
}

// ── Price one benchmark ───────────────────────────────────────────────────
async function priceOne(b) {
  const res = await httpRequest('POST', '/api/price', { query: b.query });
  const v = res?.valuation || {};
  return {
    query: b.query,
    category: b.category,
    fmv: Number.isFinite(v.fmvCore) ? v.fmvCore : null,
    confidence: v.confidence ?? null,
    compCount: v.compCount ?? null,
    method: v.method ?? null,
    lowData: !!v.lowData,
  };
}

// ── Snapshot I/O ──────────────────────────────────────────────────────────
function loadSnapshots() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return { snapshots: [] };
  try {
    const txt = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    const parsed = JSON.parse(txt);
    if (!Array.isArray(parsed.snapshots)) return { snapshots: [] };
    return parsed;
  } catch (e) {
    console.warn(`[snapshots] could not parse ${SNAPSHOT_FILE}: ${e.message} — starting fresh`);
    return { snapshots: [] };
  }
}
function saveSnapshots(store) {
  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(store, null, 2));
}

// ── Drift comparison ──────────────────────────────────────────────────────
function compareToPrior(currentSnap, priorSnap) {
  if (!priorSnap) return [];
  const priorByQuery = new Map(priorSnap.results.map(r => [r.query, r]));
  const priorSpot = priorSnap.spot || {};
  const curSpot = currentSnap.spot || {};

  const findings = [];
  for (const cur of currentSnap.results) {
    const prior = priorByQuery.get(cur.query);
    if (!prior || !Number.isFinite(prior.fmv) || !Number.isFinite(cur.fmv) || prior.fmv === 0) continue;

    const rawDrift = (cur.fmv - prior.fmv) / prior.fmv;
    const bench = BENCHMARKS.find(b => b.query === cur.query) || {};
    const isBullion = bench.category === 'bullion';

    if (isBullion) {
      const sk = spotKeyFor(bench.metal);
      const spotDrift = (sk && Number.isFinite(priorSpot[sk]) && Number.isFinite(curSpot[sk]) && priorSpot[sk] > 0)
        ? (curSpot[sk] - priorSpot[sk]) / priorSpot[sk]
        : 0;
      const excess = rawDrift - spotDrift;
      const abs = Math.abs(excess);
      if (abs > BULLION_DRIFT_THRESHOLD) {
        findings.push({
          severity: abs > BULLION_DRIFT_THRESHOLD * 2 ? 'RED' : 'YELLOW',
          type: 'bullion-excess-drift',
          query: cur.query,
          priorFmv: prior.fmv,
          curFmv: cur.fmv,
          rawDriftPct: +(rawDrift * 100).toFixed(2),
          spotDriftPct: +(spotDrift * 100).toFixed(2),
          excessDriftPct: +(excess * 100).toFixed(2),
          threshold: BULLION_DRIFT_THRESHOLD,
        });
      }
    } else {
      const abs = Math.abs(rawDrift);
      if (abs > NUMISMATIC_DRIFT_THRESHOLD) {
        findings.push({
          severity: abs > NUMISMATIC_DRIFT_THRESHOLD * 2 ? 'RED' : 'YELLOW',
          type: 'numismatic-drift',
          query: cur.query,
          priorFmv: prior.fmv,
          curFmv: cur.fmv,
          driftPct: +(rawDrift * 100).toFixed(2),
          threshold: NUMISMATIC_DRIFT_THRESHOLD,
        });
      }
    }
  }
  return findings;
}

// ── Premium-band check (uses #196 table) ──────────────────────────────────
function premiumChecks(currentSnap) {
  const out = [];
  for (const r of currentSnap.results) {
    const bench = BENCHMARKS.find(b => b.query === r.query);
    if (!bench || bench.category !== 'bullion') continue;
    const melt = meltValueFor(bench, currentSnap.spot);
    const premium = computePremium(r.fmv, melt);
    if (premium == null) continue;
    const range = lookupPremiumRange(bench);
    const verdict = classifyPremium(premium, range);
    if (verdict === 'low' || verdict === 'high') {
      out.push({
        severity: verdict === 'high' ? 'YELLOW' : 'YELLOW',
        type: `premium-${verdict}`,
        query: r.query,
        fmv: r.fmv,
        meltValue: +melt.toFixed(2),
        premiumPct: +(premium * 100).toFixed(2),
        rangeKey: range.key,
        rangeMinPct: range.min * 100,
        rangeMaxPct: range.max * 100,
      });
    }
  }
  return out;
}

// ── Pretty print ──────────────────────────────────────────────────────────
function fmtPct(n) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function printReport(currentSnap, driftFindings, premiumFindings, priorDate) {
  console.log(`\n=== FMV Drift Monitor — ${currentSnap.date} ===`);
  console.log(`Snapshot file: ${SNAPSHOT_FILE}`);
  console.log(`Benchmarks: ${currentSnap.results.length}  |  Prior snapshot: ${priorDate || '(none)'}\n`);

  const spot = currentSnap.spot || {};
  console.log('Spot prices:');
  for (const k of ['XAU','XAG','XPT','XPD']) {
    if (Number.isFinite(spot[k])) console.log(`  ${k}: $${spot[k].toFixed(2)}/oz`);
  }
  console.log('');

  const allFindings = [...driftFindings, ...premiumFindings];
  if (allFindings.length === 0) {
    console.log('✓ No findings.');
    return;
  }
  const reds = allFindings.filter(f => f.severity === 'RED');
  const yells = allFindings.filter(f => f.severity === 'YELLOW');
  console.log(`Findings: ${reds.length} RED, ${yells.length} YELLOW\n`);

  for (const f of allFindings) {
    if (f.type === 'bullion-excess-drift') {
      console.log(`[${f.severity}] bullion-excess-drift  ${f.query}`);
      console.log(`        FMV ${f.priorFmv.toFixed(2)} → ${f.curFmv.toFixed(2)} (raw ${fmtPct(f.rawDriftPct)}, spot ${fmtPct(f.spotDriftPct)}, excess ${fmtPct(f.excessDriftPct)})`);
    } else if (f.type === 'numismatic-drift') {
      console.log(`[${f.severity}] numismatic-drift       ${f.query}`);
      console.log(`        FMV ${f.priorFmv.toFixed(2)} → ${f.curFmv.toFixed(2)} (${fmtPct(f.driftPct)})`);
    } else if (f.type.startsWith('premium-')) {
      console.log(`[${f.severity}] ${f.type.padEnd(22)} ${f.query}`);
      console.log(`        premium ${fmtPct(f.premiumPct)}  band ${f.rangeKey} [${f.rangeMinPct.toFixed(0)}%-${f.rangeMaxPct.toFixed(0)}%]`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const store = loadSnapshots();
  const prior = store.snapshots[store.snapshots.length - 1] || null;

  const spot = await fetchSpot();
  const results = await parallelMap(BENCHMARKS, priceOne, CONCURRENCY);

  const current = {
    date: new Date().toISOString(),
    spot,
    results,
  };

  const driftFindings = compareToPrior(current, prior);
  const premiumFindings = premiumChecks(current);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      date: current.date,
      priorDate: prior?.date || null,
      spot,
      results,
      driftFindings,
      premiumFindings,
    }, null, 2));
  } else {
    printReport(current, driftFindings, premiumFindings, prior?.date);
  }

  if (!NO_SAVE) {
    store.snapshots.push(current);
    // keep last 52 snapshots (~1 year of weekly runs)
    if (store.snapshots.length > 52) store.snapshots = store.snapshots.slice(-52);
    saveSnapshots(store);
  }

  const hasRed = [...driftFindings, ...premiumFindings].some(f => f.severity === 'RED');
  process.exit(hasRed ? 2 : 0);
}

main().catch(err => {
  console.error(`[fatal] ${err.stack || err.message}`);
  process.exit(1);
});
