// src/services/pcgsService.js — PCGS Public API integration
// CommonJS

const axios = require('axios');
const { TTLCache } = require('../utils/cache');

const path = require('path');
const fs = require('fs');

const PCGS_API_KEY = process.env.PCGS_API_KEY || '';
const PCGS_BASE   = (process.env.PCGS_BASE_URL || 'https://api.pcgs.com/publicapi').replace(/\/+$/, '');
const TIMEOUT      = 10000;

// Ensure cache directory exists
const CACHE_DIR = path.join(__dirname, '..', '..', 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const cache = new TTLCache({ defaultTTL: 86_400_000, filePath: path.join(CACHE_DIR, 'pcgs_cache.json') }); // 24h, persisted

// ── HTTP helper with retry ──────────────────────────────────
async function pcgsGet(urlPath, retries = 2) {
  const url = `${PCGS_BASE}${urlPath}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${PCGS_API_KEY}`,
          Accept: 'application/json'
        },
        timeout: TIMEOUT
      });
      return resp.data;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 || (status >= 500 && status < 600)) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
      }
      throw err;
    }
  }
}

// ── Public methods ──────────────────────────────────────────

/**
 * Lookup a coin by PCGS certification number.
 * Returns enrichment object or { verified: false, ... }.
 */
async function lookupByCert(certNumber) {
  if (!PCGS_API_KEY) {
    return _empty('PCGS API key not configured');
  }
  const cacheKey = `pcgs:cert:${certNumber}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const data = await pcgsGet(`/coindetail/GetCoinFactsByCertNo/${certNumber}`);
    const result = _mapResponse(data);
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    return _empty(`PCGS cert lookup failed: ${err.response?.data?.Message || err.message}`);
  }
}

/**
 * Lookup by PCGS coin number + grade.
 */
async function lookupByCoinNumberAndGrade(pcgsCoinNumber, gradeNum) {
  if (!PCGS_API_KEY) {
    return _empty('PCGS API key not configured');
  }
  const cacheKey = `pcgs:num:${pcgsCoinNumber}:${gradeNum}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const data = await pcgsGet(`/coindetail/GetCoinFactsByPCGSNo/${pcgsCoinNumber}/${gradeNum}`);
    const result = _mapResponse(data);
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    return _empty(`PCGS coin# lookup failed: ${err.response?.data?.Message || err.message}`);
  }
}

/**
 * Best-effort resolve from free-text description.
 * Parses year, mint, series, grade → attempts PCGS coin # search.
 */
