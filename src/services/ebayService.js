// src/services/ebayService.js — eBay comps via multiple APIs
// Priority: Terapeak (sold) → Finding API (sold) → Browse API (active, fallback)
// Marketplace Insights API: commented out (no access)
// Includes request throttling, aggressive caching, exponential backoff
// CommonJS

const axios = require('axios');
const { TTLCache } = require('../utils/cache');
const stats = require('../utils/stats');
const { isDenied, detectDenomination, hasSeriesConflict, isCompositionMismatch, BULLION_DENY_DENOM_RE, BULLION_OK_RE, ROLL_PATTERN } = require('../utils/filters');
const terapeakService = require('./terapeakService');

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

// ── Weight detection from listing title ──────────────────────
/**
 * Detect coin/bar weight (in troy oz) from listing title.
 * Returns numeric oz (e.g. 0.25, 1, 5) or null if no weight detected.
 */
function detectWeightFromTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  // Weight-unit suffix: matches "oz", "ozt", "ounce", "ounces",
  // "troy oz", "troy ounce", "troy ounce oz", etc.
  const OZ = '(?:troy\\s+)?(?:ounces?(?:\\s+oz)?|ozt?|oz)\\b';
  // Specific fractions first (before generic integer pattern)
  const fracRe = new RegExp('\\b(1\\/20|1\\/10|1\\/4|1\\/2)\\s*' + OZ, 'i');
  const fracMatch = t.match(fracRe);
  if (fracMatch) {
    const frac = { '1/20': 0.05, '1/10': 0.1, '1/4': 0.25, '1/2': 0.5 };
    return frac[fracMatch[1]] || null;
  }
  if (/\bquarter\s*(?:troy\s+)?(?:ounce|ozt?|oz)\b/i.test(t))  return 0.25;
  if (/\bhalf\s*(?:troy\s+)?(?:ounce|ozt?|oz)\b/i.test(t))     return 0.5;
  // Generic "N oz/ounce/ozt" — integers and decimals (e.g. "1 oz", "2oz", "1.5 ounce")
  const m = t.match(new RegExp('\\b(\\d+(?:\\.\\d+)?)\\s*' + OZ, 'i'));
  if (m) return parseFloat(m[1]);
  return null;
}

// ── isDenied imported from ../utils/filters ─────────────────

// ── Metal detection from title / aspects ─────────────────────
const METAL_PATTERNS = [
  { metal: 'gold',      re: /\bgold\b/i },
  { metal: 'silver',    re: /\bsilver\b/i },
  { metal: 'platinum',  re: /\bplatinum\b/i },
  { metal: 'palladium', re: /\bpalladium\b/i },
  { metal: 'copper',    re: /\bcopper\b/i },
];

/**
 * Detect metal from a listing title string.
 * Returns 'gold', 'silver', 'platinum', 'palladium', 'copper', or null.
 */
