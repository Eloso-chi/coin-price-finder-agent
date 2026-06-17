'use strict';

/**
 * valuationInvariants.test.js -- Cross-cutting invariants for
 * src/services/valuationService.js#computeValuation.
 *
 * Coverage gap pin (test-coverage Tier 1): the existing
 * computeValuation.test.js exercises individual scenarios but does not
 * assert structural invariants that should hold for ANY input. This
 * file pins the cross-cutting properties that any future change must
 * preserve. If any of these break, a regression has been introduced.
 *
 * Invariants tested:
 *   I1. valuation always has the documented top-level keys
 *   I2. rangeLow <= fmvCore <= rangeHigh (when fmvCore is non-null)
 *   I3. rangeLow >= 0
 *   I4. confidence in [0, 100]
 *   I5. compCount is a non-negative integer
 *   I6. usedPool is one of {raw, raw (fallback), graded, proof, reverse-proof}
 *   I7. proofIntent is null | 'proof' | 'reverse-proof'
 *   I8. method is a non-empty string when fmvCore is non-null
 *   I9. soldRatio in [0, 1]
 *   I10. fmvCore null implies confidence === 0
 *   I11. Adding more comps never decreases compCount (monotonicity)
 */

const { computeValuation } = require('../src/services/valuationService');

// ── Helpers (mirroring the style of computeValuation.test.js) ──
function mockPcgs(overrides = {}) {
  return {
    verified: overrides.verified ?? false,
    pcgsNo: overrides.pcgsNo || null,
    series: overrides.series || 'Morgan Dollar',
    year: overrides.year || 1921,
    mint: overrides.mint || null,
    grade: overrides.grade || null,
    designation: overrides.designation || null,
    priceGuide: overrides.priceGuide || null,
    population: overrides.population || null,
    auction: overrides.auction || null,
    _isBar: overrides._isBar || false,
    ...overrides,
  };
}

function mockEbay(overrides = {}) {
  const usComps = overrides.usComps || [];
  const glComps = overrides.glComps || [];
  return {
    us: { comps: usComps, stats: { count: usComps.length } },
    global: { comps: glComps, stats: { count: glComps.length } },
    usedFallback: overrides.usedFallback || false,
  };
}

function makeComp(price, opts = {}) {
  return {
    itemId: opts.itemId || 'c-' + Math.random().toString(36).slice(2),
    title: opts.title || 'Test Comp',
    totalUsd: price,
    matchScore: opts.matchScore ?? 70,
    gradeType: opts.gradeType || 'raw',
    soldDate: opts.soldDate || new Date().toISOString(),
    _source: opts._source || 'finding',
  };
}

const VALID_USED_POOLS = new Set([
  'raw', 'raw (fallback)', 'graded', 'proof', 'reverse-proof',
]);
const VALID_PROOF_INTENT = new Set([null, 'proof', 'reverse-proof']);

