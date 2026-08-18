'use strict';

const MAX_QUERY_LENGTH = 300;
const MAX_CONTEXT_TURNS = 8;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function stringField(value, name, max = MAX_QUERY_LENGTH) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name} must be a non-empty string of ${max} characters or fewer`);
  }
  return value.trim();
}

function finiteNumber(value, name, min = -Infinity, max = Infinity) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} must be a finite number between ${min} and ${max}`);
  }
  return number;
}

function pickObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(allowed
    .filter(key => Object.prototype.hasOwnProperty.call(value, key))
    .map(key => [key, value[key]]));
}

function validateIdentifyInput(input) {
  const value = requireObject(input, 'identify_coin arguments');
  return {
    query: stringField(value.query, 'query'),
    context: Array.isArray(value.context) ? value.context.slice(-MAX_CONTEXT_TURNS) : [],
  };
}

function validatePriceInput(input) {
  const value = requireObject(input, 'price_coin arguments');
  const coinData = pickObject(value.coinData, [
    'name', 'year', 'mint', 'grade', 'finish', 'designation', 'composition', 'isProof', 'coa', 'originalBox',
  ]);
  const options = pickObject(value.options, [
    'timeWindowDays', 'usMinComps', 'maxPages', 'requirePCGSOnly', 'exactGradeOnly', 'weight',
  ]);
  if (options?.timeWindowDays != null) finiteNumber(options.timeWindowDays, 'options.timeWindowDays', 1, 365);
  if (options?.usMinComps != null) finiteNumber(options.usMinComps, 'options.usMinComps', 1, 100);
  if (options?.maxPages != null) finiteNumber(options.maxPages, 'options.maxPages', 1, 10);
  const output = {
    query: stringField(value.query, 'query'),
    coinData,
    weight: finiteNumber(value.weight, 'weight', 0.001, 100),
    options,
    askingPrice: finiteNumber(value.askingPrice, 'askingPrice', 0, 1000000),
    appealMultiplier: finiteNumber(value.appealMultiplier, 'appealMultiplier', 1, 2),
  };
  return output;
}

function validatePurchaseInput(input) {
  const value = validatePriceInput(input);
  if (value.askingPrice == null) throw new Error('askingPrice is required for evaluate_purchase');
  return value;
}

module.exports = {
  MAX_CONTEXT_TURNS,
  validateIdentifyInput,
  validatePriceInput,
  validatePurchaseInput,
};