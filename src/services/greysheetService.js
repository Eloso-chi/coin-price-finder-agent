// src/services/greysheetService.js — CDN Public API V2 (Greysheet) integration
// CommonJS

'use strict';

const axios = require('axios');
const path  = require('path');
const fs    = require('fs');
const { TTLCache } = require('../utils/cache');

// ── Config ──────────────────────────────────────────────────
const GS_API_TOKEN = process.env.GREYSHEET_API_TOKEN || '';
const GS_API_KEY   = process.env.GREYSHEET_API_KEY   || '';
const GS_BASE      = (process.env.GREYSHEET_BASE_URL || 'https://cpgpublicapiv2.greysheet.com/api').replace(/\/+$/, '');
const TIMEOUT       = 10_000;

// Ensure cache directory exists
const CACHE_DIR = require('../utils/cachePath').CACHE_DIR;

const cache = new TTLCache({
  defaultTTL: 86_400_000,  // 24h
  filePath: path.join(CACHE_DIR, 'greysheet_cache.json')
});

// ── HTTP helper with retry ──────────────────────────────────
async function gsGet(endpoint, params, retries = 2) {
  const url = `${GS_BASE}/${endpoint}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await axios.get(url, {
        params,
        headers: {
          'x-api-token': GS_API_TOKEN,
          'x-api-key':   GS_API_KEY,
          Accept:        'application/json'
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

// ── Parse numeric grade from label like "MS65", "PR70", "XF45" ──
function parseGradeNum(gradeStr) {
  if (!gradeStr) return null;
  const m = String(gradeStr).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ── Public methods ──────────────────────────────────────────

/**
 * Fetch Greysheet pricing for a coin by PCGS coin number + grade.
 *
 * @param {string|number} pcgsNumber – PCGS coin number (e.g. "7130")
 * @param {number}        grade      – numeric grade (e.g. 65)
 * @returns {object|null} { greyVal, cpgVal, pcgsVal, ngcVal, blueBookVal, gsid, name, grade, gradeLabel } or null
 */
async function fetchPriceByPcgsNumber(pcgsNumber, grade) {
  if (!GS_API_TOKEN || !GS_API_KEY) return null;
  if (!pcgsNumber) return null;

  const numGrade = typeof grade === 'number' ? grade : parseGradeNum(grade);
  const cacheKey = `gs:pcgs:${pcgsNumber}:${numGrade || 'all'}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const params = {
      PcgsNumber: String(pcgsNumber),
      ApiLevel: 'advanced'
    };
    if (numGrade) params.Grade = numGrade;

    const resp = await gsGet('GetPricingRequest', params);

    if (!resp?.Data?.length || resp.OpCode !== 200) {
      cache.set(cacheKey, null);
      return null;
    }

    const item = resp.Data[0];
    const pricing = (item.PricingData || [])
      .filter(p => !p.IsCac)  // Use non-CAC pricing row
      .find(p => numGrade ? p.Grade === numGrade : true);

    if (!pricing) {
      cache.set(cacheKey, null);
      return null;
    }

    const result = {
      greyVal:     pricing.GreyVal  ? parseFloat(pricing.GreyVal)  : null,
      cpgVal:      pricing.CpgVal   ? parseFloat(pricing.CpgVal)   : null,
      pcgsVal:     pricing.PcgsVal  ? parseFloat(pricing.PcgsVal)  : null,
      ngcVal:      pricing.NgcVal   ? parseFloat(pricing.NgcVal)   : null,
      blueBookVal: pricing.BlueBookVal ? parseFloat(pricing.BlueBookVal) : null,
      gsid:        item.GsId,
      name:        (item.Name || '').trim(),
      grade:       pricing.Grade,
      gradeLabel:  pricing.GradeLabel || ''
    };

    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    // Non-fatal: log and return null so valuation can proceed without Greysheet
    if (process.env.NODE_ENV !== 'test') {
      console.error(`[greysheetService] fetchPriceByPcgsNumber(${pcgsNumber}, ${grade}):`, err.message);
    }
    return null;
  }
}

/**
 * Fetch Greysheet pricing by GSID + optional grade.
 *
 * @param {number}        gsid  – Greysheet catalog ID
 * @param {number|null}   grade – numeric grade (optional)
 * @returns {object|null}
 */
