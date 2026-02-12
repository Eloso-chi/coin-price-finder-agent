// src/services/ebayService.js — eBay SOLD comps via multiple APIs
// Priority: Marketplace Insights (sold) → Finding API (sold) → Browse API (active)
// Includes request throttling, aggressive caching, exponential backoff
// CommonJS

const axios = require('axios');
require('dotenv').config();
const { TTLCache } = require('../utils/cache');
const stats = require('../utils/stats');

// ── Config ──────────────────────────────────────────────────
const EBAY_APP_ID        = process.env.EBAY_APP_ID || '';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';
const FINDING_ENDPOINT   = process.env.EBAY_FINDING_ENDPOINT || 'https://svcs.ebay.com/services/search/FindingService/v1';
const GLOBAL_ID          = process.env.EBAY_GLOBAL_ID || 'EBAY-US';
const PER_PAGE           = parseInt(process.env.EBAY_ENTRIES_PER_PAGE || '50', 10);
const TIMEOUT            = parseInt(process.env.EBAY_TIMEOUT_MS || '10000', 10);
const CACHE_TTL          = parseInt(process.env.EBAY_CACHE_TTL_MS || '3600000', 10); // 1 hour default
const US_MIN_COMPS       = parseInt(process.env.EBAY_US_MIN_COMPS || '8', 10);
const THROTTLE_MS        = parseInt(process.env.EBAY_THROTTLE_MS || '1100', 10);     // min ms between API calls

// Long-lived cache: sold data doesn't change, so cache aggressively
const path = require('path');
const fs = require('fs');
const CACHE_DIR = path.join(__dirname, '..', '..', 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
const cache = new TTLCache({ defaultTTL: CACHE_TTL, filePath: path.join(CACHE_DIR, 'ebay_cache.json') });

// ── Request Throttle ────────────────────────────────────────
// Ensures we never exceed ~1 request per THROTTLE_MS to any eBay API
let _lastRequestTime = 0;
async function throttle() {
  const now = Date.now();
  const elapsed = now - _lastRequestTime;
  if (elapsed < THROTTLE_MS) {
    await new Promise(r => setTimeout(r, THROTTLE_MS - elapsed));
  }
  _lastRequestTime = Date.now();
}

// ── Deny-list patterns ──────────────────────────────────────
const DENY_PATTERNS = [
  /\blots?\b/i, /\bcollection\b/i, /\broll\b/i, /\bestate\b/i,
  /\breplica\b/i, /\bcopy\b/i, /\bcleaned\b/i, /\bpolished\b/i,
  /\bfake\b/i, /\btoken\b/i, /\bplated\b/i
];

function isDenied(title) {
  return DENY_PATTERNS.some(p => p.test(title));
}

// ── OAuth token (shared by Browse + Insights APIs) ──────────
let _oauthToken = null;
let _oauthExpiry = 0;

async function getOAuthToken() {
  if (_oauthToken && Date.now() < _oauthExpiry) return _oauthToken;
  await throttle();
  const resp = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      auth: { username: EBAY_APP_ID, password: EBAY_CLIENT_SECRET },
      timeout: TIMEOUT
    }
  );
  _oauthToken = resp.data.access_token;
  _oauthExpiry = Date.now() + (resp.data.expires_in - 300) * 1000;
  return _oauthToken;
}

