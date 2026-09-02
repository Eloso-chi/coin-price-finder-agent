'use strict';

const MAX_QUERY_LENGTH = 300;
const MAX_CONTEXT_TURNS = 8;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function rejectUnknownFields(value, allowed, name) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw new Error(`${name} contains unsupported field: ${unknown}`);
}

function stringField(value, name, max = MAX_QUERY_LENGTH) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name} must be a non-empty string of ${max} characters or fewer`);
  }
  return value.trim();
}

function finiteNumber(value, name, min = -Infinity, max = Infinity) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function pickObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw new Error(`Unsupported field: ${unknown}`);
  return Object.fromEntries(allowed
    .filter(key => Object.prototype.hasOwnProperty.call(value, key))
    .map(key => [key, value[key]]));
}

function validateCoinData(value) {
  const projected = pickObject(value, [
    'name', 'year', 'mint', 'mintMark', 'grade', 'finish', 'designation', 'composition', 'isProof', 'coa', 'originalBox',
    'specialMarkMode', 'specialMarks', 'variantDetail',
  ]);
  if (!projected) return undefined;
  const stringBounds = {
    name: 200, mint: 10, mintMark: 10, grade: 30, finish: 100, designation: 30, composition: 50,
    specialMarkMode: 20, variantDetail: 50,
  };
  for (const key of ['name', 'mint', 'mintMark', 'grade', 'finish', 'designation', 'composition', 'specialMarkMode', 'variantDetail']) {
    if (projected[key] != null && (typeof projected[key] !== 'string' || projected[key].length > stringBounds[key])) throw new Error(`coinData.${key} must be a bounded string`);
  }
  const { isValidSpecialMarkInput, isValidVariantDetailInput } = require('../utils/coinIntent');
  if (!isValidSpecialMarkInput(projected.specialMarks, projected.specialMarkMode)
    || !isValidVariantDetailInput(projected.variantDetail)) {
    throw new Error('coinData special-mark identity is invalid');
  }
  if (projected.specialMarks) projected.specialMarks = projected.specialMarks.map(mark => ({ markId: mark.markId }));
  if (projected.year != null && !((typeof projected.year === 'string' && /^[1-9]\d{0,3}$/.test(projected.year)) || (typeof projected.year === 'number' && Number.isInteger(projected.year) && projected.year >= 1 && projected.year <= 9999))) {
    throw new Error('coinData.year must be a bounded year');
  }
  for (const key of ['isProof', 'coa', 'originalBox']) {
    if (projected[key] != null && typeof projected[key] !== 'boolean') throw new Error(`coinData.${key} must be boolean`);
  }
  return projected;
}

function validateOptions(value) {
  const projected = pickObject(value, [
    'timeWindowDays', 'usMinComps', 'maxPages', 'requirePCGSOnly', 'exactGradeOnly', 'weight',
  ]);
  if (!projected) return undefined;
  if (projected.timeWindowDays != null) finiteNumber(projected.timeWindowDays, 'options.timeWindowDays', 1, 365);
  if (projected.usMinComps != null) finiteNumber(projected.usMinComps, 'options.usMinComps', 1, 100);
  if (projected.maxPages != null) finiteNumber(projected.maxPages, 'options.maxPages', 1, 10);
  if (projected.weight != null) finiteNumber(projected.weight, 'options.weight', 0.001, 100);
  for (const key of ['requirePCGSOnly', 'exactGradeOnly']) {
    if (projected[key] != null && typeof projected[key] !== 'boolean') throw new Error(`options.${key} must be boolean`);
  }
  return projected;
}

function validateIdentifyInput(input) {
  const value = requireObject(input, 'identify_coin arguments');
  rejectUnknownFields(value, ['query'], 'identify_coin arguments');
  return {
    query: stringField(value.query, 'query'),
  };
}

function validatePriceInput(input) {
  const value = requireObject(input, 'price_coin arguments');
  rejectUnknownFields(value, ['query', 'coinData', 'weight', 'options', 'askingPrice', 'appealMultiplier'], 'price_coin arguments');
  for (const key of ['coinData', 'weight', 'options', 'askingPrice', 'appealMultiplier']) {
    if (Object.prototype.hasOwnProperty.call(value, key) && value[key] === null) throw new Error(`${key} cannot be null`);
  }
  const coinData = validateCoinData(value.coinData);
  const options = validateOptions(value.options);
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