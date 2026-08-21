'use strict';

const fc = require('fast-check');
const { detectWeightFromTitle } = require('../src/utils/coinMetalProfile');
const { applyFilters } = require('../src/services/ebayService');

describe('filter and weight properties', () => {
  test('applyFilters never returns more comps than it receives', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        title: fc.string({ minLength: 1, maxLength: 80 }),
        totalUsd: fc.double({ min: 0.01, max: 10000, noNaN: true }),
        matchScore: fc.integer({ min: 0, max: 100 }),
      })),
      comps => {
        const result = applyFilters(comps, {}, {});
        expect(result.kept.length).toBeLessThanOrEqual(comps.length);
      },
    ), { numRuns: 40, maxSkips: 0, endOnFailure: true });
  });

  test('detected title weights are null or within the plausible bound', () => {
    fc.assert(fc.property(
      fc.string({ minLength: 0, maxLength: 120 }),
      title => {
        const weight = detectWeightFromTitle(title);
        expect(weight === null || (weight > 0 && weight <= 100)).toBe(true);
      },
    ), { numRuns: 80, maxSkips: 0, endOnFailure: true });
  });

  test('rejects a zero-gram title weight', () => {
    expect(detectWeightFromTitle('0g')).toBeNull();
  });
});