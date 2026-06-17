// src/services/ebayService.js — eBay comps via multiple APIs
// Priority: Terapeak (sold) → Finding API (sold, disabled by default) → Browse API (active, fallback)
// Marketplace Insights API: commented out (no access)
// Finding API: gated behind EBAY_FINDING_ENABLED env var (default false — deprecated Feb 2025)
// Includes request throttling, aggressive caching, exponential backoff
// CommonJS

const axios = require('axios');
const { TTLCache } = require('../utils/cache');
const stats = require('../utils/stats');
const { isDenied, detectDenomination, hasSeriesConflict, isCompositionMismatch, BULLION_DENY_DENOM_RE, BULLION_OK_RE, ROLL_PATTERN } = require('../utils/filters');
const terapeakService = require('./terapeakService');
const { getSpotOnDate, METAL_SYMBOLS } = require('./metalsHistoryService');
const { detectWeightFromTitle } = require('../utils/coinMetalProfile');
const { isReverseProofFinish } = require('../utils/coinIntent');

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
const FINDING_ENABLED    = (process.env.EBAY_FINDING_ENABLED || 'false').toLowerCase() === 'true';

// ── Circuit breaker: skip APIs that have failed recently ────
const _circuitBreaker = {};
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
function circuitTripped(apiName) {
  const ts = _circuitBreaker[apiName];
  return ts && (Date.now() - ts) < CIRCUIT_COOLDOWN_MS;
}
function tripCircuit(apiName) {
  _circuitBreaker[apiName] = Date.now();
  console.warn(`[ebay] Circuit breaker tripped for ${apiName} — skipping for ${CIRCUIT_COOLDOWN_MS / 1000}s`);
}

// Long-lived cache: sold data doesn't change, so cache aggressively
const path = require('path');
const fs = require('fs');
const CACHE_DIR = require('../utils/cachePath').CACHE_DIR;
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

// ── detectWeightFromTitle imported from ../utils/coinMetalProfile ──

// ── isDenied imported from ../utils/filters ─────────────────

// ── Metal detection from title / aspects ─────────────────────
const METAL_PATTERNS = [
  { metal: 'gold',      re: /\bgold\b/i },
  { metal: 'silver',    re: /\bsilver\b/i },
  { metal: 'platinum',  re: /\bplatinum\b/i },
  { metal: 'palladium', re: /\bpalladium\b/i },
  { metal: 'copper',    re: /\bcopper\b/i },
];

// Decorative/plating patterns where "gold" does NOT indicate the primary metal.
// E.g. "24k Gold Gilded 1 oz Silver Coin" is silver, not gold.
const DECORATIVE_GOLD_RE = /\bgold[\s-]*(gild|plat|finish|color|dust|marble|rutil|rhodium|ton(?:e[ds]?|ing))/i;
// Brand names containing "gold" that do NOT indicate the metal
const BRAND_GOLD_RE = /\bgold[\s-]*(?:spartan|back|creek|hill)\b/i;
// Multi-metal decorative indicator: "Multi-Metal Gold", "Black Platinum & Gold"
const MULTI_METAL_RE = /\bmulti[\s-]*metal\b/i;

/**
 * Detect primary metal from a listing title string.
 * When both "gold" and "silver" appear, uses weight-adjacent context and
 * decorative pattern detection to determine the actual bullion metal.
 * Returns 'gold', 'silver', 'platinum', 'palladium', 'copper', or null.
 */
function detectMetalFromTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  const hasGold   = /\bgold\b/.test(t);
  const hasSilver = /\bsilver\b/.test(t);

  // When both gold and silver appear, determine the primary metal
  if (hasGold && hasSilver) {
    // Check which metal is adjacent to weight/oz tokens (primary bullion indicator)
    const weightGold   = /\b(?:\d[\d./]*\s*(?:troy\s*)?oz)\s+gold\b|\bgold\s+(?:\d[\d./]*\s*(?:troy\s*)?oz)\b/.test(t);
    const weightSilver = /\b(?:\d[\d./]*\s*(?:troy\s*)?oz)\s+silver\b|\bsilver\s+(?:\d[\d./]*\s*(?:troy\s*)?oz)\b/.test(t);
    if (weightSilver && !weightGold) return 'silver';
    if (weightGold && !weightSilver) return 'gold';

    // Check for decorative gold patterns (gilded, plated, finish, toning, etc.)
    if (DECORATIVE_GOLD_RE.test(title)) return 'silver';

    // Check for brand names containing "gold" (Gold Spartan, etc.)
    if (BRAND_GOLD_RE.test(title)) return 'silver';

    // Multi-metal / bi-metal decorative editions are typically silver base
    if (MULTI_METAL_RE.test(t)) return 'silver';

    // "X & Gold" / "Gold &" with other plating metals = decorative gold on silver
    if (/\b(?:ruthenium|rhodium|black)\b/i.test(t)) return 'silver';

    // ".999 silver" / ".999 fine silver" / "999+ silver" = silver coin with decorative gold
    if (/\.?999\+?\s*(?:fine\s+)?silver\b/.test(t)) return 'silver';

    // "fine silver" without weight-adjacent gold = silver base
    if (/\bfine\s+silver\b/.test(t)) return 'silver';

    // If no weight context or decorative clues, fall through to first-match
  }

  for (const { metal, re } of METAL_PATTERNS) {
    if (re.test(title)) return metal;
  }
  return null;
}

/**
 * Detect metal from a composition/fineness string (eBay item specifics).
 * Examples: ".999 Fine Silver", "Gold", ".9999 Fine Gold", "Silver Plated" (ignored via deny)
 */
function detectMetalFromComposition(value) {
  if (!value) return null;
  for (const { metal, re } of METAL_PATTERNS) {
    if (re.test(value)) return metal;
  }
  // Fineness-only values like ".999" or ".9999" without a metal name
  // can't reliably identify metal — return null
  return null;
}

// ── Graded (certified / slabbed) vs Raw detection ──────────
// Classification uses two independent axes:
//   Axis 1: Certification — graded (TPG-slabbed) vs raw
//   Axis 2: Strike type   — proof vs business strike (BU)
// A slabbed proof (e.g. PCGS PR69 DCAM) is 'proof', not 'graded',
// because strike type determines which pricing pool it belongs to.
//
// Priority chain:
//   1. conditionId  (eBay structured data — authoritative for certification)
//       2000 = "Certified" (graded by approved TPG)
//       3000 = "Uncirculated" (raw)
//       4000 = "Circulated" (raw)
//   2. conditionDescriptors / localizedAspects (Browse API)
//       "Certification" aspect = PCGS/NGC/etc → graded
//   3. Title regex fallback (least reliable)
const TPG_RE          = /\b(PCGS|NGC|ANACS|ICG|CGC)\b/i;
const FORMAL_GRADE_RE = /\b(MS|PR|PF|SP|AU|XF|EF|VF|VG|AG|FR|PO)\s*[-]?\s*\d{1,2}\+?\b/i;

const PROOF_RE = /\bproof\b(?![\s-]*like)/i;
// PR #3 / RP-pool-split: "Reverse Proof" and "Enhanced Reverse Proof" titles
// also match PROOF_RE (the second word is "proof"), so they previously fell
// into the regular 'proof' pool and contaminated FMV + comp lists for both
// regular Proof queries (RP comps showed up) and RP queries (regular Proof
// comps showed up). Detect RP/ERP BEFORE the generic proof check so they
// route to a dedicated 'reverse-proof' pool.
const REVERSE_PROOF_RE = /\b(enhanced[\s-]+)?reverse[\s-]+proof\b/i;

function isReverseProofTitle(title) {
  return REVERSE_PROOF_RE.test(title || '');
}

/**
 * Classify a comp as 'graded', 'proof', 'reverse-proof', or 'raw' using
 * eBay's structured condition data first, falling back to title parsing
 * only when the API doesn't provide a conditionId.
 *
 * #182: Slabbed proofs (conditionId=2000 + "proof" in title) are classified
 * as 'proof' so they land in the proof pool, not the graded (BU) pool.
 *
 * PR #3: Reverse Proof / Enhanced Reverse Proof titles classify as
 * 'reverse-proof' (checked before the generic proof match). Enhanced
 * Reverse Proof shares this pool with Reverse Proof -- pool-selection
 * uses expected.finish to distinguish where it matters, and within-pool
 * scoring/keyword filters further separate them.
 */
