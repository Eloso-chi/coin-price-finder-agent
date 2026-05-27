#!/usr/bin/env node
/**
 * pricing-health-full.js -- Full-dataset pricing health audit
 * 
 * Runs every dataset in the Terapeak store through the pricing pipeline
 * and outputs a JSON report with flagged issues.
 * 
 * Usage:
 *   node scripts/pricing-health-full.js                  # default sample (14 coins)
 *   node scripts/pricing-health-full.js --full           # all datasets with 10+ comps
 *   node scripts/pricing-health-full.js --full --min 30  # all datasets with 30+ comps
 *   node scripts/pricing-health-full.js --limit 100      # first 100 qualifying datasets
 *   node scripts/pricing-health-full.js --filter "Morgan" # datasets matching filter
 *   node scripts/pricing-health-full.js --full --out cache/health-report.json
 * 
 * Requires server running at localhost:3000 (or set BASE_URL env var).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

// -- CLI args --
const args = process.argv.slice(2);
const isFullRun = args.includes('--full');
const minComps = parseInt(args[args.indexOf('--min') + 1]) || 10;
const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : null;
const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const quiet = args.includes('--quiet') || args.includes('-q');
const CONCURRENCY = args.includes('--concurrency')
  ? parseInt(args[args.indexOf('--concurrency') + 1])
  : (isFullRun ? 10 : 5);

// -- HTTP helper --
// Sends x-api-key ONLY to admin-gated paths so the credential is not broadcast
// to non-admin endpoints, reverse proxies, or log aggregators.
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
// Paths (prefix match) that require the admin key. Keep tight.
const ADMIN_PATH_PREFIXES = [
  '/api/terapeak/datasets',
  '/api/terapeak/quota',
  '/api/terapeak/aggregation-status',
  '/api/terapeak/scrape-status',
  '/api/terapeak/purge-stale-csvs',
  '/api/terapeak/reimport',
  '/api/terapeak/backfill-aggregation-meta',
  '/api/terapeak/import',
  '/api/terapeak/report-no-data',
  '/api/admin',
  '/api/clear-cache'
];
function isAdminPath(pathname) {
  return ADMIN_PATH_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/') || pathname.startsWith(p + '?'));
}
function httpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const headers = { 'Content-Type': 'application/json' };
    if (ADMIN_API_KEY && isAdminPath(url.pathname)) headers['x-api-key'] = ADMIN_API_KEY;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 30000
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ _raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// -- Parallel limiter --
async function parallelMap(items, fn, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// -- Test one coin --
async function testCoin(query) {
  const result = { coin: query, teakRows: 0, discovery: null, batch: null, issues: [] };

  try {
    // Terapeak lookup
    const teak = await httpRequest('GET', `/api/terapeak/lookup?q=${encodeURIComponent(query)}`);
    result.teakRows = teak?.comps?.length || 0;

    // Discovery route
    const disc = await httpRequest('POST', '/api/price', { query });
    const v = disc?.valuation || {};
    const e = disc?.ebay?.us || {};
    result.discovery = {
      fmv: v.fmvCore ?? null,
      confidence: v.confidence ?? null,
      method: v.method ?? null,
      compCount: v.compCount ?? null,
      lowData: v.lowData || false,
      browseOnly: v.dataSource?.browseOnly || false,
      usComps: e.comps?.length ?? 0,
      gathered: e.gathered ?? null,
      attritionPct: e.attritionPct ?? null,
      removed: e.removed || {}
    };

    // Batch route
    const batch = await httpRequest('POST', '/api/pricing-batch', {
      items: [{ query, coinData: { name: query } }]
    });
    const r = batch?.results?.[0] || {};
    result.batch = {
      fmv: r.fmv ?? r.valuation?.fmvCore ?? null,
      confidence: r.confidence ?? r.valuation?.confidence ?? null,
      avgEbay: r.avgEbay ?? null
    };

    // -- Flag issues --
    const df = result.discovery.fmv;
    const bf = result.batch.fmv;

    // Cross-route divergence
    if (df && bf && df > 0) {
      const delta = Math.abs(df - bf) / df;
      if (delta > 0.15) result.issues.push({ type: 'cross-route', severity: 'RED', delta: +(delta * 100).toFixed(1), discoveryFmv: df, batchFmv: bf });
      else if (delta > 0.08) result.issues.push({ type: 'cross-route', severity: 'YELLOW', delta: +(delta * 100).toFixed(1), discoveryFmv: df, batchFmv: bf });
    }

    // Attrition
    const attrition = result.discovery.attritionPct;
    if (attrition > 90) result.issues.push({ type: 'attrition', severity: 'RED', attritionPct: attrition, removed: result.discovery.removed });
    else if (attrition > 70) result.issues.push({ type: 'attrition', severity: 'YELLOW', attritionPct: attrition, removed: result.discovery.removed });

    // Pipeline leak: lots of Terapeak data, few comps used
    if (result.teakRows > 50 && result.discovery.usComps < 5) {
      result.issues.push({ type: 'pipeline-leak', severity: 'RED', teakRows: result.teakRows, usComps: result.discovery.usComps, removed: result.discovery.removed });
    } else if (result.teakRows > 20 && result.discovery.usComps < 10) {
      result.issues.push({ type: 'pipeline-leak', severity: 'YELLOW', teakRows: result.teakRows, usComps: result.discovery.usComps });
    }

    // Browse-only despite data
    if (result.discovery.browseOnly && result.teakRows > 20) {
      result.issues.push({ type: 'browse-only', severity: 'RED', teakRows: result.teakRows });
    }

    // Low confidence
    if (result.discovery.confidence !== null && result.discovery.confidence < 50 && result.discovery.fmv !== null) {
      result.issues.push({ type: 'low-confidence', severity: 'YELLOW', confidence: result.discovery.confidence });
    }

    // Null FMV despite data
    if (result.discovery.fmv === null && result.teakRows > 10) {
      result.issues.push({ type: 'null-fmv', severity: 'RED', teakRows: result.teakRows });
    }

  } catch (err) {
    result.issues.push({ type: 'error', severity: 'RED', message: err.message });
  }

  return result;
}

// -- Main --
async function main() {
  // Health check
  try {
    await httpRequest('GET', '/api/health');
  } catch {
    console.error('Server not responding at ' + BASE);
    process.exit(1);
  }

  // Build coin list
  let coins;
  if (isFullRun || limit || filter) {
    const resp = await httpRequest('GET', '/api/terapeak/datasets');
    let datasets = resp?.datasets || [];
    datasets = datasets.filter(d => (d.compCount || 0) >= minComps);
    if (filter) {
      const re = new RegExp(filter, 'i');
      datasets = datasets.filter(d => re.test(d.searchTerm || ''));
    }
    // Sort or shuffle
    if (args.includes('--shuffle')) {
      for (let i = datasets.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [datasets[i], datasets[j]] = [datasets[j], datasets[i]];
      }
    } else {
      datasets.sort((a, b) => (b.compCount || 0) - (a.compCount || 0));
    }
    if (limit) datasets = datasets.slice(0, limit);
    coins = datasets.map(d => d.searchTerm);
    if (!quiet) process.stderr.write(`Testing ${coins.length} datasets (min ${minComps} comps)...\n`);
  } else {
    // Default sample (golden set)
    coins = [
      '1921 Morgan Silver Dollar',
      '1882-S Morgan Silver Dollar',
      '1880-CC Morgan Silver Dollar',
      '1921 Morgan Silver Dollar MS63',
      '2024 American Silver Eagle',
      '1986 American Silver Eagle',
      '2021 American Silver Eagle Type 1',
      '1923 Peace Dollar',
      '2024 South African Krugerrand 1 oz',
      '2023 Mexican Gold Libertad 1 oz',
      '2020 China 30g Silver Panda BU',
      '1900-O Barber Dime',
      '2021 Perth Lunar Ox 1 oz silver',
      '1974 US Proof Set'
    ];
    if (!quiet) process.stderr.write(`Testing ${coins.length} sample coins...\n`);
  }

  // Run tests with progress
  let done = 0;
  const results = await parallelMap(coins, async (coin, i) => {
    const r = await testCoin(coin);
    done++;
    if (!quiet && done % 25 === 0) process.stderr.write(`  ${done}/${coins.length} complete\n`);
    return r;
  }, CONCURRENCY);

  // Summarize
  const red = results.filter(r => r.issues.some(i => i.severity === 'RED'));
  const yellow = results.filter(r => r.issues.some(i => i.severity === 'YELLOW') && !r.issues.some(i => i.severity === 'RED'));
  const green = results.filter(r => r.issues.length === 0);

  const report = {
    timestamp: new Date().toISOString(),
    coinCount: results.length,
    summary: {
      healthy: green.length,
      yellow: yellow.length,
      red: red.length,
      rating: red.length > results.length * 0.1 ? 'DEGRADED' : red.length > 0 ? 'CONCERNS' : 'HEALTHY'
    },
    flagged: [...red, ...yellow].map(r => ({
      coin: r.coin,
      teakRows: r.teakRows,
      fmv: r.discovery?.fmv,
      confidence: r.discovery?.confidence,
      batchFmv: r.batch?.fmv,
      issues: r.issues
    })),
    results
  };

  const json = JSON.stringify(report, null, 2);

  if (outFile) {
    const dir = path.dirname(outFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outFile, json);
    if (!quiet) process.stderr.write(`\nReport saved to ${outFile}\n`);
    // Also print summary to stdout
    console.log(JSON.stringify(report.summary));
  } else {
    console.log(json);
  }

  if (!quiet) {
    process.stderr.write(`\n=== PRICING HEALTH: ${report.summary.rating} ===\n`);
    process.stderr.write(`  GREEN: ${green.length} | YELLOW: ${yellow.length} | RED: ${red.length}\n`);
    if (red.length > 0) {
      process.stderr.write(`\nRED issues:\n`);
      for (const r of red) {
        for (const issue of r.issues.filter(i => i.severity === 'RED')) {
          process.stderr.write(`  ${r.coin} -- ${issue.type}`);
          if (issue.delta) process.stderr.write(` (${issue.delta}% delta)`);
          if (issue.attritionPct) process.stderr.write(` (${issue.attritionPct}% attrition)`);
          if (issue.teakRows && issue.usComps !== undefined) process.stderr.write(` (${issue.teakRows} teak -> ${issue.usComps} comps)`);
          process.stderr.write('\n');
        }
      }
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
