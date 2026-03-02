// src/services/pcgsService.js — PCGS Public API integration
// CommonJS

const axios = require('axios');
const { TTLCache } = require('../utils/cache');
const { lookupPCGSNumber } = require('../data/pcgsNumbers');

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
    // Use documented query-param endpoint (GetCoinFactsByGrade)
    const plusGrade = String(gradeNum).includes('+');
    const gradeInt = parseInt(String(gradeNum).replace('+', ''), 10) || 65;
    const data = await pcgsGet(
      `/coindetail/GetCoinFactsByGrade?PCGSNo=${pcgsCoinNumber}&GradeNo=${gradeInt}&PlusGrade=${plusGrade}`
    );
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
  // ── Parse description into tokens (always, even without API key) ──
  const parsed = parseDescription(text);

  if (!PCGS_API_KEY) {
    // No API key — return best-effort parsed data so the frontend
    // still gets series, year, weight, metal, etc. for eBay + melt.
    const pcgsNo = lookupPCGSNumber(parsed.series || '', parsed.year, parsed.mint);
    return {
      verified: false,
      pcgsCoinNumber: pcgsNo || null,
      series: parsed.series || null,
      year: parsed.year || null,
      mint: parsed.mint || null,
      grade: parsed.grade || null,
      designation: parsed.designation || null,
      finish: parsed.finish || null,
      variety: null,
      priceGuide: null,
      population: null,
      auction: null,
      trueViewUrl: null,
      coinImages: [],
      parsed,
      limitations: ['PCGS API key not configured; using parsed description']
    };
  }

  // ── Quick cert-number detection ──
  const certMatch = text.match(/\b(\d{7,9})\b/);
  if (certMatch) {
    const result = await lookupByCert(certMatch[1]);
    if (result.verified) return result;
  }

  // Try PCGS search endpoint
  try {
    const cacheKey = `pcgs:desc:${text.toLowerCase().trim()}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const data = await pcgsGet(`/coindetail/Search?query=${encodeURIComponent(text)}`);
    if (data && (Array.isArray(data) ? data.length : data.PCGSNo)) {
      const coin = Array.isArray(data) ? data[0] : data;
      const result = _mapResponse(coin);

      // ── Sanity-check: reject API results that contradict the parsed query ──
      // The PCGS Search endpoint occasionally returns the wrong coin
      // (e.g. "Buffalo" when the user asked for "Jefferson").
      const apiYear = result.year;
      const apiSeries = (result.series || '').toLowerCase();
      let trustResult = true;

      // Year mismatch: if the parsed year exists and API returned a different year, reject.
      if (parsed.year && apiYear && parsed.year !== apiYear) {
        console.warn(`[pcgs] Search result year mismatch: parsed ${parsed.year}, API returned ${apiYear} — falling through to local table`);
        trustResult = false;
      }

      // Series mismatch: if we know the series from parsing (e.g. "Jefferson")
      // and the API returned a clearly different series (e.g. "Buffalo"),
      // reject the result.  Compare key tokens from the parsed series.
      if (trustResult && parsed.series) {
        const parsedSeriesLow = parsed.series.toLowerCase();
        const CONFLICTING_PAIRS = [
          ['jefferson', 'buffalo'], ['kennedy', 'franklin'], ['kennedy', 'walking liberty'],
          ['franklin', 'walking liberty'], ['washington', 'standing liberty'],
          ['roosevelt', 'mercury'], ['roosevelt', 'barber'], ['mercury', 'barber'],
          ['morgan', 'peace'], ['lincoln', 'indian head'], ['lincoln', 'indian'],
        ];
        for (const [a, b] of CONFLICTING_PAIRS) {
          const parsedHasA = parsedSeriesLow.includes(a);
          const parsedHasB = parsedSeriesLow.includes(b);
          const apiHasA = apiSeries.includes(a);
          const apiHasB = apiSeries.includes(b);
          if ((parsedHasA && apiHasB && !apiHasA) || (parsedHasB && apiHasA && !apiHasB)) {
            console.warn(`[pcgs] Search result series mismatch: parsed "${parsed.series}", API returned "${result.series}" — falling through to local table`);
            trustResult = false;
            break;
          }
        }
      }

      if (trustResult) {
        cache.set(cacheKey, result);
        return result;
      }
      // Otherwise fall through to local PCGS table lookup
    }
  } catch (_) { /* fall through */ }

  // ── Try static PCGS coin number table ──
  const pcgsNo = lookupPCGSNumber(
    parsed.series || '',
    parsed.year,
    parsed.mint
  );
  if (pcgsNo && parsed.gradeNum) {
    const tableResult = await lookupByCoinNumberAndGrade(pcgsNo, parsed.gradeNum);
    if (tableResult.verified) {
      // Validate: if PCGS returned a different year or conflicting series, reject.
      const apiYear = tableResult.year;
      const apiSeries = (tableResult.series || '').toLowerCase();
      let trustTable = true;

      if (parsed.year && apiYear && parsed.year !== apiYear) {
        console.warn(`[pcgs] Table result year mismatch: parsed ${parsed.year}, API returned ${apiYear} for PCGS#${pcgsNo}`);
        trustTable = false;
      }

      if (trustTable && parsed.series) {
        const parsedLow = parsed.series.toLowerCase();
        const CONFLICTING_PAIRS = [
          ['jefferson', 'buffalo'], ['kennedy', 'franklin'], ['kennedy', 'walking liberty'],
          ['franklin', 'walking liberty'], ['washington', 'standing liberty'],
          ['roosevelt', 'mercury'], ['morgan', 'peace'], ['lincoln', 'indian'],
        ];
        for (const [a, b] of CONFLICTING_PAIRS) {
          if ((parsedLow.includes(a) && apiSeries.includes(b) && !apiSeries.includes(a))
            || (parsedLow.includes(b) && apiSeries.includes(a) && !apiSeries.includes(b))) {
            console.warn(`[pcgs] Table result series mismatch: parsed "${parsed.series}", API returned "${tableResult.series}" for PCGS#${pcgsNo}`);
            trustTable = false;
            break;
          }
        }
      }

      if (trustTable) {
        tableResult.parsed = parsed;
        const cacheKey = `pcgs:desc:${text.toLowerCase().trim()}`;
        cache.set(cacheKey, tableResult);
        return tableResult;
      }
      // Fall through to best-effort if validation failed
    }
  }

  // Return best-effort parsed data without verification
  return {
    verified: false,
    pcgsCoinNumber: pcgsNo || null,
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

  // Mint mark — try year-adjacent first (e.g. "1960-D", "1881-CC"), then standalone
  const mintMatch = t.match(/\b(\d{4})\s*[-]?\s*(CC|[SDPWO])\b/i);
  if (mintMatch) {
    result.mint = mintMatch[2].toUpperCase();
  } else {
    // Standalone mint mark: single letter S/D/O/W or two-letter CC
    const standalone = t.match(/(?:^|[\s-])(CC)\b/i)
      || t.match(/(?:\bmint\s*(?:mark)?:?\s*|\b(?:cent|dollar|dime|quarter|half|nickel|penny|eagle)\s+)([SDPWO])\b/i)
      || t.match(/\b([SDOW])\s+(?:mint)\b/i);
    if (standalone) result.mint = (standalone[1] || standalone[2]).toUpperCase();
  }

  // Grade: MS/PR/SP/PF + number, optional +
  const gradeMatch = t.match(/\b(MS|PR|PF|SP|AU|XF|EF|VF|F|VG|G|AG|PO)\s*[-]?\s*(\d{1,2})(\+)?(?!\w)/i);
  if (gradeMatch) {
    let prefix = gradeMatch[1].toUpperCase();
    if (prefix === 'PF') prefix = 'PR';
    if (prefix === 'EF') prefix = 'XF';  // normalize EF → XF (PCGS standard)
    result.grade = `${prefix}${gradeMatch[2]}${gradeMatch[3] || ''}`;
    result.gradeNum = parseInt(gradeMatch[2], 10);
  }

  // BU / UNC grade terms (no numeric suffix) — map to approximate MS grades
  // Must come AFTER formal grade regex so "MS-65 BU" doesn't override MS-65.
  if (!result.grade) {
    const buMatch = t.match(/\b(superb\s+gem\s+BU|gem\s+BU|choice\s+BU|BU|UNC)\b/i);
    if (buMatch) {
      const term = buMatch[0].toLowerCase().replace(/\s+/g, ' ').trim();
      if (/superb\s+gem/i.test(term))      { result.grade = 'MS67'; result.gradeNum = 67; }
      else if (/gem/i.test(term))           { result.grade = 'MS65'; result.gradeNum = 65; }
      else if (/choice/i.test(term))        { result.grade = 'MS63'; result.gradeNum = 63; }
      else                                  { result.grade = 'MS60'; result.gradeNum = 60; }
      result._gradeSource = 'bu-term';
    }
  }

  // Bare word grades without numbers (e.g. "Fine", "Very Good", "Poor")
  // Must come AFTER formal grade + BU detection.
  if (!result.grade) {
    const WORD_GRADES = [
      { re: /\babout\s+uncirculated\b/i,  grade: 'AU50', num: 50 },
      { re: /\bextremely\s+fine\b/i,      grade: 'XF40', num: 40 },
      { re: /\bvery\s+fine\b/i,           grade: 'VF20', num: 20 },
      { re: /\bvery\s+good\b/i,           grade: 'VG8',  num: 8 },
      { re: /\b(?:^|\s)fine\b(?!\s+silver)/i, grade: 'F12', num: 12 },  // exclude "fine silver"
      { re: /\b(?:^|\s)good\b(?!\s+(?:luck|condition|deal|price|quality))/i, grade: 'G4', num: 4 },
      { re: /\bpoor\b/i,                  grade: 'PO1',  num: 1 },
    ];
    for (const { re, grade, num } of WORD_GRADES) {
      if (re.test(t)) {
        result.grade = grade;
        result.gradeNum = num;
        result._gradeSource = 'word-grade';
        break;
      }
    }
  }

  // Designation: DCAM, CAM, PL, DPL, FB, FBL, FS, FH, RD, RB, BN
  const desMatch = t.match(/\b(DCAM|CAM|PL|DPL|FB|FBL|FS|FH|RD|RB|BN)\b/i);
  if (desMatch) result.designation = desMatch[1].toUpperCase();

  // ── Finish / special strike detection ──
  // Must come BEFORE proof/set detection so "reverse proof" isn't reduced to just "Proof".
  // Order matters: longest phrases first.
  const finishPatterns = [
    { re: /\benhanced\s+reverse\s+proof\b/i,  finish: 'Enhanced Reverse Proof' },
    { re: /\breverse\s+proof\b/i,              finish: 'Reverse Proof' },
    { re: /\bburnished\b/i,                     finish: 'Burnished' },
    { re: /\bsatin\s+finish\b/i,               finish: 'Satin Finish' },
    { re: /\bantiqued\b/i,                      finish: 'Antiqued' },
    { re: /\bhigh\s+relief\b/i,                finish: 'High Relief' },
    { re: /\bcolorized\b/i,                     finish: 'Colorized' },
    { re: /\bcoloured\b/i,                      finish: 'Colorized' },
    { re: /\buncirculated\b(?!\s*set)/i,         finish: 'Uncirculated' },
  ];
  for (const { re, finish } of finishPatterns) {
    if (re.test(t)) {
      result.finish = finish;
      break;
    }
  }

  // Roll detection — "lincoln cent roll", "nickel roll", "roll of quarters", etc.
  if (/\brolls?\b/i.test(t)) {
    result.isRoll = true;
  }

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
  } else if (/\bproof\b/i.test(t) && !result.grade && !result.finish) {
    // Standalone "proof" without "set" and without a finish qualifier → grade
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
    // 2026 Semiquincentennial (250th Anniversary) — must be before denomination words
    'semiquincentennial gold $5', 'semiquincentennial $5 gold',
    'semiquincentennial gold coin', 'semiquincentennial $2.50',
    'semiquincentennial silver dollar', 'semiquincentennial silver medal',
    'semiquincentennial clad half', 'semiquincentennial half dollar',
    'semiquincentennial nickel', 'semiquincentennial dime',
    'semiquincentennial quarter', 'semiquincentennial cent',
    'semiquincentennial gold', 'semiquincentennial silver',
    'semiquincentennial medal', 'semiquincentennial',
    '250th anniversary gold', '250th anniversary silver',
    '250th anniversary coin', '250th anniversary',
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
    'perth mint lunar', 'british lunar', 'britannia lunar',
    'lunar britannia', 'perth lunar', 'australian lunar',
    'year of the rat', 'year of the ox', 'year of the tiger',
    'year of the rabbit', 'year of the dragon', 'year of the snake',
    'year of the horse', 'year of the goat', 'year of the monkey',
    'year of the rooster', 'year of the dog', 'year of the pig',
    'silver britannia', 'gold britannia', 'britannia',
    'chinese silver panda', 'chinese gold panda',
    'silver panda', 'gold panda', 'panda',
    'silver kookaburra', 'kookaburra',
    'gold kangaroo', 'kangaroo', 'nugget',
    'silver krugerrand', 'gold krugerrand', 'krugerrand',
    'canadian silver polar bear', 'silver polar bear', 'polar bear',
    // US bullion & classic
    'american gold buffalo', 'gold buffalo',
    'american silver eagle', 'american gold eagle',
    'american platinum eagle', 'american palladium eagle',
    'silver eagle', 'gold eagle', 'platinum eagle', 'palladium eagle',
    // Classic US gold — most-specific first
    'saint gaudens double eagle', 'st gaudens double eagle',
    'st. gaudens double eagle', 'saint-gaudens',
    'saint gaudens', 'st gaudens', 'st. gaudens',
    'liberty head double eagle', 'liberty double eagle', 'double eagle',
    'indian head eagle', 'indian eagle',
    'indian head quarter eagle', 'indian quarter eagle',
    'indian head half eagle', 'indian half eagle',
    'liberty head eagle', 'liberty eagle',
    'liberty head half eagle', 'liberty half eagle',
    'liberty head quarter eagle', 'liberty quarter eagle',
    // Classic US series
    'walking liberty half', 'walking liberty',
    'standing liberty quarter', 'standing liberty',
    'seated liberty dollar', 'seated liberty half', 'seated liberty quarter',
    'seated liberty dime', 'seated liberty',
    'indian head cent', 'indian head penny', 'indian head',
    'liberty nickel', 'flowing hair', 'capped bust', 'draped bust',
    'trade dollar',
    'morgan', 'peace', 'barber', 'mercury', 'roosevelt',
    'washington quarter', 'washington',
    'lincoln', 'jefferson nickel', 'jefferson', 'buffalo nickel', 'buffalo',
    'eisenhower', 'ike', 'kennedy half', 'kennedy', 'franklin half', 'franklin',
    'shield', 'ase', 'sae',
    // Denomination fallbacks (last resort)
    'wheat penny', 'wheat cent', 'steel penny', 'steel cent',
    'half dollar', 'quarter dollar', 'quarter', 'dime', 'nickel',
    'dollar', 'penny', 'cent',
  ];
  for (const kw of seriesKeywords) {
    if (t.toLowerCase().includes(kw)) {
      let seriesName = kw;

      // Zodiac / Lunar coin enrichment: when a "year of the X" matches,
      // preserve mint & program context from the raw query so eBay keywords
      // are specific enough to find the right coin.
      if (/^year of the /.test(kw)) {
        const tLow = t.toLowerCase();
        const prefixParts = [];
        // Mint context
        if (/\bperth\b/i.test(tLow))           prefixParts.push('Perth');
        else if (/\baustralian?\b/i.test(tLow)) prefixParts.push('Australian');
        else if (/\broyal\s*mint\b/i.test(tLow)) prefixParts.push('Royal Mint');
        else if (/\brcm\b|\broyal\s*canadian\b/i.test(tLow)) prefixParts.push('RCM');
        else if (/\bchinese?\b/i.test(tLow))   prefixParts.push('Chinese');
        // Program context
        if (/\blunar\b/i.test(tLow))            prefixParts.push('Lunar');
        // Metal context
        if (/\bsilver\b/i.test(tLow))           prefixParts.push('Silver');
        else if (/\bgold\b/i.test(tLow))        prefixParts.push('Gold');
        else if (/\bplatinum\b/i.test(tLow))    prefixParts.push('Platinum');
        if (prefixParts.length > 0) {
          seriesName = prefixParts.join(' ') + ' ' + kw;
        }
      }

      result.series = seriesName.replace(/\b\w/g, c => c.toUpperCase());
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
  const coinImages = [];
  if (Array.isArray(data.Images) && data.Images.length) {
    for (const img of data.Images) {
      const url = img.Fullsize || img.Thumbnail || null;
      if (url && !coinImages.includes(url)) coinImages.push(url);
    }
    if (!trueView && data.HasTrueViewImage && coinImages.length) {
      trueView = coinImages[0];
    }
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
    coinImages: coinImages,   // All stock reference images (obverse, reverse, etc.)
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
    coinImages: [],
    limitations: [reason]
  };
}

/** Flush the in-memory + on-disk PCGS cache. */
function clearCache() { cache.clear(); }

module.exports = {
  lookupByCert,
  lookupByCoinNumberAndGrade,
  resolveFromDescription,
  parseDescription,
  clearCache
};