async function fetchPriceByGsid(gsid, grade) {
  if (!GS_API_TOKEN || !GS_API_KEY) return null;
  if (!gsid) return null;

  const numGrade = typeof grade === 'number' ? grade : parseGradeNum(grade);
  const cacheKey = `gs:gsid:${gsid}:${numGrade || 'all'}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const params = {
      Gsid: gsid,
      ApiLevel: 'advanced'
    };
    if (numGrade) params.Grade = numGrade;

    const resp = await gsGet('GetPricingRequest', params);

    if (!resp?.Data?.length || resp.OpCode !== 200) {
      cache.set(cacheKey, null);
      return null;
    }

    const item = resp.Data[0];
    const pricing = (item.PricingData || [])
      .filter(p => !p.IsCac)
      .find(p => numGrade ? p.Grade === numGrade : true);

    if (!pricing) {
      cache.set(cacheKey, null);
      return null;
    }

    const result = {
      greyVal:     pricing.GreyVal  ? parseFloat(pricing.GreyVal)  : null,
      cpgVal:      pricing.CpgVal   ? parseFloat(pricing.CpgVal)   : null,
      pcgsVal:     pricing.PcgsVal  ? parseFloat(pricing.PcgsVal)  : null,
      ngcVal:      pricing.NgcVal   ? parseFloat(pricing.NgcVal)   : null,
      blueBookVal: pricing.BlueBookVal ? parseFloat(pricing.BlueBookVal) : null,
      gsid:        item.GsId,
      name:        (item.Name || '').trim(),
      grade:       pricing.Grade,
      gradeLabel:  pricing.GradeLabel || ''
    };

    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.error(`[greysheetService] fetchPriceByGsid(${gsid}, ${grade}):`, err.message);
    }
    return null;
  }
}

/**
 * Fetch collectible metadata by GSID.
 * Useful for discovering GSIDs and cross-referencing catalog data.
 *
 * @param {number} gsid
 * @returns {object|null}
 */
async function fetchCollectible(gsid) {
  if (!GS_API_TOKEN || !GS_API_KEY) return null;
  if (!gsid) return null;

  const cacheKey = `gs:collectible:${gsid}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const resp = await gsGet('GetCollectibleRequest', {
      GsId: gsid,
      ApiLevel: 'advanced'
    });

    if (!resp?.Data?.length || resp.OpCode !== 200) {
      cache.set(cacheKey, null);
      return null;
    }

    const c = resp.Data[0];
    const result = {
      gsid:        c.Gsid,
      name:        (c.Name || '').trim(),
      pcgsNumber:  c.PcgsNumber || null,
      coinDate:    c.CoinDate || null,
      denomination: (c.DenominationShort || '').trim(),
      designation: c.Desg || null,
      mintMark:    c.MintMark || null,
      composition: c.Composition || null,
      mintage:     c.Mintage || null,
      fineness:    c.Fineness ? parseFloat(c.Fineness) : null,
      weightOz:    c.WeightOunces || null,
      strikeType:  c.StrikeType || null
    };

    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.error(`[greysheetService] fetchCollectible(${gsid}):`, err.message);
    }
    return null;
  }
}

/**
 * Fetch Greysheet Type pricing for a generic / yearless coin.
 * Uses the GSID Type map to resolve a series-level price.
 *
 * @param {string} queryText -- free-text coin description
 * @param {number|null} grade -- numeric grade (optional)
 * @param {object} [hints]  -- optional { series, metal, weight }
 * @returns {object|null} same shape as fetchPriceByPcgsNumber result, plus { isType: true, lookupKey }
 */
async function fetchTypePrice(queryText, grade, hints = {}) {
  const { lookupTypeGsid } = require('../data/greysheetTypeMap');
  const match = lookupTypeGsid(queryText, hints);
  if (!match) return null;

  const result = await fetchPriceByGsid(match.gsid, grade);
  if (!result) return null;

  return { ...result, isType: true, lookupKey: match.lookupKey };
}

module.exports = {
  fetchPriceByPcgsNumber,
  fetchPriceByGsid,
  fetchCollectible,
  fetchTypePrice,
  // Exposed for testing
  _cache: cache
};
