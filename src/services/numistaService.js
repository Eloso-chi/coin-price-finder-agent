// src/services/numistaService.js — Numista API v3 integration
// Provides catalogue search, type details, issue mintages, price estimates,
// and derived rarity classification for coins.
// CommonJS

const { TTLCache } = require('../utils/cache');
const path = require('path');

const API_BASE = 'https://api.numista.com/v3';
function getApiKey() { return process.env.NUMISTA_API_KEY || ''; }

// 24-hour TTL cache, persisted to disk
const cache = new TTLCache({
  defaultTTL: 86_400_000,
  filePath: path.join(__dirname, '../../cache/numista_cache.json')
});

// ── Rarity tiers derived from mintage ───────────────────────────────────
// Since the Numista Rarity Index (NRI) is not exposed via the API, we derive
// a rarity classification from mintage numbers using standard numismatic
// conventions.  The Numista URL is always included so users can check the
// actual NRI on the website.
const RARITY_TIERS = [
  { max: 5,         label: 'Unique',          score: 100, color: '#ff0000' },
  { max: 25,        label: 'Extremely Rare',  score: 90,  color: '#ff4500' },
  { max: 100,       label: 'Very Rare',       score: 80,  color: '#ff8c00' },
  { max: 1000,      label: 'Rare',            score: 65,  color: '#ffa500' },
  { max: 10000,     label: 'Scarce',          score: 50,  color: '#daa520' },
  { max: 100000,    label: 'Semi-Scarce',     score: 35,  color: '#bdb76b' },
  { max: 1000000,   label: 'Common',          score: 15,  color: '#6b8e23' },
  { max: Infinity,  label: 'Very Common',     score: 5,   color: '#228b22' }
];

function rarityFromMintage(mintage) {
  if (mintage == null || mintage < 0) return null;
  for (const tier of RARITY_TIERS) {
    if (mintage <= tier.max) {
      return { label: tier.label, score: tier.score, color: tier.color, mintage };
    }
  }
  return { label: 'Very Common', score: 5, color: '#228b22', mintage };
}

// ── API helpers ─────────────────────────────────────────────────────────

/**
 * Make an authenticated GET request to the Numista API.
 * Returns null on failure (non-fatal).
 */
