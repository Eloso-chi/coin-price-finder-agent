'use strict';

const {
  PRODUCT_IDENTITY_PARSER_VERSION,
  resolveProductIdentity,
  detectUnambiguousWeight,
  assertUnambiguousProductIdentity,
} = require('../src/utils/productIdentityResolver');

describe('canonical product identity weight evidence', () => {
  test.each([
    ['2024 Gold Libertad 1/4 oz', 0.25],
    ['American Silver Eagle 1 oz', 1],
    ['2011 Mexico Libertad 1 Onza', 1],
    ['30 g Silver Panda', 30 / 31.1035],
  ])('resolves one explicit weight from %s', (text, expectedWeight) => {
    const identity = resolveProductIdentity({ text });

    expect(identity.nominalWeightOz).toBeCloseTo(expectedWeight, 6);
    expect(identity.weightEvidence).toEqual(expect.objectContaining({
      status: 'single',
      source: 'text',
      conflict: false,
    }));
    expect(identity.parserVersion).toBe(PRODUCT_IDENTITY_PARSER_VERSION);
    expect(identity.ambiguous).toBe(false);
  });

  test.each([
    ['1/20 oz Proof and 1/10 oz UNC', [0.05, 0.1]],
    ['1/10 oz UNC and 1/20 oz Proof', [0.05, 0.1]],
    ['1 oz and 5 oz Silver Bars', [1, 5]],
    ['5 oz Silver Bar with 1 oz bonus', [1, 5]],
  ])('rejects order-independent mixed weights in %s', (text, valuesOz) => {
    const identity = resolveProductIdentity({ text });

    expect(identity).toEqual(expect.objectContaining({
      nominalWeightOz: null,
      ambiguous: true,
    }));
    expect(identity.weightEvidence).toEqual(expect.objectContaining({
      status: 'ambiguous',
      valuesOz,
      mentions: 2,
    }));
    expect(detectUnambiguousWeight(text)).toBeNull();
  });

  test('preserves no-weight evidence for benefit-of-doubt handling', () => {
    const identity = resolveProductIdentity({ text: 'Morgan Silver Dollar MS65' });

    expect(identity.nominalWeightOz).toBeNull();
    expect(identity.weightEvidence).toEqual({
      status: 'none',
      valuesOz: [],
      mentions: 0,
      source: 'none',
      conflict: false,
    });
    expect(identity.ambiguous).toBe(false);
  });

  test('structured weight outranks matching text evidence', () => {
    const identity = resolveProductIdentity({
      text: '2025 American Silver Eagle 1 oz',
      structured: { name: 'American Silver Eagle', year: 2025, weight: 1 },
    });

    expect(identity).toEqual(expect.objectContaining({
      series: 'American Silver Eagle',
      year: 2025,
      nominalWeightOz: 1,
      ambiguous: false,
    }));
    expect(identity.weightEvidence.source).toBe('structured');
    expect(identity.pool).toBe('raw');
  });

  test('treats a Panda 30 g mass as equivalent to a structured nominal 1 oz weight', () => {
    const identity = resolveProductIdentity({
      text: '2025 Silver Panda 30 g',
      structured: { series: 'Silver Panda', year: 2025, weight: 1 },
    });

    expect(identity.nominalWeightOz).toBe(1);
    expect(identity.weightEvidence).toEqual(expect.objectContaining({
      status: 'single',
      valuesOz: [1],
      conflict: false,
    }));
    expect(identity.ambiguous).toBe(false);
  });

  test('flags conflicting structured and text weights', () => {
    const identity = resolveProductIdentity({
      text: '2025 American Silver Eagle 1/2 oz',
      structured: { weight: 1 },
    });

    expect(identity.nominalWeightOz).toBeNull();
    expect(identity.weightEvidence).toEqual(expect.objectContaining({
      status: 'ambiguous',
      valuesOz: [0.5, 1],
      source: 'structured',
      conflict: true,
    }));
  });

  test.each(['bad', 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid structured weight %s', (weight) => {
      const identity = resolveProductIdentity({ text: 'Silver Eagle 1 oz', structured: { weight } });

      expect(identity.nominalWeightOz).toBeNull();
      expect(identity.weightEvidence).toEqual(expect.objectContaining({
        status: 'ambiguous',
        source: 'structured',
        conflict: true,
      }));
      expect(identity.ambiguous).toBe(true);
    }
  );

  test('throws a typed validation error for ambiguous identity', () => {
    const identity = resolveProductIdentity({ text: '1 oz and 5 oz Silver Bars' });

    expect(() => assertUnambiguousProductIdentity(identity)).toThrow(expect.objectContaining({
      name: 'ProductIdentityError',
      code: 'AMBIGUOUS_PRODUCT_IDENTITY',
      identity,
    }));
  });

  test.each([
    [{ grade: 'MS70' }, {}, 'graded'],
    [{ isProof: true }, {}, 'proof'],
    [{ finish: 'Reverse Proof' }, {}, 'reverse-proof'],
    [{}, { grade: 'PR69' }, 'proof'],
    [{}, { grade: 'SP66' }, 'proof'],
    [{}, { grade: 'MS64', finish: 'Proof-Like' }, 'graded'],
    [{}, {}, 'raw'],
  ])('classifies the target pool from structured and parsed intent', (structured, parsed, pool) => {
    expect(resolveProductIdentity({ structured, parsed }).pool).toBe(pool);
  });

  test('does not allow a caller-supplied pool to override grade and finish evidence', () => {
    const identity = resolveProductIdentity({
      structured: { pool: 'raw', grade: 'PR70', finish: 'Proof' },
    });

    expect(identity.pool).toBe('proof');
    expect(identity.poolConstrained).toBe(true);
  });

  test('keeps parser-expanded BU terms in the raw pool', () => {
    const identity = resolveProductIdentity({
      text: '2025 American Silver Eagle 1 oz BU',
      parsed: { grade: 'MS60', _gradeSource: 'bu-term' },
    });

    expect(identity.grade).toBeNull();
    expect(identity.pool).toBe('raw');
  });

  test.each([
    ['year', { year: 2025 }, { year: 2024 }],
    ['mint', { mint: 'W' }, { mint: 'S' }],
    ['metal', { metal: 'silver' }, { metal: 'gold' }],
    ['series', { series: 'American Gold Eagle' }, { series: 'Gold Maple Leaf' }],
    ['grade', { grade: 'MS70' }, { grade: 'PR70' }],
    ['finish', { finish: 'Burnished' }, { finish: 'Reverse Proof' }],
    ['designation', { designation: 'DCAM' }, { designation: 'CAM' }],
  ])('flags conflicting structured and text %s identity', (field, structured, parsed) => {
    const identity = resolveProductIdentity({ structured, parsed });

    expect(identity.ambiguous).toBe(true);
    expect(identity.ambiguities).toContainEqual(expect.objectContaining({ field }));
  });

  test('accepts PF and parser-normalized PR grade aliases', () => {
    const identity = resolveProductIdentity({
      structured: { grade: 'PF69' },
      parsed: { grade: 'PR69' },
    });

    expect(identity.ambiguous).toBe(false);
  });

  test('checks composition aliases for metal conflicts', () => {
    const identity = resolveProductIdentity({
      structured: { composition: 'gold' },
      parsed: { metal: 'silver' },
    });

    expect(identity.ambiguities).toContainEqual(expect.objectContaining({ field: 'metal' }));
  });

  test.each([
    ['2024 2025 American Silver Eagle', 'year'],
    ['2025-S 2025-W American Silver Eagle', 'mint'],
    ['gold silver commemorative coin', 'metal'],
    ['Morgan Dollar PR69 MS70', 'grade'],
  ])('rejects contradictory %s text evidence', (text, field) => {
    const identity = resolveProductIdentity({ text });

    expect(identity.ambiguous).toBe(true);
    expect(identity.ambiguities).toContainEqual(expect.objectContaining({ field }));
  });

  test('accepts a zodiac product name as a refinement of a generic Australian series', () => {
    const identity = resolveProductIdentity({
      structured: { name: 'Year of the Dragon' },
      parsed: { series: 'Australian Silver Coin' },
    });

    expect(identity.ambiguous).toBe(false);
    expect(identity.series).toBe('Year of the Dragon');
  });

  test.each([
    ['Gold Krugerrand', 'Krugerrand'],
    ['Mexican Silver Libertad', 'Libertad'],
  ])('treats known parser series aliases %s and %s as equivalent', (expectedSeries, actualSeries) => {
    const { findIdentityMismatches } = require('../src/utils/productIdentityResolver');

    expect(findIdentityMismatches(
      { series: expectedSeries },
      { series: actualSeries }
    )).toEqual([]);
  });

  test('accepts a full generic Maple Leaf description with parsed silver-series shorthand', () => {
    const identity = resolveProductIdentity({
      text: '2015 Canadian Maple Leaf Silver 1 oz Reverse Proof EMC2 Privy',
      structured: {
        name: 'Canadian Maple Leaf Reverse Proof',
        year: 2015,
        composition: 'silver',
        weight: 1,
        finish: 'Reverse Proof',
      },
      parsed: {
        series: 'Canadian Silver Maple Leaf',
        year: 2015,
        metal: 'silver',
        weight: 1,
        finish: 'Reverse Proof',
      },
    });

    expect(identity).toEqual(expect.objectContaining({
      series: 'Canadian Maple Leaf Reverse Proof',
      metal: 'silver',
      nominalWeightOz: 1,
      finish: 'Reverse Proof',
      pool: 'reverse-proof',
      ambiguous: false,
    }));
  });

  test('preserves a registered special mark orthogonally to reverse-proof pool identity', () => {
    const identity = resolveProductIdentity({
      text: '2015 Canadian Silver Maple Leaf 1 oz Reverse Proof E=mc2 Privy',
      structured: {
        name: 'Canadian Maple Leaf', year: 2015, composition: 'silver', weight: 1,
        finish: 'Reverse Proof', specialMarkMode: 'exact',
        specialMarks: [{ markId: 'rcm.maple.emc2' }],
      },
      parsed: { series: 'Canadian Silver Maple Leaf', year: 2015, metal: 'silver', weight: 1, finish: 'Reverse Proof' },
    });

    expect(identity).toEqual(expect.objectContaining({
      pool: 'reverse-proof',
      specialMarkMode: 'exact',
      specialMarks: [expect.objectContaining({ markId: 'rcm.maple.emc2', canonicalName: 'E=mc2' })],
      ambiguous: false,
    }));
  });

  test('fails closed when a registered mark is not applicable to the product context', () => {
    const identity = resolveProductIdentity({
      structured: {
        name: 'Canadian Maple Leaf', year: 2016, composition: 'silver', weight: 1,
        finish: 'Reverse Proof', specialMarkMode: 'exact',
        specialMarks: [{ markId: 'rcm.maple.emc2' }],
      },
    });
    expect(identity.ambiguities).toContainEqual(expect.objectContaining({
      field: 'specialMark', markId: 'rcm.maple.emc2', reason: 'inapplicable',
    }));
    expect(() => assertUnambiguousProductIdentity(identity)).toThrow(/specialMark/);
  });

  test('rejects conflicting explicit denomination evidence for an exact mark', () => {
    const identity = resolveProductIdentity({
      text: '2015 Canadian Silver Maple Leaf $50 1 oz Reverse Proof E=mc2 Privy',
      structured: {
        name: 'Canadian Maple Leaf', year: 2015, composition: 'silver', weight: 1,
        denomination: 5, finish: 'Reverse Proof', specialMarkMode: 'exact',
        specialMarks: [{ markId: 'rcm.maple.emc2' }],
      },
    });
    expect(identity.ambiguities).toContainEqual(expect.objectContaining({
      field: 'denomination', structured: 5, text: 50,
    }));
  });

  test('resolves an exact registered mark from complete quick-search text', () => {
    const identity = resolveProductIdentity({
      text: '2015 Canadian Silver Maple Leaf 1 oz Reverse Proof E=mc2 Privy',
      parsed: { series: 'Canadian Silver Maple Leaf', year: 2015, metal: 'silver', weight: 1, finish: 'Reverse Proof' },
    });
    expect(identity.specialMarkMode).toBe('exact');
    expect(identity.specialMarks).toEqual([
      expect.objectContaining({ markId: 'rcm.maple.emc2', canonicalName: 'E=mc2' }),
    ]);
  });

  test('keeps unknown-mode detail unverified even when it resembles a known alias', () => {
    const identity = resolveProductIdentity({
      text: '2015 Canadian Silver Maple Leaf 1 oz Reverse Proof EMC2 Privy',
      structured: {
        name: 'Canadian Maple Leaf', year: 2015, composition: 'silver', weight: 1,
        finish: 'Reverse Proof', specialMarkMode: 'unknown', variantDetail: 'EMC2',
      },
      parsed: { series: 'Canadian Silver Maple Leaf', year: 2015, metal: 'silver', weight: 1, finish: 'Reverse Proof' },
    });
    expect(identity.specialMarkMode).toBe('unknown');
    expect(identity.specialMarks).toEqual([
      expect.objectContaining({ markId: null, canonicalName: 'EMC2', officialStatus: 'unknown' }),
    ]);
  });

  test.each(['standard', 'unspecified'])(
    'rejects %s mode when the product text names a registered mark', (specialMarkMode) => {
      const identity = resolveProductIdentity({
        text: '2015 Canadian Silver Maple Leaf 1 oz Reverse Proof E=mc2 Privy',
        structured: {
          name: 'Canadian Maple Leaf', year: 2015, composition: 'silver', weight: 1,
          finish: 'Reverse Proof', specialMarkMode,
        },
        parsed: { series: 'Canadian Silver Maple Leaf', year: 2015, metal: 'silver', weight: 1, finish: 'Reverse Proof' },
      });
      expect(identity.ambiguities).toContainEqual(expect.objectContaining({
        field: 'specialMark', structured: specialMarkMode, reason: 'mode-text-conflict',
      }));
    }
  );

  test('does not equate explicitly silver and gold Maple Leaf series', () => {
    const identity = resolveProductIdentity({
      structured: { series: 'Canadian Silver Maple Leaf' },
      parsed: { series: 'Canadian Gold Maple Leaf' },
    });

    expect(identity.ambiguities).toContainEqual(expect.objectContaining({ field: 'series' }));
  });

  test('treats a generic proof dataset as compatible with a numeric proof grade', () => {
    const { findIdentityMismatches } = require('../src/utils/productIdentityResolver');

    expect(findIdentityMismatches(
      { grade: 'Proof', pool: 'proof' },
      { grade: 'PR69', pool: 'proof' }
    )).toEqual([]);
  });

  test('does not constrain pool when the dataset identity has no grade or finish evidence', () => {
    const { findIdentityMismatches } = require('../src/utils/productIdentityResolver');

    expect(findIdentityMismatches(
      { pool: 'raw', poolConstrained: false },
      { grade: 'MS70', pool: 'graded' }
    )).toEqual([]);
  });

  test.each(['Australian Gold Kangaroo', 'Australian Kookaburra', 'Canadian Lunar Coin'])(
    'does not treat %s as an equivalent zodiac series', (series) => {
      const identity = resolveProductIdentity({
        structured: { name: 'Year of the Dragon' },
        parsed: { series },
      });

      expect(identity.ambiguities).toContainEqual(expect.objectContaining({ field: 'series' }));
    }
  );

  test('derives versioned comp evidence from listing text', () => {
    const identity = resolveProductIdentity({
      text: '2025-W American Silver Eagle 1 oz Reverse Proof PCGS PR70',
    });

    expect(identity).toEqual(expect.objectContaining({
      year: '2025',
      mint: 'W',
      metal: 'silver',
      nominalWeightOz: 1,
      grade: 'PR70',
      finish: 'Reverse Proof',
      designation: null,
      pool: 'reverse-proof',
      parserVersion: PRODUCT_IDENTITY_PARSER_VERSION,
    }));
  });

  test('keeps Proof-Like business strikes graded and extracts their designation', () => {
    const identity = resolveProductIdentity({ text: '1881-S Morgan Dollar MS64 Proof-Like PL' });

    expect(identity).toEqual(expect.objectContaining({
      grade: 'MS64',
      finish: 'Proof-Like',
      designation: 'PL',
      pool: 'graded',
    }));
  });

  test('extracts historic mint marks and proof designations', () => {
    const identity = resolveProductIdentity({ text: '1893-CC Morgan Dollar PCGS PR65 DCAM' });

    expect(identity).toEqual(expect.objectContaining({
      mint: 'CC',
      grade: 'PR65',
      designation: 'DCAM',
      pool: 'proof',
    }));
  });
});