// ── Exponential backoff retry wrapper ───────────────────────
async function withRetry(fn, retries = 2, baseDelay = 1500) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 429 || (status >= 500 && status < 600);
      if (isRetryable && attempt < retries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        console.warn(`[ebay] Retryable error ${status}, attempt ${attempt + 1}/${retries}, waiting ${Math.round(delay)}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// API 1: Marketplace Insights (SOLD items — OAuth, separate rate limits)
// ═══════════════════════════════════════════════════════════════
async function insightsSearch(keywords, timeWindowDays = 90, limit = 50) {
  const token = await getOAuthToken();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - timeWindowDays);
  const dateFilter = `soldDate:[${startDate.toISOString()}]`;

  await throttle();
  const resp = await withRetry(() => axios.get(
    'https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search',
    {
      params: {
        q: keywords,
        category_ids: '11116',
        limit: Math.min(limit, 200),
        filter: dateFilter
      },
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
      },
      timeout: TIMEOUT
    }
  ));

  return (resp.data.itemSales || []).map(item => ({
    itemId: item.itemId || item.legacyItemId || null,
    title: item.title,
    url: item.itemWebUrl || item.itemHref || null,
    soldDate: item.lastSoldDate || item.transactionDate || null,
    price: parseFloat(item.lastSoldPrice?.value || item.totalSoldCount ? 0 : 0),
    shipping: 0,
    totalUsd: parseFloat(item.lastSoldPrice?.value || 0),
    currency: item.lastSoldPrice?.currency || 'USD',
    location: 'US',
    listingType: 'Sold',
    conditionId: item.conditionId || null,
    matchScore: null,
    matchNotes: ['marketplace-insights-sold'],
    _source: 'insights'
  }));
}

// ═══════════════════════════════════════════════════════════════
// API 2: Finding API (SOLD items — AppID auth, separate rate limit)
// ═══════════════════════════════════════════════════════════════
async function findingPage(keywords, filters, page) {
  const params = {
    'OPERATION-NAME': 'findCompletedItems',
    'SERVICE-VERSION': '1.13.0',
    'SECURITY-APPNAME': EBAY_APP_ID,
    'RESPONSE-DATA-FORMAT': 'JSON',
    'GLOBAL-ID': GLOBAL_ID,
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
  return withRetry(() => axios.get(FINDING_ENDPOINT, { params, timeout: TIMEOUT }).then(r => r.data));
}

// ═══════════════════════════════════════════════════════════════
// API 3: Browse API (ACTIVE listings — OAuth, fallback only)
// ═══════════════════════════════════════════════════════════════
async function browseSearch(keywords, limit = 50) {
  const token = await getOAuthToken();
  await throttle();
  const resp = await withRetry(() => axios.get(
    'https://api.ebay.com/buy/browse/v1/item_summary/search',
    {
      params: { q: keywords, category_ids: '11116', limit: Math.min(limit, 200) },
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      timeout: TIMEOUT
    }
  ));
  return (resp.data.itemSummaries || []).map(item => ({
    itemId: item.itemId || item.legacyItemId || null,
    title: item.title,
    url: item.itemWebUrl,
    soldDate: null,
    price: parseFloat(item.price?.value || 0),
    shipping: item.shippingOptions?.[0]?.shippingCost?.value
      ? parseFloat(item.shippingOptions[0].shippingCost.value) : 0,
    totalUsd: parseFloat(item.price?.value || 0) +
      (item.shippingOptions?.[0]?.shippingCost?.value ? parseFloat(item.shippingOptions[0].shippingCost.value) : 0),
    currency: item.price?.currency || 'USD',
    location: item.itemLocation?.country || 'US',
    listingType: 'FixedPrice',
    conditionId: item.conditionId || null,
    matchScore: null,
    matchNotes: ['browse-api-active-listing'],
    _source: 'browse'
  }));
}

// ── Normalize Finding API item ──────────────────────────────
function normalizeItem(item) {
  const price = parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0);
  const currency = item.sellingStatus?.[0]?.currentPrice?.[0]?.['@currencyId'] || 'USD';
  const shippingRaw = item.shippingInfo?.[0]?.shippingServiceCost?.[0]?.__value__;
  const shipping = shippingRaw ? parseFloat(shippingRaw) : 0;
  const title = item.title?.[0] || '';

  return {
    itemId: item.itemId?.[0] || null,
    title,
    url: item.viewItemURL?.[0] || null,
    soldDate: item.listingInfo?.[0]?.endTime?.[0] || null,
    price,
    shipping,
    totalUsd: currency === 'USD' ? price + shipping : null,
    currency,
    location: item.location?.[0] || null,
    listingType: item.listingInfo?.[0]?.listingType?.[0] || null,
    conditionId: item.condition?.[0]?.conditionId?.[0] || null,
    matchScore: null,
    matchNotes: []
  };
}

// ── Match scoring ───────────────────────────────────────────
function scoreMatch(comp, expected) {
  let score = 50; // baseline
  const notes = [];
  const tLow = (comp.title || '').toLowerCase();

  // Year match
  if (expected.year && tLow.includes(String(expected.year))) { score += 15; notes.push('year-match'); }

  // Grade token match
  if (expected.grade) {
    const g = expected.grade.toLowerCase().replace(/\s+/g, '');
    if (tLow.replace(/\s+/g, '').includes(g)) { score += 15; notes.push('grade-exact'); }
    else if (/pcgs|ngc|anacs|icg/i.test(tLow)) { score += 5; notes.push('certified'); }
  }

  // Mint match
  if (expected.mint && new RegExp(`\\b${expected.mint}\\b`, 'i').test(tLow)) {
    score += 5; notes.push('mint-match');
  }

  // Series match
  if (expected.series) {
    const seriesTokens = expected.series.toLowerCase().split(/\s+/);
    const hits = seriesTokens.filter(t => t.length > 2 && tLow.includes(t)).length;
    if (hits >= Math.ceil(seriesTokens.length * 0.6)) { score += 10; notes.push('series-match'); }
  }

  // PCGS slab bonus
  if (/\bpcgs\b/i.test(tLow)) { score += 5; notes.push('pcgs-slab'); }

  comp.matchScore = Math.min(100, score);
  comp.matchNotes = notes;
  return comp;
}

// ── Deduplication ───────────────────────────────────────────
function dedup(comps) {
  const seen = new Map();
  const result = [];
  for (const c of comps) {
    // By itemId
    if (c.itemId && seen.has(c.itemId)) continue;
    if (c.itemId) seen.set(c.itemId, true);
    // By normalized title + price (within $1 tolerance)
    const key = (c.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80) + '|' + Math.round(c.totalUsd || 0);
    if (seen.has(key)) continue;
    seen.set(key, true);
    result.push(c);
  }
  return result;
}

// ── Apply filters ───────────────────────────────────────────
function applyFilters(comps, options, expected) {
  const removed = { denied: 0, nonUsd: 0, pcgsOnly: 0, gradeOnly: 0, outlier: 0 };

  // Deny-list
  let kept = comps.filter(c => {
    if (isDenied(c.title)) { removed.denied++; return false; }
    return true;
  });

  // USD only for stats
  kept = kept.filter(c => {
    if (c.totalUsd === null) { removed.nonUsd++; return false; }
    return true;
  });

  // requirePCGSOnly
  if (options.requirePCGSOnly) {
    kept = kept.filter(c => {
      if (!/\bpcgs\b/i.test(c.title)) { removed.pcgsOnly++; return false; }
      return true;
    });
  }

  // exactGradeOnly
  if (options.exactGradeOnly && expected.grade) {
    const gradeRe = new RegExp(`\\b${expected.grade.replace('+', '\\+')}\\b`, 'i');
    kept = kept.filter(c => {
      if (!gradeRe.test(c.title)) { removed.gradeOnly++; return false; }
      return true;
    });
  }

  // MAD outlier removal on totalUsd
  const prices = kept.map(c => c.totalUsd);
  const { kept: cleanPrices, removed: outlierPrices } = stats.removeOutliersMAD(prices, 3.5);
  removed.outlier = outlierPrices.length;
  const cleanSet = new Set(cleanPrices);
  // Need to be careful: if duplicate prices exist, track by index
  const priceCount = {};
  cleanPrices.forEach(p => { priceCount[p] = (priceCount[p] || 0) + 1; });
  const usedCount = {};
  kept = kept.filter(c => {
    const p = c.totalUsd;
    usedCount[p] = (usedCount[p] || 0);
    if (cleanSet.has(p) && usedCount[p] < (priceCount[p] || 0)) {
      usedCount[p]++;
      return true;
    }
    return false;
  });

  return { kept, removed };
}

// ── Fetch tier (Finding API) ────────────────────────────────
async function fetchFindingTier(keywords, timeWindowDays, maxPages, locatedIn) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - timeWindowDays);

  const filters = [
    { name: 'SoldItemsOnly', value: 'true' },
    { name: 'EndTimeFrom', value: startDate.toISOString() }
  ];
  if (locatedIn) filters.push({ name: 'LocatedIn', value: locatedIn });

  let allItems = [];
  let totalPages = 1;
  for (let page = 1; page <= Math.min(maxPages, totalPages); page++) {
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
    allItems = allItems.concat(items.map(normalizeItem));
    if (items.length < PER_PAGE) break;
  }
  return allItems;
}

// ── MAIN: fetchSoldComps ────────────────────────────────────
/**
 * Fetch eBay comps. Priority chain:
 *   1) Marketplace Insights API (sold data, OAuth, separate rate limit)
 *   2) Finding API (sold data, AppID auth)
 *   3) Browse API (active listings — last resort)
 *
 * Within each, tiered: US first, global second.
 */
async function fetchSoldComps(keywords, options = {}, expected = {}) {
  const opts = {
    timeWindowDays: options.timeWindowDays || 90,
    requirePCGSOnly: !!options.requirePCGSOnly,
    exactGradeOnly: !!options.exactGradeOnly,
    usMinComps: options.usMinComps || US_MIN_COMPS,
    maxPages: options.maxPages || 3
  };

  if (!EBAY_APP_ID) {
    const emptyTier = { stats: null, comps: [], removed: {}, error: { message: 'eBay credentials not configured' } };
    return { keywords, us: emptyTier, global: emptyTier, usedFallback: false, apiUsed: 'none' };
  }

  const cacheKey = `ebay:${keywords}:${JSON.stringify(opts)}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let usResult, globalResult;
  let apiUsed = 'none';
  let usedFallback = false;

  // ── Attempt 1: Marketplace Insights API (best: actual sold prices) ──
  try {
    const insightComps = await insightsSearch(keywords, opts.timeWindowDays, PER_PAGE * opts.maxPages);
    if (insightComps.length > 0) {
      apiUsed = 'marketplace-insights';
      const deduped = dedup(insightComps);
      const scored = deduped.map(c => scoreMatch(c, expected));
      const { kept, removed } = applyFilters(scored, opts, expected);
      const prices = kept.map(c => c.totalUsd);
      usResult = { stats: stats.summarize(prices), comps: kept, removed, error: null };
      globalResult = usResult; // Insights doesn't have a US/Global split; treat as both
      console.log(`[ebay] Marketplace Insights: ${kept.length} comps`);
    }
  } catch (err) {
    console.warn(`[ebay] Marketplace Insights unavailable: ${err.response?.status || err.message}`);
  }

  // ── Attempt 2: Finding API (if Insights didn't yield enough) ──
  if (!usResult || usResult.comps.length < opts.usMinComps) {
    try {
      // US tier
      const rawUS = await fetchFindingTier(keywords, opts.timeWindowDays, opts.maxPages, 'US');
      const dedupedUS = dedup(rawUS);
      const scoredUS = dedupedUS.map(c => scoreMatch(c, expected));
      const filterUS = applyFilters(scoredUS, opts, expected);
      const usPrices = filterUS.kept.map(c => c.totalUsd);

      // Merge with any Insights comps
      const mergedUS = usResult ? dedup([...usResult.comps, ...filterUS.kept]) : filterUS.kept;
      const mergedPrices = mergedUS.map(c => c.totalUsd);

      usResult = { stats: stats.summarize(mergedPrices), comps: mergedUS, removed: filterUS.removed, error: null };
      apiUsed = apiUsed === 'marketplace-insights' ? 'insights+finding' : 'finding';

      // Global tier
      const rawGlobal = await fetchFindingTier(keywords, opts.timeWindowDays, opts.maxPages, null);
      const dedupedGlobal = dedup(rawGlobal);
      const scoredGlobal = dedupedGlobal.map(c => scoreMatch(c, expected));
      const filterGlobal = applyFilters(scoredGlobal, opts, expected);
      const glPrices = filterGlobal.kept.map(c => c.totalUsd);
      globalResult = { stats: stats.summarize(glPrices), comps: filterGlobal.kept, removed: filterGlobal.removed, error: null };

      console.log(`[ebay] Finding API: US ${mergedUS.length}, Global ${filterGlobal.kept.length} comps`);
    } catch (err) {
      console.warn(`[ebay] Finding API unavailable: ${err.response?.status || err.message}`);
      if (!usResult) usResult = { stats: null, comps: [], removed: {}, error: { message: err.message } };
      if (!globalResult) globalResult = { stats: null, comps: [], removed: {}, error: { message: err.message } };
    }
  }

  // ── Attempt 3: Browse API (active listings — last resort) ──
  if (usResult.comps.length < opts.usMinComps) {
    try {
      const browseComps = await browseSearch(keywords, PER_PAGE * opts.maxPages);
      const dedupedBrowse = dedup(browseComps);
      const scoredBrowse = dedupedBrowse.map(c => scoreMatch(c, expected));
      const { kept, removed } = applyFilters(scoredBrowse, opts, expected);
      const prices = kept.map(c => c.totalUsd);
      usedFallback = true;

      // Merge with whatever we already have
      const merged = dedup([...usResult.comps, ...kept]);
      const mergedPrices = merged.map(c => c.totalUsd);
      usResult = {
        stats: stats.summarize(mergedPrices),
        comps: merged,
        removed,
        error: { message: `Browse API fallback used (active listings, not sold). Previous: ${usResult.error?.message || 'n/a'}` }
      };
      if (globalResult.comps.length < opts.usMinComps) {
        globalResult = usResult;
      }
      apiUsed = apiUsed !== 'none' ? `${apiUsed}+browse` : 'browse';
      console.log(`[ebay] Browse API fallback: ${kept.length} active listing comps`);
    } catch (browseErr) {
      console.error(`[ebay] Browse API also failed: ${browseErr.message}`);
      if (usResult.error) usResult.error.message += ` | Browse fallback failed: ${browseErr.message}`;
    }
  }

  if (usResult.comps.length < opts.usMinComps && globalResult.comps.length >= opts.usMinComps) {
    usedFallback = true;
  }

  const result = { keywords, us: usResult, global: globalResult, usedFallback, apiUsed };
  cache.set(cacheKey, result);
  return result;
}

/**
 * Build eBay search keywords from PCGS enrichment + raw query.
 */
function buildKeywords(pcgsData, rawQuery) {
  const parts = [];
  if (pcgsData?.year) parts.push(String(pcgsData.year));
  if (pcgsData?.mint) parts.push(`-${pcgsData.mint}`);
  if (pcgsData?.series) parts.push(pcgsData.series);
  if (pcgsData?.grade) parts.push(pcgsData.grade);
  if (pcgsData?.designation) parts.push(pcgsData.designation);
  if (parts.length >= 2) return parts.join(' ').trim();
  // Fall back to raw query
  return rawQuery || '';
}

module.exports = {
  fetchSoldComps,
  buildKeywords,
  scoreMatch,
  isDenied,
  dedup
};
