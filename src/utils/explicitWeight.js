'use strict';

const WORD_WEIGHTS = new Map([
  ['half', 0.5],
  ['quarter', 0.25],
  ['tenth', 0.1],
  ['twentieth', 0.05],
]);
const MAX_WEIGHT_OUNCES = 1000;
const MAX_SEARCH_TERM_LENGTH = 500;
const OUNCE_UNIT_PATTERN = /(?:ounces?|ozt|ozs?)\b/g;
const VALID_NUMERIC_LITERAL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const NUMERIC_LOOKING_LITERAL = /^[+-]?(?:\d|\.\d|infinity\b|nan\b)/;
function canonicalWeight(ounces) {
  return Number(ounces.toFixed(6)).toString();
}

function parseFractionWeight(literal) {
  const match = literal.match(/^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/);
  if (!match) return null;
  const [, whole = '0', numeratorText, denominatorText] = match;
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator === 0) return null;
  const ounces = Number(whole) + numerator / denominator;
  return Number.isFinite(ounces) && ounces > 0 && ounces <= MAX_WEIGHT_OUNCES &&
    Number(ounces.toFixed(6)) === ounces
    ? ounces
    : null;
}

function parseNumericWeight(literal) {
  if (!VALID_NUMERIC_LITERAL.test(literal)) return null;
  const decimalPlaces = literal.includes('.') ? literal.length - literal.indexOf('.') - 1 : 0;
  const ounces = Number(literal);
  return Number.isFinite(ounces) && ounces > 0 && ounces <= MAX_WEIGHT_OUNCES && decimalPlaces <= 6
    ? ounces
    : null;
}

