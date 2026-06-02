// src/utils/redactForPublic.js
// CommonJS
//
// Purpose: mask the licensed-data provenance label on sold comps before they
// leave the server to non-admin callers. eBay Seller Hub Research (Terapeak)
// data is provided under terms that restrict redistribution; advertising
// `_source: "terapeak"` on every comp in a public response is the most
// defensible thing to strip. The comp payload itself (title/price/sold date/
// url) is retained so the public UI's "sold comps" tables keep rendering --
// see BACKLOG #243 for the broader compliance discussion (option C, full
// strip-to-stats, is captured there if compliance ever escalates).
//
// Single responsibility: walk the response, rewrite the `_source` field on
// every comp object from `'terapeak'` to `'ebay-sold'`. Idempotent.

'use strict';

/**
 * Rewrite `_source: "terapeak"` -> `_source: "ebay-sold"` on every comp
 * object found under `ebay.us.comps`, `ebay.global.comps`, and (for batch
 * routes) any `comps` array nested one level deeper inside a `results`
 * array. The containing `comps` arrays are reassigned with shallow-cloned
 * comp objects so upstream caches that share comp references are NOT
 * mutated -- this is critical because terapeakService returns comp objects
 * from an in-memory dataset cache that is reused across requests, and a
 * non-admin call MUST NOT poison the cached `_source` value seen by a
 * subsequent admin call.
 *
 * No-op when `isAdmin === true`.
 *
 * @param {object} response  The about-to-be-sent JSON object. The top-level
 *                           `ebay.us`, `ebay.global` (and per-result
 *                           equivalents) objects are mutated to point at
 *                           freshly-cloned `comps` arrays; the original
 *                           comp objects are left untouched.
 * @param {boolean} isAdmin  Caller's admin context (req.isAdmin).
 * @returns {object} The same response object (for chaining).
 */
function redactCompsForPublic(response, isAdmin) {
  if (isAdmin === true) return response;
  if (!response || typeof response !== 'object') return response;

  // Single-coin price route shape: response.ebay.{us,global}.comps[]
  if (response.ebay && typeof response.ebay === 'object') {
    response.ebay = _cloneEbay(response.ebay);
  }

  // Batch route shape: response.results[].ebay.{us,global}.comps[]
  if (Array.isArray(response.results)) {
    for (const r of response.results) {
      if (r && r.ebay && typeof r.ebay === 'object') {
        r.ebay = _cloneEbay(r.ebay);
      }
    }
  }

  return response;
}

// Shallow-clone ebay + each side that contains a comps[] so we never mutate
// objects held by the upstream ebayService TTL cache.
function _cloneEbay(ebay) {
  const out = { ...ebay };
  if (out.us && typeof out.us === 'object' && Array.isArray(out.us.comps)) {
    out.us = { ...out.us, comps: out.us.comps.map(_redactComp) };
  }
  if (out.global && typeof out.global === 'object' && Array.isArray(out.global.comps)) {
    out.global = { ...out.global, comps: out.global.comps.map(_redactComp) };
  }
  return out;
}

function _redactComp(c) {
  if (!c || typeof c !== 'object') return c;
  if (c._source !== 'terapeak') return c;
  return { ...c, _source: 'ebay-sold' };
}

module.exports = { redactCompsForPublic };
