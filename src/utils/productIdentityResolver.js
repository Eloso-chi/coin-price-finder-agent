'use strict';

const { detectWeightsFromTitle } = require('./coinMetalProfile');
const { resolveSpecialMark, detectMarksInTitle, serializeMark } = require('../data/specialMarksRegistry');

const PRODUCT_IDENTITY_PARSER_VERSION = '2.0.0';
const WEIGHT_RELATIVE_TOLERANCE = 0.05;

class ProductIdentityError extends Error {
  constructor(message, identity) {
    super(message);
    this.name = 'ProductIdentityError';
    this.code = 'AMBIGUOUS_PRODUCT_IDENTITY';
    this.identity = identity;
  }
}

function uniqueWeights(weights) {
  const result = [];
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight <= 0) continue;
    if (!result.some(existing => Math.abs(existing - weight) < 0.000001)) result.push(weight);
  }
  return result.sort((left, right) => left - right);
}

function weightsEquivalent(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return false;
  return Math.abs(left - right) / Math.max(left, right) < WEIGHT_RELATIVE_TOLERANCE;
}

function distinctWeights(weights) {
  const result = [];
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight <= 0) continue;
    if (!result.some(existing => weightsEquivalent(existing, weight))) result.push(weight);
  }
  return result.sort((left, right) => left - right);
}

function countWeightMentions(text) {
  const value = String(text || '').toLowerCase();
  const patterns = [
    /(?<![\d/.])(?:\d+\/\d+|\d+(?:\.\d+)?)\s*(?:troy\s+)?(?:ounces?(?:\s+oz)?|ozt?|oz|onzas?)\b/g,
    /\b(?:quarter|half)\s*(?:troy\s+)?(?:ounce|ozt?|oz|onzas?)\b/g,
    /(?<![\d/.])(?:\d+\/\d+|\d+(?:\.\d+)?|\.\d+)\s*(?:grams?|g)\b/g,
    /\bhalf\s+gram\b/g,
    /\b(?:1\s*)?kilo(?:gram)?\b/g,
  ];
  return patterns.reduce((total, pattern) => total + [...value.matchAll(pattern)].length, 0);
}

function resolveWeightEvidence(text, explicitWeight, explicitSource = 'structured') {
  const textWeights = uniqueWeights(detectWeightsFromTitle(text));
  const explicit = Number(explicitWeight);
  const explicitProvided = explicitWeight != null;
  const hasExplicit = explicitWeight != null && Number.isFinite(explicit) && explicit > 0;
  const invalidExplicit = explicitProvided && !hasExplicit;
  const conflicts = hasExplicit
    ? textWeights.filter(weight => !weightsEquivalent(weight, explicit))
    : [];
  const valuesOz = distinctWeights(hasExplicit ? [explicit, ...textWeights] : textWeights);
  const ambiguous = invalidExplicit || distinctWeights(textWeights).length > 1 || conflicts.length > 0;

  return {
    status: ambiguous ? 'ambiguous' : valuesOz.length ? 'single' : 'none',
    valuesOz,
    mentions: countWeightMentions(text),
    source: explicitProvided ? explicitSource : valuesOz.length ? 'text' : 'none',
    conflict: invalidExplicit || conflicts.length > 0,
  };
}

