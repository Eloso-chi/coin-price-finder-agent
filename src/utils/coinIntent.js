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

const { canonicalizeBarIntent } = require('../data/barSeries');

const MAX_FINISH_LENGTH = 100;
const MAX_VARIANT_DETAIL_LENGTH = 50;
const SPECIALTY_FINISHES = new Set(['Colorized', 'Antiqued', 'Gilded', 'Burnished', 'High Relief']);
const SPECIALTY_FINISH_FAMILIES = {
  Colorized: 'colorized',
  Antiqued: 'antiqued',
  Gilded: 'gilded',
  Burnished: 'burnished',
  'High Relief': 'highRelief',
};
const SPECIALTY_TITLE_TOKENS = {
  colorized: ['colorized', 'colourized', 'colorised', 'coloured', 'enameled', 'enamelled', 'painted', 'full color', 'full-colour', 'spot color', 'spot-colour'],
  antiqued: ['antiqued', 'antique finish'],
  gilded: ['gilded', 'guilded', 'gold plated', 'gold-plated', 'golden finish', 'gilt'],
  burnished: ['burnished'],
  highRelief: ['high relief', 'ultra high relief', 'uhr'],
};

// Shared Reverse Proof / Enhanced Reverse Proof detection (#260W review m3).
// Three sites previously each had their own regex with subtly different
// strictness (valuationService and ebayService used the loose `/reverse[\s-]*proof/i`
// which also matches "reverseproof" or words with no separator; coinHistoryRoute
// used the stricter `\b(enhanced[\s-]+)?reverse[\s-]+proof\b`).  All three now
// import this single helper using the stricter form.  Canonical inputs from
// FINISH_CANONICAL ("Reverse Proof", "Enhanced Reverse Proof") and free-text
// query strings ("2023 Reverse Proof Morgan Dollar") both match.
const REVERSE_PROOF_RE = /\b(enhanced[\s-]+)?reverse[\s-]+proof\b/i;

function isReverseProofFinish(s) {
  return REVERSE_PROOF_RE.test(String(s || ''));
}

function ownString(object, property) {
  return object
    && Object.prototype.hasOwnProperty.call(object, property)
    && typeof object[property] === 'string'
    ? object[property]
    : null;
}

function isValidFinishInput(value) {
  return value == null || (typeof value === 'string' && value.length <= MAX_FINISH_LENGTH);
}

function isValidVariantDetailInput(value) {
  return value == null || (typeof value === 'string'
    && value.length <= MAX_VARIANT_DETAIL_LENGTH
    && !/(?:^|\s)[+-]/.test(value)
    && (value === '' || /^[A-Za-z0-9][A-Za-z0-9 ._+=-]*$/.test(value)));
}

function isSpecialtyFinish(value) {
  if (value == null) return false;
  const normalized = String(value).trim();
  const canonical = FINISH_CANONICAL[normalized.toLowerCase()] || normalized;
  return SPECIALTY_FINISHES.has(canonical);
}

function specialtyFinishFamily(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  const canonical = FINISH_CANONICAL[normalized.toLowerCase()] || normalized;
  return SPECIALTY_FINISH_FAMILIES[canonical] || null;
}

function detectSpecialtyFinishFamilies(value) {
  const text = String(value || '').toLowerCase();
  const families = new Set();
  for (const [family, tokens] of Object.entries(SPECIALTY_TITLE_TOKENS)) {
    if (tokens.some(token => text.includes(token))) families.add(family);
  }
  return families;
}

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
  'colorized':                 'Colorized',
  'colourized':                'Colorized',
  'coloured':                  'Colorized',
  'gilded':                    'Gilded',
  'satin finish':              'Satin Finish',
  'satin':                     'Satin Finish',
  'antiqued':                  'Antiqued',
  'high relief':               'High Relief',
  'ultra high relief':         'High Relief',
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

  const rawBarBrand = ownString(coinData, 'barBrand') || ownString(parsed, 'barBrand');
  const rawBarSeries = ownString(coinData, 'barSeries') || ownString(parsed, 'barSeries');
  const { barBrand, barSeries } = canonicalizeBarIntent(rawBarBrand, rawBarSeries);

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
  const designationIsProof  = /^(PR|PF)/i.test(String(designation || '')) && /\d/.test(String(designation || ''));
  const gradeIsProof        = /^(PR|PF)/i.test(String(grade || '')) && /\d/.test(String(grade || ''))
                           || /^proof$/i.test(String(grade || ''));
  const parsedGradeIsProof  = parsed.grade === 'Proof';

  const isProof = !isSet && (
    explicitFlag ||
    finishIsProof ||
    designationIsProof ||
    gradeIsProof ||
    parsedGradeIsProof
  );

  return { grade, finish, isProof, designation, barBrand, barSeries };
}

module.exports = {
  extractCoinIntent,
  FINISH_CANONICAL,
  isReverseProofFinish,
  isSpecialtyFinish,
  specialtyFinishFamily,
  detectSpecialtyFinishFamilies,
  isValidFinishInput,
  isValidVariantDetailInput,
  MAX_FINISH_LENGTH,
  MAX_VARIANT_DETAIL_LENGTH,
};
