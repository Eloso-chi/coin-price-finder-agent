// src/schemas/priceResponse.schema.js
// CommonJS
//
// JSON Schema (Draft 2020-12 / ajv) for the POST /api/price response shape.
//
// SCOPE: This schema covers STRUCTURAL completeness only — required top-level
// keys, required nested sub-keys, and basic types. It does NOT cover:
//   - Cross-field ordering rules (rangeLow ≤ fmvCore ≤ rangeHigh, max70 ≤ max75
//     ≤ max80, etc). Those live in responseValidator.validateNumericSanity().
//   - Domain integrity (series consistency, FMV-vs-comp reasonability).
//     Those live in responseValidator.validateSeriesIntegrity / FMVReasonability.
//
// Treat ajv as the schema layer; keep the cross-field/business rules in JS.
//
// IMPORTANT: additionalProperties is left as the JSON Schema default (true) on
// every object. This is a deliberate non-breaking choice — the /api/price
// response evolves and we do not want a schema add to break route changes.
// If we ever want stricter contracts, switch to a frozen schema version under
// /v1/ and lock additionalProperties: false there.

'use strict';

// `null` allowed wherever a numeric field can be missing (no-data case).
const numericOrNull = { type: ['number', 'null'] };

const priceResponseSchema = {
  $id: 'https://coinpricefinder.app/schemas/priceResponse.json',
  title: 'PriceResponse',
  type: 'object',
  required: ['query', 'identification', 'pcgs', 'ebay', 'valuation', 'decisions'],
  properties: {
    query: {
      type: 'object',
      // No required keys enforced here; callers vary (input vs cert vs barcode).
    },
    identification: {
      type: 'object',
    },
    pcgs: {
      type: 'object',
    },
    ebay: {
      type: 'object',
    },
    valuation: {
      type: 'object',
      required: ['algorithmVersion', 'configVersion', 'computedAt', 'fmvCore', 'rangeLow', 'rangeHigh', 'confidence', 'explanation', 'dataSource', 'gradePool'],
      properties: {
        algorithmVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
        configVersion: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        computedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' },
        fmvCore: numericOrNull,
        rangeLow: numericOrNull,
        rangeHigh: numericOrNull,
        confidence: numericOrNull,
        explanation: {}, // shape varies (array or string)
        dataSource: {},  // shape varies
        gradePool: {
          type: 'object',
          required: ['usedPool'],
          properties: {
            usedPool: {
              enum: ['raw', 'raw (fallback)', 'graded', 'proof', 'reverse-proof'],
            },
          },
        },
      },
    },
    decisions: {
      type: 'object',
      required: ['buy', 'sell'],
      properties: {
        buy: {
          type: 'object',
          required: ['max70', 'max75', 'max80'],
          properties: {
            max70: numericOrNull,
            max75: numericOrNull,
            max80: numericOrNull,
          },
        },
        sell: {
          type: 'object',
          required: ['fast', 'normal', 'premium', 'offerFloor'],
          properties: {
            fast: numericOrNull,
            normal: numericOrNull,
            premium: numericOrNull,
            offerFloor: numericOrNull,
          },
        },
      },
    },
  },
};

module.exports = priceResponseSchema;
