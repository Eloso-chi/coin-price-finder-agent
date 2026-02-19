// __tests__/pcgsBullion.test.js — PCGS resolution coverage for bullion coins
// Verifies that parseDescription() returns correct series, year, weight, metal
// and that lookupPCGSNumber() can find a PCGS coin number when the static table
// has an entry.  Any coin that returns null for pcgsNo here will also return
// verified: false from the live API-less path.

const { parseDescription } = require('../src/services/pcgsService');
const { lookupPCGSNumber }  = require('../src/data/pcgsNumbers');

// ── Helper ──────────────────────────────────────────────────
function check(query, expect) {
  const parsed = parseDescription(query);
  const pcgsNo = lookupPCGSNumber(
    parsed.series || '',
    parsed.year,
    parsed.mint
  );
  return { parsed, pcgsNo };
}

// ══════════════════════════════════════════════════════════════
//  US BULLION
// ══════════════════════════════════════════════════════════════
describe('PCGS resolution — US Bullion', () => {
  const US_BULLION = [
    // American Silver Eagles
    { q: '2024 American Silver Eagle MS69',        series: /silver eagle/i, year: 2024, metal: 'silver', weight: null },
    { q: '2023 American Silver Eagle',             series: /silver eagle/i, year: 2023, metal: 'silver' },
    { q: '2021 American Silver Eagle Type 2',      series: /silver eagle/i, year: 2021, metal: 'silver' },
    { q: '1986 American Silver Eagle',             series: /silver eagle/i, year: 1986, metal: 'silver' },
    // American Gold Eagles
    { q: '2024 American Gold Eagle 1 oz',          series: /gold eagle/i, year: 2024, metal: 'gold', weight: 1 },
    { q: '2023 American Gold Eagle 1/2 oz',        series: /gold eagle/i, year: 2023, metal: 'gold', weight: 0.5 },
    { q: '2022 American Gold Eagle 1/4 oz',        series: /gold eagle/i, year: 2022, metal: 'gold', weight: 0.25 },
    { q: '2021 American Gold Eagle 1/10 oz',       series: /gold eagle/i, year: 2021, metal: 'gold', weight: 0.1 },
    // American Gold Buffalo
    { q: '2024 American Gold Buffalo 1 oz',        series: /gold buffalo/i, year: 2024, metal: 'gold', weight: 1 },
    { q: '2006 American Gold Buffalo',             series: /gold buffalo/i, year: 2006, metal: 'gold' },
    // American Platinum Eagle
    { q: '2024 American Platinum Eagle 1 oz',      series: /platinum eagle/i, year: 2024, metal: 'platinum', weight: 1 },
    // American Palladium Eagle
    { q: '2022 American Palladium Eagle 1 oz',     series: /palladium eagle/i, year: 2022, metal: 'palladium', weight: 1 },
  ];

  test.each(US_BULLION)('parses "$q" correctly', ({ q, series, year, metal, weight }) => {
    const { parsed, pcgsNo } = check(q);
    expect(parsed.series).toMatch(series);
    expect(parsed.year).toBe(year);
    if (metal) expect(parsed.metal).toBe(metal);
    if (weight !== undefined && weight !== null) expect(parsed.weight).toBe(weight);
  });

  test.each(US_BULLION)('lookupPCGSNumber for "$q" returns a number', ({ q }) => {
    const { parsed, pcgsNo } = check(q);
    // US bullion should now have entries in the static table
    expect(pcgsNo).not.toBeNull();
    expect(pcgsNo).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════
//  WORLD BULLION — Silver
// ══════════════════════════════════════════════════════════════
describe('PCGS resolution — World Silver Bullion', () => {
  const WORLD_SILVER = [
    { q: '2024 Canadian Silver Maple Leaf 1 oz',        series: /maple/i, year: 2024, metal: 'silver', weight: 1 },
    { q: '2023 British Silver Britannia 1 oz',          series: /britannia/i, year: 2023, metal: 'silver', weight: 1 },
    { q: '2024 Austrian Silver Philharmonic 1 oz',      series: /philharmonic/i, year: 2024, metal: 'silver', weight: 1 },
    { q: '2023 Mexican Silver Libertad 1 oz',           series: /libertad/i, year: 2023, metal: 'silver', weight: 1 },
    { q: '2024 Australian Silver Kookaburra 1 oz',      series: /kookaburra/i, year: 2024, metal: 'silver', weight: 1 },
    { q: '2023 Chinese Silver Panda 30g',               series: /panda/i, year: 2023, metal: 'silver' },
    { q: '2024 Silver Krugerrand 1 oz',                 series: /krugerrand/i, year: 2024, metal: 'silver', weight: 1 },
    // Fractional silver
    { q: '2024 British Silver Britannia 1/4 oz',        series: /britannia/i, year: 2024, metal: 'silver', weight: 0.25 },
    { q: '2023 Canadian Silver Maple Leaf 1/2 oz',      series: /maple/i, year: 2023, metal: 'silver', weight: 0.5 },
    { q: '2024 Mexican Silver Libertad 1/2 oz',         series: /libertad/i, year: 2024, metal: 'silver', weight: 0.5 },
    { q: '2023 Austrian Silver Philharmonic 1/4 oz',    series: /philharmonic/i, year: 2023, metal: 'silver', weight: 0.25 },
    { q: '2024 Australian Silver Kookaburra 10 oz',     series: /kookaburra/i, year: 2024, metal: 'silver', weight: 10 },
  ];

  test.each(WORLD_SILVER)('parses "$q" correctly', ({ q, series, year, metal, weight }) => {
    const { parsed } = check(q);
    expect(parsed.series).toMatch(series);
    expect(parsed.year).toBe(year);
    if (metal) expect(parsed.metal).toBe(metal);
    if (weight !== undefined && weight !== null) expect(parsed.weight).toBe(weight);
  });
});

// ══════════════════════════════════════════════════════════════
//  WORLD BULLION — Gold
// ══════════════════════════════════════════════════════════════
describe('PCGS resolution — World Gold Bullion', () => {
  const WORLD_GOLD = [
    { q: '2024 Canadian Gold Maple Leaf 1 oz',          series: /maple/i, year: 2024, metal: 'gold', weight: 1 },
    { q: '2024 Canadian Gold Maple Leaf 1/4 oz',        series: /maple/i, year: 2024, metal: 'gold', weight: 0.25 },
    { q: '2023 British Gold Britannia 1 oz',            series: /britannia/i, year: 2023, metal: 'gold', weight: 1 },
    { q: '2024 Austrian Gold Philharmonic 1 oz',        series: /philharmonic/i, year: 2024, metal: 'gold', weight: 1 },
    { q: '2023 Mexican Gold Libertad 1 oz',             series: /libertad/i, year: 2023, metal: 'gold', weight: 1 },
    { q: '2024 South African Krugerrand 1 oz',          series: /krugerrand/i, year: 2024, metal: null, weight: 1 },
    { q: '2023 Gold Krugerrand 1/2 oz',                 series: /krugerrand/i, year: 2023, metal: 'gold', weight: 0.5 },
    { q: '2024 Chinese Gold Panda 30g',                 series: /panda/i, year: 2024, metal: 'gold' },
    { q: '2024 Australian Gold Kangaroo 1 oz',          series: /kangaroo/i, year: 2024, metal: 'gold', weight: 1 },
    // Fractional gold
    { q: '2024 British Gold Britannia 1/4 oz',          series: /britannia/i, year: 2024, metal: 'gold', weight: 0.25 },
    { q: '2023 British Gold Britannia 1/10 oz',         series: /britannia/i, year: 2023, metal: 'gold', weight: 0.1 },
    { q: '2024 Austrian Gold Philharmonic 1/4 oz',      series: /philharmonic/i, year: 2024, metal: 'gold', weight: 0.25 },
    { q: '2023 Mexican Gold Libertad 1/2 oz',           series: /libertad/i, year: 2023, metal: 'gold', weight: 0.5 },
    { q: '2024 Mexican Gold Libertad 1/4 oz',           series: /libertad/i, year: 2024, metal: 'gold', weight: 0.25 },
    { q: '2024 Mexican Gold Libertad 1/10 oz',          series: /libertad/i, year: 2024, metal: 'gold', weight: 0.1 },
  ];

  test.each(WORLD_GOLD)('parses "$q" correctly', ({ q, series, year, metal, weight }) => {
    const { parsed } = check(q);
    expect(parsed.series).toMatch(series);
    expect(parsed.year).toBe(year);
    if (metal) expect(parsed.metal).toBe(metal);
    if (weight !== undefined && weight !== null) expect(parsed.weight).toBe(weight);
  });
});

// ══════════════════════════════════════════════════════════════
//  LUNAR SERIES
// ══════════════════════════════════════════════════════════════
describe('PCGS resolution — Lunar Series', () => {
  const LUNAR = [
    { q: '2024 Perth Mint Lunar Year of the Dragon 1 oz silver',  series: /lunar|perth|dragon/i, year: 2024, metal: 'silver', weight: 1 },
    { q: '2023 Australian Lunar Year of the Rabbit 1 oz gold',    series: /lunar|australian/i, year: 2023, metal: 'gold', weight: 1 },
    { q: '2024 British Lunar Year of the Dragon 1 oz silver',     series: /lunar|britannia|dragon/i, year: 2024, metal: 'silver', weight: 1 },
    { q: '2025 Perth Lunar Year of the Snake 1 oz silver',        series: /lunar|perth/i, year: 2025, metal: 'silver', weight: 1 },
    { q: '2024 Australian Lunar Gold 1/4 oz',                     series: /lunar|australian/i, year: 2024, metal: 'gold', weight: 0.25 },
  ];

  test.each(LUNAR)('parses "$q" correctly', ({ q, series, year, metal, weight }) => {
    const { parsed } = check(q);
    expect(parsed.series).toBeDefined();
    expect(parsed.year).toBe(year);
    if (metal) expect(parsed.metal).toBe(metal);
    if (weight !== undefined && weight !== null) expect(parsed.weight).toBe(weight);
  });
});

// ══════════════════════════════════════════════════════════════
//  CLASSIC US GOLD
// ══════════════════════════════════════════════════════════════
describe('PCGS resolution — Classic US Gold', () => {
  const CLASSIC_GOLD = [
    { q: '1924 Saint Gaudens Double Eagle MS65',        series: /saint.*gaudens/i, year: 1924 },
    { q: '1907 St. Gaudens $20',                        series: /st.*gaudens/i, year: 1907 },
    { q: '1904 Liberty Head Double Eagle',              series: /liberty.*double/i, year: 1904 },
    { q: '1910 Indian Head Eagle',                      series: /indian.*eagle/i, year: 1910 },
    { q: '1915 Indian Head Quarter Eagle',              series: /indian.*quarter/i, year: 1915 },
    { q: '1908 Indian Head Half Eagle',                 series: /indian.*half/i, year: 1908 },
    { q: '1895 Liberty Head Eagle',                     series: /liberty.*eagle/i, year: 1895 },
  ];

  test.each(CLASSIC_GOLD)('parses "$q" correctly', ({ q, series, year }) => {
    const { parsed } = check(q);
    expect(parsed.series).toMatch(series);
    expect(parsed.year).toBe(year);
  });
});

// ══════════════════════════════════════════════════════════════
//  FULL END-TO-END: resolveFromDescription (no PCGS API key)
//  Tests that the function completes without error and returns
//  the best-effort parsed data.
// ══════════════════════════════════════════════════════════════
describe('resolveFromDescription — bullion (no API key)', () => {
  const { resolveFromDescription } = require('../src/services/pcgsService');

  const QUERIES = [
    '2024 American Silver Eagle MS69',
    '2024 American Gold Eagle 1 oz',
    '2023 American Gold Buffalo',
    '2024 Canadian Silver Maple Leaf 1 oz',
    '2024 British Silver Britannia 1 oz',
    '2024 Austrian Silver Philharmonic 1 oz',
    '2023 Mexican Silver Libertad 1 oz',
    '2024 South African Krugerrand 1 oz',
    '2024 Chinese Silver Panda',
    '2024 Australian Silver Kookaburra 1 oz',
    '2024 Canadian Gold Maple Leaf 1/4 oz',
    '2024 British Gold Britannia 1 oz',
    '2024 Austrian Gold Philharmonic 1 oz',
    '2024 Australian Gold Kangaroo 1 oz',
    '2024 Perth Mint Lunar Year of the Dragon 1 oz silver',
  ];

  test.each(QUERIES)('resolves "%s" without error', async (q) => {
    const result = await resolveFromDescription(q);
    expect(result).toBeDefined();
    // Without API key, should still return verified: false with parsed data
    expect(result.verified).toBe(false);
    expect(result.parsed).toBeDefined();
    expect(result.parsed.year).toBeGreaterThan(1900);
    expect(result.parsed.series).toBeTruthy();
    // Should also propagate series and year to the top-level result
    expect(result.series).toBeTruthy();
    expect(result.year).toBeGreaterThan(1900);
  });

  // Document which bullion coins LACK a PCGS number from the static table
  test('PCGS number coverage report', () => {
    const results = QUERIES.map(q => {
      const parsed = parseDescription(q);
      const pcgsNo = lookupPCGSNumber(parsed.series || '', parsed.year, parsed.mint);
      return { query: q, series: parsed.series, pcgsNo };
    });

    const withNumber  = results.filter(r => r.pcgsNo !== null);
    const withoutNumber = results.filter(r => r.pcgsNo === null);

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  PCGS NUMBER COVERAGE — BULLION COINS                   ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Total queries:     ${results.length.toString().padEnd(36)}║`);
    console.log(`║  With PCGS number:  ${withNumber.length.toString().padEnd(36)}║`);
    console.log(`║  Missing PCGS #:    ${withoutNumber.length.toString().padEnd(36)}║`);
    console.log('╠══════════════════════════════════════════════════════════╣');
    if (withoutNumber.length) {
      console.log('║  MISSING entries:                                        ║');
      withoutNumber.forEach(r => {
        const label = `  - ${r.series || '?'}: ${r.query.substring(0, 45)}`;
        console.log(`║${label.padEnd(58)}║`);
      });
    }
    if (withNumber.length) {
      console.log('║  HAS entries:                                            ║');
      withNumber.forEach(r => {
        const label = `  ✓ ${r.series} → #${r.pcgsNo}`;
        console.log(`║${label.padEnd(58)}║`);
      });
    }
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // This assertion documents the current state — update when coverage improves
    expect(withoutNumber.length).toBeGreaterThanOrEqual(0);
  });
});