function numericExpressionBeforeUnit(text, unitIndex) {
  let prefix = text.slice(Math.max(0, unitIndex - 64), unitIndex).trimEnd();
  if (/\btroy$/i.test(prefix)) prefix = prefix.replace(/\btroy$/i, '').trimEnd();

  const mixedFraction = prefix.match(/((?<!\d)(?:\d+\s+)?\d+\s*\/\s*\d+)$/);
  if (mixedFraction) {
    const literal = mixedFraction[1].replace(/\s+/g, ' ');
    const yearAndFraction = literal.match(/^(17|18|19|20)\d{2}\s+((?:\d+\s+)?\d+\s*\/\s*\d+)$/);
    return yearAndFraction ? yearAndFraction[2].replace(/\s+/g, ' ') : literal;
  }

  const fraction = prefix.match(/([+-]?\d+\s*\/\s*\d+)$/);
  if (fraction) return fraction[1].replace(/\s/g, '');

  const grouped = prefix.match(/([+-]?\d+(?:\s+['’]?\s*\d{3})+)$/);
  if (grouped) return grouped[1];

  const token = prefix.match(/([^\s([{]+)$/);
  return token && NUMERIC_LOOKING_LITERAL.test(token[1]) ? token[1] : null;
}

function hasInvalidFractionSyntax(text, unitIndex) {
  let prefix = text.slice(Math.max(0, unitIndex - 64), unitIndex).trimEnd();
  if (/\btroy$/i.test(prefix)) prefix = prefix.replace(/\btroy$/i, '').trimEnd();
  if (/[\u00bc-\u00be\u2150-\u215e]$/.test(prefix)) return true;
  if (/(?:^|\s)[+-]?\s*\/\s*\d+$/.test(prefix)) return true;

  const expression = prefix.match(/([+-]?\d(?:[\d\s/]*\d)?)$/)?.[1];
  if (!expression || !expression.includes('/')) return false;
  const simpleFraction = expression.match(/(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/);
  if (!simpleFraction) return true;
  if (/^(?:17|18|19|20)\d{2}\s/.test(expression)) return false;
  return parseFractionWeight(expression) === null;
}

function analyzeExplicitWeights(text) {
  if (typeof text !== 'string' || !text.trim()) return { weights: [], invalid: false };
  if (text.length > MAX_SEARCH_TERM_LENGTH) return { weights: [], invalid: true };

  const normalized = text.toLowerCase()
    .replace(/\bone\s+(?:troy\s+)?(?:ounces?|ozt|ozs?)\b/g, '1 oz');
  const tokens = normalized.match(/[a-z0-9]+/g) || [];
  const canonicalSortedOrder = tokens.every((token, index) => index === 0 || tokens[index - 1] <= token);
  const ounceUnitCount = [...normalized.matchAll(OUNCE_UNIT_PATTERN)].length;
  const weights = new Set();
  let invalid = false;

  for (const unit of normalized.matchAll(OUNCE_UNIT_PATTERN)) {
    if (unit.index > 0 && /[a-z_]/.test(normalized[unit.index - 1])) continue;
    if (hasInvalidFractionSyntax(normalized, unit.index)) {
      invalid = true;
      continue;
    }
    const literal = numericExpressionBeforeUnit(normalized, unit.index);
    if (!literal) continue;
    if (literal.includes('/')) {
      const fraction = parseFractionWeight(literal);
      if (fraction === null) invalid = true;
      else weights.add(canonicalWeight(fraction));
      continue;
    }
    const ounces = parseNumericWeight(literal);
    if (ounces === null) invalid = true;
    else weights.add(canonicalWeight(ounces));
  }

  const hasStandaloneOunce = /(?:^|[^a-z_])(?:ounces?|ozt|ozs?)\b/.test(normalized);
  const hasHistoricalEagleDenomination = /\b(?:classic|head|indian|liberty)\b/.test(normalized) &&
    /\beagle\b/.test(normalized) && !/\bamerican\b/.test(normalized);
  for (const [word, ounces] of WORD_WEIGHTS) {
    const isHistoricalEagleWord = (word === 'half' || word === 'quarter') &&
      hasHistoricalEagleDenomination;
    const isKnownBareDenomination = (word === 'half' &&
      /\b(?:walking liberty|kennedy|franklin|barber|capped bust|seated liberty)\b/.test(normalized)) ||
      (word === 'quarter' &&
        /\b(?:washington|standing liberty|barber|america beautiful)\b/.test(normalized));
    for (const occurrence of normalized.matchAll(new RegExp(`\\b${word}\\b`, 'g'))) {
      const before = normalized.slice(0, occurrence.index);
      const after = normalized.slice(occurrence.index + word.length);
      const followsWeightDenomination = /\b(?:half|quarter|tenth|twentieth)[\s-]+(?:dollars?|cents?)[\s-]+$/.test(before);
      const isImmediateDenomination = /^(?:[\s-]+(?:dollars?|cents?|eagles?)\b)/.test(after) ||
        (!followsWeightDenomination && /\b(?:dollars?|cents?)[\s-]+$/.test(before));
      const isDescriptiveOrdinal = /^(?:[\s-]+(?:anniversary|edition|commemorative)\b)/.test(after);
      const followedByOunce = /^[\s-]+(?:troy[\s-]+)?(?:ounces?|ozt|ozs?)\b/.test(after);
      const precededByOunce = /\b(?:ounces?|ozt|ozs?)[\s-]+$/.test(before);

      // A detached word-form weight is accepted only in the token-sorted key
      // format used by canonical Terapeak dataset keys. In prose, an unrelated
      // word such as "tenth" in "tenth anniversary" is not a coin weight.
      const sortedKeyWeight = canonicalSortedOrder && !isImmediateDenomination &&
        !isHistoricalEagleWord && !isKnownBareDenomination;
      const isWeightWord = (followedByOunce && !isImmediateDenomination && !isDescriptiveOrdinal) ||
        (precededByOunce && !followsWeightDenomination && !isImmediateDenomination && !isDescriptiveOrdinal) ||
        (ounceUnitCount > 1 && !isImmediateDenomination && !isDescriptiveOrdinal &&
          !isHistoricalEagleWord && !isKnownBareDenomination) ||
        (sortedKeyWeight && !followedByOunce && !precededByOunce);
      if (hasStandaloneOunce && isWeightWord) {
        weights.add(canonicalWeight(ounces));
        break;
      }
    }
  }

  return { weights: [...weights].map(Number).sort((left, right) => left - right), invalid };
}

function extractExplicitWeights(text) {
  return analyzeExplicitWeights(text).weights;
}

function hasContradictoryWeights(text) {
  const analysis = analyzeExplicitWeights(text);
  return analysis.invalid || analysis.weights.length > 1;
}

function analyzeExplicitWeightSources(...sources) {
  const weights = new Set();
  let invalid = false;
  for (const source of sources) {
    const analysis = analyzeExplicitWeights(source);
    invalid ||= analysis.invalid;
    for (const weight of analysis.weights) weights.add(weight);
  }
  return { weights: [...weights].sort((left, right) => left - right), invalid };
}

function hasContradictoryWeightSources(...sources) {
  const analysis = analyzeExplicitWeightSources(...sources);
  return analysis.invalid || analysis.weights.length > 1;
}

module.exports = {
  analyzeExplicitWeights,
  analyzeExplicitWeightSources,
  extractExplicitWeights,
  hasContradictoryWeights,
  hasContradictoryWeightSources,
};
