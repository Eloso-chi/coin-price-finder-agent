#!/usr/bin/env node
// scripts/investigate-libertad-batch.js
// ---------------------------------------------------------------------------
// Backlog #202 — Investigate Lot Evaluator Batch: Silver Libertad 1 oz
//
// Re-runs the 13-coin batch reported by the user through the Price Discovery
// route (/api/price) and produces a per-row diagnostic table. Reuses the
// dealer-premium benchmarks from #196 to flag low/high premiums against the
// current silver spot, and surfaces attrition / comp-count anomalies.
//
// Usage:
//   node scripts/investigate-libertad-batch.js
//   node scripts/investigate-libertad-batch.js --base-url https://...
//   node scripts/investigate-libertad-batch.js --json
//   node scripts/investigate-libertad-batch.js --out cache/libertad-202.json
//
// Requires server running at localhost:3000 (or set BASE_URL).
// ---------------------------------------------------------------------------
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const {
  lookupPremiumRange,
  classifyPremium,
  computePremium,
} = require('../src/data/dealerPremiums');

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function opt(name, dflt = null) {
  const eq = args.find(a => a.startsWith(name + '='));
  if (eq) return eq.split('=').slice(1).join('=');
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return dflt;
}
const BASE_URL = opt('--base-url', process.env.BASE_URL || 'http://localhost:3000');
const JSON_OUT = args.includes('--json');
const OUT_FILE = opt('--out');
const CONCURRENCY = parseInt(opt('--concurrency', '3'), 10);

// ── The batch under investigation (13 rows, duplicates preserved) ────────
const BATCH = [
  '1985 Mexican Silver Libertad 1 oz',
  '1993 Mexican Silver Libertad 1 oz',
  '1993 Mexican Silver Libertad 1 oz',
  '2004 Mexican Silver Libertad 1 oz',
  '2004 Mexican Silver Libertad 1 oz',
  '2009 Mexican Silver Libertad 1 oz',
  '2009 Mexican Silver Libertad 1 oz',
  '2011 Mexican Silver Libertad 1 oz',
  '2014 Mexican Silver Libertad 1 oz',
  '2014 Mexican Silver Libertad 1 oz',
  '2016 Mexican Silver Libertad 1 oz',
  '2020 Mexican Silver Libertad 1 oz',
  '2024 Mexican Silver Libertad 1 oz',
];

// All rows share these benchmark attributes for the premium-range lookup.
const COIN_PROFILE = {
  metal: 'silver',
  weightOz: 1,
  series: 'Mexican Silver Libertad',
  form: 'coin',
};

// ── HTTP helper ──────────────────────────────────────────────────────────
function httpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 60000,
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

async function fetchSilverSpot() {
  try {
    const res = await httpRequest('GET', '/api/metals/XAG');
    if (res && res.ok && Number.isFinite(res.price)) return res.price;
  } catch (e) {
    console.warn(`[spot] warning: ${e.message}`);
  }
  return null;
}