function detectMetalFromTitle(title) {
  if (!title) return null;
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
// Priority chain for classifying a comp as graded or raw:
//   1. conditionId  (eBay structured data — authoritative)
//       2000 = "Certified" (graded by approved TPG)
//       3000 = "Uncirculated" (raw)
//       4000 = "Circulated" (raw)
//   2. conditionDescriptors / localizedAspects (Browse API)
//       "Certification" aspect = PCGS/NGC/etc → graded
//   3. Title regex fallback (least reliable)
const TPG_RE          = /\b(PCGS|NGC|ANACS|ICG|CGC)\b/i;
const FORMAL_GRADE_RE = /\b(MS|PR|PF|SP|AU|XF|EF|VF|VG|AG|FR|PO)\s*[-]?\s*\d{1,2}\+?\b/i;

/**
 * Classify a comp as 'graded' or 'raw' using eBay's structured
 * condition data first, falling back to title parsing only when
 * the API doesn't provide a conditionId.
 */
function classifyGradeType(comp) {
  const cid = comp.conditionId ? String(comp.conditionId) : null;

  // 1. Authoritative: eBay conditionId
  if (cid === '2000') return 'graded';          // "Certified"
  if (cid === '3000' || cid === '4000') return 'raw';  // "Uncirculated" / "Circulated"
  // 1000 (New), 1500 (New Other) — not standard for coins but treat as raw
  if (cid === '1000' || cid === '1500') return 'raw';

  // 2. ConditionDescriptors / localizedAspects (set by Browse API normalizer)
  if (comp._certificationAspect) return 'graded';

  // 3. Title fallback (least reliable — eBay policy says don't rely on title)
  const title = comp.title || '';
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
  const VARIANT_TOKENS = ['golden', 'gilded', 'gold plated', 'gold-plated',
    'colorized', 'coloured', 'colorised', 'colour', 'enameled',
    'reverse proof', 'burnished', 'enhanced reverse proof',
    'satin finish', 'first strike', 'first day', 'first release',
    'first releases', 'antiqued', 'high relief', 'piedfort', 'privy',
    'prooflike', 'ruthenium', 'hologram',
    'flag label', 'brown label', 'blue label', 'black label',
    'mercanti', 'moy signed', 'reagan'];
  const queryLower = (expected._rawQuery || '').toLowerCase();
  const labelLower = (expected.label || '').toLowerCase();
  const hasVariantInQuery = VARIANT_TOKENS.some(t => queryLower.includes(t))
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
  }

  // ── Weight / size match for bullion coins (25 pts match, –35 mismatch) ──
  if (expected.weight) {
    const detectedWeight = detectWeightFromTitle(tLow);
    if (detectedWeight !== null) {
      if (Math.abs(detectedWeight - expected.weight) < 0.01) {
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

  // Brand match (20 pts)
  if (expected.brand) {
    const brandLow = expected.brand.toLowerCase();
    if (tLow.includes(brandLow)) { score += 20; notes.push('brand-match'); }
  }

  // Size match (15 pts) — normalize e.g. "1 oz" → "1oz"
  if (expected.barSize) {
    const sizeNorm = expected.barSize.toLowerCase().replace(/\s+/g, '');
    if (tNorm.includes(sizeNorm)) { score += 15; notes.push('size-match'); }
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

  // Zodiac animal match (5 pts) — Lunar series
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
  // This prevents completely irrelevant items (e.g. electronics, clothing) from appearing.
  const relevanceGate = expected.isSet ? 30 : 20;
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

  // USD only for stats
  kept = kept.filter(c => {
    if (c.totalUsd === null) { removed.nonUsd++; return false; }
    return true;
  });

  // Metal-mismatch filter: drop comps whose detected metal contradicts expected
  if (expected.metal) {
    const wantMetal = expected.metal.toLowerCase();
    removed.metalMismatch = 0;
    kept = kept.filter(c => {
      const compMetal = c._detectedMetal;
      // If comp has no detected metal, keep it (benefit of the doubt)
      if (!compMetal) return true;
      if (compMetal !== wantMetal) { removed.metalMismatch++; return false; }
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
      if (Math.abs(detW - expected.weight) < 0.01) return true; // matches
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
  // Allow ±1 year tolerance for non-bullion searches (e.g. 1965 roll in 1964 search).
  if (expected.year) {
    removed.yearMismatch = 0;
    const yearTolerance = expected.weight ? 0 : 1; // bullion: exact year; others: ±1
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

  // Melt-floor sanity check for 1 oz (and larger) bullion: if no weight is
  // detected in the title and the price is well below expected melt for the
  // searched weight, the listing is almost certainly a smaller/fractional coin.
  if (expected.meltPerOz && expected.weight && expected.weight >= 1) {
    removed.meltFloor = 0;
    // Floor: 40% of expected melt — generous enough for damaged/junk bullion
    // but catches e.g. 1/2 oz coins ($15) in a 1 oz search (melt ~$30+).
    const meltFloor = expected.meltPerOz * expected.weight * 0.40;
    kept = kept.filter(c => {
      const detW = detectWeightFromTitle(c.title);
      if (detW !== null) return true; // already handled by weight-mismatch filter
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
    const VARIANT_TOKENS = ['golden', 'gilded', 'gold plated', 'gold-plated',
      'colorized', 'coloured', 'colorised', 'enameled',
      'reverse proof', 'burnished', 'enhanced reverse proof',
      'satin finish', 'antiqued', 'high relief', 'piedfort', 'privy',
      'prooflike', 'ruthenium', 'hologram',
      'flag label', 'brown label', 'blue label', 'black label',
      'mercanti', 'moy signed', 'reagan'];
    const qLow = (expected._rawQuery || '').toLowerCase();
    const labelLow = (expected.label || '').toLowerCase();
    const queryWantsVariant = VARIANT_TOKENS.some(t => qLow.includes(t))
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
    }
  }

  // Mint-mark mismatch filter: drop comps whose title explicitly states
  // a different mint mark than expected (e.g. user wants 1892-S but title says 1892-O)
  if (expected.mint) {
    const wantMint = expected.mint.toUpperCase();
    const MINT_CITY_MAP = { 'carson city': 'CC', 'denver': 'D', 'philadelphia': 'P', 'san francisco': 'S', 'west point': 'W' };
    removed.mintMismatch = 0;
    kept = kept.filter(c => {
      const tLow = (c.title || '').toLowerCase();
      const mintRe = /\b\d{4}\s*[-]?\s*(CC|[SDPWO])\b/i;
      const m = tLow.match(mintRe);
      let titleMint = m ? m[1].toUpperCase() : null;
      // Also recognise mint city names as mint marks
      if (!titleMint) {
        for (const [city, mark] of Object.entries(MINT_CITY_MAP)) {
          if (tLow.includes(city)) { titleMint = mark; break; }
        }
      }
      // Standalone "CC" anywhere in title (unique two-letter mark)
      if (!titleMint && /\bCC\b/.test(c.title || '')) {
        titleMint = 'CC';
      }
      if (!titleMint) return true; // no mint stated → benefit of the doubt
      if (titleMint === wantMint) return true;
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
          // Both matched — prefer the raw-query dataset when the user's query
          // mentions "set" and only the raw-query result is a set dataset.
          const queryHasSet = /\bset\b/i.test(expected._rawQuery);
          const rawIsSet = /\bset\b/i.test(rawData.searchTerm || '');
          const kwIsSet  = /\bset\b/i.test(terapeakData.searchTerm || '');
          if (queryHasSet && rawIsSet && !kwIsSet) {
            terapeakData = rawData;
          }
        }
      }
    }
  }

  if (terapeakData && terapeakData.comps && terapeakData.comps.length > 0) {
    let tpComps = terapeakData.comps;

    // ── Grade-type pool split: use only the matching pool ──
    // Graded coins (PCGS MS65, NGC AU58) sell for very different prices than
    // raw coins.  Mixing them distorts FMV.  Split into separate pools and
    // use only the pool that matches the user's query.
    const wantsGraded = !!expected.grade;
    const beforeSplit = tpComps.length;
    tpComps = tpComps.filter(c => {
      const gt = c.gradeType || classifyGradeType(c);
      return wantsGraded ? gt === 'graded' : gt === 'raw';
    });
    if (tpComps.length !== beforeSplit) {
      console.log(`[ebay] Terapeak grade-split: ${beforeSplit} → ${tpComps.length} (${wantsGraded ? 'graded' : 'raw'} only)`);
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

    // Apply scoring and filters
    const scored = pool.map(c => scoreMatch(c, expected));
    const { kept, removed } = applyFilters(scored, opts, expected);
    const prices = kept.map(c => c.totalUsd);

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
    if ((!usResult || usResult.comps.length < opts.usMinComps) && !circuitTripped('finding')) {
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
        const filterUS = applyFilters(scoredUS, opts, expected);

        // Merge with any Insights comps
        const mergedUS = usResult ? dedup([...usResult.comps, ...filterUS.kept]) : filterUS.kept;
        const mergedPrices = mergedUS.map(c => c.totalUsd);

        usResult = { stats: stats.summarize(mergedPrices), comps: mergedUS, removed: filterUS.removed, error: null };
        apiUsed = apiUsed === 'marketplace-insights' ? 'insights+finding' : 'finding';
        console.log(`[ebay] Finding API US (${tierDays}d): ${mergedUS.length} comps`);
      } catch (err) {
        console.warn(`[ebay] Finding API US unavailable: ${err.response?.status || err.message}`);
        // When Finding API fails and keywords contain proof/finish terms,
        // retry with those terms stripped.  eBay's Finding API sometimes
        // returns 500 for "Proof" in the query while returning valid results
        // without it.  applyFilters will remove non-proof comps.
        // Also strip country names that can trigger eBay 500 errors.
        const proofTermRe = /\b(Proof|Reverse Proof|Enhanced Reverse Proof|Burnished|Satin Finish|Antiqued)\b/i;
        const countryRe = /\b(Mexico|Mexican|Canada|Canadian|Australia|Australian|Austria|Austrian|Great Britain|British|China|Chinese)\b/gi;
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
            const filterRetry = applyFilters(scoredRetry, opts, expected);
            const mergedRetry = usResult ? dedup([...usResult.comps, ...filterRetry.kept]) : filterRetry.kept;
            const mergedPrices = mergedRetry.map(c => c.totalUsd);
            usResult = { stats: stats.summarize(mergedPrices), comps: mergedRetry, removed: filterRetry.removed, error: null };
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
  if (!globalResult && !circuitTripped('finding')) {
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
  applyFilters,
  classifyGradeType
};