async function apiGet(endpoint, params = {}) {
  const key = getApiKey();
  if (!key) return null;

  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }

  try {
    const resp = await fetch(url.toString(), {
      headers: { 'Numista-API-Key': key },
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) {
      if (resp.status === 429) console.warn('[Numista] Rate-limited');
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.warn('[Numista] API error:', err.message);
    return null;
  }
}

// ── Issuer mapping ──────────────────────────────────────────────────────
// Maps common country names to Numista issuer codes for more precise searches
const ISSUER_MAP = {
  'us': 'united-states',
  'usa': 'united-states',
  'united states': 'united-states',
  'canada': 'canada',
  'uk': 'united-kingdom',
  'united kingdom': 'united-kingdom',
  'great britain': 'united-kingdom',
  'australia': 'australia',
  'mexico': 'mexico',
  'china': 'china-peoples-republic',
  'japan': 'japan',
  'germany': 'germany-federal-republic',
  'france': 'france',
  'italy': 'italy',
  'india': 'india-republic',
  'south africa': 'south-africa'
};

function resolveIssuer(country) {
  if (!country) return 'united-states'; // Default for this tool
  const c = country.toLowerCase().trim();
  return ISSUER_MAP[c] || c.replace(/\s+/g, '-');
}

// ── Search the Numista catalogue ────────────────────────────────────────

/**
 * Search for coin types matching a query string.
 * @param {string} query  – free-text search query
 * @param {object} opts   – { issuer, year, count }
 * @returns {Array|null}  – array of type objects, or null on failure
 */
async function searchTypes(query, opts = {}) {
  const cacheKey = `search:${query}:${opts.issuer || ''}:${opts.year || ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const params = {
    q: query,
    lang: 'en',
    count: opts.count || 10
  };
  if (opts.issuer) params.issuer = opts.issuer;
  if (opts.year)   params.date = String(opts.year);

  const data = await apiGet('/types', params);
  if (!data || !data.types) return null;

  cache.set(cacheKey, data.types);
  return data.types;
}

/**
 * Get detailed information about a specific type.
 * @param {number} typeId
 * @returns {object|null}
 */
async function getType(typeId) {
  const cacheKey = `type:${typeId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const data = await apiGet(`/types/${typeId}`, { lang: 'en' });
  if (!data) return null;

  cache.set(cacheKey, data);
  return data;
}

/**
 * Get all issues (year-by-year mintage data) for a type.
 * @param {number} typeId
 * @returns {Array|null}
 */
async function getIssues(typeId) {
  const cacheKey = `issues:${typeId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const data = await apiGet(`/types/${typeId}/issues`, { lang: 'en' });
  if (!data || !Array.isArray(data)) return null;

  cache.set(cacheKey, data);
  return data;
}

/**
 * Get Numista price estimates for a specific issue.
 * @param {number} typeId
 * @param {number} issueId
 * @param {string} currency – default 'USD'
 * @returns {object|null}   – { currency, prices: [{ grade, price }] }
 */
async function getPrices(typeId, issueId, currency = 'USD') {
  const cacheKey = `prices:${typeId}:${issueId}:${currency}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const data = await apiGet(`/types/${typeId}/issues/${issueId}/prices`, {
    currency,
    lang: 'en'
  });
  if (!data) return null;

  cache.set(cacheKey, data);
  return data;
}

// ── Scoring: pick the best type match ───────────────────────────────────

/**
 * Score how well a Numista type matches our parsed coin data.
 * Higher is better.
 */
function scoreMatch(type, parsed) {
  let score = 0;

  const title = (type.title || '').toLowerCase();

  // Year overlap
  if (parsed.year) {
    const y = Number(parsed.year);
    if (type.min_year && type.max_year && y >= type.min_year && y <= type.max_year) {
      score += 20;
    }
  }

  // Series / denomination name overlap
  if (parsed.series) {
    const series = parsed.series.toLowerCase();
    const seriesWords = series.split(/\s+/).filter(w => w.length > 2);
    const matchingWords = seriesWords.filter(w => title.includes(w));
    score += matchingWords.length * 5;
  }

  // Denomination value match
  if (parsed.denomination && type.value) {
    const denomText = (type.value.text || '').toLowerCase();
    if (denomText.includes(parsed.denomination.toLowerCase())) {
      score += 15;
    }
  }

  // Composition match (gold, silver, etc.)
  if (parsed.metal && type.composition) {
    const comp = (type.composition.text || '').toLowerCase();
    if (comp.includes(parsed.metal.toLowerCase())) {
      score += 10;
    }
  }

  // Category = coin (not banknote/exonumia)
  if (type.category === 'coin') score += 2;

  return score;
}

// ── High-level lookup ───────────────────────────────────────────────────

/**
 * Look up a coin in the Numista catalogue and return enriched data.
 *
 * @param {object} parsed     – parsed coin data { series, year, mint, grade, metal, denomination, weight }
 * @param {string} [country]  – country/issuer (defaults to US)
 * @returns {object}          – { accessible, type, issue, rarity, numistaUrl, prices, composition, references, limitations }
 */
async function lookupCoin(parsed, country) {
  if (!getApiKey()) {
    return {
      accessible: false,
      type: null,
      issue: null,
      rarity: null,
      numistaUrl: null,
      prices: null,
      composition: null,
      references: null,
      limitations: ['Numista API key not configured (set NUMISTA_API_KEY env var)']
    };
  }

  const fullCacheKey = `lookup:${JSON.stringify(parsed)}:${country || 'us'}`;
  const cached = cache.get(fullCacheKey);
  if (cached) return cached;

  try {
    // Build search query from parsed data
    const parts = [];
    if (parsed.series) parts.push(parsed.series);
    if (parsed.denomination && !parsed.series) parts.push(parsed.denomination);
    if (parsed.year) parts.push(String(parsed.year));
    const q = parts.join(' ').trim();
    if (!q) {
      return { accessible: true, type: null, issue: null, rarity: null, numistaUrl: null, prices: null, composition: null, references: null, limitations: ['Insufficient data to search Numista'] };
    }

    const issuer = resolveIssuer(country);

    // Search for types
    const types = await searchTypes(q, { issuer, year: parsed.year });
    if (!types || types.length === 0) {
      // Retry without year filter (broader search)
      const broaderTypes = await searchTypes(q, { issuer });
      if (!broaderTypes || broaderTypes.length === 0) {
        return {
          accessible: true,
          type: null,
          issue: null,
          rarity: null,
          numistaUrl: null,
          prices: null,
          composition: null,
          references: null,
          limitations: ['No matching types found in Numista catalogue']
        };
      }
      types?.length || (types = broaderTypes);  // fallback
    }

    // Pick the best-matching type
    const scored = (types || []).map(t => ({ type: t, score: scoreMatch(t, parsed) }));
    scored.sort((a, b) => b.score - a.score);
    const bestMatch = scored[0]?.type;
    if (!bestMatch) {
      return { accessible: true, type: null, issue: null, rarity: null, numistaUrl: null, prices: null, composition: null, references: null, limitations: ['No suitable match found'] };
    }

    // Fetch full type details
    const typeDetail = await getType(bestMatch.id);
    const numistaUrl = typeDetail?.url || bestMatch.url || `https://en.numista.com/catalogue/pieces${bestMatch.id}.html`;

    // Fetch issues (mintage per year)
    const issues = await getIssues(bestMatch.id);

    // Find the matching issue for the specific year/mint
    let matchedIssue = null;
    let issueMintage = null;
    if (issues && parsed.year) {
      const yr = Number(parsed.year);
      const mintLetter = (parsed.mint || '').toUpperCase();

      // Try exact match on year + mint
      matchedIssue = issues.find(iss => {
        const yearMatch = iss.gregorian_year === yr || iss.year === yr;
        if (!yearMatch) return false;
        if (mintLetter && iss.mint_letter) return iss.mint_letter.toUpperCase() === mintLetter;
        return true;
      });

      // Fallback: just year
      if (!matchedIssue) {
        matchedIssue = issues.find(iss => iss.gregorian_year === yr || iss.year === yr);
      }

      if (matchedIssue) {
        issueMintage = matchedIssue.mintage || null;
      }
    }

    // Derive rarity from mintage
    // Prefer issue-level mintage, fall back to any available
    const mintageForRarity = issueMintage
      || (issues && issues.length > 0 ? Math.min(...issues.filter(i => i.mintage).map(i => i.mintage)) : null);
    const rarity = rarityFromMintage(mintageForRarity);

    // Fetch Numista price estimates for the matched issue
    let prices = null;
    if (matchedIssue) {
      const priceData = await getPrices(bestMatch.id, matchedIssue.id, 'USD');
      if (priceData && priceData.prices) {
        prices = {
          currency: priceData.currency || 'USD',
          estimates: priceData.prices
        };
      }
    }

    // Build composition info
    const composition = typeDetail?.composition?.text || bestMatch.composition?.text || null;

    // Build references (cross-refs to other catalogues like KM#, NGC#, etc.)
    const references = (typeDetail?.references || []).map(ref => ({
      catalogue: ref.catalogue?.title || ref.catalogue?.abbreviation || 'Unknown',
      number: ref.number || null
    }));

    const result = {
      accessible: true,
      type: {
        id: bestMatch.id,
        title: typeDetail?.title || bestMatch.title,
        issuer: typeDetail?.issuer?.name || bestMatch.issuer?.name || null,
        minYear: typeDetail?.min_year || bestMatch.min_year,
        maxYear: typeDetail?.max_year || bestMatch.max_year,
        denomination: typeDetail?.value?.text || bestMatch.value?.text || null,
        shape: typeDetail?.shape || null,
        weight: typeDetail?.weight || null,
        size: typeDetail?.size || null,
        series: typeDetail?.series || null,
        obverseDescription: typeDetail?.obverse?.description || null,
        reverseDescription: typeDetail?.reverse?.description || null,
        obverseImage: typeDetail?.obverse?.thumbnail || null,
        reverseImage: typeDetail?.reverse?.thumbnail || null,
        edgeDescription: typeDetail?.edge?.description || null,
        tags: typeDetail?.tags || []
      },
      issue: matchedIssue ? {
        id: matchedIssue.id,
        year: matchedIssue.year || matchedIssue.gregorian_year,
        mintLetter: matchedIssue.mint_letter || null,
        mintage: matchedIssue.mintage || null,
        comment: matchedIssue.comment || null
      } : null,
      rarity,
      numistaUrl,
      prices,
      composition,
      references,
      matchScore: scored[0]?.score || 0,
      alternateTypes: scored.slice(1, 4).map(s => ({
        id: s.type.id,
        title: s.type.title,
        score: s.score
      })),
      limitations: []
    };

    cache.set(fullCacheKey, result);
    return result;
  } catch (err) {
    console.error('[Numista] lookupCoin error:', err.message);
    return {
      accessible: false,
      type: null,
      issue: null,
      rarity: null,
      numistaUrl: null,
      prices: null,
      composition: null,
      references: null,
      limitations: ['Numista API error: ' + err.message]
    };
  }
}

/**
 * Batch-lookup rarity for many year/mint pairs in a single series.
 * Uses only 2–3 API calls total (search → getType → getIssues), NOT per-cell.
 *
 * @param {string} series  – coin series name, e.g. "Morgan Dollar"
 * @param {Array<{year:number, mint:string}>} cells – year/mint pairs to enrich
 * @param {string} [country] – issuer country (default US)
 * @returns {Promise<Map<string, object>>} – Map of "year-mint" → rarity object
 */
async function batchRarityForSeries(series, cells, country) {
  const result = new Map();
  if (!getApiKey() || !series || !cells || cells.length === 0) return result;

  const batchCacheKey = `batchRarity:${series}:${country || 'us'}`;
  const cached = cache.get(batchCacheKey);
  if (cached) {
    // cached is a plain object { "year-mint": rarity }
    for (const [key, val] of Object.entries(cached)) result.set(key, val);
    return result;
  }

  try {
    const issuer = resolveIssuer(country);

    // 1. Search for the type
    const types = await searchTypes(series, { issuer });
    if (!types || types.length === 0) return result;

    // Pick best match using a minimal parsed descriptor
    const parsed = { series, denomination: null, year: null, metal: null };
    const scored = types.map(t => ({ type: t, score: scoreMatch(t, parsed) }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]?.type;
    if (!best) return result;

    // 2. Get all issues (mintage per year/mint)
    const issues = await getIssues(best.id);
    if (!issues || issues.length === 0) return result;

    // Build quick lookup: "year-mintLetter" → issue
    const issueLookup = {};
    for (const iss of issues) {
      const yr = iss.gregorian_year || iss.year;
      if (!yr) continue;
      const ml = (iss.mint_letter || '').toUpperCase() || 'P';
      const key = `${yr}-${ml}`;
      // Keep the one with the actual mintage if duplicates
      if (!issueLookup[key] || (iss.mintage && !issueLookup[key].mintage)) {
        issueLookup[key] = iss;
      }
    }

    // 3. Map each cell to its rarity
    const numistaUrl = best.url || `https://en.numista.com/catalogue/pieces${best.id}.html`;
    for (const cell of cells) {
      const key = `${cell.year}-${cell.mint || 'P'}`;
      const iss = issueLookup[key];
      if (iss && iss.mintage != null) {
        const rarity = rarityFromMintage(iss.mintage);
        if (rarity) {
          rarity.numistaUrl = numistaUrl;
          result.set(key, rarity);
        }
      }
    }

    // Cache the plain-object version
    const cacheable = {};
    for (const [k, v] of result) cacheable[k] = v;
    cache.set(batchCacheKey, cacheable);
  } catch (err) {
    console.warn('[Numista] batchRarityForSeries error:', err.message);
  }

  return result;
}

function clearCache() { cache.clear(); }

module.exports = {
  searchTypes,
  getType,
  getIssues,
  getPrices,
  lookupCoin,
  batchRarityForSeries,
  rarityFromMintage,
  clearCache,
  // Exported for testing
  scoreMatch,
  resolveIssuer,
  RARITY_TIERS,
  // For testing: allow overriding the cache
  _cache: cache
};