async function priceOne(query) {
  const out = { query, fmv: null, confidence: null, compCount: null, method: null,
    lowData: false, attritionPct: null, gathered: null, usComps: null, removed: null,
    dataSource: null, error: null };
  try {
    const res = await httpRequest('POST', '/api/price', { query });
    const v = res?.valuation || {};
    const e = res?.ebay?.us || {};
    out.fmv = Number.isFinite(v.fmvCore) ? v.fmvCore : null;
    out.confidence = v.confidence ?? null;
    out.compCount = v.compCount ?? null;
    out.method = v.method ?? null;
    out.lowData = !!v.lowData;
    out.attritionPct = e.attritionPct ?? null;
    out.gathered = e.gathered ?? null;
    out.usComps = e.comps?.length ?? 0;
    out.removed = e.removed || null;
    out.dataSource = v.dataSource || null;
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

async function parallelMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i]); }
      catch (err) { results[i] = { query: items[i], error: err.message }; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// ── Diagnostic analysis ──────────────────────────────────────────────────
function analyze(row, spot, premiumRange) {
  const issues = [];
  if (row.error) {
    issues.push({ severity: 'RED', type: 'request-error', detail: row.error });
    return issues;
  }
  if (row.fmv == null) {
    issues.push({ severity: 'RED', type: 'no-fmv' });
    return issues;
  }
  if (row.lowData) issues.push({ severity: 'YELLOW', type: 'low-data', compCount: row.compCount });
  if (Number.isFinite(row.compCount) && row.compCount < 5) {
    issues.push({ severity: 'YELLOW', type: 'thin-comps', compCount: row.compCount });
  }
  if (Number.isFinite(row.attritionPct)) {
    if (row.attritionPct > 90) issues.push({ severity: 'RED', type: 'high-attrition', attritionPct: row.attritionPct });
    else if (row.attritionPct > 70) issues.push({ severity: 'YELLOW', type: 'attrition', attritionPct: row.attritionPct });
  }
  if (spot && premiumRange) {
    const melt = spot * COIN_PROFILE.weightOz;
    const premium = computePremium(row.fmv, melt);
    const verdict = classifyPremium(premium, premiumRange);
    if (verdict === 'low' || verdict === 'high') {
      issues.push({
        severity: 'YELLOW',
        type: `premium-${verdict}`,
        premiumPct: +(premium * 100).toFixed(1),
        rangePct: `${(premiumRange.min*100).toFixed(0)}-${(premiumRange.max*100).toFixed(0)}`,
      });
    }
  }
  return issues;
}

// ── Group duplicates: stability check ────────────────────────────────────
function checkDuplicateStability(rows) {
  const byQuery = new Map();
  for (const r of rows) {
    if (!byQuery.has(r.query)) byQuery.set(r.query, []);
    byQuery.get(r.query).push(r);
  }
  const flagged = [];
  for (const [query, group] of byQuery.entries()) {
    if (group.length < 2) continue;
    const fmvs = group.map(g => g.fmv).filter(v => Number.isFinite(v));
    if (fmvs.length < 2) continue;
    const max = Math.max(...fmvs);
    const min = Math.min(...fmvs);
    const delta = max - min;
    if (max > 0 && delta / max > 0.05) {
      flagged.push({ query, fmvs, deltaPct: +((delta / max) * 100).toFixed(2) });
    }
  }
  return flagged;
}

// ── Pretty print ─────────────────────────────────────────────────────────
function fmt(n, decimals = 2) {
  return Number.isFinite(n) ? n.toFixed(decimals) : 'n/a';
}
function printReport(rows, spot, premiumRange, dupFlags) {
  console.log('\n=== Backlog #202 — Silver Libertad 1oz Batch Investigation ===');
  console.log(`Base URL:     ${BASE_URL}`);
  console.log(`Silver spot:  $${fmt(spot)}/oz`);
  if (premiumRange) {
    console.log(`Premium band: ${(premiumRange.min*100).toFixed(0)}%-${(premiumRange.max*100).toFixed(0)}% (key: ${premiumRange.key})`);
  }
  console.log(`Rows:         ${rows.length}\n`);

  const HEADER = ['#', 'query'.padEnd(40), 'fmv'.padStart(8), 'conf'.padStart(5),
    'comps'.padStart(6), 'attr%'.padStart(6), 'prem%'.padStart(7), 'verdict'];
  console.log(HEADER.join('  '));
  console.log('-'.repeat(110));

  let totalIssues = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const issues = analyze(r, spot, premiumRange);
    totalIssues += issues.length;
    const melt = spot ? spot * COIN_PROFILE.weightOz : null;
    const premium = (melt && r.fmv) ? ((r.fmv - melt) / melt) * 100 : null;
    const verdict = issues.length === 0
      ? 'OK'
      : issues.map(x => `${x.severity}:${x.type}`).join(' ');
    console.log([
      String(i + 1).padStart(2),
      r.query.padEnd(40),
      fmt(r.fmv).padStart(8),
      fmt(r.confidence, 2).padStart(5),
      String(r.compCount ?? 'n/a').padStart(6),
      fmt(r.attritionPct, 1).padStart(6),
      fmt(premium, 1).padStart(7),
      verdict,
    ].join('  '));
  }

  if (dupFlags.length) {
    console.log('\n--- Duplicate-row instability (same query, ≥5% FMV spread) ---');
    for (const d of dupFlags) {
      console.log(`  ${d.query}: [${d.fmvs.map(v => v.toFixed(2)).join(', ')}]  delta ${d.deltaPct}%`);
    }
  } else {
    console.log('\n✓ Duplicate rows are stable (FMV spread < 5% within each query).');
  }
  console.log(`\nTotal findings: ${totalIssues}`);
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const spot = await fetchSilverSpot();
  const premiumRange = lookupPremiumRange(COIN_PROFILE);

  const rows = await parallelMap(BATCH, priceOne, CONCURRENCY);
  const dupFlags = checkDuplicateStability(rows);

  const report = {
    investigation: 'backlog-202-silver-libertad',
    date: new Date().toISOString(),
    baseUrl: BASE_URL,
    silverSpot: spot,
    coinProfile: COIN_PROFILE,
    premiumRange,
    rows: rows.map(r => ({ ...r, issues: analyze(r, spot, premiumRange) })),
    duplicateInstability: dupFlags,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(rows, spot, premiumRange, dupFlags);
  }

  if (OUT_FILE) {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
    if (!JSON_OUT) console.log(`\nReport saved: ${OUT_FILE}`);
  }
}

main().catch(err => {
  console.error(`[fatal] ${err.stack || err.message}`);
  process.exit(1);
});