// Build a fixture matrix that spans the major code paths in
// computeValuation. Each row's `name` is the test label; the actual
// inputs are passed verbatim to computeValuation.
const FIXTURES = [
  {
    name: 'no data',
    pcgs: mockPcgs(),
    ebay: mockEbay(),
  },
  {
    name: 'sparse raw comps',
    pcgs: mockPcgs(),
    ebay: mockEbay({ usComps: [makeComp(35), makeComp(40)] }),
  },
  {
    name: 'dense raw comps',
    pcgs: mockPcgs(),
    ebay: mockEbay({
      usComps: [30, 32, 35, 35, 36, 38, 40, 42, 45, 48].map(p => makeComp(p)),
    }),
  },
  {
    name: 'graded MS65 query',
    pcgs: mockPcgs({ grade: 'MS65' }),
    ebay: mockEbay({
      usComps: [200, 210, 215, 220, 225].map(p =>
        makeComp(p, { gradeType: 'graded' })),
    }),
  },
  {
    name: 'proof query (PR70)',
    pcgs: mockPcgs({ grade: 'PR70', designation: 'PR' }),
    ebay: mockEbay({
      usComps: [80, 85, 90, 95, 100].map(p =>
        makeComp(p, { gradeType: 'proof', title: 'Silver Eagle Proof PR70' })),
    }),
  },
  {
    name: 'reverse proof query',
    pcgs: mockPcgs({ series: 'American Silver Eagle', year: 2021 }),
    ebay: mockEbay({
      usComps: [
        makeComp(150, { title: '2021 Reverse Proof Silver Eagle' }),
        makeComp(160, { title: '2021 Reverse Proof Silver Eagle' }),
        makeComp(170, { title: '2021 Reverse Proof Silver Eagle' }),
      ],
    }),
  },
  {
    name: 'asking-only fallback',
    pcgs: mockPcgs(),
    ebay: mockEbay({ usComps: [
      makeComp(50, { _source: 'browse' }),
      makeComp(55, { _source: 'browse' }),
    ], usedFallback: true }),
  },
];

// The 'no data' early-out path returns a minimal valuation shape
// (only fmvCore/rangeLow/rangeHigh/confidence/explanation). Invariants
// that depend on dataSource/gradePool/compCount/method only apply to
// the full result path -- so we use FIXTURES_FULL for those.
const FIXTURES_FULL = FIXTURES.filter(f => f.name !== 'no data');

// ============================================================
//  I1. structural shape (full-result path)
// ============================================================

describe('valuation -- structural shape (I1)', () => {
  const REQUIRED_KEYS = [
    'fmvCore', 'rangeLow', 'rangeHigh', 'confidence',
    'lowData', 'compCount', 'explanation', 'dataSource',
    'gradePool', 'method',
  ];

  test.each(FIXTURES_FULL)('$name', ({ pcgs, ebay }) => {
    const { valuation } = computeValuation(pcgs, ebay);
    for (const key of REQUIRED_KEYS) {
      expect(valuation).toHaveProperty(key);
    }
  });

  test('no-data path returns minimal valuation shape', () => {
    // Early-out path: only the four core null fields plus explanation.
    const { valuation } = computeValuation(null, mockEbay());
    expect(valuation).toHaveProperty('fmvCore', null);
    expect(valuation).toHaveProperty('rangeLow', null);
    expect(valuation).toHaveProperty('rangeHigh', null);
    expect(valuation).toHaveProperty('confidence', 0);
    expect(valuation).toHaveProperty('explanation');
  });
});

// ============================================================
//  I2-I3. range invariants
// ============================================================

describe('valuation -- range invariants (I2, I3)', () => {
  test.each(FIXTURES)(
    '$name: rangeLow >= 0 and rangeLow <= fmvCore <= rangeHigh',
    ({ pcgs, ebay }) => {
      const { valuation } = computeValuation(pcgs, ebay);
      const { fmvCore, rangeLow, rangeHigh } = valuation;

      if (fmvCore == null) {
        expect(rangeLow).toBeNull();
        expect(rangeHigh).toBeNull();
        return;
      }
      expect(rangeLow).toBeGreaterThanOrEqual(0);
      expect(rangeLow).toBeLessThanOrEqual(fmvCore);
      expect(fmvCore).toBeLessThanOrEqual(rangeHigh);
    }
  );
});

// ============================================================
//  I4. confidence bounds
// ============================================================

describe('valuation -- confidence in [0,100] (I4)', () => {
  test.each(FIXTURES)('$name', ({ pcgs, ebay }) => {
    const { valuation } = computeValuation(pcgs, ebay);
    expect(valuation.confidence).toBeGreaterThanOrEqual(0);
    expect(valuation.confidence).toBeLessThanOrEqual(100);
    expect(Number.isFinite(valuation.confidence)).toBe(true);
  });
});

// ============================================================
//  I5. compCount sane
// ============================================================

