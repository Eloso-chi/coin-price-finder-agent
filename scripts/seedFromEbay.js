#!/usr/bin/env node
// scripts/seedFromEbay.js
//
// Bulk-seed the Terapeak store with REAL sold data from eBay Finding API.
// Iterates every CSV filename in data/terapeak/, calls findCompletedItems
// for each search term, and saves the results via terapeakService.importComps().
//
// Usage:
//   node scripts/seedFromEbay.js                   # dry-run — show what would be seeded
//   node scripts/seedFromEbay.js --run              # seed all coins
//   node scripts/seedFromEbay.js --run --days 365   # widen lookback to 365 days
//   node scripts/seedFromEbay.js --run --limit 50   # only seed first 50 coins
//   node scripts/seedFromEbay.js --run --skip 100   # skip first 100, seed the rest
//   node scripts/seedFromEbay.js --run --filter "Morgan"  # only seed terms matching "Morgan"
//   node scripts/seedFromEbay.js --status            # show how many datasets have real data
//
// Rate limiting: 1.1 seconds between API calls (matches EBAY_THROTTLE_MS).
// eBay Finding API allows ~5,000 calls/day.  At 3 pages max per coin,
// 525 coins = ~1,575 calls, well within limits.

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ── Load env vars (reuse the server's .env) ──
const dotenvPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(dotenvPath)) {
  require('dotenv').config({ path: dotenvPath });
}

const terapeakService = require('../src/services/terapeakService');

// ── Config ──
const EBAY_APP_ID       = process.env.EBAY_APP_ID || '';
const FINDING_ENDPOINT  = process.env.EBAY_FINDING_ENDPOINT || 'https://svcs.ebay.com/services/search/FindingService/v1';
const PER_PAGE          = 50;
const MAX_PAGES         = 3;
const THROTTLE_MS       = parseInt(process.env.EBAY_THROTTLE_MS || '1100', 10);
const TERAPEAK_DIR      = path.join(__dirname, '..', 'data', 'terapeak');

// ── CLI args ──
const args = process.argv.slice(2);
const isRun      = args.includes('--run');
const isStatus   = args.includes('--status');
const daysIdx    = args.indexOf('--days');
const days       = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) : 180;
const limitIdx   = args.indexOf('--limit');
const limit      = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const skipIdx    = args.indexOf('--skip');
const skip       = skipIdx >= 0 ? parseInt(args[skipIdx + 1], 10) : 0;
const filterIdx  = args.indexOf('--filter');
const filterTerm = filterIdx >= 0 ? args[filterIdx + 1] : null;

// ── Throttle ──
let lastReq = 0;
async function throttle() {
  const elapsed = Date.now() - lastReq;
  if (elapsed < THROTTLE_MS) {
    await new Promise(r => setTimeout(r, THROTTLE_MS - elapsed));
  }
  lastReq = Date.now();
}

// ── Weight detection (simplified — matches ebayService patterns) ──
function detectMetalFromTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\bgold\b/.test(t)) return 'gold';
  if (/\bsilver\b/.test(t)) return 'silver';
  if (/\bplatinum\b/.test(t)) return 'platinum';
  if (/\bpalladium\b/.test(t)) return 'palladium';
  return null;
}

function classifyGradeType(comp) {
  const t = (comp.title || '').toUpperCase();
  if (/\b(PCGS|NGC|ANACS|ICG|CAC)\b/.test(t)) return 'graded';
  if (/\b(BU|UNC|MS[-\s]?\d|GEM)\b/.test(t)) return 'raw-bu';
  if (/\b(VG|VF|XF|EF|AU|AG|G[-\s]?\d|F[-\s]?\d)\b/.test(t)) return 'raw-circ';
  return 'unclassified';
}

// ── Finding API call ──
async function findingPage(keywords, filters, page) {
  const params = {
    'OPERATION-NAME': 'findCompletedItems',
    'SERVICE-VERSION': '1.13.0',
    'SECURITY-APPNAME': EBAY_APP_ID,
    'RESPONSE-DATA-FORMAT': 'JSON',
    'GLOBAL-ID': 'EBAY-US',
    'keywords': keywords,
    'categoryId': '11116',
    'paginationInput.entriesPerPage': String(PER_PAGE),
    'paginationInput.pageNumber': String(page)
  };
  let idx = 0;
  for (const f of filters) {
    params[`itemFilter(${idx}).name`] = f.name;
    params[`itemFilter(${idx}).value`] = f.value;
    idx++;
  }
  await throttle();
  const resp = await axios.get(FINDING_ENDPOINT, { params, timeout: 15000 });
  return resp.data;
}

function normalizeItem(item) {
  const price = parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0);
  const currency = item.sellingStatus?.[0]?.currentPrice?.[0]?.['@currencyId'] || 'USD';
  const shippingRaw = item.shippingInfo?.[0]?.shippingServiceCost?.[0]?.__value__;
  const shipping = shippingRaw ? parseFloat(shippingRaw) : 0;
  const title = item.title?.[0] || '';

  const comp = {
    itemId: item.itemId?.[0] || null,
    title,
    url: item.viewItemURL?.[0] || null,
    imageUrl: item.galleryURL?.[0] || null,
    additionalImages: [],
    soldDate: item.listingInfo?.[0]?.endTime?.[0] || null,
    price,
    shipping,
    totalUsd: currency === 'USD' ? price + shipping : null,
    currency,
    location: item.location?.[0] || null,
    listingType: item.listingInfo?.[0]?.listingType?.[0] || null,
    conditionId: item.condition?.[0]?.conditionId?.[0] || null,
    _certificationAspect: null,
    _compositionAspect: null,
    _finenessAspect: null,
    _detectedMetal: detectMetalFromTitle(title),
    matchScore: null,
    matchNotes: ['finding-api-seed'],
    _source: 'finding-seed'
  };
  comp.gradeType = classifyGradeType(comp);
  return comp;
}