function classifyGradeType(comp) {
  const cid = comp.conditionId ? String(comp.conditionId) : null;
  const title = comp.title || '';
  const isRP = isReverseProofTitle(title);

  // 1. Authoritative: eBay conditionId
  if (cid === '2000') {
    // #182: Certified coin — check if it's a slabbed proof or slabbed BU
    if (isRP) return 'reverse-proof';
    if (PROOF_RE.test(title)) return 'proof';
    return 'graded';
  }
  if (cid === '3000' || cid === '4000') {
    // Uncirculated/Circulated condition but may still be proof
    if (isRP) return 'reverse-proof';
    if (PROOF_RE.test(title)) return 'proof';
    return 'raw';
  }
  // 1000 (New), 1500 (New Other) — not standard for coins but treat as raw
  if (cid === '1000' || cid === '1500') return 'raw';

  // 2. ConditionDescriptors / localizedAspects (set by Browse API normalizer)
  if (comp._certificationAspect) {
    // #182: Certified via aspect — still check for proof
    if (isRP) return 'reverse-proof';
    if (PROOF_RE.test(title)) return 'proof';
    return 'graded';
  }

  // 3. Title fallback (least reliable — eBay policy says don't rely on title)
  if (isRP) return 'reverse-proof';
  if (PROOF_RE.test(title)) return 'proof';
  if (TPG_RE.test(title) || FORMAL_GRADE_RE.test(title)) return 'graded';

  return 'raw';
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
async function withRetry(fn, retries = 2, baseDelay = 800) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 429 || (status >= 500 && status < 600);
      if (isRetryable && attempt < retries) {
        const delay = baseDelay * (attempt + 1) + Math.random() * 300;
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
// COMMENTED OUT — we do not have access to Marketplace Insights API.
// Keeping for reference in case access is restored later.
// ═══════════════════════════════════════════════════════════════
/*
async function insightsSearch(keywords, timeWindowDays = 90, limit = 50, brandFilter = null) {
  const token = await getOAuthToken();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - timeWindowDays);
  const dateFilter = `soldDate:[${startDate.toISOString()}]`;

  await throttle();
  const params = {
    q: keywords,
    category_ids: '11116',
    limit: Math.min(limit, 200),
    filter: dateFilter
  };
  if (brandFilter) {
    params.aspect_filter = `categoryId:11116,Brand:{${brandFilter}}`;
  }
  const resp = await withRetry(() => axios.get(
    'https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search',
    {
      params,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
      },
      timeout: TIMEOUT
    }
  ));

  return (resp.data.itemSales || []).map(item => {
    const comp = {
      itemId: item.itemId || item.legacyItemId || null,
      title: item.title,
      url: item.itemWebUrl || item.itemHref || null,
      imageUrl: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
      soldDate: item.lastSoldDate || item.transactionDate || null,
      price: parseFloat(item.lastSoldPrice?.value || 0),
      shipping: 0,
      totalUsd: parseFloat(item.lastSoldPrice?.value || 0),
      currency: item.lastSoldPrice?.currency || 'USD',
      location: 'US',
      listingType: 'Sold',
      conditionId: item.conditionId || null,
      _detectedMetal: detectMetalFromTitle(item.title),
      matchScore: null,
      matchNotes: ['marketplace-insights-sold'],
      _source: 'insights'
    };
    comp.gradeType = classifyGradeType(comp);
    return comp;
  });
}
*/

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
async function browseSearch(keywords, limit = 50, brandFilter = null) {
  const token = await getOAuthToken();
  await throttle();
  const params = { q: keywords, category_ids: '11116', limit: Math.min(limit, 200) };
  // Apply Brand / Mint aspect filter when available — eBay will only return
  // items whose item-specifics match, dramatically reducing cross-mint pollution.
  if (brandFilter) {
    params.aspect_filter = `categoryId:11116,Brand:{${brandFilter}}`;
  }
  const resp = await withRetry(() => axios.get(
    'https://api.ebay.com/buy/browse/v1/item_summary/search',
    {
      params,
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      timeout: TIMEOUT
    }
  ));
  return (resp.data.itemSummaries || []).map(item => {
    // Extract certification aspect from localizedAspects (structured item specifics)
    const aspects = item.localizedAspects || [];
    const certAspect = aspects.find(a => /certification|grading\s*company|professional\s*grader/i.test(a.name));
    const gradeAspect = aspects.find(a => a.name === 'Grade' && /^(MS|PR|PF|SP|AU|XF|EF|VF|VG)\s*\d/i.test(a.value || ''));
    // Composition / fineness / metal from item specifics
    const compAspect = aspects.find(a => /composition|metal\s*content|precious\s*metal\s*content/i.test(a.name));
    const fineAspect = aspects.find(a => /fineness/i.test(a.name));
    const aspectMetal = detectMetalFromComposition(compAspect?.value)
                     || detectMetalFromComposition(fineAspect?.value);
    const comp = {
      itemId: item.itemId || item.legacyItemId || null,
      title: item.title,
      url: item.itemWebUrl,
      imageUrl: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
      additionalImages: (item.additionalImages || []).map(i => i.imageUrl).filter(Boolean),
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
      _certificationAspect: certAspect?.value || gradeAspect?.value || null,
      _compositionAspect: compAspect?.value || null,
      _finenessAspect: fineAspect?.value || null,
      _detectedMetal: aspectMetal || detectMetalFromTitle(item.title) || null,
      matchScore: null,
      matchNotes: ['browse-api-active-listing'],
      _source: 'browse'
    };
    comp.gradeType = classifyGradeType(comp);
    return comp;
  });
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
    imageUrl: item.galleryURL?.[0] || null,
    soldDate: item.listingInfo?.[0]?.endTime?.[0] || null,
    price,
    shipping,
    totalUsd: currency === 'USD' ? price + shipping : null,
    currency,
    location: item.location?.[0] || null,
    listingType: item.listingInfo?.[0]?.listingType?.[0] || null,
    conditionId: item.condition?.[0]?.conditionId?.[0] || null,
    conditionDisplayName: item.condition?.[0]?.conditionDisplayName?.[0] || null,
    _detectedMetal: detectMetalFromTitle(title),
    matchScore: null,
    matchNotes: [],
    _source: 'finding'
  };
}

// Apply gradeType after Finding API normalization
function classifyFindingItem(comp) {
  comp.gradeType = classifyGradeType(comp);
  return comp;
}

// ── Match scoring ───────────────────────────────────────────
function scoreMatch(comp, expected) {
  // Delegate to bar-specific scorer when appropriate
  if (expected.type === 'bar') return scoreBarMatch(comp, expected);

  let score = 50; // baseline
  const notes = [];
  const tLow = (comp.title || '').toLowerCase();

  // Roll / tube match / mismatch
  if (expected.isRoll) {
    if (ROLL_PATTERN.test(tLow)) { score += 15; notes.push('roll-match'); }
    else { score -= 30; notes.push('roll-mismatch'); }
  }

  // Year match / mismatch
  if (expected.year) {
    const yearsInTitle = [...tLow.matchAll(/\b(1[7-9]\d{2}|20[0-4]\d)\b/g)].map(m => parseInt(m[1], 10));
    const hasExpected = yearsInTitle.includes(expected.year);
    const hasDifferent = yearsInTitle.some(y => y !== expected.year);
    if (hasExpected) { score += 15; notes.push('year-match'); }
    if (hasDifferent && !hasExpected) { score -= 30; notes.push('year-mismatch'); }
  }

  // Grade token match
  if (expected.grade) {
    const g = expected.grade.toLowerCase().replace(/\s+/g, '');
    // Normalize EF↔XF bidirectionally for matching
    const gXF = g.replace(/^ef/, 'xf');
    const gEF = g.replace(/^xf/, 'ef');
    const tNorm = tLow.replace(/\s+/g, '');
    if (tNorm.includes(g) || tNorm.includes(gXF) || tNorm.includes(gEF)) {
      score += 15; notes.push('grade-exact');
    } else if (/pcgs|ngc|anacs|icg/i.test(tLow)) {
      score += 5; notes.push('certified');
      // Check for numeric grade mismatch: if the comp title has a formal
      // grade (e.g. MS63) that differs from the expected grade (e.g. MS65),
      // apply a penalty proportional to the distance.  In Morgan dollars
      // the jump from MS64 to MS65 can be 2-5x in price.
      const wantNum = parseInt((g.match(/\d+/) || [])[0], 10);
      const titleGradeMatch = tLow.match(/\b(?:ms|pr|pf|sp|au|xf|ef|vf|vg|ag|fr|po)\s*[-]?\s*(\d{1,2})\b/i);
      const titleNum = titleGradeMatch ? parseInt(titleGradeMatch[1], 10) : null;
      if (wantNum && titleNum != null && titleNum !== wantNum) {
        const diff = Math.abs(wantNum - titleNum);
        // Steeper penalty for larger gaps; even 1 grade point matters at MS65+
        const penalty = diff >= 3 ? 40 : diff === 2 ? 30 : 20;
        score -= penalty;
        notes.push('grade-num-mismatch(' + titleNum + 'vs' + wantNum + ')');
      }
    }
    // BU-term matching: if user searched "BU" or "Choice BU" etc.,
    // also give credit for comp titles with matching BU terms
    if (/bu|unc/i.test(g) || (expected._gradeSource === 'bu-term')) {
      if (/\bBU\b|\bunc(?:irculated)?\b|\bbrill(?:iant)?\b/i.test(tLow)) {
        score += 10; notes.push('bu-match');
      }
    }
  }

  // Mint match / mismatch
  if (expected.mint) {
    const wantMint = expected.mint.toUpperCase();
    // Extract mint mark from title: year-adjacent "1892-S", "1881 CC", etc.
    const mintRe = /\b\d{4}\s*[-]?\s*(CC|[SDPWO])\b/i;
    const mintHit = tLow.match(mintRe);
    let titleMint = mintHit ? mintHit[1].toUpperCase() : null;
    // Also check for mint city names (Carson City, Denver, etc.)
    if (!titleMint) {
      const MINT_CITY_MAP = { 'carson city': 'CC', 'denver': 'D', 'philadelphia': 'P', 'san francisco': 'S', 'west point': 'W' };
      for (const [city, mark] of Object.entries(MINT_CITY_MAP)) {
        if (tLow.includes(city)) { titleMint = mark; break; }
      }
    }
    // Standalone "CC" anywhere in title (unique two-letter mark, no false-positive risk)
    if (!titleMint && /\bCC\b/.test(comp.title || '')) {
      titleMint = 'CC';
    }
    if (titleMint === wantMint) {
      score += 10; notes.push('mint-match');
    } else if (titleMint && titleMint !== wantMint) {
      // Different mint mark explicitly stated in title — strong penalty
      score -= 30; notes.push('mint-mismatch');
    }
    // If no mint found in title, no bonus or penalty (benefit of doubt)
  }

  // Series match / mismatch
  if (expected.series) {
    const seriesTokens = expected.series.toLowerCase().split(/\s+/);
    const hits = seriesTokens.filter(t => t.length > 2 && tLow.includes(t)).length;
    if (hits >= Math.ceil(seriesTokens.length * 0.6)) { score += 10; notes.push('series-match'); }
    else if (hits === 0 && seriesTokens.length > 0) { score -= 25; notes.push('series-mismatch'); }
  }

  // Series conflict (e.g. Jefferson vs Buffalo — both nickels, but completely different coins)
  if (expected.series && hasSeriesConflict(expected.series, tLow)) {
    score -= 50; notes.push('series-conflict');
  }

  // Silver/clad composition mismatch (e.g. 1978 quarter comp says "silver")
  if (isCompositionMismatch(tLow, expected)) {
    score -= 40; notes.push('composition-mismatch');
  }

  // Denomination match / mismatch  (quarter vs dollar, dime vs half, etc.)
  {
    const wantDenom = detectDenomination(expected.series || expected._rawQuery || '');
    const compDenom = detectDenomination(tLow);
    if (wantDenom && compDenom && wantDenom !== compDenom) {
      score -= 40; notes.push('denom-mismatch');
    }
  }

  // Metal match / mismatch
  if (expected.metal) {
    const compMetal = comp._detectedMetal;
    if (compMetal === expected.metal) { score += 10; notes.push('metal-match'); }
    else if (compMetal && compMetal !== expected.metal) { score -= 30; notes.push('metal-mismatch'); }
  }

  // PCGS slab bonus
  if (/\bpcgs\b/i.test(tLow)) { score += 5; notes.push('pcgs-slab'); }

  // ── Proof vs BU mismatch ──
  // When the user is searching for a proof coin, penalize BU/non-proof comps
  // and vice versa. Plain "proof" in title is the discriminator.
  const userWantsProof = expected.isProof
    || (expected.grade && /^(proof|pr|pf)/i.test(expected.grade))
    || (expected.finish === 'Proof');
  const titleHasProof = /\bproof\b/i.test(tLow);
  if (userWantsProof && !titleHasProof) {
    score -= 25; notes.push('proof-mismatch-want-proof');
  } else if (!userWantsProof && titleHasProof && !expected.isSet) {
    score -= 25; notes.push('proof-mismatch-unwanted-proof');
  }

  // ── #183: Designation scoring (DCAM / CAM / etc.) ──
  // On proof coins, DCAM vs CAM vs plain can mean 10-40%+ price difference.
  // Soft scoring (not a hard filter) to avoid thin-pool problems.
  if (expected.designation && userWantsProof) {
    const desigRe = new RegExp('\\b' + expected.designation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (desigRe.test(tLow)) {
      score += 10; notes.push('designation-match');
    } else {
      score -= 15; notes.push('designation-mismatch');
    }
  }

  // ── Grade-type classification + mismatch penalty ──
  // gradeType was set during normalization via classifyGradeType();
  // re-classify here in case it wasn't set (e.g. cached comps from older format)
  if (!comp.gradeType) comp.gradeType = classifyGradeType(comp);

  if (expected.grade) {
    // User specified a grade → they want graded comps
    if (comp.gradeType !== 'graded') { score -= 20; notes.push('raw-vs-graded'); }
  } else {
    // No grade specified → they want raw comps
    if (comp.gradeType === 'graded')  { score -= 25; notes.push('graded-vs-raw'); }
    if (comp.gradeType === 'proof')   { score -= 25; notes.push('proof-vs-raw'); }
  }

  // ── Set-type scoring ──
  // When the search is for a mint/proof set, reward "set" in title and
  // heavily penalize individual-coin denominations that are NOT sets.
  if (expected.isSet) {
    const hasSetKeyword = /\bset\b/i.test(tLow);
    if (hasSetKeyword) {
      score += 15; notes.push('set-match');
    } else {
      // Title lacks "set" — likely an individual coin, not a set
      score -= 35; notes.push('set-missing');
    }
    // Penalize titles with specific individual-coin denomination words
    // (quarter, dime, nickel, penny, cent, half dollar) that don't also say "set"
    const INDIVIDUAL_COIN_RE = /\b(penny|pennies|cent[s]?|nickel[s]?|dime[s]?|quarter[s]?|half\s*dollar[s]?|dollar\s*coin)\b/i;
    if (INDIVIDUAL_COIN_RE.test(tLow) && !hasSetKeyword) {
      score -= 25; notes.push('individual-coin-in-set-search');
    }
    // Proof vs mint-uncirculated set type discrimination
    if (expected.setType === 'mint-uncirculated') {
      if (/\bproof\b/i.test(tLow) && !/\bmint\b/i.test(tLow)) {
        score -= 20; notes.push('wrong-set-type');
      }
    } else if (expected.setType && expected.setType.includes('proof')) {
      if (/\bmint\s+set\b/i.test(tLow) && !/\bproof\b/i.test(tLow)) {
        score -= 20; notes.push('wrong-set-type');
      }
    }
  }

  // Lunar series: zodiac animal match (5 pts)
  if (expected.zodiacAnimal && tLow.includes(expected.zodiacAnimal.toLowerCase())) {
    score += 5; notes.push('animal-match');
  }

  // Lunar series: "lunar" keyword (3 pts)
  if (expected.isLunarCoin && /\blunar\b/i.test(tLow)) {
    score += 3; notes.push('lunar-match');
  }

  // ── Variant mismatch: gilded / coloured / proof / first strike etc. ──
  // When the query doesn't ask for a specialty variant, penalise comps whose
  // title explicitly advertises one — these carry heavy premiums over BU.
  const VARIANT_TOKENS = ['golden', 'gilded', 'guilded', 'gold plated', 'gold-plated',
    'colorized', 'coloured', 'colorised', 'colour', 'color', 'enameled', 'purple',
    'yellow', 'lilac', 'teal',
    'reverse proof', 'burnished', 'enhanced reverse proof',
    'satin finish', 'first strike', 'first day', 'first release',
    'first releases', 'antiqued', 'high relief', 'piedfort', 'privy',
    'prooflike', 'ruthenium', 'hologram',
    'flag label', 'brown label', 'blue label', 'black label',
    'mercanti', 'moy signed', 'reagan'];
  const queryLower = (expected._rawQuery || '').toLowerCase();
  const labelLower = (expected.label || '').toLowerCase();
  const queryVariantTokens = VARIANT_TOKENS.filter(t => queryLower.includes(t));
  const hasVariantInQuery = queryVariantTokens.length > 0
    || (expected.finish && expected.finish !== 'Uncirculated')
    || !!labelLower;
  if (!hasVariantInQuery) {
    const hasVariantInTitle = VARIANT_TOKENS.some(t => tLow.includes(t));
    if (hasVariantInTitle) {
      score -= 30; notes.push('variant-mismatch');
    }
  } else if (labelLower) {
    // Label specified: reward comps whose title contains the label, penalize those without
    if (tLow.includes(labelLower)) {
      score += 10; notes.push('label-match');
    } else {
      score -= 20; notes.push('label-mismatch');
    }
  } else if (queryVariantTokens.length > 0) {
    // Query asks for a specific variant (e.g. "purple") -- penalize comps that
    // have a DIFFERENT variant token but NOT the one the query wants.
    const titleVariantTokens = VARIANT_TOKENS.filter(t => tLow.includes(t));
    const hasRequestedVariant = queryVariantTokens.some(t => tLow.includes(t));
    if (titleVariantTokens.length > 0 && !hasRequestedVariant) {
      score -= 30; notes.push('variant-wrong-color');
    } else if (hasRequestedVariant) {
      score += 5; notes.push('variant-match');
    }
  }

  // ── Weight / size match for bullion coins (25 pts match, –35 mismatch) ──
  // #266W: Use 5% relative tolerance so coins whose actual metric weight differs
  // slightly from the troy-ounce nominal still match.  Primary case: 2016+ Chinese
  // Silver Pandas (30g = 0.9646 oz vs 1.0 oz nominal = 3.5% off).  Mirrors the
  // comp-filter pattern landed in PR #33.  Without this, correct comps were scored
  // weight-mismatch (-35) instead of weight-match (+25) -- a 60-point swing that
  // could demote them out of the top-K window.
  if (expected.weight) {
    const detectedWeight = detectWeightFromTitle(tLow);
    if (detectedWeight !== null) {
      const wtRatio = Math.abs(detectedWeight - expected.weight) / Math.max(detectedWeight, expected.weight);
      if (wtRatio < 0.05) {
        score += 25; notes.push('weight-match');
      } else {
        score -= 35; notes.push('weight-mismatch');
      }
    } else {
      // No weight stated in title. Penalize: for fractional searches the listing
      // is likely 1 oz; for 1 oz searches it could be a fractional listed vaguely.
      score -= 15; notes.push('weight-not-stated');
    }
  }

  // ── Precious metal content cross-check for fractional bullion ──
  // If melt price per oz is known and comp price far exceeds 1 full oz melt,
  // it's almost certainly a larger coin than the user is searching for.
  if (expected.meltPerOz && expected.weight && expected.weight < 1) {
    if (comp.totalUsd > expected.meltPerOz * 2 && !detectWeightFromTitle(tLow)) {
      score -= 20; notes.push('price-exceeds-melt');
    }
  }

  comp.matchScore = Math.min(100, score);
  comp.matchNotes = notes;

  // Assign human-readable quality label
  if (score >= 85) comp.matchQuality = 'exact';
  else if (score >= 65) comp.matchQuality = 'close';
  else comp.matchQuality = 'loose';

  return comp;
}

/**
 * Bar-specific match scoring.
 * Awards points for brand, size, metal, "bar" keyword, and condition.
 */
function scoreBarMatch(comp, expected) {
  let score = 50; // baseline
  const notes = [];
  const tLow = (comp.title || '').toLowerCase();
  const tNorm = tLow.replace(/\s+/g, '');

  // Brand match (20 pts) / mismatch (-25 pts)
  if (expected.brand) {
    const brandLow = expected.brand.toLowerCase();
    if (tLow.includes(brandLow)) { score += 20; notes.push('brand-match'); }
    else { score -= 25; notes.push('brand-mismatch'); }
  }

  // Size match (15 pts) -- normalize and check alternates for gram sizes
  if (expected.barSize) {
    const sizeNorm = expected.barSize.toLowerCase().replace(/\s+/g, '');
    let sizeMatched = tNorm.includes(sizeNorm);
    // Also check alternate representations: "0.5gram" ↔ ".5gram" ↔ "1/2gram"
    if (!sizeMatched) {
      const gramMatch = expected.barSize.match(/^(\d+(?:\.\d+)?)\s*gram/i);
      if (gramMatch) {
        const grams = parseFloat(gramMatch[1]);
        const alts = [grams + 'g', grams + 'gram'];
        if (grams === 0.5) alts.push('1/2gram', '1/2g', 'halfgram');
        if (grams === 2.5) alts.push('2.5g');
        sizeMatched = alts.some(a => tNorm.includes(a));
      }
    }
    if (sizeMatched) { score += 15; notes.push('size-match'); }
  }

  // Metal match (10 pts)
  if (expected.metal) {
    if (tLow.includes(expected.metal.toLowerCase())) { score += 10; notes.push('metal-match'); }
  }

  // "bar" keyword (5 pts)
  if (/\bbar\b/i.test(tLow)) { score += 5; notes.push('bar-keyword'); }

  // Condition indicator — sealed / assay (5 pts)
  if (expected.condition === 'sealed') {
    if (/sealed|assay/i.test(tLow)) { score += 5; notes.push('sealed-match'); }
  }

  // Year match (5 pts)
  if (expected.barYear && tLow.includes(String(expected.barYear))) {
    score += 5; notes.push('year-match');
  }

  // Lunar series keyword (5 pts)
  if (expected.isLunar) {
    if (/\blunar\b/i.test(tLow)) { score += 5; notes.push('lunar-match'); }
  }

  // Bar series match (10 pts) / mismatch (-15 pts)
  if (expected.barSeriesRe) {
    if (expected.barSeriesRe.test(tLow)) { score += 10; notes.push('bar-series-match'); }
    else { score -= 15; notes.push('bar-series-mismatch'); }
  }

  // Zodiac animal match (5 pts) -- Lunar series
  if (expected.zodiacAnimal && tLow.includes(expected.zodiacAnimal.toLowerCase())) {
    score += 5; notes.push('animal-match');
  }

  // Bars are never graded — always tag as raw
  comp.gradeType = 'raw';

  // Perth Lunar series number match (5 pts)
  if (expected.perthSeriesNum) {
    const snRe = new RegExp('series\\s*' + expected.perthSeriesNum + '\\b', 'i');
    if (snRe.test(tLow)) { score += 5; notes.push('series-num-match'); }
  }

  comp.matchScore = Math.min(100, score);
  comp.matchNotes = notes;

  if (score >= 85) comp.matchQuality = 'exact';
  else if (score >= 65) comp.matchQuality = 'close';
  else comp.matchQuality = 'loose';

  return comp;
}

// ── Deduplication ───────────────────────────────────────────
function dedup(comps) {
  const seen = new Set();
  const result = [];
  for (const c of comps) {
    // By itemId
    if (c.itemId && seen.has(c.itemId)) continue;
    if (c.itemId) seen.add(c.itemId);
    // By normalized title + price (within $1 tolerance)
    const key = (c.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80) + '|' + Math.round(c.totalUsd || 0);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return result;
}

// ── Apply filters ───────────────────────────────────────────
function applyFilters(comps, options, expected) {
  const removed = { denied: 0, nonUsd: 0, pcgsOnly: 0, gradeOnly: 0, outlier: 0 };

  // Minimum relevance gate: discard comps that scored very low in scoreMatch.
  // A score below 20 means almost nothing matched (year, series, weight, metal all wrong).
  // For set searches, use a higher gate (30) since set-specific penalties push
  // individual coins and wrong set types well below baseline.
  // For bar searches with a brand specified, use 45 to exclude wrong-brand comps.
  // This prevents completely irrelevant items (e.g. electronics, clothing) from appearing.
  const relevanceGate = (expected.type === 'bar' && expected.brand) ? 45
    : expected.isSet ? 30
    : 20;
  removed.lowRelevance = 0;
  let kept = comps.filter(c => {
    if (c.matchScore != null && c.matchScore < relevanceGate) { removed.lowRelevance++; return false; }
    return true;
  });

  // Deny-list (context-aware for roll searches)
  const isRollSearch = !!expected.isRoll;
  kept = kept.filter(c => {
    if (isDenied(c.title, { allowRoll: isRollSearch })) { removed.denied++; return false; }
    return true;
  });

  // Non-bullion denomination filter: when searching for a bullion series,
  // drop listings that are circulating denomination coins (centavos, pesos, etc.)
  // which share keywords like "libertad" but are not bullion.
  if (expected.weight) {
    removed.nonBullionDenom = 0;
    kept = kept.filter(c => {
      const t = c.title || '';
      if (BULLION_DENY_DENOM_RE.test(t) && !BULLION_OK_RE.test(t)) {
        removed.nonBullionDenom++;
        return false;
      }
      return true;
    });
  }

  // Set-match filter: when searching for a mint/proof set, keep ONLY listings
  // that contain "set" in the title. Individual coins, accessories, and other
  // non-set items are almost never what the user wants.
  if (expected.isSet) {
    removed.notSet = 0;
    kept = kept.filter(c => {
      if (!/\bset\b/i.test(c.title)) { removed.notSet++; return false; }
      return true;
    });
  }

  // Roll/tube-match filter: when searching for rolls, keep ONLY roll/tube listings;
  // when NOT searching for rolls the deny-list already blocks them.
  if (isRollSearch) {
    removed.notRoll = 0;
    kept = kept.filter(c => {
      if (!ROLL_PATTERN.test(c.title)) { removed.notRoll++; return false; }
      return true;
    });
  }

  // Proof-match filter: when searching for a proof coin, keep ONLY listings
  // that contain "proof" in the title. BU/uncirculated comps should not be
  // blended into proof pricing — they are fundamentally different products.
  if (expected.isProof) {
    removed.notProof = 0;
    kept = kept.filter(c => {
      if (!/\bproof\b/i.test(c.title)) { removed.notProof++; return false; }
      return true;
    });
  }

  // Bar brand-match filter: when searching for a bar with a brand specified
  // (e.g. "Perth Mint"), keep ONLY listings whose title contains every token
  // of the brand. eBay's Brand aspect filter is unreliable because sellers
  // don't consistently tag listings, so wrong-brand bars (Geiger, PAMP,
  // New Zealand Mint Star Wars, etc.) slip through the keyword search and
  // the -25 score penalty alone isn't enough to gate them out.
  if (expected.type === 'bar' && expected.brand) {
    const tokens = String(expected.brand)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (tokens.length) {
      const tokenRes = tokens.map(t => new RegExp(`\\b${t}\\b`, 'i'));
      removed.wrongBrand = 0;
      kept = kept.filter(c => {
        const t = c.title || '';
        for (const re of tokenRes) {
          if (!re.test(t)) { removed.wrongBrand++; return false; }
        }
        return true;
      });
    }
  }

  // Exclusion-term filter: when the query contains eBay-style exclusion
  // operators (e.g. "-proof", "-gold"), remove comps whose title contains
  // the excluded word. This honors the user's intent to exclude specific
  // product types from their results.
  if (expected._exclusions && expected._exclusions.length) {
    removed.excluded = 0;
    kept = kept.filter(c => {
      const tLow = c.title.toLowerCase();
      for (const ex of expected._exclusions) {
        if (tLow.includes(ex)) { removed.excluded++; return false; }
      }
      return true;
    });
  }

  // USD only for stats
  kept = kept.filter(c => {
    if (c.totalUsd === null) { removed.nonUsd++; return false; }
    return true;
  });

  // Metal-mismatch filter: drop comps whose detected metal contradicts expected.
  // #178: Re-detect metal from title to handle stale _detectedMetal values
  // from comps imported before the mixed-metal disambiguation fix.
  if (expected.metal) {
    const wantMetal = expected.metal.toLowerCase();
    removed.metalMismatch = 0;
    kept = kept.filter(c => {
      const compMetal = detectMetalFromTitle(c.title) ?? c._detectedMetal;
      // If comp has no detected metal, keep it (benefit of the doubt)
      if (!compMetal) return true;
      if (compMetal !== wantMetal) { removed.metalMismatch++; return false; }
      // Secondary check: catch "gold plated silver" or "silver with gold" where
      // detectMetalFromTitle picks the wrong metal from ambiguous titles.
      // If searching for gold but title has strong silver indicators, reject.
      // If searching for silver but title has strong gold indicators, reject.
      const t = (c.title || '').toLowerCase();
      if (wantMetal === 'gold' && /\.999\s*silver|\bsilver\s+(coin|panda|eagle|bullion)\b|\b\d+\s*yuan\b.*silver/i.test(t)) {
        removed.metalMismatch++; return false;
      }
      if (wantMetal === 'silver' && /\.999\s*gold|\bgold\s+(coin|panda|eagle|bullion)\b|\b\d+\s*yuan\b.*\bgold\b/i.test(t)) {
        removed.metalMismatch++; return false;
      }
      return true;
    });
  }

  // Silver/clad composition mismatch: drop comps from the wrong era.
  // e.g. a 1978-D Washington Quarter is CLAD — reject comps with "silver"/"90%"
  // in the title, and vice versa for silver-era coins with "clad" comps.
  {
    removed.compositionMismatch = 0;
    kept = kept.filter(c => {
      if (isCompositionMismatch(c.title, expected)) {
        removed.compositionMismatch++;
        return false;
      }
      return true;
    });
  }

  // Weight-mismatch hard filter: remove comps whose title explicitly states a
  // different weight than what the user searched for (e.g. "1 oz" in results
  // when user wants "1/4 oz").
  if (expected.weight) {
    removed.weightMismatch = 0;
    kept = kept.filter(c => {
      const detW = detectWeightFromTitle(c.title);
      if (detW === null) return true; // no weight stated — benefit of doubt
      const wtRatio = Math.abs(detW - expected.weight) / Math.max(detW, expected.weight);
      if (wtRatio < 0.05) return true; // within 5% relative tolerance (handles 30g≈1oz)
      removed.weightMismatch++;
      return false;
    });
  }

  // Precious metal content sanity check: for fractional bullion coins,
  // if no weight is detected in the title and the price is well above
  // 1 full troy oz of melt, the listing is almost certainly a larger coin.
  if (expected.meltPerOz && expected.weight && expected.weight < 1) {
    removed.meltSanity = 0;
    // Threshold: 1.8× the spot melt of a full oz — generous enough to keep
    // high-premium fractionals but catches obvious 1-oz-priced comps.
    const meltCeiling = expected.meltPerOz * 1.8;
    kept = kept.filter(c => {
      const detW = detectWeightFromTitle(c.title);
      if (detW !== null) return true; // already handled by weight-mismatch filter
      if (c.totalUsd > meltCeiling) {
        removed.meltSanity++;
        return false;
      }
      return true;
    });
  }

  // Year-mismatch hard filter: drop comps whose title explicitly states
  // only a different year than the expected year. A listing titled
  // "2005 Perth Lunar Rooster" should NOT appear for a 2017 search.
  // #165: For generic datasets (no year in dataset name), relax tolerance.
  // Bullion generic datasets intentionally span all years -- value is driven
  // by metal content, not mintage year, so year filtering is counter-productive.
  if (expected.year) {
    const skipYearFilter = expected._fromGenericDataset && !!expected.weight;
    if (!skipYearFilter) {
      removed.yearMismatch = 0;
      let yearTolerance;
      if (expected._fromGenericDataset) {
        // Non-bullion generic dataset: wider tolerance (±3 years)
        yearTolerance = 3;
      } else {
        // Year-specific dataset: strict — bullion exact, numismatic ±1
        yearTolerance = expected.weight ? 0 : 1;
      }
      kept = kept.filter(c => {
        const tLow = (c.title || '').toLowerCase();
        const yearsInTitle = [...tLow.matchAll(/\b(1[7-9]\d{2}|20[0-4]\d)\b/g)].map(m => parseInt(m[1], 10));
        if (yearsInTitle.length === 0) return true; // no year in title — keep
        if (yearsInTitle.includes(expected.year)) return true; // contains expected year — keep
        // Check if any title year is within tolerance
        if (yearsInTitle.some(y => Math.abs(y - expected.year) <= yearTolerance)) return true;
        // Title has year(s) but all are outside tolerance — drop
        removed.yearMismatch++;
        return false;
      });
    }
  }

  // Melt-floor sanity check for bullion: if the price is well below expected
  // melt for the searched weight, the listing is almost certainly a different
  // metal or a smaller/fractional coin that slipped through weight-mismatch.
  // Uses historical spot price at time of sale when available, so older comps
  // aren't falsely rejected due to recent spot price increases.
  if (expected.meltPerOz && expected.weight && expected.weight >= 1) {
    removed.meltFloor = 0;
    // Resolve metal symbol for historical lookup
    const metalSym = expected.metal ? METAL_SYMBOLS[expected.metal] : null;
    kept = kept.filter(c => {
      // Determine the appropriate spot price for this comp's sale date
      let spotForComp = expected.meltPerOz; // default: today's spot
      if (metalSym && c.soldDate) {
        const historicalSpot = getSpotOnDate(metalSym, c.soldDate);
        if (historicalSpot) spotForComp = historicalSpot;
      }
      // Floor: 40% of melt at time of sale — generous enough for damaged/junk
      // bullion but catches e.g. silver coins in a gold search or fractional pieces.
      const meltFloor = spotForComp * expected.weight * 0.40;
      if (c.totalUsd < meltFloor) {
        removed.meltFloor++;
        return false;
      }
      return true;
    });
  }

  // Variant-mismatch hard filter: remove comps with specialty variant tokens
  // (golden, coloured, gilded, etc.) when the query didn't ask for them.
  // These carry heavy premiums that distort FMV for regular BU coins.
  {
    const VARIANT_TOKENS = ['golden', 'gilded', 'guilded', 'gold plated', 'gold-plated',
      'colorized', 'coloured', 'colorised', 'color', 'enameled', 'purple',
      'yellow', 'lilac', 'teal',
      'reverse proof', 'burnished', 'enhanced reverse proof',
      'satin finish', 'antiqued', 'high relief', 'piedfort', 'privy',
      'prooflike', 'ruthenium', 'hologram',
      'flag label', 'brown label', 'blue label', 'black label',
      'mercanti', 'moy signed', 'reagan'];
    const qLow = (expected._rawQuery || '').toLowerCase();
    const labelLow = (expected.label || '').toLowerCase();
    const queryVariantTokensHF = VARIANT_TOKENS.filter(t => qLow.includes(t));
    const queryWantsVariant = queryVariantTokensHF.length > 0
      || (expected.finish && expected.finish !== 'Uncirculated')
      || !!labelLow;
    if (!queryWantsVariant) {
      removed.variantMismatch = 0;
      kept = kept.filter(c => {
        const tLow = (c.title || '').toLowerCase();
        const hasVariant = VARIANT_TOKENS.some(t => tLow.includes(t));
        if (hasVariant) { removed.variantMismatch++; return false; }
        return true;
      });
    } else if (queryVariantTokensHF.length > 0) {
      // Query asks for a specific variant -- keep comps that either:
      // (a) match the requested variant, or (b) are plain BU (no variant tokens).
      // Reject comps with a DIFFERENT variant.
      removed.variantWrongColor = 0;
      kept = kept.filter(c => {
        const tLow = (c.title || '').toLowerCase();
        const titleHasAnyVariant = VARIANT_TOKENS.some(t => tLow.includes(t));
        if (!titleHasAnyVariant) return true; // plain BU -- keep
        const matchesRequested = queryVariantTokensHF.some(t => tLow.includes(t));
        if (matchesRequested) return true; // matches the requested variant
        removed.variantWrongColor++;
        return false;
      });
    }
  }

  // Type 1 / Type 2 design variant hard filter (#180): when user specifies a Type,
  // remove comps that explicitly state the OTHER type. This is critical for the
  // 2021 ASE/AGE transition year where both designs coexist.
  if (expected.label === 'Type 1' || expected.label === 'Type 2') {
    const wantType = expected.label; // "Type 1" or "Type 2"
    const rejectType = wantType === 'Type 1' ? /\btype\s*2\b/i : /\btype\s*1\b/i;
    removed.typeMismatch = 0;
    kept = kept.filter(c => {
      if (rejectType.test(c.title || '')) { removed.typeMismatch++; return false; }
      return true;
    });
  }

  // Mint-mark mismatch filter: drop comps whose title explicitly states
  // a different mint mark than expected (e.g. user wants 1892-S but title says 1892-O)
  // Uses matchAll to detect ALL year-mint patterns (including over-mintmark "O/S" varieties).
  if (expected.mint) {
    const wantMint = expected.mint.toUpperCase();
    const MINT_CITY_MAP = { 'carson city': 'CC', 'denver': 'D', 'philadelphia': 'P', 'san francisco': 'S', 'west point': 'W' };
    removed.mintMismatch = 0;
    kept = kept.filter(c => {
      const tLow = (c.title || '').toLowerCase();
      // Collect ALL mint marks mentioned in the title (not just the first)
      const mintRe = /\b\d{4}\s*[-]?\s*(CC|[SDPWO])\b/gi;
      const titleMints = new Set();
      for (const m of tLow.matchAll(mintRe)) {
        titleMints.add(m[1].toUpperCase());
      }
      // Detect over-mintmark varieties: "O/S", "O over S", "O/S Strong"
      const overMintRe = /\b\d{4}\s*[-]?\s*([SDPWO])\s*(?:\/|over)\s*([SDPWO])\b/gi;
      for (const m of tLow.matchAll(overMintRe)) {
        titleMints.add(m[1].toUpperCase());
        titleMints.add(m[2].toUpperCase());
      }
      // Also recognise mint city names as mint marks
      if (titleMints.size === 0) {
        for (const [city, mark] of Object.entries(MINT_CITY_MAP)) {
          if (tLow.includes(city)) { titleMints.add(mark); break; }
        }
      }
      // Standalone "CC" anywhere in title (unique two-letter mark)
      if (titleMints.size === 0 && /\bCC\b/.test(c.title || '')) {
        titleMints.add('CC');
      }
      if (titleMints.size === 0) return true; // no mint stated → benefit of the doubt
      if (titleMints.has(wantMint)) return true;
      removed.mintMismatch++;
      return false;
    });
  }

  // Denomination mismatch hard filter: if the searched coin is a "quarter",
  // drop comps whose title explicitly indicates a different denomination
  // (e.g. a commemorative dollar, a dime, a half dollar).
  {
    const wantDenom = detectDenomination(
      expected.series || expected._rawQuery || ''
    );
    if (wantDenom) {
      removed.denomMismatch = 0;
      kept = kept.filter(c => {
        const compDenom = detectDenomination(c.title);
        if (!compDenom) return true; // no denomination detected → keep
        if (compDenom === wantDenom) return true;
        removed.denomMismatch++;
        return false;
      });
    }
  }

  // Series conflict hard filter: drop comps from a mutually-exclusive series
  // (e.g. Buffalo Nickels when the user searched for Jefferson Nickels).
  if (expected.series) {
    removed.seriesConflict = 0;
    kept = kept.filter(c => {
      if (hasSeriesConflict(expected.series, c.title)) {
        removed.seriesConflict++;
        return false;
      }
      return true;
    });
  }

  // Grade-number mismatch hard filter: when the user searches for a specific
  // numeric grade (e.g. MS65), drop comps whose title explicitly states a
  // different grade number (e.g. MS63, MS64).  The price difference between
  // adjacent Mint State grades can be 2-5x for key dates.
  if (expected.grade) {
    const wantGradeNum = parseInt((expected.grade.match(/\d+/) || [])[0], 10);
    if (wantGradeNum) {
      const GRADE_RE = /\b(ms|pr|pf|sp|au|xf|ef|vf|vg|ag|fr|po)\s*[-]?\s*(\d{1,2})\b/gi;
      removed.gradeNumMismatch = 0;
      kept = kept.filter(c => {
        const tLow = (c.title || '').toLowerCase();
        const grades = [...tLow.matchAll(GRADE_RE)].map(m => parseInt(m[2], 10));
        if (grades.length === 0) return true; // no grade stated → benefit of the doubt
        // Keep if any grade in the title matches the expected grade
        if (grades.includes(wantGradeNum)) return true;
        removed.gradeNumMismatch++;
        return false;
      });
    }
  }

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

  return { kept, removed, gathered: comps.length };
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
    allItems = allItems.concat(items.map(normalizeItem).map(classifyFindingItem));
    if (items.length < PER_PAGE) break;
  }
  return allItems;
}

// ── MAIN: fetchSoldComps ────────────────────────────────────
/**
 * Fetch eBay comps. Priority chain:
 *   1) Marketplace Insights API (sold data, OAuth, separate rate limit)
 *   2) Finding API (sold data, AppID auth)
 *   2b) Auto-extend: if too few sold comps, widen lookback (90→180→365)
 *   3) Browse API (active listings — last resort)
 *
 * Within each, tiered: US first, global second.
 *
 * Returns an extra `lookback` object: { requested, used, extended }
 */
async function fetchSoldComps(keywords, options = {}, expected = {}) {
  // Ensure _rawQuery is available for variant filtering
  if (!expected._rawQuery) expected._rawQuery = keywords;

  // Auto-detect metal from the raw query / keywords when not explicitly provided.
  // This prevents gold Terapeak datasets from matching a silver search when the
  // caller (e.g. marketAggregator) doesn't set expected.metal.
  if (!expected.metal && expected._rawQuery) {
    expected.metal = detectMetalFromTitle(expected._rawQuery) || null;
  }

  // Auto-detect Brand for eBay aspect filtering when not explicitly set.
  // This ensures Browse/Insights API calls only return items from the correct mint.
  if (!expected._brandFilter) {
    const bq = (expected._rawQuery || keywords || '').toLowerCase();
    if (/\bperth\b/i.test(bq) || /\baustralian?\b.*\blunar\b/i.test(bq))       expected._brandFilter = 'Perth Mint';
    else if (/\broyal\s*mint\b/i.test(bq) || /\bbritish\b.*\blunar\b/i.test(bq)) expected._brandFilter = 'The Royal Mint';
    else if (/\broyal\s*canadian\b|\brcm\b/i.test(bq))                            expected._brandFilter = 'Royal Canadian Mint';
    else if (/\bchinese\b.*\b(?:panda|lunar)\b/i.test(bq))                        expected._brandFilter = 'China Mint';
    else if (/\baustrian\b|\bphilharmonic\b/i.test(bq))                           expected._brandFilter = 'Austrian Mint';
    else if (/\bmexi|\blibertad\b/i.test(bq))                                     expected._brandFilter = 'Casa de Moneda de Mexico';
  }

  const opts = {
    timeWindowDays: options.timeWindowDays || 180,
    requirePCGSOnly: !!options.requirePCGSOnly,
    exactGradeOnly: !!options.exactGradeOnly,
    usMinComps: options.usMinComps || US_MIN_COMPS,
    maxPages: options.maxPages || 3
  };

  const requestedDays = opts.timeWindowDays;

  if (!EBAY_APP_ID) {
    const emptyTier = { stats: null, comps: [], removed: {}, error: { message: 'eBay credentials not configured' } };
    return { keywords, us: emptyTier, global: emptyTier, usedFallback: false, apiUsed: 'none',
             lookback: { requested: requestedDays, used: requestedDays, extended: false } };
  }

  const cacheKey = `ebay:${keywords}:${expected.metal || ''}:${expected._rawQuery || ''}:${JSON.stringify(opts)}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let usResult, globalResult;
  let apiUsed = 'none';
  let usedFallback = false;
  let actualDays = requestedDays;
  // #244: pre-filter telemetry shared across all downstream usResult rebuilds.
  // Populated inside the Terapeak block; merged into every later usResult so
  // partial-seed paths (Finding/Browse supplement) do not silently drop it.
  let preFilterRemoved = {};

  // ── Attempt 0: Terapeak imported sold data (highest priority — real sold comps) ──
  const tpOpts = { metal: expected.metal || null, grade: expected.grade || null };
  let terapeakData = terapeakService.lookupComps(keywords, tpOpts);

  // Also try the raw user query for Terapeak when keywords differ significantly.
  // Keywords are built from parsed fields and may lose critical tokens
  // (e.g. "2023 reverse proof Morgan and ASE 2 coin set" → keywords "2023 Morgan Reverse Proof"
  //  drops "ASE", "set" — the raw query may match a multi-coin set dataset better).
  if (expected._rawQuery) {
    const rawNorm = expected._rawQuery.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const kwNorm  = keywords.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (rawNorm !== kwNorm) {
      const rawData = terapeakService.lookupComps(expected._rawQuery, tpOpts);
      if (rawData && rawData.comps && rawData.comps.length > 0) {
        if (!terapeakData || !terapeakData.comps || terapeakData.comps.length === 0) {
          terapeakData = rawData;
        } else {
          // Both matched different datasets — pick the better one.
          // Prefer raw-query result when:
          //  1. User's query mentions "set" and only raw matched a set dataset
          //  2. Raw-query matched a dataset with MORE comps (closer match to user intent)
          const queryHasSet = /\bset\b/i.test(expected._rawQuery);
          const rawIsSet = /\bset\b/i.test(rawData.searchTerm || '');
          const kwIsSet  = /\bset\b/i.test(terapeakData.searchTerm || '');
          const rawMatchedDifferent = (rawData.searchTerm || '') !== (terapeakData.searchTerm || '');
          if (queryHasSet && rawIsSet && !kwIsSet) {
            terapeakData = rawData;
          } else if (rawMatchedDifferent && rawData.comps.length > terapeakData.comps.length) {
            terapeakData = rawData;
          }
        }
      }
    }
  }

  if (terapeakData && terapeakData.comps && terapeakData.comps.length > 0) {
    let tpComps = terapeakData.comps;

    // #244: pre-filter telemetry. Drops upstream of applyFilters() must report
    // a non-zero bucket so 98%+ attrition can be attributed. Keys are merged
    // into the final `removed` object so existing consumers (pricing-health,
    // freshness diagnostics) see them without code changes. Key names are
    // intentionally provenance-neutral (no 'terapeak' prefix) because the
    // `removed` object is returned to non-admin callers via /api/price
    // (see redactForPublic.js + BACKLOG #243).
    preFilterRemoved = {
      prefilterPoolSize: tpComps.length,
      prefilterStrikeSplit: 0,
      prefilterTimeWindow: 0
    };

    // ── Strike & grade-type pool split: use only the matching pool ──
    // Split by user intent in this order:
    //  1) Strike type (proof vs reverse-proof vs non-proof), then
    //  2) Certification (graded vs raw)
    // This avoids dropping proof comps when the user asked for proof but did
    // not specify a slab grade.
    // Always re-classify: stored gradeType may be stale (pre-proof-split imports).
    //
    // PR #3: When the user picked Finish = "Reverse Proof" or "Enhanced
    // Reverse Proof", target the dedicated 'reverse-proof' pool so RP comps
    // are not mixed with regular Proof comps (and vice versa). Measurement
    // showed 97--100% cross-contamination on years where both issues exist
    // (e.g. 2023 ASE, 2019-S ASE ERP, 2023-S Morgan Dollar).
    const wantsProof = !!expected.isProof;
    const wantsReverseProof = wantsProof && isReverseProofFinish(expected.finish);
    const wantsGraded = !!expected.grade;
    const targetPool = wantsReverseProof
      ? 'reverse-proof'
      : (wantsProof ? 'proof' : (wantsGraded ? 'graded' : 'raw'));
    const beforeSplit = tpComps.length;
    tpComps = tpComps.filter(c => {
      const gt = classifyGradeType(c);
      c.gradeType = gt; // update stored value for downstream consumers
      return gt === targetPool;
    });
    preFilterRemoved.prefilterStrikeSplit = beforeSplit - tpComps.length;
    if (tpComps.length !== beforeSplit) {
      console.log(`[ebay] Terapeak grade-split: ${beforeSplit} → ${tpComps.length} (${targetPool} only)`);
    }

    // Filter by time window if soldDate available
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - requestedDays);
    const withinWindow = tpComps.filter(c => {
      if (!c.soldDate) return true; // keep comps without dates
      return new Date(c.soldDate) >= cutoff;
    });
    // Use windowed comps if enough, otherwise use all terapeak comps
    const pool = withinWindow.length >= opts.usMinComps ? withinWindow : tpComps;
    // Only attribute the time-window drop when the window result is actually
    // used as the pool (fallback path keeps stale comps and reports 0 here).
    if (pool === withinWindow) {
      preFilterRemoved.prefilterTimeWindow = tpComps.length - withinWindow.length;
    }

    // #165: Detect if comps came from a generic (non-year-specific) dataset.
    // Generic datasets intentionally span multiple years; applying strict
    // yearMismatch filtering kills most of their value.
    const dsName = (terapeakData.searchTerm || '').toLowerCase();
    const isGenericDataset = expected.year && !dsName.includes(String(expected.year));
    if (isGenericDataset) expected._fromGenericDataset = true;

    // Apply scoring and filters
    const scored = pool.map(c => scoreMatch(c, expected));
    const { kept, removed: filterRemoved } = applyFilters(scored, opts, expected);
    const prices = kept.map(c => c.totalUsd);

    // Merge pre-filter buckets so callers see the full attrition picture.
    const removed = { ...preFilterRemoved, ...filterRemoved };

    // #244 safety net: catch any future silent drop -- including PARTIAL
    // attribution gaps where some drops are reported but most are not. A
    // small tolerance absorbs boundary effects (e.g. dedup, score-eq-cap).
    const droppedTotal = preFilterRemoved.prefilterPoolSize - kept.length;
    if (droppedTotal > 0) {
      const reportedTotal = Object.entries(removed)
        .filter(([k]) => k !== 'prefilterPoolSize')
        .reduce((s, [, v]) => s + (typeof v === 'number' ? v : 0), 0);
      const tolerance = 2;
      if (reportedTotal + tolerance < droppedTotal) {
        console.warn(`[telemetry-leak] dropped ${droppedTotal} terapeak comps for "${terapeakData.searchTerm}" but only ${reportedTotal} attributed (#244)`);
      }
    }

    // Clean up transient flag
    delete expected._fromGenericDataset;

    if (kept.length >= opts.usMinComps) {
      usResult = { stats: stats.summarize(prices), comps: kept, removed, error: null };
      apiUsed = 'terapeak';
      console.log(`[ebay] Terapeak sold data: ${kept.length} comps (from "${terapeakData.searchTerm}", imported ${terapeakData.lastImport})`);

      // Still no global — leave empty
      globalResult = { stats: null, comps: [], removed: {}, error: null };

      const lookback = { requested: requestedDays, used: requestedDays, extended: false };
      const result = { keywords, us: usResult, global: globalResult, usedFallback: false, apiUsed, lookback };
      cache.set(cacheKey, result);
      return result;
    } else if (kept.length > 0) {
      // Some terapeak comps but not enough — seed usResult, continue to APIs for more
      usResult = { stats: stats.summarize(prices), comps: kept, removed, error: null };
      apiUsed = 'terapeak';
      console.log(`[ebay] Terapeak partial: ${kept.length} comps (need ${opts.usMinComps}), supplementing with APIs…`);
    }
  }

  // Build the lookback tiers: start with requested, then widen up to 365
  const lookbackTiers = [requestedDays];
  if (requestedDays < 180) lookbackTiers.push(180);
  if (requestedDays < 365) lookbackTiers.push(365);
  // Deduplicate in case requested was already 180 or 365
  const uniqueTiers = [...new Set(lookbackTiers)];

  for (const tierDays of uniqueTiers) {
    actualDays = tierDays;

    // ── Attempt 1: Marketplace Insights API — DISABLED ──
    // We do not have access to Marketplace Insights API.
    // Uncomment when/if access is restored.
    /*
    if (!circuitTripped('insights')) {
      try {
        const insightComps = await insightsSearch(keywords, tierDays, PER_PAGE * opts.maxPages, expected._brandFilter || null);
        if (insightComps.length > 0) {
          apiUsed = 'marketplace-insights';
          const deduped = dedup(insightComps);
          const scored = deduped.map(c => scoreMatch(c, expected));
          const { kept, removed } = applyFilters(scored, opts, expected);
          const prices = kept.map(c => c.totalUsd);
          usResult = { stats: stats.summarize(prices), comps: kept, removed, error: null };
          console.log(`[ebay] Marketplace Insights (${tierDays}d): ${kept.length} US comps`);
        }
      } catch (err) {
        console.warn(`[ebay] Marketplace Insights unavailable: ${err.response?.status || err.message}`);
        tripCircuit('insights');
      }
    }
    */

    // ── Attempt 2: Finding API ──
    // US tier: only if we don't have enough sold comps yet
    // Gated behind EBAY_FINDING_ENABLED (default: false) — API has been unreliable since Feb 2025 deprecation.
    if (FINDING_ENABLED && (!usResult || usResult.comps.length < opts.usMinComps) && !circuitTripped('finding')) {
      try {
        const rawUS = await fetchFindingTier(keywords, tierDays, opts.maxPages, 'US');

        // ── Auto-seed: save raw Finding API results to Terapeak store ──
        // This accumulates real sold data over time so future lookups hit
        // the local store first, reducing API calls and building history.
        if (rawUS.length > 0) {
          try {
            const seedComps = rawUS.map(c => ({ ...c, _source: 'finding-auto', matchNotes: [...(c.matchNotes || []), 'finding-auto-seed'] }));
            const seedResult = terapeakService.importComps(keywords, seedComps, { source: 'finding-auto', lastSeedDate: new Date().toISOString() });
            if (seedResult.newComps > 0) {
              console.log(`[ebay] Auto-seed: saved ${seedResult.newComps} new comps for "${keywords}" (${seedResult.totalStored} total)`);
            }
          } catch (seedErr) {
            console.warn(`[ebay] Auto-seed failed (non-fatal): ${seedErr.message}`);
          }
        }

        const dedupedUS = dedup(rawUS);
        const scoredUS = dedupedUS.map(c => scoreMatch(c, expected));
        // #168: API-fetched comps are keyword-searched (inherently multi-year),
        // similar to generic Terapeak datasets. Relax year filter for bullion.
        if (expected.weight) expected._fromGenericDataset = true;
        const filterUS = applyFilters(scoredUS, opts, expected);
        delete expected._fromGenericDataset;

        // Merge with any Insights comps
        const mergedUS = usResult ? dedup([...usResult.comps, ...filterUS.kept]) : filterUS.kept;
        const mergedPrices = mergedUS.map(c => c.totalUsd);

        usResult = { stats: stats.summarize(mergedPrices), comps: mergedUS, removed: { ...preFilterRemoved, ...filterUS.removed }, error: null };
        apiUsed = apiUsed === 'marketplace-insights' ? 'insights+finding' : 'finding';
        console.log(`[ebay] Finding API US (${tierDays}d): ${mergedUS.length} comps`);
      } catch (err) {
        console.warn(`[ebay] Finding API US unavailable: ${err.response?.status || err.message}`);
        // When Finding API fails and keywords contain proof/finish terms,
        // retry with those terms stripped.  eBay's Finding API sometimes
        // returns 500 for "Proof" in the query while returning valid results
        // without it.  applyFilters will remove non-proof comps.
        // Also strip country/mint names that can trigger eBay 500 errors.
        const proofTermRe = /\b(Proof|Reverse Proof|Enhanced Reverse Proof|Burnished|Satin Finish|Antiqued)\b/i;
        const countryRe = /\b(Mexico|Mexican|Canada|Canadian|Australia|Australian|Austria|Austrian|Great Britain|British|China|Chinese|Perth Mint|Perth|Royal Mint|Royal Canadian)\b/gi;
        const hasStrippable = proofTermRe.test(keywords) || countryRe.test(keywords);
        if (hasStrippable) {
          const strippedKw = keywords.replace(proofTermRe, '').replace(countryRe, '').replace(/\s{2,}/g, ' ').trim();
          try {
            console.log(`[ebay] Retrying Finding API with simplified keywords: "${strippedKw}"`);
            const rawRetry = await fetchFindingTier(strippedKw, tierDays, opts.maxPages, 'US');

            // Auto-seed retry results too (use original keywords as store key)
            if (rawRetry.length > 0) {
              try {
                const seedComps = rawRetry.map(c => ({ ...c, _source: 'finding-auto', matchNotes: [...(c.matchNotes || []), 'finding-auto-seed'] }));
                const seedResult = terapeakService.importComps(keywords, seedComps, { source: 'finding-auto', lastSeedDate: new Date().toISOString() });
                if (seedResult.newComps > 0) {
                  console.log(`[ebay] Auto-seed (retry): saved ${seedResult.newComps} new comps for "${keywords}"`);
                }
              } catch (seedErr) {
                console.warn(`[ebay] Auto-seed (retry) failed (non-fatal): ${seedErr.message}`);
              }
            }

            const dedupedRetry = dedup(rawRetry);
            const scoredRetry = dedupedRetry.map(c => scoreMatch(c, expected));
            if (expected.weight) expected._fromGenericDataset = true;
            const filterRetry = applyFilters(scoredRetry, opts, expected);
            delete expected._fromGenericDataset;
            const mergedRetry = usResult ? dedup([...usResult.comps, ...filterRetry.kept]) : filterRetry.kept;
            const mergedPrices = mergedRetry.map(c => c.totalUsd);
            usResult = { stats: stats.summarize(mergedPrices), comps: mergedRetry, removed: { ...preFilterRemoved, ...filterRetry.removed }, error: null };
            apiUsed = 'finding';
            console.log(`[ebay] Finding API retry US (${tierDays}d): ${mergedRetry.length} comps (simplified keywords)`);
          } catch (retryErr) {
            console.warn(`[ebay] Finding API retry also failed: ${retryErr.response?.status || retryErr.message}`);
            tripCircuit('finding');
            if (!usResult) usResult = { stats: null, comps: [], removed: {}, error: { message: err.message } };
          }
        } else {
          tripCircuit('finding');
          if (!usResult) usResult = { stats: null, comps: [], removed: {}, error: { message: err.message } };
        }
      }
    }

    // Check if we have enough sold comps — if yes, stop widening
    const soldCount = (usResult?.comps || []).filter(c => c._source !== 'browse').length;
    if (soldCount >= opts.usMinComps) {
      if (tierDays > requestedDays) {
        console.log(`[ebay] Auto-extended lookback ${requestedDays}d → ${tierDays}d to get ${soldCount} sold comps`);
      }
      break;
    }

    if (tierDays < uniqueTiers[uniqueTiers.length - 1]) {
      console.log(`[ebay] Only ${soldCount} sold comps at ${tierDays}d, extending lookback…`);
    }
  }

  // Global tier: always attempt so global is independent from US
  if (FINDING_ENABLED && !globalResult && !circuitTripped('finding')) {
    try {
      const rawGlobal = await fetchFindingTier(keywords, actualDays, opts.maxPages, null);

      // Auto-seed global results too (broader pool of real sold data)
      if (rawGlobal.length > 0) {
        try {
          const seedComps = rawGlobal.map(c => ({ ...c, _source: 'finding-auto', matchNotes: [...(c.matchNotes || []), 'finding-auto-seed'] }));
          const seedResult = terapeakService.importComps(keywords, seedComps, { source: 'finding-auto', lastSeedDate: new Date().toISOString() });
          if (seedResult.newComps > 0) {
            console.log(`[ebay] Auto-seed (global): saved ${seedResult.newComps} new comps for "${keywords}"`);
          }
        } catch (seedErr) {
          console.warn(`[ebay] Auto-seed (global) failed (non-fatal): ${seedErr.message}`);
        }
      }

      const dedupedGlobal = dedup(rawGlobal);
      const scoredGlobal = dedupedGlobal.map(c => scoreMatch(c, expected));
      const filterGlobal = applyFilters(scoredGlobal, opts, expected);
      const glPrices = filterGlobal.kept.map(c => c.totalUsd);
      globalResult = { stats: stats.summarize(glPrices), comps: filterGlobal.kept, removed: filterGlobal.removed, error: null };
      if (apiUsed === 'none') apiUsed = 'finding';
      else if (!apiUsed.includes('finding')) apiUsed += '+finding';
      console.log(`[ebay] Finding API Global (${actualDays}d): ${filterGlobal.kept.length} comps`);
    } catch (err) {
      console.warn(`[ebay] Finding API Global unavailable: ${err.response?.status || err.message}`);
      if (!globalResult) globalResult = { stats: null, comps: [], removed: {}, error: { message: err.message } };
    }
  }

  // Ensure usResult/globalResult are initialized before Browse fallback
  if (!usResult) usResult = { stats: null, comps: [], removed: {}, error: { message: 'Finding API skipped/unavailable' } };
  if (!globalResult) globalResult = { stats: null, comps: [], removed: {}, error: { message: 'Finding API skipped/unavailable' } };

  // ── Attempt 3: Browse API (active listings — last resort) ──
  // Only use Browse fallback when we have NO sold comps at all.
  // When Terapeak provided partial sold data, prefer those real sold comps
  // over active listings — sold data at any quantity is more reliable for FMV.
  const soldCompsCount = (usResult?.comps || []).filter(c => c._source !== 'browse').length;
  if (usResult.comps.length < opts.usMinComps && soldCompsCount === 0) {
    try {
      const browseComps = await browseSearch(keywords, PER_PAGE * opts.maxPages, expected._brandFilter || null);
      const dedupedBrowse = dedup(browseComps);
      const scoredBrowse = dedupedBrowse.map(c => scoreMatch(c, expected));
      if (expected.weight) expected._fromGenericDataset = true;
      const { kept, removed } = applyFilters(scoredBrowse, opts, expected);
      delete expected._fromGenericDataset;
      const prices = kept.map(c => c.totalUsd);
      usedFallback = true;

      // Merge with whatever we already have
      const merged = dedup([...usResult.comps, ...kept]);
      const mergedPrices = merged.map(c => c.totalUsd);
      usResult = {
        stats: stats.summarize(mergedPrices),
        comps: merged,
        removed: { ...preFilterRemoved, ...removed },
        error: { message: `Browse API fallback used (active listings, not sold). Previous: ${usResult.error?.message || 'n/a'}` }
      };
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

  // #159: Compute filter attrition stats for each tier
  function _addAttrition(tier) {
    if (!tier || !tier.removed) return;
    const removedTotal = Object.values(tier.removed).reduce((s, n) => s + (n || 0), 0);
    tier.gathered = tier.comps.length + removedTotal;
    tier.attritionPct = tier.gathered > 0
      ? +((removedTotal / tier.gathered) * 100).toFixed(1)
      : 0;
  }
  _addAttrition(usResult);
  _addAttrition(globalResult);

  const lookback = {
    requested: requestedDays,
    used: actualDays,
    extended: actualDays > requestedDays
  };

  const result = { keywords, us: usResult, global: globalResult, usedFallback, apiUsed, lookback };
  cache.set(cacheKey, result);
  return result;
}

/**
 * Build eBay search keywords from PCGS enrichment + raw query.
 * @param {object} pcgsData
 * @param {string} rawQuery
 * @param {number} [weight]  e.g. 0.5, 1.5, 2 --- omitted or 1 means standard 1 oz
 * @param {string} [label]   e.g. 'First Strike', 'Early Releases'
 */
function buildKeywords(pcgsData, rawQuery, weight, label) {
  const parts = [];
  if (pcgsData?.year) parts.push(String(pcgsData.year));
  // Append mint mark with hyphen joining to year (e.g. "1892-S") so eBay
  // doesn't interpret a standalone "-S" as a negation/exclusion operator.
  if (pcgsData?.mint && pcgsData?.year) {
    // Remove the bare year we just pushed and replace with year-mint
    parts.pop();
    parts.push(`${pcgsData.year}-${pcgsData.mint}`);
  } else if (pcgsData?.mint) {
    parts.push(pcgsData.mint);
  }
  if (pcgsData?.series) {
    // Normalize demonyms to country names for eBay compatibility.
    // eBay listings use "Mexico Libertad" not "Mexican Libertad";
    // the Finding API returns HTTP 500 for "Mexican Silver Libertad".
    let seriesKw = pcgsData.series
      .replace(/\bMexican\b/gi, 'Mexico')
      .replace(/\bCanadian\b/gi, 'Canada')
      .replace(/\bAustralian\b/gi, 'Australia')
      .replace(/\bAustrian\b/gi, 'Austria')
      .replace(/\bBritish\b/gi, 'Great Britain')
      .replace(/\bChinese\b/gi, 'China');
    parts.push(seriesKw);
  }
  if (pcgsData?.finish) parts.push(pcgsData.finish);
  if (pcgsData?.grade && pcgsData.grade !== 'Proof') parts.push(pcgsData.grade);
  // When grade is bare "Proof" and finish wasn't already added, inject the keyword
  if (pcgsData?.grade === 'Proof' && !pcgsData?.finish) parts.push('Proof');
  if (pcgsData?.designation) parts.push(pcgsData.designation);
  // Inject weight for bullion coins so eBay comps match the right size.
  if (weight) {
    const FRAC_MAP = { 0.5:'1/2', 0.25:'1/4', 0.1:'1/10', 0.05:'1/20' };
    const weightStr = FRAC_MAP[weight]
      ? FRAC_MAP[weight] + ' oz'
      : weight + ' oz';
    parts.push(weightStr);
  }
  // Append graded slab label (e.g. "First Strike", "Early Releases")
  if (label) parts.push(label);

  // #171/#184: Metal exclusion keywords — when the query is explicitly one metal,
  // add negations for other common metals so eBay doesn't return mixed-metal
  // results (e.g. silver Libertads in a gold Libertad search).
  const joinedLower = parts.join(' ').toLowerCase();
  const hasGold = /\bgold\b/.test(joinedLower);
  const hasSilver = /\bsilver\b/.test(joinedLower);
  const hasPlatinum = /\bplatinum\b/.test(joinedLower);
  const hasPalladium = /\bpalladium\b/.test(joinedLower);

  if (hasPlatinum || hasPalladium) {
    // Platinum/palladium: exclude both silver and gold
    if (!hasSilver) parts.push('-silver');
    if (!hasGold) parts.push('-gold');
  } else if (hasGold && !hasSilver) {
    parts.push('-silver');
  } else if (hasSilver && !hasGold) {
    parts.push('-gold');
  }

  // Require at least a series/denomination in the keywords;
  // year + mint alone (e.g. "1956 -D") is too vague and matches wrong coins
  const hasSeries = !!pcgsData?.series;
  if (hasSeries && parts.length >= 2) return parts.join(' ').trim();
  // Fall back to raw query so the denomination is preserved
  return rawQuery || parts.join(' ').trim() || '';
}

/** Flush the in-memory + on-disk eBay sold-comps cache. */
function clearCache() { cache.clear(); }

module.exports = {
  fetchSoldComps,
  browseSearch,
  buildKeywords,
  scoreMatch,
  isDenied,
  dedup,
  clearCache,
  detectWeightFromTitle,
  detectMetalFromTitle,
  applyFilters,
  classifyGradeType,
  isReverseProofTitle
};
