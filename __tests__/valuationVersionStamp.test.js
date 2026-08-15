'use strict';

const { computeValuation, ALGORITHM_VERSION } = require('../src/services/valuationService');
const { normalizeSource } = require('../src/utils/versionHash');

describe('valuation reproducibility versions', () => {
  test('stamps null-FMV results with stable versions and an ISO timestamp', () => {
    const first = computeValuation({}, {}, null, null).valuation;
    const second = computeValuation({}, {}, null, null).valuation;

    expect(first.algorithmVersion).toBe(ALGORITHM_VERSION);
    expect(first.algorithmVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(first.configVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.configVersion).toBe(first.configVersion);
    expect(Number.isNaN(Date.parse(first.computedAt))).toBe(false);
  });

  test('stamps successful comp-based valuations', () => {
    const comps = [30, 32, 35, 37, 40].map((totalUsd, index) => ({
      itemId: `comp-${index}`,
      title: `Test coin ${index}`,
      totalUsd,
      matchScore: 80,
      gradeType: 'raw',
      soldDate: '2026-08-01T00:00:00.000Z',
      _source: 'finding',
    }));
    const result = computeValuation({}, {
      us: { comps, stats: { count: comps.length } },
      global: { comps: [], stats: { count: 0 } },
      usedFallback: false,
    }).valuation;

    expect(result.fmvCore).toBeGreaterThan(0);
    expect(result).toEqual(expect.objectContaining({
      algorithmVersion: ALGORITHM_VERSION,
      configVersion: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      computedAt: expect.stringMatching(/Z$/),
    }));
  });

  test('normalizes checkout line endings before hashing', () => {
    expect(normalizeSource(Buffer.from('first\r\nsecond\r\n')))
      .toBe(normalizeSource(Buffer.from('first\nsecond\n')));
  });
});