async function fetchSold(keywords, lookbackDays) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - lookbackDays);

  const filters = [
    { name: 'SoldItemsOnly', value: 'true' },
    { name: 'EndTimeFrom', value: startDate.toISOString() },
    { name: 'LocatedIn', value: 'US' }
  ];

  const allComps = [];
  let totalPages = 1;

  for (let page = 1; page <= Math.min(MAX_PAGES, totalPages); page++) {
    const data = await findingPage(keywords, filters, page);
    const resp = data.findCompletedItemsResponse?.[0];
    if (!resp) break;

    const ack = resp.ack?.[0];
    if (ack === 'Failure') {
      const errMsg = resp.errorMessage?.[0]?.error?.[0]?.message?.[0] || 'Unknown Finding API error';
      throw new Error(errMsg);
    }

    totalPages = parseInt(resp.paginationOutput?.[0]?.totalPages?.[0] || '1', 10);
    const items = resp.searchResult?.[0]?.item || [];
    allComps.push(...items.map(normalizeItem));

    if (items.length < PER_PAGE) break;
  }

  return allComps;
}

// ── Derive search terms from CSV filenames ──
function getSearchTerms() {
  const files = fs.readdirSync(TERAPEAK_DIR).filter(f => f.endsWith('.csv'));
  return files.map(f => {
    const metaPath = path.join(TERAPEAK_DIR, f.replace(/\.csv$/, '.meta'));
    if (fs.existsSync(metaPath)) {
      return fs.readFileSync(metaPath, 'utf8').trim();
    }
    return f.replace(/\.csv$/, '').replace(/[_]+/g, ' ').trim();
  });
}

// ── Status command ──
function showStatus() {
  const datasets = terapeakService.listDatasets();
  let realCount = 0;
  let syntheticCount = 0;
  let mixedCount = 0;

  for (const ds of datasets) {
    const hasReal = ds.comps.some(c => c._source === 'finding-seed' || c._source === 'finding-auto');
    const hasSynthetic = ds.comps.some(c => !c._source || c._source === 'terapeak');
    if (hasReal && hasSynthetic) mixedCount++;
    else if (hasReal) realCount++;
    else syntheticCount++;
  }

  console.log(`\nTerapeak Store Status:`);
  console.log(`  Total datasets:  ${datasets.length}`);
  console.log(`  Real data only:  ${realCount}`);
  console.log(`  Synthetic only:  ${syntheticCount}`);
  console.log(`  Mixed:           ${mixedCount}`);
  console.log();
}

// ── Main ──
async function main() {
  if (!EBAY_APP_ID) {
    console.error('ERROR: EBAY_APP_ID not set. Configure it in .env or environment.');
    process.exit(1);
  }

  if (isStatus) {
    showStatus();
    return;
  }

  let terms = getSearchTerms();
  console.log(`Found ${terms.length} search terms from data/terapeak/ CSVs`);

  if (filterTerm) {
    const re = new RegExp(filterTerm, 'i');
    terms = terms.filter(t => re.test(t));
    console.log(`Filtered to ${terms.length} terms matching "${filterTerm}"`);
  }

  terms = terms.slice(skip, skip + limit);
  console.log(`Processing ${terms.length} terms (skip=${skip}, limit=${limit === Infinity ? 'none' : limit}, lookback=${days}d)`);

  if (!isRun) {
    console.log('\nDRY RUN — would seed these terms:');
    terms.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
    console.log(`\nRun with --run to execute. Estimated time: ~${Math.ceil(terms.length * MAX_PAGES * THROTTLE_MS / 60000)} minutes`);
    return;
  }

  console.log(`\nStarting bulk seed (${terms.length} coins, ~${THROTTLE_MS}ms between calls)...`);
  const startTime = Date.now();

  let success = 0;
  let failed = 0;
  let totalNew = 0;
  let totalDups = 0;

  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    const pct = Math.round(((i + 1) / terms.length) * 100);

    try {
      const comps = await fetchSold(term, days);

      if (comps.length === 0) {
        console.log(`  [${pct}%] ${term} — no results`);
        continue;
      }

      const result = terapeakService.importComps(term, comps, {
        source: 'finding-api-seed',
        seedDate: new Date().toISOString()
      });

      totalNew += result.newComps;
      totalDups += result.duplicatesSkipped;
      success++;

      console.log(`  [${pct}%] ${term} — ${result.newComps} new, ${result.duplicatesSkipped} dups, ${result.totalStored} total`);
    } catch (err) {
      failed++;
      console.error(`  [${pct}%] ${term} — ERROR: ${err.message}`);

      // If rate limited, wait extra before continuing
      if (err.message.includes('10001') || err.message.includes('rate')) {
        console.log('  >> Rate limited. Waiting 60 seconds...');
        await new Promise(r => setTimeout(r, 60000));
      }
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n=== Bulk Seed Complete ===`);
  console.log(`  Time:       ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
  console.log(`  Succeeded:  ${success} / ${terms.length}`);
  console.log(`  Failed:     ${failed}`);
  console.log(`  New comps:  ${totalNew}`);
  console.log(`  Duplicates: ${totalDups}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