describe('valuation -- compCount is a non-negative integer (I5)', () => {
  test.each(FIXTURES_FULL)('$name', ({ pcgs, ebay }) => {
    const { valuation } = computeValuation(pcgs, ebay);
    expect(Number.isInteger(valuation.compCount)).toBe(true);
    expect(valuation.compCount).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
//  I6 + I7. usedPool / proofIntent enums
// ============================================================

describe('valuation -- usedPool and proofIntent enums (I6, I7)', () => {
  test.each(FIXTURES_FULL)('$name', ({ pcgs, ebay }) => {
    const { valuation } = computeValuation(pcgs, ebay);
    expect(VALID_USED_POOLS.has(valuation.gradePool.usedPool)).toBe(true);
    expect(VALID_PROOF_INTENT.has(valuation.gradePool.proofIntent)).toBe(true);
  });
});

// ============================================================
//  I8. method is non-empty when fmvCore exists
// ============================================================

describe('valuation -- method is set when fmvCore is non-null (I8)', () => {
  test.each(FIXTURES.filter(f => f.ebay.us.comps.length > 0))(
    '$name',
    ({ pcgs, ebay }) => {
      const { valuation } = computeValuation(pcgs, ebay);
      if (valuation.fmvCore != null) {
        expect(typeof valuation.method).toBe('string');
        expect(valuation.method.length).toBeGreaterThan(0);
      }
    }
  );
});

// ============================================================
//  I9. soldRatio in [0,1]
// ============================================================

describe('valuation -- dataSource.soldRatio in [0,1] (I9)', () => {
  test.each(FIXTURES_FULL)('$name', ({ pcgs, ebay }) => {
    const { valuation } = computeValuation(pcgs, ebay);
    const { soldRatio } = valuation.dataSource;
    expect(soldRatio).toBeGreaterThanOrEqual(0);
    expect(soldRatio).toBeLessThanOrEqual(1);
  });
});

// ============================================================
//  I10. no-data implies zero confidence
// ============================================================

describe('valuation -- fmvCore null implies confidence 0 (I10)', () => {
  test('no comps and no PCGS data -> confidence 0', () => {
    const { valuation } = computeValuation(null, mockEbay());
    expect(valuation.fmvCore).toBeNull();
    expect(valuation.confidence).toBe(0);
  });

  test('empty mockPcgs and empty ebay -> confidence 0', () => {
    const { valuation } = computeValuation(mockPcgs(), mockEbay());
    expect(valuation.fmvCore).toBeNull();
    expect(valuation.confidence).toBe(0);
  });
});

// ============================================================
//  I11. compCount monotonicity
// ============================================================

describe('valuation -- compCount monotonicity (I11)', () => {
  test('adding more comps never decreases compCount', () => {
    const small = [makeComp(30), makeComp(35)];
    const medium = [...small, makeComp(40), makeComp(45), makeComp(50)];
    const large = [...medium,
      makeComp(55), makeComp(60), makeComp(65), makeComp(70), makeComp(75)];

    const r1 = computeValuation(mockPcgs(), mockEbay({ usComps: small })).valuation;
    const r2 = computeValuation(mockPcgs(), mockEbay({ usComps: medium })).valuation;
    const r3 = computeValuation(mockPcgs(), mockEbay({ usComps: large })).valuation;

    expect(r2.compCount).toBeGreaterThanOrEqual(r1.compCount);
    expect(r3.compCount).toBeGreaterThanOrEqual(r2.compCount);
  });
});

// ============================================================
//  Decision shape sanity (extra)
// ============================================================

describe('top-level result -- valuation + decisions present', () => {
  test.each(FIXTURES)('$name returns { valuation, decisions }',
    ({ pcgs, ebay }) => {
      const result = computeValuation(pcgs, ebay);
      expect(result).toHaveProperty('valuation');
      expect(result).toHaveProperty('decisions');
    }
  );
});
