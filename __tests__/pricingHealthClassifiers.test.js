'use strict';

/**
 * #262W -- Unit tests for scripts/lib/pricingHealthClassifiers.js.
 *
 * Pure-function tests; no HTTP, no spawn. Each rule is a regression pin
 * for a previously-missed RED case in pricing-health-full.js:
 *   - rp-melt-floor       -> the #260W class (RP Morgan returned silver melt)
 *   - dealer-premium      -> generic premium drift (#196 integration)
 *   - fractional-collision-> the #261W class (1/10 oz == 1/20 oz FMV)
 */

const {
  classifyRpMeltFloor,
  classifyDealerPremium,
  findFractionalCollisions,
  detectSeriesFromQuery,
  detectFormFromQuery,
  PROOF_INTENT_RE,
} = require('../scripts/lib/pricingHealthClassifiers');

describe('#262W classifiers -- detectSeriesFromQuery', () => {
  test.each([
    ['1 oz American Silver Eagle', 'American Silver Eagle'],
    ['2024 South African Krugerrand 1 oz', 'Gold Krugerrand'],
    ['2024 South African Silver Krugerrand 1 oz', 'Silver Krugerrand'],
    ['1/10 oz Canadian Gold Maple Leaf', 'Canadian Gold Maple Leaf'],
    ['1/20 oz Canadian Gold Maple Leaf', 'Canadian Gold Maple Leaf'],
    ['2020 China 30g Silver Panda BU', 'Chinese Silver Panda'],
    ['2023 Mexican Gold Libertad 1 oz', 'Mexican Gold Libertad'],
    ['2021 Perth Lunar Ox 1 oz silver', 'Silver Lunar'],
    ['1923 Peace Dollar', null],          // no bullion series -> null
    ['1909-S VDB Lincoln Cent', null],    // base metal -> null
  ])('%s -> %s', (q, expected) => {
    expect(detectSeriesFromQuery(q)).toBe(expected);
  });
});

describe('#262W classifiers -- detectFormFromQuery', () => {
  test('coin (default)', () => expect(detectFormFromQuery('1 oz Silver Eagle')).toBe('coin'));
  test('bar', () => expect(detectFormFromQuery('1 oz Silver Bar PAMP')).toBe('bar'));
  test('round', () => expect(detectFormFromQuery('1 oz Silver Round Buffalo')).toBe('round'));
  test('empty', () => expect(detectFormFromQuery('')).toBe('coin'));
});

describe('#262W classifiers -- classifyRpMeltFloor', () => {
  // The #260W signature: proof intent + >=10 surviving comps + spot fallback.
  test('flags RED when RP intent + >=10 comps + bullion-spot-premium', () => {
    const issue = classifyRpMeltFloor({
      query: '2023 Reverse Proof Morgan Silver Dollar',
      discovery: { method: 'bullion-spot-premium', usComps: 50, fmv: 35 },
    });
    expect(issue).not.toBeNull();
    expect(issue.severity).toBe('RED');
    expect(issue.type).toBe('rp-melt-floor');
    expect(issue.usComps).toBe(50);
  });

  test('flags RED for plain "Proof" intent (not just "Reverse Proof")', () => {
    const issue = classifyRpMeltFloor({
      query: '2024 Proof American Silver Eagle',
      discovery: { method: 'bullion-spot-premium', usComps: 25, fmv: 40 },
    });
    expect(issue).not.toBeNull();
    expect(issue.severity).toBe('RED');
  });

  test('null when method is certified-blend (proof comps actually won)', () => {
    expect(classifyRpMeltFloor({
      query: '2023 Reverse Proof Morgan Silver Dollar',
      discovery: { method: 'certified-blend', usComps: 50, fmv: 130 },
    })).toBeNull();
  });

  test('null when query has no proof intent', () => {
    expect(classifyRpMeltFloor({
      query: '1921 Morgan Silver Dollar',
      discovery: { method: 'bullion-spot-premium', usComps: 50, fmv: 35 },
    })).toBeNull();
  });

  test('null when usComps < 10 (genuinely no comp data -> fallback is correct)', () => {
    expect(classifyRpMeltFloor({
      query: '2023 Reverse Proof Morgan Silver Dollar',
      discovery: { method: 'bullion-spot-premium', usComps: 3, fmv: 35 },
    })).toBeNull();
  });

  test('null on malformed inputs', () => {
    expect(classifyRpMeltFloor({})).toBeNull();
    expect(classifyRpMeltFloor({ query: 'x' })).toBeNull();
    expect(classifyRpMeltFloor()).toBeNull();
  });

  test('PROOF_INTENT_RE matches reverse proof, enhanced reverse proof, proof', () => {
    expect(PROOF_INTENT_RE.test('reverse proof')).toBe(true);
    expect(PROOF_INTENT_RE.test('Enhanced Reverse Proof')).toBe(true);
    expect(PROOF_INTENT_RE.test('PROOF')).toBe(true);
    // Conservative: \b boundary; "proofs" (plural) is NOT a proof intent.
    expect(PROOF_INTENT_RE.test('proofs')).toBe(false);
    expect(PROOF_INTENT_RE.test('mint set')).toBe(false);
  });
});

