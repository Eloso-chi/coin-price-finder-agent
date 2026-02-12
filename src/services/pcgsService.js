// src/services/pcgsService.js — PCGS Public API integration
// CommonJS

const axios = require('axios');
require('dotenv').config();
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

  // Proof
  if (/\bproof\b/i.test(t) && !result.grade) {
    result.grade = 'Proof';
  }

  // Series heuristics (common U.S. series keywords)
  const seriesKeywords = [
    'morgan', 'peace', 'walking liberty', 'seated liberty',
    'standing liberty', 'barber', 'mercury', 'roosevelt',
    'washington', 'lincoln', 'jefferson', 'buffalo',
    'indian head', 'saint gaudens', 'eisenhower', 'ike',
    'kennedy', 'franklin', 'trade dollar', 'draped bust',
    'flowing hair', 'capped bust', 'shield', 'liberty nickel',
    'american silver eagle', 'ase', 'sae'
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

  return {
    verified: true,
    pcgsCoinNumber: data.PCGSNo || data.pcgsNumber || null,
    series: data.Series || data.Denomination || null,
    year: data.Year || null,
    mint: data.MintMark || null,
    grade: data.Grade || null,
    designation: data.Designation || null,
    variety: data.Variety || data.MajorVariety || null,
    priceGuide: _mapPriceGuide(data),
    population: {
      thisGrade: data.PopulationThisGrade ?? data.PopsThisGrade ?? null,
      higher: data.PopulationHigher ?? data.PopsHigher ?? null
    },
    auction: _mapAuction(data),
    trueViewUrl: data.TrueViewURL || data.TrueViewUrl || null,
    limitations: []
  };
}

function _mapPriceGuide(data) {
  const guide = data.PriceGuide || data.priceGuide || {};
  return {
    grade: data.Grade || null,
    valueUsd: guide.Value ?? guide.PriceGuideValue ?? null,
    adjacent: guide.AdjacentGrades || []
  };
}

function _mapAuction(data) {
  const auc = data.AuctionData || data.auctionResults || null;
  if (!auc) return { count: 0, medianUsd: null, highUsd: null };
  return {
    count: auc.TotalSales ?? auc.Count ?? 0,
    medianUsd: auc.MedianPrice ?? auc.Median ?? null,
    highUsd: auc.HighPrice ?? auc.High ?? null
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
