/**
 * normalizeSearchKey.test.js -- #266H Phase 2 alias map + sorted-token
 *                              canonicalization regression suite.
 *
 * Covers each alias rule introduced in #266H Phase 2 and the deterministic
 * sorted-token canonicalization that collapses word-order variants. The
 * golden-input cases are drawn from the top duplicate groups identified in
 * docs/reports/duplicate-keys-report.json -- each pair MUST normalize to
 * the same key, or `scripts/audit-duplicate-keys.js` would re-detect them
 * as drift on the next freshness pass.
 *
 * If you are adding a new alias rule, also add:
 *   - One pair of inputs that exercise the alias in both directions
 *   - One golden-case pair from a real duplicate group (if available)
 *   - The reverse-direction guard so the canonical form is idempotent
 */
'use strict';

const { normalizeSearchKey } = require('../src/services/terapeakService');

// ─────────────────────────────────────────────────────────────────────
//  Country aliases
// ─────────────────────────────────────────────────────────────────────
describe('normalizeSearchKey -- country aliases (#266H Phase 2)', () => {
  test('mexico <-> mexican collapse to the same canonical key', () => {
    const a = normalizeSearchKey('2025 Mexico Half Oz Silver Libertad');
    const b = normalizeSearchKey('2025 Mexican Silver Libertad Half Oz');
    expect(a).toBe(b);
    expect(a).toContain('mexican'); // canonical is the adjective form
    expect(a).not.toContain('mexico');
  });

  test('china <-> chinese collapse to the same canonical key', () => {
    const a = normalizeSearchKey('2017 China 30g Silver Panda');
    const b = normalizeSearchKey('2017 Chinese 30g Silver Panda');
    expect(a).toBe(b);
    expect(a).toContain('chinese');
    expect(a).not.toContain(' china '); // bare "china" should be aliased away
  });

  test('usa / united states / us all collapse to american', () => {
    const usa = normalizeSearchKey('2024 USA Silver Eagle 1oz');
    const us = normalizeSearchKey('2024 US Silver Eagle 1oz');
    const longForm = normalizeSearchKey('2024 United States Silver Eagle 1oz');
    const adjective = normalizeSearchKey('2024 American Silver Eagle 1oz');
    expect(usa).toBe(adjective);
    expect(us).toBe(adjective);
    expect(longForm).toBe(adjective);
    expect(adjective).toContain('american');
  });

  // Deep-review finding #4: "U.S." / "U.S" (dotted single-word form, distinct
  // from "U.S.A.") was previously not aliased -- common in coin descriptions
  // like "U.S. Mint Set" and "U.S. Silver Eagle".
  test('dotted U.S. / U.S forms also collapse to american', () => {
    const adjective = normalizeSearchKey('2024 American Silver Eagle 1oz');
    expect(normalizeSearchKey('2024 U.S. Silver Eagle 1oz')).toBe(adjective);
    expect(normalizeSearchKey('2024 U.S Silver Eagle 1oz')).toBe(adjective);
  });

  test('U.S. Mint Set / US Mint Set / United States Mint Set all collapse', () => {
    const a = normalizeSearchKey('1947 U.S. Mint Set');
    const b = normalizeSearchKey('1947 US Mint Set');
    const c = normalizeSearchKey('1947 United States Mint Set');
    const d = normalizeSearchKey('1947 American Mint Set');
    expect(a).toBe(d);
    expect(b).toBe(d);
    expect(c).toBe(d);
  });

  // Deep-review finding #7: repeated tokens after alias collapse (e.g.
  // "usa american USA" -> three "american" tokens) used to survive the
  // sort step; dedupe collapses them.
  test('repeated tokens after alias collapse are deduplicated', () => {
    expect(normalizeSearchKey('USA American USA')).toBe('american');
    expect(normalizeSearchKey('china chinese CHINA')).toBe('chinese');
  });

  test('great britain / united kingdom collapse to british', () => {
    const gb = normalizeSearchKey('2025 Great Britain 1oz Gold Britannia');
    const uk = normalizeSearchKey('2025 United Kingdom 1oz Gold Britannia');
    const adj = normalizeSearchKey('2025 British Gold Britannia 1oz');
    expect(gb).toBe(adj);
    expect(uk).toBe(adj);
    expect(adj).toContain('british');
    expect(adj).not.toContain('britain');
  });

  test('royal mint <-> royalmint collapse without word boundary', () => {
    const spaced = normalizeSearchKey('Royal Mint 2024 Britannia Silver 1oz');
    const concat = normalizeSearchKey('RoyalMint 2024 Britannia Silver 1oz');
    expect(spaced).toBe(concat);
    expect(spaced).toContain('royalmint');
  });

  test('common British misspelling "Great Britian" still collapses', () => {
    const typo = normalizeSearchKey('2025 Great Britian 1oz Gold Britannia');
    const canon = normalizeSearchKey('2025 British Gold Britannia 1oz');
    expect(typo).toBe(canon);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Series-redundant country stripping
// ─────────────────────────────────────────────────────────────────────
describe('normalizeSearchKey -- Krugerrand south africa stripping (#266H Phase 2)', () => {
  test('drops bare "south africa" when krugerrand is present', () => {
    const withCountry = normalizeSearchKey('2000 South Africa 1oz Gold Krugerrand');
    const withoutCountry = normalizeSearchKey('2000 Gold Krugerrand 1oz');
    expect(withCountry).toBe(withoutCountry);
    expect(withCountry).not.toContain('south');
    expect(withCountry).not.toContain('africa');
  });

  test('drops "south african" (adjective) for krugerrand', () => {
    const adj = normalizeSearchKey('2010 South African Gold Krugerrand 1oz');
    const canon = normalizeSearchKey('2010 Gold Krugerrand 1oz');
    expect(adj).toBe(canon);
  });

  test('drops collapsed "southafrica" form for krugerrand', () => {
    const collapsed = normalizeSearchKey('southafrica gold krugerrand 1oz');
    const canon = normalizeSearchKey('gold krugerrand 1oz');
    expect(collapsed).toBe(canon);
  });

  test('does NOT strip "south africa" when krugerrand is absent', () => {
    // Other South African coins (rare, but possible) keep the country tokens
    // because there is no implicit-country signal to lean on.
    const out = normalizeSearchKey('1967 South Africa Silver Crown');
    expect(out).toContain('south');
    expect(out).toContain('africa');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Ounce-form aliases (extension of existing fraction handling)
// ─────────────────────────────────────────────────────────────────────
describe('normalizeSearchKey -- ounce notation aliases (#266H Phase 2)', () => {
  test('"one ounce" collapses to "1oz" (matches numeric form)', () => {
    const word = normalizeSearchKey('Silver Eagle One Ounce');
    const num = normalizeSearchKey('Silver Eagle 1oz');
    expect(word).toBe(num);
  });

  test('"1 troy oz" collapses to "1oz"', () => {
    const troy = normalizeSearchKey('Silver Eagle 1 troy oz');
    const plain = normalizeSearchKey('Silver Eagle 1oz');
    expect(troy).toBe(plain);
  });

  test('decimal fraction "0.5 oz" collapses to "half oz"', () => {
    const dec = normalizeSearchKey('Gold Eagle 0.5 oz');
    const word = normalizeSearchKey('Gold Eagle half oz');
    expect(dec).toBe(word);
  });

  test('decimal fraction "0.25 oz" collapses to "quarter oz"', () => {
    const dec = normalizeSearchKey('Gold Eagle 0.25 oz');
    const word = normalizeSearchKey('Gold Eagle quarter oz');
    expect(dec).toBe(word);
  });

  test('decimal fraction "0.1 oz" collapses to "tenth oz"', () => {
    const dec = normalizeSearchKey('Platinum Eagle 0.1 oz');
    const word = normalizeSearchKey('Platinum Eagle tenth oz');
    expect(dec).toBe(word);
  });

  test('decimal fraction "0.05 oz" collapses to "twentieth oz"', () => {
    const dec = normalizeSearchKey('Gold Eagle 0.05 oz');
    const word = normalizeSearchKey('Gold Eagle twentieth oz');
    expect(dec).toBe(word);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Sorted-token canonicalization
// ─────────────────────────────────────────────────────────────────────
describe('normalizeSearchKey -- sorted-token canonicalization (#266H Phase 2)', () => {
  test('word-order variants of the same coin collapse to one key', () => {
    // From docs/reports/duplicate-keys-report.json: the Perth Lunar series
    // is the largest single source of token-order duplicates.
    const a = normalizeSearchKey('2025 Perth Lunar Snake 1oz Silver');
    const b = normalizeSearchKey('Perth Lunar 2025 Snake Silver 1oz');
    expect(a).toBe(b);
  });

  test('output is alphabetically sorted', () => {
    const out = normalizeSearchKey('2025 Perth Lunar Snake 1oz Silver');
    const sorted = out.split(/\s+/).slice().sort().join(' ');
    expect(out).toBe(sorted);
  });

  test('multiple Perth Lunar variants from the audit all collapse', () => {
    const pairs = [
      ['2021 perth lunar ox 1oz silver',     'perth lunar 2021 ox silver 1oz'],
      ['2022 perth lunar tiger half oz silver', '2022 perth lunar tiger half oz silver'],
      ['2023 perth lunar rabbit 1oz silver', '2023 perth lunar rabbit 1oz silver'],
      ['2024 perth lunar dragon 1oz silver', 'perth lunar 2024 dragon silver 1oz'],
    ];
    for (const [a, b] of pairs) {
      expect(normalizeSearchKey(a)).toBe(normalizeSearchKey(b));
    }
  });

  test('idempotent: normalize(normalize(x)) === normalize(x)', () => {
    const inputs = [
      '2025 Mexico Half Oz Silver Libertad',
      '2024 USA Silver Eagle 1oz',
      '2010 South Africa 1oz Gold Krugerrand',
      'Perth Lunar 2025 Snake Silver 1oz',
      '2017 China 30g Silver Panda',
    ];
    for (const x of inputs) {
      const once = normalizeSearchKey(x);
      const twice = normalizeSearchKey(once);
      expect(twice).toBe(once);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Golden cases from duplicate-keys-report.json
// ─────────────────────────────────────────────────────────────────────
describe('normalizeSearchKey -- golden duplicate-pair regression (#266H Phase 2)', () => {
  // Each pair is a real duplicate detected by the Phase 1 audit script.
  // After Phase 2 ships, both halves MUST canonicalize to the same key;
  // otherwise the next audit pass will surface the same drift again.
  const goldenPairs = [
    // Mexican Libertad: country alias (mexican/mexico)
    ['2025 mexico half oz silver libertad',     '2025 mexican silver libertad half oz'],
    // British Gold Britannia: country alias (great britain -> british)
    ['2025 british gold britannia 1oz',         '2025 great britain 1oz gold britannia'],
    ['2013 british gold britannia 1oz',         '2013 great britain 1oz gold britannia'],
    ['2010 british gold britannia 1oz',         '2010 great britain 1oz gold britannia'],
    // Gold Krugerrand: redundant-country stripping
    ['2000 gold krugerrand 1oz',                '2000 south africa 1oz gold krugerrand'],
    ['2001 gold krugerrand 1oz',                '2001 south africa 1oz gold krugerrand'],
    ['2006 gold krugerrand 1oz',                '2006 south africa 1oz gold krugerrand'],
    ['2007 gold krugerrand 1oz',                '2007 south africa 1oz gold krugerrand'],
    // Perth Lunar token-order pairs (pure sorted-token canonicalization)
    ['2025 perth lunar snake 1oz silver',       'perth lunar 2025 snake silver 1oz'],
  ];

  test.each(goldenPairs)('collapses %s == %s', (a, b) => {
    expect(normalizeSearchKey(a)).toBe(normalizeSearchKey(b));
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Negative cases: aliases must NOT collapse semantically-different coins
// ─────────────────────────────────────────────────────────────────────
describe('normalizeSearchKey -- alias negative cases (#266H Phase 2)', () => {
  test('different countries still produce different keys', () => {
    const mx = normalizeSearchKey('2011 Mexican Silver Libertad 1oz');
    const ca = normalizeSearchKey('2011 Canadian Silver Maple Leaf 1oz');
    expect(mx).not.toBe(ca);
  });

  test('different years still produce different keys', () => {
    const y1 = normalizeSearchKey('2010 Perth Lunar Tiger Half Oz Silver');
    const y2 = normalizeSearchKey('2022 Perth Lunar Tiger Half Oz Silver');
    expect(y1).not.toBe(y2);
  });

  test('different weights still produce different keys', () => {
    const half = normalizeSearchKey('2025 Perth Lunar Snake Half Oz Silver');
    const oz1 = normalizeSearchKey('2025 Perth Lunar Snake 1oz Silver');
    expect(half).not.toBe(oz1);
  });

  test('different metals still produce different keys', () => {
    const ag = normalizeSearchKey('2025 Perth Lunar Snake 1oz Silver');
    const au = normalizeSearchKey('2025 Perth Lunar Snake 1oz Gold');
    expect(ag).not.toBe(au);
  });

  test('Krugerrand still differs from Britannia (no over-collapse)', () => {
    const kr = normalizeSearchKey('2010 South Africa 1oz Gold Krugerrand');
    const br = normalizeSearchKey('2010 Great Britain 1oz Gold Britannia');
    expect(kr).not.toBe(br);
  });
});