async function resolveFromDescription(text) {
  if (!PCGS_API_KEY) {
    return _empty('PCGS API key not configured');
  }

  // ── Quick cert-number detection ──
  const certMatch = text.match(/\b(\d{7,9})\b/);
  if (certMatch) {
    const result = await lookupByCert(certMatch[1]);
    if (result.verified) return result;
  }

  // ── Parse description into tokens ──
  const parsed = parseDescription(text);

  // Try PCGS search endpoint
  try {
    const cacheKey = `pcgs:desc:${text.toLowerCase().trim()}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const data = await pcgsGet(`/coindetail/Search?query=${encodeURIComponent(text)}`);
    if (data && (Array.isArray(data) ? data.length : data.PCGSNo)) {
      const coin = Array.isArray(data) ? data[0] : data;
      const result = _mapResponse(coin);
      cache.set(cacheKey, result);
      return result;
    }
  } catch (_) { /* fall through */ }

  // Return best-effort parsed data without verification
  return {
    verified: false,
    pcgsCoinNumber: null,
    series: parsed.series || null,
    year: parsed.year || null,
    mint: parsed.mint || null,
    grade: parsed.grade || null,
    designation: parsed.designation || null,
    variety: null,
    priceGuide: null,
    population: null,
    auction: null,
    trueViewUrl: null,
    parsed,
    limitations: ['Could not verify via PCGS API; using parsed description']
  };
}

// ── Description parser ──────────────────────────────────────
function parseDescription(text) {
  const t = text.trim();
  const result = {};

  // Year: 4-digit starting with 1 or 2
  const yearMatch = t.match(/\b(1[7-9]\d{2}|20[0-2]\d)\b/);
  if (yearMatch) result.year = parseInt(yearMatch[1], 10);

  // Mint mark
  const mintMatch = t.match(/\b(\d{4})\s*[-]?\s*([SDPWO])\b/i);
  if (mintMatch) result.mint = mintMatch[2].toUpperCase();

  // Grade: MS/PR/SP/PF + number, optional +
  const gradeMatch = t.match(/\b(MS|PR|PF|SP|AU|XF|EF|VF|F|VG|G|AG|PO)\s*[-]?\s*(\d{1,2})(\+)?\b/i);
  if (gradeMatch) {
    let prefix = gradeMatch[1].toUpperCase();
    if (prefix === 'PF') prefix = 'PR';
    result.grade = `${prefix}${gradeMatch[2]}${gradeMatch[3] || ''}`;
    result.gradeNum = parseInt(gradeMatch[2], 10);
  }

  // Designation: DCAM, CAM, PL, DPL, FB, FBL, FS, FH, RD, RB, BN
  const desMatch = t.match(/\b(DCAM|CAM|PL|DPL|FB|FBL|FS|FH|RD|RB|BN)\b/i);
  if (desMatch) result.designation = desMatch[1].toUpperCase();

  // Proof / Mint set detection — MUST come before generic "proof" grade
  const setMatch = t.match(/\b(prestige|premier\s*silver|silver|clad)?\s*proof\s*set\b/i)
    || t.match(/\bmint\s*set\b/i)
    || t.match(/\buncirculated\s*set\b/i);
  if (setMatch) {
    const full = setMatch[0].toLowerCase();
    if (/mint\s*set|uncirculated\s*set/i.test(full)) {
      result.series = 'US Mint Set';
      result.setType = 'mint-uncirculated';
    } else if (/prestige/i.test(full)) {
      result.series = 'US Prestige Proof Set';
      result.setType = 'prestige';
    } else if (/premier/i.test(full)) {
      result.series = 'US Premier Silver Proof Set';
      result.setType = 'premier-silver';
    } else if (/silver/i.test(full)) {
      result.series = 'US Silver Proof Set';
      result.setType = 'silver';
    } else {
      result.series = 'US Proof Set';
      result.setType = 'clad';
    }
    // Don't set grade to 'Proof' — it's a set, not a graded coin
  } else if (/\bproof\b/i.test(t) && !result.grade) {
    // Standalone "proof" without "set" → grade qualifier
    result.grade = 'Proof';
  }

  // Weight: extract "1/2 oz", "1/4 oz", "1/10 oz", "1.5 oz", "5 oz", "10 oz", etc.
  const weightMatch = t.match(/\b(\d+(?:\.\d+)?(?:\/\d+)?)\s*(?:troy\s*)?oz\b/i);
  if (weightMatch) {
    const raw = weightMatch[1];
    if (raw.includes('/')) {
      const [num, den] = raw.split('/');
      result.weight = parseFloat(num) / parseFloat(den);
    } else {
      result.weight = parseFloat(raw);
    }
    result.weightRaw = weightMatch[0];
  }

  // Metal detection — infer from series name or explicit keywords
  const metalPatterns = [
    { metal: 'gold',      re: /\bgold\b/i },
    { metal: 'silver',    re: /\bsilver\b/i },
    { metal: 'platinum',  re: /\bplatinum\b/i },
    { metal: 'palladium', re: /\bpalladium\b/i },
    { metal: 'copper',    re: /\bcopper\b/i },
  ];
  for (const { metal, re } of metalPatterns) {
    if (re.test(t)) { result.metal = metal; break; }
  }

  // Series heuristics — order matters: longer / more-specific phrases first
  const seriesKeywords = [
    // World bullion — multi-word first
    'canadian silver maple leaf', 'canadian gold maple leaf',
    'silver maple leaf', 'gold maple leaf',
    'canadian silver maple', 'canadian gold maple',
    'silver maple', 'gold maple', 'maple leaf', 'maple',
    'mexican silver libertad', 'mexican gold libertad',
    'silver libertad', 'gold libertad', 'libertad',
    'austrian silver philharmonic', 'austrian gold philharmonic',
    'silver philharmonic', 'gold philharmonic', 'philharmonic',
    'british silver britannia', 'british gold britannia',
    'lunar britannia', 'britannia lunar', 'perth lunar', 'australian lunar',
    'silver britannia', 'gold britannia', 'britannia',
    'chinese silver panda', 'chinese gold panda',
    'silver panda', 'gold panda', 'panda',
    'silver kookaburra', 'kookaburra',
    'gold kangaroo', 'kangaroo', 'nugget',
    'silver krugerrand', 'gold krugerrand', 'krugerrand',
    // US bullion & classic
    'american gold buffalo', 'gold buffalo',
    'american silver eagle', 'american gold eagle',
    'silver eagle', 'gold eagle',
    'walking liberty', 'standing liberty',
    'seated liberty', 'indian head', 'saint gaudens', 'st gaudens',
    'liberty nickel', 'flowing hair', 'capped bust', 'draped bust',
    'trade dollar',
    'morgan', 'peace', 'barber', 'mercury', 'roosevelt',
    'washington', 'lincoln', 'jefferson', 'buffalo nickel', 'buffalo',
    'eisenhower', 'ike', 'kennedy', 'franklin',
    'shield', 'ase', 'sae',
    // Denomination fallbacks (last resort)
    'wheat penny', 'wheat cent', 'steel penny', 'steel cent',
    'penny', 'cent',
  ];
  for (const kw of seriesKeywords) {
    if (t.toLowerCase().includes(kw)) {
      result.series = kw.replace(/\b\w/g, c => c.toUpperCase());
      break;
    }
  }

  return result;
}

// ── Response mapper ─────────────────────────────────────────
function _mapResponse(data) {
  if (!data) return _empty('Empty PCGS response');

  // Extract TrueView image from Images array if direct URL not present
  let trueView = data.TrueViewURL || data.TrueViewUrl || null;
  if (!trueView && data.HasTrueViewImage && Array.isArray(data.Images) && data.Images.length) {
    trueView = data.Images[0].Fullsize || data.Images[0].Thumbnail || null;
  }

  return {
    verified: true,
    pcgsCoinNumber: data.PCGSNo || data.pcgsNumber || null,
    series: data.SeriesName || data.Series || data.Denomination || data.Name || null,
    year: data.Year || null,
    mint: data.MintMark || data.MintLocation || null,
    grade: data.Grade || null,
    designation: data.Designation || null,
    variety: data.Variety || data.MajorVariety || null,
    priceGuide: _mapPriceGuide(data),
    population: {
      thisGrade: data.Population ?? data.PopulationThisGrade ?? data.PopsThisGrade ?? null,
      higher: data.PopHigher ?? data.PopulationHigher ?? data.PopsHigher ?? null
    },
    auction: _mapAuction(data),
    trueViewUrl: trueView,
    mintage: data.Mintage || null,
    metalContent: data.MetalContent || null,
    country: data.Country || null,
    limitations: []
  };
}

function _mapPriceGuide(data) {
  const guide = data.PriceGuide || data.priceGuide || {};
  // PriceGuideValue is top-level in the actual PCGS API response
  const value = data.PriceGuideValue ?? guide.Value ?? guide.PriceGuideValue ?? null;
  return {
    grade: data.Grade || null,
    valueUsd: (value && value > 0) ? value : null,
    adjacent: guide.AdjacentGrades || []
  };
}

function _mapAuction(data) {
  // PCGS API uses AuctionList (array) not AuctionData
  const list = data.AuctionList || data.AuctionData || data.auctionResults || null;
  if (!list) return { count: 0, medianUsd: null, highUsd: null };

  // If it's an array of auction records, compute stats
  if (Array.isArray(list)) {
    if (!list.length) return { count: 0, medianUsd: null, highUsd: null };
    const prices = list.map(a => a.Price ?? a.SalePrice).filter(p => p != null && p > 0);
    if (!prices.length) return { count: list.length, medianUsd: null, highUsd: null };
    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
    return {
      count: prices.length,
      medianUsd: +median.toFixed(2),
      highUsd: prices[prices.length - 1]
    };
  }

  // Object format
  return {
    count: list.TotalSales ?? list.Count ?? 0,
    medianUsd: list.MedianPrice ?? list.Median ?? null,
    highUsd: list.HighPrice ?? list.High ?? null
  };
}

function _empty(reason) {
  return {
    verified: false,
    pcgsCoinNumber: null,
    series: null,
    year: null,
    mint: null,
    grade: null,
    designation: null,
    variety: null,
    priceGuide: null,
    population: null,
    auction: null,
    trueViewUrl: null,
    limitations: [reason]
  };
}

module.exports = {
  lookupByCert,
  lookupByCoinNumberAndGrade,
  resolveFromDescription,
  parseDescription
};