function normalizeToken(value) {
  return value == null ? null : String(value).trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function canonicalSeries(value) {
  const normalized = normalizeToken(value) || '';
  const aliases = [
    [/\bkrugerrand\b/, 'krugerrand'],
    [/\blibertad\b/, 'libertad'],
    [/\b(?:american\s+)?silver\s+eagle\b|\base\b/, 'american silver eagle'],
    [/\b(?:american\s+)?gold\s+eagle\b|\bage\b/, 'american gold eagle'],
    [/\b(?:canadian\s+)?silver\s+maple\s+leaf\b/, 'silver maple leaf'],
    [/\b(?:canadian\s+)?gold\s+maple\s+leaf\b/, 'gold maple leaf'],
    [/\b(?:canadian\s+)?maple\s+leaf\b/, 'maple leaf'],
  ];
  return aliases.find(([pattern]) => pattern.test(normalized))?.[1] || normalized;
}

function seriesEquivalent(left, right) {
  const normalizedLeft = normalizeToken(left);
  const normalizedRight = normalizeToken(right);
  if (normalizedLeft === normalizedRight) return true;
  const canonicalLeft = canonicalSeries(normalizedLeft);
  const canonicalRight = canonicalSeries(normalizedRight);
  if (canonicalLeft === canonicalRight) return true;
  const mapleSeries = new Set(['maple leaf', 'silver maple leaf', 'gold maple leaf']);
  if (mapleSeries.has(canonicalLeft) && mapleSeries.has(canonicalRight)) {
    return canonicalLeft === 'maple leaf' || canonicalRight === 'maple leaf';
  }
  const zodiacPattern = /\b(?:year of the )?(?:rat|mouse|ox|tiger|rabbit|dragon|snake|horse|goat|sheep|monkey|rooster|dog|pig)\b/;
  const lunarContextPattern = /^(?:australian|perth(?: mint)?)?\s*(?:silver|gold)?\s*lunar(?: coin| series)?$|^australian\s+(?:silver|gold)\s+coin$/;
  return (zodiacPattern.test(normalizedLeft) && lunarContextPattern.test(normalizedRight))
    || (zodiacPattern.test(normalizedRight) && lunarContextPattern.test(normalizedLeft));
}

function gradeEquivalent(left, right) {
  const normalizeGrade = value => normalizeToken(value)?.replace(/\s/g, '').replace(/^pf(?=\d)/, 'pr');
  const normalizedLeft = normalizeGrade(left);
  const normalizedRight = normalizeGrade(right);
  if (normalizedLeft === normalizedRight) return true;
  const isGenericProof = value => value === 'proof';
  const isNumericProof = value => /^(?:pr|pf|sp)\d{1,2}\+?$/.test(value || '');
  return (isGenericProof(normalizedLeft) && isNumericProof(normalizedRight))
    || (isGenericProof(normalizedRight) && isNumericProof(normalizedLeft));
}

function inferPool(structured, parsed) {
  const finish = normalizeToken(structured.finish || parsed.finish) || '';
  const grade = normalizeToken(structured.grade || parsed.grade) || '';
  if (structured.isReverseProof === true || /reverse proof|reverse pr|rev proof/.test(finish)) return 'reverse-proof';
  if (structured.isProof === true || /^(?:pr|pf|sp)\s*\d/.test(grade) || /\bproof\b(?![\s-]*like)/.test(finish)) return 'proof';
  if (/^(?:ms|au|xf|ef|vf|vg|ag|fr|po)\s*\d/.test(grade)) return 'graded';
  return 'raw';
}

function addConflict(ambiguities, field, structuredValue, parsedValue) {
  if (structuredValue == null || parsedValue == null) return;
  if (field === 'series' && seriesEquivalent(structuredValue, parsedValue)) return;
  if (field === 'grade' && gradeEquivalent(structuredValue, parsedValue)) return;
  const normalize = field === 'grade'
    ? value => normalizeToken(value)?.replace(/\s/g, '')
    : normalizeToken;
  if (normalize(structuredValue) !== normalize(parsedValue)) {
    ambiguities.push({ field, structured: structuredValue, text: parsedValue });
  }
}

function findIdentityMismatches(expected, actual) {
  const mismatches = [];
  for (const field of ['series', 'year', 'mint', 'metal', 'grade', 'finish', 'designation', 'pool']) {
    if (expected?.[field] == null || actual?.[field] == null) continue;
    if (field === 'pool' && expected.poolConstrained === false) continue;
    if (field === 'series' && seriesEquivalent(expected[field], actual[field])) continue;
    if (field === 'grade' && gradeEquivalent(expected[field], actual[field])) continue;
    const normalize = field === 'grade'
      ? value => normalizeToken(value)?.replace(/\s/g, '')
      : normalizeToken;
    if (normalize(expected[field]) !== normalize(actual[field])) mismatches.push(field);
  }
  if (expected?.nominalWeightOz != null && actual?.nominalWeightOz != null
    && !weightsEquivalent(expected.nominalWeightOz, actual.nominalWeightOz)) {
    mismatches.push('weight');
  }
  return mismatches;
}

function inferTextIdentity(text) {
  const value = String(text || '');
  const years = distinctMatches(value, /\b(1[7-9]\d{2}|20\d{2})\b/gi, match => match[1]);
  const mints = distinctMatches(value, /\b(?:1[7-9]|20)\d{2}[-\s]+(CC|[CDOPSW])\b/gi, match => match[1].toUpperCase());
  const metals = distinctMatches(value, /\b(silver|gold|platinum|palladium)\b/gi, match => match[1].toLowerCase());
  const grades = distinctMatches(
    value,
    /\b(MS|PR|PF|SP|AU|XF|EF|VF|VG|AG|FR|PO)\s*-?\s*(\d{1,2}\+?)\b/gi,
    match => `${match[1].toUpperCase() === 'PF' ? 'PR' : match[1].toUpperCase()}${match[2]}`
  );
  const designationMatch = value.match(/\b(DMPL|DPL|DCAM|UCAM|CAM|PL|FDOI|FIRST STRIKE|EARLY RELEASES)\b/i);
  const designation = designationMatch?.[1]?.toUpperCase() || null;
  const finish = /\breverse\s+proof\b/i.test(value)
    ? 'Reverse Proof'
    : /\bproof[\s-]*like\b/i.test(value) ? 'Proof-Like'
    : /\bproof\b(?![\s-]*like)|\b(?:PR|PF|SP)\s*-?\s*\d{1,2}\b/i.test(value) ? 'Proof' : null;
  const ambiguities = [];
  for (const [field, values] of Object.entries({ year: years, mint: mints, metal: metals, grade: grades })) {
    if (values.length > 1) ambiguities.push({ field, values });
  }
  return {
    year: years[0] || null,
    mint: mints[0] || null,
    metal: metals[0] || null,
    grade: grades[0] || null,
    designation,
    finish,
    ambiguities,
  };
}

function distinctMatches(text, pattern, normalize) {
  return [...new Set(Array.from(text.matchAll(pattern), normalize))];
}

function inferBullionDenomination(text, series, metal) {
  const explicit = String(text || '').match(/(?:C?\$|USD\s*)(1|5|50)\b|\b(1|5|50)\s+dollars?\b/i);
  if (explicit) return Number(explicit[1] || explicit[2]);
  const canonical = canonicalSeries(series);
  if (canonical === 'silver maple leaf' || (canonical === 'maple leaf' && normalizeToken(metal) === 'silver')) return 5;
  if (canonical === 'american silver eagle') return 1;
  if (canonical === 'american gold eagle') return 50;
  return null;
}

function explicitDenomination(text) {
  const match = String(text || '').match(/(?:C?\$|USD\s*)(1|5|50)\b|\b(1|5|50)\s+dollars?\b/i);
  return match ? Number(match[1] || match[2]) : null;
}

function resolveProductIdentity({ text = '', structured = {}, parsed = {} } = {}) {
  const textIdentity = inferTextIdentity(text);
  const evidence = { ...textIdentity, ...parsed };
  if (textIdentity.finish === 'Proof-Like') evidence.finish = textIdentity.finish;
  if (parsed._gradeSource === 'bu-term') evidence.grade = null;
  const hasStructuredWeight = structured.weight != null;
  const explicitWeight = hasStructuredWeight ? structured.weight : evidence.weight ?? null;
  const weightEvidence = resolveWeightEvidence(text, explicitWeight, hasStructuredWeight ? 'structured' : 'parsed');
  const nominalWeightOz = weightEvidence.status === 'single'
    ? (hasStructuredWeight ? Number(structured.weight) : (evidence.weight ?? weightEvidence.valuesOz[0]))
    : null;
  const ambiguities = [...textIdentity.ambiguities];
  const structuredMetal = structured.metal ?? structured.composition;
  addConflict(ambiguities, 'year', structured.year, evidence.year);
  addConflict(ambiguities, 'mint', structured.mint || structured.mintMark, evidence.mint);
  addConflict(ambiguities, 'metal', structuredMetal, evidence.metal);
  addConflict(ambiguities, 'series', structured.series || structured.name, evidence.series);
  addConflict(ambiguities, 'grade', structured.grade, evidence.grade);
  addConflict(ambiguities, 'finish', structured.finish, evidence.finish);
  addConflict(ambiguities, 'designation', structured.designation, evidence.designation);
  if (weightEvidence.status === 'ambiguous') {
    ambiguities.push({ field: 'weight', valuesOz: weightEvidence.valuesOz });
  }
  const markRequest = Array.isArray(structured.specialMarks) ? structured.specialMarks[0] : null;
  const legacyPrivyDetail = structured.label === 'Privy' && structured.specialMarkMode !== 'unknown'
    ? structured.variantDetail
    : null;
  const structuredDenomination = structured.denomination ?? evidence.denomination ?? null;
  const textDenomination = explicitDenomination(text);
  if (structuredDenomination != null && textDenomination != null
    && Number(structuredDenomination) !== textDenomination) {
    ambiguities.push({
      field: 'denomination', structured: structuredDenomination, text: textDenomination,
    });
  }
  const markContext = {
    program: structured.series || structured.name || evidence.series,
    year: structured.year || evidence.year,
    metal: structuredMetal || evidence.metal,
    weight: nominalWeightOz,
    finish: structured.finish || evidence.finish,
    mint: structured.mint || structured.mintMark || evidence.mint,
    denomination: structuredDenomination ?? textDenomination
      ?? inferBullionDenomination(text, structured.series || structured.name || evidence.series, structuredMetal || evidence.metal),
  };
  const markResolution = structured.specialMarkMode === 'unknown'
    ? { status: 'none', mark: null }
    : resolveSpecialMark({
    markId: markRequest?.markId,
    detail: legacyPrivyDetail,
    context: markContext,
  });
  const textMarks = structured.specialMarkMode === 'unknown' ? [] : detectMarksInTitle(text, markContext).filter(mark =>
    resolveSpecialMark({ markId: mark.markId, context: markContext }).status === 'resolved');
  if (textMarks.length > 1) ambiguities.push({ field: 'specialMark', reason: 'multiple-text-marks' });
  if ((structured.specialMarkMode === 'standard' || structured.specialMarkMode === 'unspecified') && textMarks.length) {
    ambiguities.push({
      field: 'specialMark',
      structured: structured.specialMarkMode,
      text: textMarks[0].markId,
      reason: 'mode-text-conflict',
    });
  }
  if (markResolution.status === 'resolved' && textMarks.length === 1
    && textMarks[0].markId !== markResolution.mark.markId) {
    ambiguities.push({ field: 'specialMark', structured: markResolution.mark.markId, text: textMarks[0].markId });
  }
  if (markRequest && markResolution.status !== 'resolved') {
    ambiguities.push({ field: 'specialMark', markId: markRequest.markId, reason: markResolution.status });
  }
  const resolvedMark = markResolution.status === 'resolved' ? markResolution.mark : textMarks[0];
  const unknownDetail = structured.specialMarkMode === 'unknown' ? structured.variantDetail : legacyPrivyDetail;
  const specialMarks = resolvedMark
    ? [serializeMark(resolvedMark)]
    : unknownDetail ? [{
      markId: null,
      canonicalName: String(unknownDetail).trim(),
      kind: 'privy',
      officialStatus: 'unknown',
      registryVersion: null,
    }] : [];

  return Object.freeze({
    series: structured.series || structured.name || evidence.series || null,
    year: structured.year || evidence.year || null,
    mint: structured.mint || structured.mintMark || evidence.mint || null,
    metal: structuredMetal || evidence.metal || null,
    nominalWeightOz,
    grade: structured.grade || evidence.grade || null,
    finish: structured.finish || evidence.finish || null,
    designation: structured.designation || evidence.designation || null,
    specialMarkMode: structured.specialMarkMode || (resolvedMark ? 'exact' : specialMarks.length ? 'unknown' : 'unspecified'),
    specialMarks: Object.freeze(specialMarks.map(mark => Object.freeze(mark))),
    pool: inferPool(structured, evidence),
    poolConstrained: Boolean(
      structured.isProof === true || structured.isReverseProof === true
      || structured.grade || structured.finish || evidence.grade || evidence.finish
    ),
    weightEvidence: Object.freeze(weightEvidence),
    ambiguities: Object.freeze(ambiguities),
    parserVersion: PRODUCT_IDENTITY_PARSER_VERSION,
    ambiguous: ambiguities.length > 0,
  });
}

function serializeProductIdentity(identity) {
  return {
    series: identity.series,
    year: identity.year == null ? null : String(identity.year),
    mint: identity.mint,
    metal: identity.metal,
    nominalWeightOz: identity.nominalWeightOz,
    grade: identity.grade,
    finish: identity.finish,
    designation: identity.designation,
    specialMarkMode: identity.specialMarkMode,
    specialMarks: identity.specialMarks,
    pool: identity.pool,
    poolConstrained: identity.poolConstrained,
    weightEvidence: identity.weightEvidence,
    parserVersion: identity.parserVersion,
  };
}

function detectUnambiguousWeight(text) {
  return resolveProductIdentity({ text }).nominalWeightOz;
}

function assertUnambiguousProductIdentity(identity) {
  if (!identity?.ambiguous) return identity;
  const fields = identity.ambiguities.map(item => item.field).join(', ');
  throw new ProductIdentityError(
    `Product identity is ambiguous (${fields}). Specify one product with consistent structured and text attributes.`,
    identity
  );
}

module.exports = {
  PRODUCT_IDENTITY_PARSER_VERSION,
  ProductIdentityError,
  resolveProductIdentity,
  resolveWeightEvidence,
  weightsEquivalent,
  seriesEquivalent,
  gradeEquivalent,
  findIdentityMismatches,
  serializeProductIdentity,
  detectUnambiguousWeight,
  assertUnambiguousProductIdentity,
};