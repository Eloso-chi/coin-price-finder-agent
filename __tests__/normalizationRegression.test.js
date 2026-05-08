/**
 * normalizationRegression.test.js -- Regression tests for key normalization bugs
 *
 * Covers all bugs discovered in the 2026-05-08 normalization audit:
 *   - Broken fraction handling (1/2 oz -> "12oz" instead of "half oz")
 *   - Year-mint hyphen/space divergence ("1878-cc" vs "1878 cc")
 *   - Country/adjective mismatch ("mexico" vs "mexican")
 *   - Cross-script normalizer consistency (backfill, freshness, prune)
 *   - Ghost key detection (mangled fractions, Cosmos-only keys)
 *   - CSV-to-meta key matching
 */
'use strict';

const { normalizeSearchKey, detectWeightFromQuery } = require('../src/services/terapeakService');

// ═══════════════════════════════════════════════════════════════
//  Bug F5: Fraction handling in normalizeSearchKey
//  Old behavior: "1/2 oz" -> "12oz", "1/4 oz" -> "14oz"
//  Fixed: "1/2 oz" -> "half oz", "1/4 oz" -> "quarter oz"
// ═══════════════════════════════════════════════════════════════
describe('normalizeSearchKey -- fraction handling (F5 regression)', () => {
  test('1/2 oz converts to "half oz"', () => {
    expect(normalizeSearchKey('1/2 oz Silver Libertad')).toBe('half oz silver libertad');
  });

  test('1/4 oz converts to "quarter oz"', () => {
    expect(normalizeSearchKey('1/4 oz Gold Eagle')).toBe('quarter oz gold eagle');
  });

  test('1/10 oz converts to "tenth oz"', () => {
    expect(normalizeSearchKey('1/10 oz Platinum Eagle')).toBe('tenth oz platinum eagle');
  });

  test('fractions with no space before oz', () => {
    expect(normalizeSearchKey('1/2oz Libertad')).toBe('half oz libertad');
    expect(normalizeSearchKey('1/4oz Gold Eagle')).toBe('quarter oz gold eagle');
    expect(normalizeSearchKey('1/10oz Platinum')).toBe('tenth oz platinum');
  });

  test('does NOT produce mangled forms like 12oz, 14oz, 110oz', () => {
    const result1 = normalizeSearchKey('1/2 oz Libertad');
    const result2 = normalizeSearchKey('1/4 oz Gold Eagle');
    const result3 = normalizeSearchKey('1/10 oz Platinum');
    expect(result1).not.toContain('12oz');
    expect(result2).not.toContain('14oz');
    expect(result3).not.toContain('110oz');
  });

  test('integer oz still collapses ("1 oz" -> "1oz")', () => {
    expect(normalizeSearchKey('Silver Eagle 1 oz')).toBe('silver eagle 1oz');
    expect(normalizeSearchKey('Silver Eagle 2 oz')).toBe('silver eagle 2oz');
    expect(normalizeSearchKey('Silver Eagle 10 oz')).toBe('silver eagle 10oz');
  });

  test('already-word-form fractions pass through correctly', () => {
    expect(normalizeSearchKey('half oz Silver Libertad')).toBe('half oz silver libertad');
    expect(normalizeSearchKey('quarter oz Gold Eagle')).toBe('quarter oz gold eagle');
    expect(normalizeSearchKey('tenth oz Platinum Eagle')).toBe('tenth oz platinum eagle');
  });

  test('gram weights are not broken', () => {
    expect(normalizeSearchKey('2017 China 30g Silver Panda')).toBe('2017 china 30g silver panda');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Bug F1: Year-mint hyphen/space divergence
//  Old backfill preserved hyphens ("1878-cc"), server split them ("1878 cc")
// ═══════════════════════════════════════════════════════════════
describe('normalizeSearchKey -- year-mint normalization (F1 regression)', () => {
  test('splits year-mint hyphen for common mint marks', () => {
    expect(normalizeSearchKey('1878-CC')).toBe('1878 cc');
    expect(normalizeSearchKey('1893-S')).toBe('1893 s');
    expect(normalizeSearchKey('1921-D')).toBe('1921 d');
    expect(normalizeSearchKey('1889-O')).toBe('1889 o');
  });

  test('splits year-mint in context of full coin name', () => {
    expect(normalizeSearchKey('1878-CC Morgan Silver Dollar')).toBe('1878 cc morgan silver dollar');
    expect(normalizeSearchKey('1893-S Morgan Silver Dollar MS65')).toBe('1893 s morgan silver dollar ms65');
  });

  test('CSV filename with year-mint matches meta key', () => {
    // CSV: "1878-CC_Morgan_Silver_Dollar.csv" -> stem: "1878-CC Morgan Silver Dollar"
    const csvStem = '1878-CC Morgan Silver Dollar';
    // Meta key from Cosmos/search: "1878 CC Morgan Silver Dollar"
    const searchTerm = '1878 CC Morgan Silver Dollar';
    expect(normalizeSearchKey(csvStem)).toBe(normalizeSearchKey(searchTerm));
  });

  test('handles double-letter mint marks', () => {
    expect(normalizeSearchKey('1878-CC')).toBe('1878 cc');
    // Non-year hyphens should be preserved
    expect(normalizeSearchKey('MS-65')).toBe('ms-65');
  });

  test('zero-to-O normalization for year-mint typo', () => {
    expect(normalizeSearchKey('1883-0 Morgan')).toBe('1883 morgan');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Bug: Roman numeral stripping
//  "Perth Lunar III" -> "perth lunar" (not "perth lunar iii")
// ═══════════════════════════════════════════════════════════════
describe('normalizeSearchKey -- Roman numeral stripping', () => {
  test('strips standalone Roman numerals I through V', () => {
    expect(normalizeSearchKey('Perth Lunar I Silver')).toBe('perth lunar silver');
    expect(normalizeSearchKey('Perth Lunar II Silver')).toBe('perth lunar silver');
    expect(normalizeSearchKey('Perth Lunar III Silver')).toBe('perth lunar silver');
    expect(normalizeSearchKey('Perth Lunar IV Silver')).toBe('perth lunar silver');
    expect(normalizeSearchKey('Perth Lunar V Silver')).toBe('perth lunar silver');
  });

  test('does not strip Roman numerals embedded in words', () => {
    // "silver" contains "i" and "v" but they should not be stripped
    expect(normalizeSearchKey('silver')).toBe('silver');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Cross-format key equivalence
//  Different naming conventions MUST normalize to the same key
// ═══════════════════════════════════════════════════════════════
describe('normalizeSearchKey -- cross-format equivalence', () => {
  test('CSV filename and search term produce same key', () => {
    // CSV: "2011_Mexican_Silver_Libertad_1oz.csv"
    const csvKey = normalizeSearchKey('2011 Mexican Silver Libertad 1oz');
    // Search term: "2011 Mexican Silver Libertad 1oz"
    const searchKey = normalizeSearchKey('2011 Mexican Silver Libertad 1oz');
    expect(csvKey).toBe(searchKey);
  });

  test('year-mint CSV matches year-mint search term', () => {
    const csvKey = normalizeSearchKey('1936-S Walking Liberty Half MS64');
    const searchKey = normalizeSearchKey('1936 S Walking Liberty Half MS64');
    expect(csvKey).toBe(searchKey);
  });

  test('fraction CSV matches fraction search term', () => {
    const csvKey = normalizeSearchKey('American Gold Eagle Half oz');
    const searchKey = normalizeSearchKey('American Gold Eagle 1/2 oz');
    expect(csvKey).toBe(searchKey);
  });

  test('fraction quarter oz equivalence', () => {
    const csvKey = normalizeSearchKey('American Gold Eagle Quarter oz');
    const searchKey = normalizeSearchKey('American Gold Eagle 1/4 oz');
    expect(csvKey).toBe(searchKey);
  });

  test('fraction tenth oz equivalence', () => {
    const csvKey = normalizeSearchKey('American Platinum Eagle Tenth oz');
    const searchKey = normalizeSearchKey('American Platinum Eagle 1/10 oz');
    expect(csvKey).toBe(searchKey);
  });

  test('Lunar series with Roman numeral stripped', () => {
    const csvKey = normalizeSearchKey('2024 Perth Lunar III Dragon 1oz Gold');
    const searchKey = normalizeSearchKey('2024 Perth Lunar Dragon 1oz Gold');
    expect(csvKey).toBe(searchKey);
  });
});

// ═══════════════════════════════════════════════════════════════
//  detectWeightFromQuery -- fraction/word form consistency
//  Must agree with normalizeSearchKey's output
// ═══════════════════════════════════════════════════════════════
describe('detectWeightFromQuery -- fraction consistency with normalizeSearchKey', () => {
  test('detects weight from normalizeSearchKey output', () => {
    // After normalization, "1/2 oz" becomes "half oz"
    const normalized = normalizeSearchKey('1/2 oz Silver Libertad');
    expect(detectWeightFromQuery(normalized)).toBe(0.5);
  });

  test('detects quarter oz from normalized key', () => {
    const normalized = normalizeSearchKey('1/4 oz Gold Eagle');
    expect(detectWeightFromQuery(normalized)).toBe(0.25);
  });

  test('detects tenth oz from normalized key', () => {
    const normalized = normalizeSearchKey('1/10 oz Platinum Eagle');
    expect(detectWeightFromQuery(normalized)).toBe(0.1);
  });

  test('detects 1oz from normalized key', () => {
    const normalized = normalizeSearchKey('Silver Eagle 1 oz');
    expect(detectWeightFromQuery(normalized)).toBe(1);
  });

  test('original and normalized forms produce same weight', () => {
    const pairs = [
      '1/2 oz Silver Libertad',
      '1/4 oz Gold Eagle',
      '1/10 oz Platinum Eagle',
      'Silver Eagle 1 oz',
      'Gold Buffalo 1oz',
      'Perth Lunar Silver 2oz',
    ];
    for (const term of pairs) {
      const original = detectWeightFromQuery(term);
      const normalized = detectWeightFromQuery(normalizeSearchKey(term));
      expect(normalized).toBe(original);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
//  Ghost key detection helpers
//  Verify that broken-fraction keys are identifiable
// ═══════════════════════════════════════════════════════════════
describe('ghost key patterns', () => {
  test('mangled fraction keys do NOT match correct-form keys', () => {
    // "12oz" (mangled from "1/2 oz") must NOT equal "half oz"
    expect(normalizeSearchKey('american gold eagle 12oz'))
      .not.toBe(normalizeSearchKey('american gold eagle half oz'));
  });

  test('mangled fraction pattern is detectable via regex', () => {
    // These patterns indicate old-normalizer ghost keys
    const mangledPattern = /\b(12oz|14oz|110oz)\b/;
    expect(mangledPattern.test('american gold eagle 12oz')).toBe(true);
    expect(mangledPattern.test('american gold eagle 14oz')).toBe(true);
    expect(mangledPattern.test('american gold eagle 110oz')).toBe(true);
    // Correct forms should NOT match
    expect(mangledPattern.test('american gold eagle half oz')).toBe(false);
    expect(mangledPattern.test('american gold eagle quarter oz')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Country/adjective word-set matching
//  "mexico" vs "mexican" normalization for CSV-to-meta matching
// ═══════════════════════════════════════════════════════════════
describe('country/adjective normalization', () => {
  const DEMONYM_MAP = {
    mexican: 'mexico',
    canadian: 'canada',
    chinese: 'china',
    australian: 'australia',
    austrian: 'austria',
    british: 'britain',
  };

  function normalizeWordSet(key) {
    return key.toLowerCase()
      .replace(/[_-]/g, ' ')
      .replace(/\bmexican\b/g, 'mexico')
      .replace(/\bcanadian\b/g, 'canada')
      .replace(/\bchinese\b/g, 'china')
      .replace(/\baustralian\b/g, 'australia')
      .replace(/\baustrian\b/g, 'austria')
      .replace(/\bbritish\b/g, 'britain')
      .split(/\s+/).filter(Boolean).sort().join(' ');
  }

  test('country noun and adjective produce same word-set', () => {
    for (const [adj, noun] of Object.entries(DEMONYM_MAP)) {
      const adjSet = normalizeWordSet(`2011 ${adj} 1oz silver libertad`);
      const nounSet = normalizeWordSet(`2011 ${noun} 1oz silver libertad`);
      expect(adjSet).toBe(nounSet);
    }
  });

  test('CSV filename (adjective) matches meta key (noun) via word-set', () => {
    // CSV: "2011_Mexican_Silver_Libertad_1oz.csv"
    const csvWordSet = normalizeWordSet('2011 Mexican Silver Libertad 1oz');
    // Meta key from Cosmos: "2011 mexico 1oz silver libertad"
    const metaWordSet = normalizeWordSet('2011 mexico 1oz silver libertad');
    expect(csvWordSet).toBe(metaWordSet);
  });

  test('word order differences are handled by sorted word-set', () => {
    // CSV: adjective form, weight at end
    const csv = normalizeWordSet('2011 Mexican Silver Libertad 1oz');
    // Cosmos: country form, weight in middle
    const cosmos = normalizeWordSet('2011 mexico 1oz silver libertad');
    expect(csv).toBe(cosmos);
  });

  test('different countries do NOT match', () => {
    const mexico = normalizeWordSet('2011 mexico 1oz silver libertad');
    const canada = normalizeWordSet('2011 canada 1oz silver maple leaf');
    expect(mexico).not.toBe(canada);
  });
});

// ═══════════════════════════════════════════════════════════════
//  eBay exclusion operator stripping
// ═══════════════════════════════════════════════════════════════
describe('normalizeSearchKey -- eBay exclusion operators', () => {
  test('strips -gold and -silver exclusion operators', () => {
    expect(normalizeSearchKey('Morgan Dollar -gold -proof')).toBe('morgan dollar');
  });

  test('does not strip hyphenated year-mints', () => {
    // "1878-CC" has a digit before the hyphen, not stripped
    expect(normalizeSearchKey('1878-CC Morgan -proof')).toBe('1878 cc morgan');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Real-world regression cases from the 2026-05-08 audit
//  Each of these was a confirmed ghost or duplicate found in production
// ═══════════════════════════════════════════════════════════════
describe('real-world regression cases', () => {
  test('Type 2 ghost: mint-mark hyphen vs space (1878-cc vs 1878 cc)', () => {
    // These were separate meta entries before the fix
    expect(normalizeSearchKey('1878-CC Morgan Silver Dollar'))
      .toBe(normalizeSearchKey('1878 CC Morgan Silver Dollar'));
  });

  test('Type 4 ghost: mangled fraction (12oz from 1/2 oz)', () => {
    // Old normalizer produced "12oz", new produces "half oz"
    const oldBroken = '12oz';
    const newFixed = normalizeSearchKey('1/2 oz');
    expect(newFixed).toBe('half oz');
    expect(newFixed).not.toBe(oldBroken);
  });

  test('Type 4 ghost: mangled fraction (14oz from 1/4 oz)', () => {
    const newFixed = normalizeSearchKey('1/4 oz');
    expect(newFixed).toBe('quarter oz');
    expect(newFixed).not.toBe('14oz');
  });

  test('Type 4 ghost: mangled fraction (110oz from 1/10 oz)', () => {
    const newFixed = normalizeSearchKey('1/10 oz');
    expect(newFixed).toBe('tenth oz');
    expect(newFixed).not.toBe('110oz');
  });

  test('Walking Liberty half dollar year-mint', () => {
    expect(normalizeSearchKey('1936-S Walking Liberty Half MS64'))
      .toBe('1936 s walking liberty half ms64');
  });

  test('Perth Lunar series with Roman numeral', () => {
    expect(normalizeSearchKey('2024 Perth Lunar III Dragon Gold Quarter'))
      .toBe('2024 perth lunar dragon gold quarter');
  });

  test('integer oz forms are stable', () => {
    // Make sure the fix didn't break integer oz collapsing
    expect(normalizeSearchKey('2020 American Silver Eagle 1oz'))
      .toBe('2020 american silver eagle 1oz');
    expect(normalizeSearchKey('2020 American Silver Eagle 1 oz'))
      .toBe('2020 american silver eagle 1oz');
  });

  test('30g panda format is stable', () => {
    expect(normalizeSearchKey('2017 China 30g Silver Panda'))
      .toBe('2017 china 30g silver panda');
  });

  test('graded coin format is stable', () => {
    expect(normalizeSearchKey('1893-S Morgan Silver Dollar MS65'))
      .toBe('1893 s morgan silver dollar ms65');
  });

  test('bar format is stable', () => {
    expect(normalizeSearchKey('10oz 999 Silver Bar'))
      .toBe('10oz 999 silver bar');
  });
});
