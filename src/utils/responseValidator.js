// src/utils/responseValidator.js — Runtime response validation
// CommonJS
//
// Validates the final JSON response from POST /api/price to ensure
// completeness, consistency, and logical correctness.

'use strict';

const { hasSeriesConflict, detectDenomination } = require('./filters');

// ── Schema: required top-level keys and their types ─────────
const TOP_LEVEL_KEYS = [
  'query', 'identification', 'pcgs', 'ebay', 'valuation', 'decisions'
];

// Valuation sub-keys that must be present and numeric (or null only when no data)
const VALUATION_NUMERIC = ['fmvCore', 'rangeLow', 'rangeHigh', 'confidence'];

// Decisions sub-keys
const BUY_NUMERIC  = ['max70', 'max75', 'max80'];
const SELL_NUMERIC = ['fast', 'normal', 'premium', 'offerFloor'];

/**
 * Validate response schema completeness.
 * Returns { valid: boolean, errors: string[] }
 */
function validateSchema(response) {
  const errors = [];
  if (!response || typeof response !== 'object') {
    return { valid: false, errors: ['Response is null or not an object'] };
  }

  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in response)) errors.push(`Missing top-level key: "${key}"`);
  }

  // Valuation
  if (response.valuation) {
    for (const k of VALUATION_NUMERIC) {
      if (!(k in response.valuation)) {
        errors.push(`Missing valuation.${k}`);
      }
    }
    if (!('explanation' in response.valuation)) {
      errors.push('Missing valuation.explanation');
    }
    if (!('dataSource' in response.valuation)) {
      errors.push('Missing valuation.dataSource');
    }
  }

  // Decisions
  if (response.decisions) {
    if (response.decisions.buy) {
      for (const k of BUY_NUMERIC) {
        if (!(k in response.decisions.buy)) errors.push(`Missing decisions.buy.${k}`);
      }
    } else {
      errors.push('Missing decisions.buy');
    }
    if (response.decisions.sell) {
      for (const k of SELL_NUMERIC) {
        if (!(k in response.decisions.sell)) errors.push(`Missing decisions.sell.${k}`);
      }
    } else {
      errors.push('Missing decisions.sell');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate numeric sanity: no NaN, no negative prices, ranges make sense.
 * Only checks when values are non-null (null means "no data").
 */
function validateNumericSanity(response) {
  const errors = [];
  const v = response?.valuation;
  if (!v) return { valid: true, errors };

  // FMV must be non-negative
  if (v.fmvCore != null) {
    if (typeof v.fmvCore !== 'number' || isNaN(v.fmvCore)) {
      errors.push(`fmvCore is not a valid number: ${v.fmvCore}`);
    } else if (v.fmvCore < 0) {
      errors.push(`fmvCore is negative: ${v.fmvCore}`);
    }
  }

  // Range must be ordered: rangeLow ≤ fmvCore ≤ rangeHigh
  if (v.fmvCore != null && v.rangeLow != null && v.rangeHigh != null) {
    if (v.rangeLow > v.fmvCore) {
      errors.push(`rangeLow (${v.rangeLow}) > fmvCore (${v.fmvCore})`);
    }
    if (v.rangeHigh < v.fmvCore) {
      errors.push(`rangeHigh (${v.rangeHigh}) < fmvCore (${v.fmvCore})`);
    }
    if (v.rangeLow > v.rangeHigh) {
      errors.push(`rangeLow (${v.rangeLow}) > rangeHigh (${v.rangeHigh})`);
    }
  }

  // Confidence must be 0–100
  if (v.confidence != null) {
    if (typeof v.confidence !== 'number' || isNaN(v.confidence)) {
      errors.push(`confidence is not a valid number: ${v.confidence}`);
    } else if (v.confidence < 0 || v.confidence > 100) {
      errors.push(`confidence out of range [0,100]: ${v.confidence}`);
    }
  }

  // Buy decisions should be ordered: max70 ≤ max75 ≤ max80
  const d = response?.decisions?.buy;
  if (d && d.max70 != null && d.max75 != null && d.max80 != null) {
    if (d.max70 > d.max75) errors.push(`max70 (${d.max70}) > max75 (${d.max75})`);
    if (d.max75 > d.max80) errors.push(`max75 (${d.max75}) > max80 (${d.max80})`);
  }

  // Sell decisions: fast ≤ normal ≤ premium
  const s = response?.decisions?.sell;
  if (s && s.fast != null && s.normal != null && s.premium != null) {
    if (s.fast > s.normal) errors.push(`sell.fast (${s.fast}) > sell.normal (${s.normal})`);
    if (s.normal > s.premium) errors.push(`sell.normal (${s.normal}) > sell.premium (${s.premium})`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate series/identity consistency:
 * - If query says "Jefferson", no PCGS series should say "Buffalo"
 * - If query says "Kennedy", comps shouldn't be Franklin
 * - Denomination of response matches query denomination
 */
function validateSeriesIntegrity(response) {
  const errors = [];

  const queryInput = response?.query?.input || response?.identification?.inputQuery || '';
  const resolvedSeries = response?.pcgs?.series || response?.identification?.parsed?.series || '';

  // Check PCGS series doesn't conflict with query
  if (queryInput && resolvedSeries) {
    if (hasSeriesConflict(queryInput, resolvedSeries)) {
      errors.push(`Series conflict: query "${queryInput}" vs resolved series "${resolvedSeries}"`);
    }
  }

  // Check denomination consistency
  const queryDenom = detectDenomination(queryInput);
  const pcgsDenom = detectDenomination(resolvedSeries);
  if (queryDenom && pcgsDenom && queryDenom !== pcgsDenom) {
    errors.push(`Denomination mismatch: query="${queryDenom}" vs pcgs="${pcgsDenom}"`);
  }

  // Check eBay comps don't have series conflicts
  const comps = response?.ebay?.us?.comps || [];
  let conflictCount = 0;
  for (const c of comps) {
    if (resolvedSeries && hasSeriesConflict(resolvedSeries, c.title || '')) {
      conflictCount++;
    }
  }
  if (conflictCount > 0) {
    errors.push(`${conflictCount} eBay comps have series conflicts with resolved series "${resolvedSeries}"`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate FMV is reasonable relative to comps.
 * FMV should not be wildly outside the comp price range.
 */
function validateFMVReasonability(response) {
  const errors = [];
  const fmv = response?.valuation?.fmvCore;
  if (fmv == null) return { valid: true, errors };

  const comps = response?.ebay?.us?.comps || [];
  const prices = comps.map(c => c.totalUsd).filter(p => p != null);
  if (prices.length < 3) return { valid: true, errors }; // not enough data

  const min = Math.min(...prices);
  const max = Math.max(...prices);

  // FMV should not be more than 3× the max comp or less than 1/3 of min comp
  if (fmv > max * 3) {
    errors.push(`FMV ($${fmv}) is >3× the max comp ($${max})`);
  }
  if (fmv < min / 3) {
    errors.push(`FMV ($${fmv}) is <1/3 the min comp ($${min})`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Run all validations and return a combined result.
 */
function validateResponse(response) {
  const results = {
    schema: validateSchema(response),
    numeric: validateNumericSanity(response),
    series: validateSeriesIntegrity(response),
    fmvReasonability: validateFMVReasonability(response),
  };

  const allErrors = [];
  for (const [category, result] of Object.entries(results)) {
    for (const err of result.errors) {
      allErrors.push(`[${category}] ${err}`);
    }
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    details: results,
  };
}

module.exports = {
  validateSchema,
  validateNumericSanity,
  validateSeriesIntegrity,
  validateFMVReasonability,
  validateResponse,
};
