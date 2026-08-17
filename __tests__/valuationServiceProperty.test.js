'use strict';

const fc = require('fast-check');
const {
  computeWeightedMedian,
  _computeConfidence: computeConfidence,
} = require('../src/services/valuationService');

const positivePrice = fc.double({ min: 0.01, max: 10000, noNaN: true });
const compArray = fc.array(
  fc.record({
    totalUsd: positivePrice,
    matchScore: fc.integer({ min: 1, max: 100 }),
    soldDate: fc.constant('2026-01-01T00:00:00.000Z'),
  }),
  { minLength: 1, maxLength: 30 },
);

const runOptions = { numRuns: 40, maxSkips: 0, endOnFailure: true };

describe('FMV numerical properties', () => {
  test('weighted median stays between the input price bounds', () => {
    fc.assert(fc.property(compArray, comps => {
      const result = computeWeightedMedian(comps);
      const prices = comps.map(comp => comp.totalUsd);
      expect(result).toBeGreaterThanOrEqual(Math.min(...prices));
      expect(result).toBeLessThanOrEqual(Math.max(...prices));
    }), runOptions);
  });

  test('weighted median is monotonic when one comp price increases', () => {
    fc.assert(fc.property(compArray, fc.integer({ min: 0, max: 29 }), positivePrice, (comps, index, increase) => {
      const selected = index % comps.length;
      const baseline = computeWeightedMedian(comps);
      const changed = comps.map(comp => ({ ...comp }));
      changed[selected].totalUsd += increase;
      expect(computeWeightedMedian(changed)).toBeGreaterThanOrEqual(baseline);
    }), runOptions);
  });

  test('confidence is always bounded from 0 through 100', () => {
    const confidenceInput = fc.record({
      verified: fc.boolean(),
      usCompCount: fc.integer({ min: 0, max: 500 }),
      glCompCount: fc.integer({ min: 0, max: 500 }),
      dispersion: fc.double({ min: 0, max: 10, noNaN: true }),
      avgMatchScore: fc.integer({ min: 0, max: 100 }),
      usedFallback: fc.boolean(),
      hasPcgsGuide: fc.boolean(),
      hasAuction: fc.boolean(),
      hasGreysheet: fc.boolean(),
      isBar: fc.boolean(),
      pcgsFound: fc.boolean(),
      browseOnly: fc.boolean(),
      soldRatio: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
      population: fc.option(fc.integer({ min: 0, max: 10000 }), { nil: null }),
      greysheetSpreadPct: fc.option(fc.double({ min: -100, max: 200, noNaN: true }), { nil: null }),
      filterAttritionPct: fc.option(fc.double({ min: -100, max: 200, noNaN: true }), { nil: null }),
      poolFallback: fc.boolean(),
    });

    fc.assert(fc.property(confidenceInput, input => {
      const result = computeConfidence(input);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
    }), runOptions);
  });
});