describe('#262W classifiers -- classifyDealerPremium', () => {
  // Silver Eagle band: 0.25 .. 0.80. Spot silver ~$32/oz -> meltValue = $32
  // for a 1 oz coin. A $200 FMV gives (200-32)/32 = 5.25 = 525% premium,
  // which is way above the 0.80 band -> RED 'high'.
  test('flags RED high when premium far above band (1 oz Silver Eagle @ $200)', () => {
    const issue = classifyDealerPremium({
      query: '2024 American Silver Eagle 1 oz',
      discovery: { fmv: 200, spotPrice: 32 },
    });
    expect(issue).not.toBeNull();
    expect(issue.severity).toBe('RED');
    expect(issue.type).toBe('dealer-premium');
    expect(issue.classification).toBe('high');
    expect(issue.bandKey).toBe('silver-eagle-1oz');
  });

  // Same coin, fmv = $40 (premium 0.25 = 25%) -> on the lower edge -> 'normal' -> null.
  test('null when premium is inside band (Silver Eagle @ $40, spot $32)', () => {
    expect(classifyDealerPremium({
      query: '2024 American Silver Eagle 1 oz',
      discovery: { fmv: 40, spotPrice: 32 },
    })).toBeNull();
  });

  // Realized FMV BELOW melt -> classification 'low' -> RED.
  test('flags RED low when fmv below band floor (1 oz Gold Eagle @ $1900, spot $2200)', () => {
    const issue = classifyDealerPremium({
      query: '2024 American Gold Eagle 1 oz',
      discovery: { fmv: 1900, spotPrice: 2200 }, // premium = -13.6% -> below 0.04 floor
    });
    expect(issue).not.toBeNull();
    expect(issue.classification).toBe('low');
  });

  test('null when series not in dealerPremiums coverage (fail-quiet)', () => {
    expect(classifyDealerPremium({
      query: '1921 Morgan Silver Dollar', // not a bullion series
      discovery: { fmv: 35, spotPrice: 25 },
    })).toBeNull();
  });

  test('null when spotPrice missing', () => {
    expect(classifyDealerPremium({
      query: '2024 American Silver Eagle 1 oz',
      discovery: { fmv: 200, spotPrice: null },
    })).toBeNull();
  });

  test('null on malformed inputs', () => {
    expect(classifyDealerPremium({})).toBeNull();
    expect(classifyDealerPremium()).toBeNull();
  });
});

describe('#262W classifiers -- findFractionalCollisions', () => {
  // The #261W signature: 1/10 oz and 1/20 oz Gold Maple Leaf both
  // returning $4986 because the fractional melt ceiling was scaled
  // to a full-ounce comp.
  test('flags both rows in a 2x weight pair with FMV within 1%', () => {
    const results = [
      { coin: '1/20 oz Canadian Gold Maple Leaf', discovery: { fmv: 4986.93 } },
      { coin: '1/10 oz Canadian Gold Maple Leaf', discovery: { fmv: 4986.93 } },
      { coin: '1923 Peace Dollar',                 discovery: { fmv: 35 } },
    ];
    const collisions = findFractionalCollisions(results);
    expect(collisions.size).toBe(2);
    const a = collisions.get('1/20 oz Canadian Gold Maple Leaf');
    expect(a).toBeDefined();
    expect(a.severity).toBe('RED');
    expect(a.type).toBe('fractional-collision');
    expect(a.peer).toBe('1/10 oz Canadian Gold Maple Leaf');
    expect(a.weight).toBeCloseTo(0.05, 3);
    expect(a.peerWeight).toBeCloseTo(0.1, 3);
    expect(a.fmvDeltaPct).toBeLessThanOrEqual(1);
  });

  test('no collision when FMVs differ by more than 1%', () => {
    const results = [
      { coin: '1/20 oz Canadian Gold Maple Leaf', discovery: { fmv: 250 } },
      { coin: '1/10 oz Canadian Gold Maple Leaf', discovery: { fmv: 500 } }, // healthy 2x scaling
    ];
    expect(findFractionalCollisions(results).size).toBe(0);
  });

  test('no collision across different series (Maple vs Krugerrand)', () => {
    const results = [
      { coin: '1/10 oz Canadian Gold Maple Leaf', discovery: { fmv: 4986 } },
      { coin: '1/10 oz Gold Krugerrand',          discovery: { fmv: 4986 } },
    ];
    expect(findFractionalCollisions(results).size).toBe(0);
  });

  test('no collision when weight ratio is not 2x (e.g. 1/20 vs 1/4)', () => {
    const results = [
      { coin: '1/20 oz Canadian Gold Maple Leaf', discovery: { fmv: 4986 } },
      { coin: '1/4 oz Canadian Gold Maple Leaf',  discovery: { fmv: 4986 } },
    ];
    expect(findFractionalCollisions(results).size).toBe(0);
  });

  test('handles empty / malformed inputs without throwing', () => {
    expect(findFractionalCollisions([]).size).toBe(0);
    expect(findFractionalCollisions(null).size).toBe(0);
    expect(findFractionalCollisions(undefined).size).toBe(0);
    expect(findFractionalCollisions([{ coin: 'x' }]).size).toBe(0);
  });

  test('skips entries with non-finite or zero FMV', () => {
    const results = [
      { coin: '1/20 oz Canadian Gold Maple Leaf', discovery: { fmv: 0 } },
      { coin: '1/10 oz Canadian Gold Maple Leaf', discovery: { fmv: NaN } },
    ];
    expect(findFractionalCollisions(results).size).toBe(0);
  });
});
