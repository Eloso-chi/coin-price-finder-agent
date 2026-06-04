// src/utils/coinIntent.js -- canonicalize user-supplied coin intent
// across input sources for the comp-filter pipeline.  See backlog #254.
//
// History: priceRoute and pricingBatchRoute each had their own (subtly
// different) expression that derived `expected.grade`, `expected.finish`,
// and `expected.isProof`.  Both silently dropped several common shapes a
// UI or API caller could reasonably send (lowercase finish, isProof flag,
// coinData.grade with no grade word in query text).  This module is the
// single source of truth.
'use strict';

// PCGS-canonical finish spelling.  Downstream classifiers compare against
// `expected.finish` literally, so we normalize on the way in.
const FINISH_CANONICAL = {
  'proof':                     'Proof',
  'reverse proof':             'Reverse Proof',
  'reverse-proof':             'Reverse Proof',
  'enhanced reverse proof':    'Enhanced Reverse Proof',
  'enhanced reverse-proof':    'Enhanced Reverse Proof',
  'matte proof':               'Matte Proof',
  'matte-proof':               'Matte Proof',
  'burnished':                 'Burnished',
  'satin finish':              'Satin Finish',
  'satin':                     'Satin Finish',
  'antiqued':                  'Antiqued',
  'business strike':           'Business Strike',
};

/**
 * Extract canonical coin intent (grade / finish / isProof / designation)
 * from the union of structured input, PCGS lookup result, and the
 * parser's read of the raw query text.
 *
 * Precedence: user-explicit structured input wins, then PCGS lookup,
 * then query-text parse.  isSet always nulls grade / isProof (sets are
 * a separate pricing pool).
 *
 * @param {object} args
 * @param {object} [args.coinData] - structured-form input (req.body.coinData)
 * @param {object} [args.options]  - search options (req.body.options)
 * @param {object} [args.parsed]   - pcgsService.parseDescription(query) output
 * @param {object} [args.pcgs]     - PCGS lookup result (may be heuristic)
 * @param {boolean} [args.isSet]   - true if this is a Proof/Mint Set lookup
 * @returns {{grade: string|null, finish: string|null, isProof: boolean, designation: string|null}}
 */
function extractCoinIntent({ coinData, options, parsed, pcgs, isSet } = {}) {
  coinData = coinData || {};
  options  = options  || {};
  parsed   = parsed   || {};
  pcgs     = pcgs     || {};

  // ── Grade ──
  // User-explicit (structured form) wins over heuristic PCGS resolution
  // and over parsed-from-text.  isSet nulls grade entirely.
  // Coerce to string so downstream `.match(/\d+/)` callers don't throw
  // if an API caller sends a numeric grade.
  const rawGrade = coinData.grade || pcgs.grade || parsed.grade || null;
  const grade = isSet || rawGrade == null ? null : String(rawGrade);

  // ── Finish ──
  // Accept any case / hyphenation; normalize to PCGS spelling.
  // Unknown finishes pass through unchanged (don't drop signal).
  const rawFinish = String(coinData.finish || parsed.finish || '').trim();
  const finish = rawFinish
    ? (FINISH_CANONICAL[rawFinish.toLowerCase()] || rawFinish)
    : null;

  // ── Designation (DCAM/CAM/PL/DMPL/FS/FB/FBL/etc.) ──
  const designation = pcgs.designation || coinData.designation || parsed.designation || null;

  // ── isProof ──
  // True if ANY signal indicates a proof strike.  Reverse Proof /
  // Enhanced Reverse Proof / Matte Proof all carry the word "proof".
  // Set lookups are always non-proof (the set itself may contain proofs;
  // pricing them works on a different pool).
  // Accept boolean true and the string "true" -- HTML forms and several
  // JSON serializers emit the latter.
  const isExplicitTrue = (v) => v === true || v === 'true';
  const explicitFlag        = isExplicitTrue(options.isProof) || isExplicitTrue(coinData.isProof);
  const finishIsProof       = /\bproof\b/i.test(finish || '');
  const designationIsProof  = /^(PR|PF)\s*[-]?\s*\d/i.test(String(designation || ''));
  const gradeIsProof        = /^(PR|PF)[-\s]?\d/i.test(String(grade || ''))
                           || /^proof$/i.test(String(grade || ''));
  const parsedGradeIsProof  = parsed.grade === 'Proof';

  const isProof = !isSet && (
    explicitFlag ||
    finishIsProof ||
    designationIsProof ||
    gradeIsProof ||
    parsedGradeIsProof
  );

  return { grade, finish, isProof, designation };
}

module.exports = { extractCoinIntent, FINISH_CANONICAL };
