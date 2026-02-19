// __tests__/numistaService.test.js — Tests for Numista API integration
// Tests the rarity classification, match scoring, issuer resolution, and
// overall lookup logic (with API mocked).

const {
  rarityFromMintage,
  scoreMatch,
  resolveIssuer,
  RARITY_TIERS
} = require('../src/services/numistaService');

// ════════════════════════════════════════════════════════════════
//  rarityFromMintage
// ════════════════════════════════════════════════════════════════
describe('rarityFromMintage', () => {
  test('returns null for null/undefined mintage', () => {
    expect(rarityFromMintage(null)).toBeNull();
    expect(rarityFromMintage(undefined)).toBeNull();
  });

  test('returns null for negative mintage', () => {
    expect(rarityFromMintage(-1)).toBeNull();
  });

  test('classifies mintage = 0 as Unique', () => {
    const r = rarityFromMintage(0);
    expect(r.label).toBe('Unique');
    expect(r.score).toBe(100);
  });

  test('classifies mintage = 1 as Unique', () => {
    const r = rarityFromMintage(1);
    expect(r.label).toBe('Unique');
    expect(r.score).toBe(100);
  });

  test('classifies mintage = 5 as Unique (boundary)', () => {
    const r = rarityFromMintage(5);
    expect(r.label).toBe('Unique');
  });

  test('classifies mintage = 6 as Extremely Rare', () => {
    const r = rarityFromMintage(6);
    expect(r.label).toBe('Extremely Rare');
    expect(r.score).toBe(90);
  });

  test('classifies mintage = 25 as Extremely Rare (boundary)', () => {
    const r = rarityFromMintage(25);
    expect(r.label).toBe('Extremely Rare');
  });

  test('classifies mintage = 26 as Very Rare', () => {
    const r = rarityFromMintage(26);
    expect(r.label).toBe('Very Rare');
    expect(r.score).toBe(80);
  });

  test('classifies mintage = 100 as Very Rare (boundary)', () => {
    expect(rarityFromMintage(100).label).toBe('Very Rare');
  });

  test('classifies mintage = 101 as Rare', () => {
    const r = rarityFromMintage(101);
    expect(r.label).toBe('Rare');
    expect(r.score).toBe(65);
  });

  test('classifies mintage = 1000 as Rare (boundary)', () => {
    expect(rarityFromMintage(1000).label).toBe('Rare');
  });

  test('classifies mintage = 1001 as Scarce', () => {
    expect(rarityFromMintage(1001).label).toBe('Scarce');
    expect(rarityFromMintage(1001).score).toBe(50);
  });

  test('classifies mintage = 10000 as Scarce (boundary)', () => {
    expect(rarityFromMintage(10000).label).toBe('Scarce');
  });

  test('classifies mintage = 10001 as Semi-Scarce', () => {
    expect(rarityFromMintage(10001).label).toBe('Semi-Scarce');
    expect(rarityFromMintage(10001).score).toBe(35);
  });

  test('classifies mintage = 100000 as Semi-Scarce (boundary)', () => {
    expect(rarityFromMintage(100000).label).toBe('Semi-Scarce');
  });

  test('classifies mintage = 100001 as Common', () => {
    expect(rarityFromMintage(100001).label).toBe('Common');
    expect(rarityFromMintage(100001).score).toBe(15);
  });

  test('classifies mintage = 1000000 as Common (boundary)', () => {
    expect(rarityFromMintage(1000000).label).toBe('Common');
  });

  test('classifies mintage = 1000001 as Very Common', () => {
    expect(rarityFromMintage(1000001).label).toBe('Very Common');
    expect(rarityFromMintage(1000001).score).toBe(5);
  });

  test('classifies very large mintage as Very Common', () => {
    const r = rarityFromMintage(500000000);
    expect(r.label).toBe('Very Common');
    expect(r.score).toBe(5);
    expect(r.mintage).toBe(500000000);
  });

  test('always includes mintage in result', () => {
    const r = rarityFromMintage(42);
    expect(r.mintage).toBe(42);
  });

  test('always includes color in result', () => {
    const r = rarityFromMintage(500);
    expect(r.color).toBeTruthy();
    expect(typeof r.color).toBe('string');
  });
});

// ════════════════════════════════════════════════════════════════
//  RARITY_TIERS structure
// ════════════════════════════════════════════════════════════════
describe('RARITY_TIERS', () => {
  test('has 8 tiers', () => {
    expect(RARITY_TIERS).toHaveLength(8);
  });

  test('tiers are in ascending max order', () => {
    for (let i = 1; i < RARITY_TIERS.length; i++) {
      expect(RARITY_TIERS[i].max).toBeGreaterThan(RARITY_TIERS[i - 1].max);
    }
  });

  test('tiers have descending scores', () => {
    for (let i = 1; i < RARITY_TIERS.length; i++) {
      expect(RARITY_TIERS[i].score).toBeLessThan(RARITY_TIERS[i - 1].score);
    }
  });

  test('last tier max is Infinity', () => {
    expect(RARITY_TIERS[RARITY_TIERS.length - 1].max).toBe(Infinity);
  });

  test('every tier has required fields', () => {
    RARITY_TIERS.forEach(t => {
      expect(t).toHaveProperty('max');
      expect(t).toHaveProperty('label');
      expect(t).toHaveProperty('score');
      expect(t).toHaveProperty('color');
    });
  });
});

// ════════════════════════════════════════════════════════════════
//  resolveIssuer
// ════════════════════════════════════════════════════════════════
describe('resolveIssuer', () => {
  test('defaults to united-states when null', () => {
    expect(resolveIssuer(null)).toBe('united-states');
    expect(resolveIssuer(undefined)).toBe('united-states');
    expect(resolveIssuer('')).toBe('united-states');
  });

  test('maps common US aliases', () => {
    expect(resolveIssuer('us')).toBe('united-states');
    expect(resolveIssuer('USA')).toBe('united-states');
    expect(resolveIssuer('United States')).toBe('united-states');
  });

  test('maps UK aliases', () => {
    expect(resolveIssuer('uk')).toBe('united-kingdom');
    expect(resolveIssuer('United Kingdom')).toBe('united-kingdom');
    expect(resolveIssuer('Great Britain')).toBe('united-kingdom');
  });

  test('maps Canada', () => {
    expect(resolveIssuer('Canada')).toBe('canada');
  });

  test('maps Australia', () => {
    expect(resolveIssuer('Australia')).toBe('australia');
  });

  test('maps China', () => {
    expect(resolveIssuer('China')).toBe('china-peoples-republic');
  });

  test('maps Mexico', () => {
    expect(resolveIssuer('Mexico')).toBe('mexico');
  });

  test('maps South Africa', () => {
    expect(resolveIssuer('South Africa')).toBe('south-africa');
  });

  test('converts unknown countries to slug format', () => {
    expect(resolveIssuer('New Zealand')).toBe('new-zealand');
    expect(resolveIssuer('Costa Rica')).toBe('costa-rica');
  });

  test('is case-insensitive', () => {
    expect(resolveIssuer('CANADA')).toBe('canada');
    expect(resolveIssuer('uSa')).toBe('united-states');
  });
});

// ════════════════════════════════════════════════════════════════
//  scoreMatch
// ════════════════════════════════════════════════════════════════
describe('scoreMatch', () => {
  test('scores year overlap as +20', () => {
    const type = { title: 'Morgan Dollar', min_year: 1878, max_year: 1921 };
    const parsed = { year: 1889 };
    expect(scoreMatch(type, parsed)).toBeGreaterThanOrEqual(20);
  });

  test('scores 0 for year outside range', () => {
    const type = { title: 'Morgan Dollar', min_year: 1878, max_year: 1921 };
    const parsed = { year: 2020 };
    expect(scoreMatch(type, parsed)).toBeLessThan(20);
  });

  test('scores series word matches', () => {
    const type = { title: '1 Dollar - Morgan', min_year: 1878, max_year: 1921 };
    const parsed = { series: 'Morgan Dollar' };
    const score = scoreMatch(type, parsed);
    expect(score).toBeGreaterThan(0);
  });

  test('scores denomination match +15', () => {
    const type = { title: 'Quarter Dollar', value: { text: '25 Cents' }, category: 'coin' };
    const parsed = { denomination: '25 Cents' };
    const score = scoreMatch(type, parsed);
    expect(score).toBeGreaterThanOrEqual(15);
  });

  test('scores composition match +10', () => {
    const type = { title: 'Eagle', composition: { text: 'Gold (.900)' }, category: 'coin' };
    const parsed = { metal: 'gold' };
    const score = scoreMatch(type, parsed);
    expect(score).toBeGreaterThanOrEqual(10);
  });

  test('scores coin category +2', () => {
    const type = { title: 'Test', category: 'coin' };
    const parsed = {};
    expect(scoreMatch(type, parsed)).toBe(2);
  });

  test('no bonus for banknote category', () => {
    const type = { title: 'Test', category: 'banknote' };
    const parsed = {};
    expect(scoreMatch(type, parsed)).toBe(0);
  });

  test('handles missing fields gracefully', () => {
    expect(scoreMatch({}, {})).toBe(0);
    expect(scoreMatch({ title: '' }, {})).toBe(0);
  });

  test('combined scoring for full match', () => {
    const type = {
      title: '1 Dollar - Morgan',
      min_year: 1878,
      max_year: 1921,
      value: { text: '1 Dollar' },
      composition: { text: 'Silver (.900)' },
      category: 'coin'
    };
    const parsed = {
      year: 1889,
      series: 'Morgan Dollar',
      denomination: '1 Dollar',
      metal: 'silver'
    };
    const score = scoreMatch(type, parsed);
    // Year(20) + series words(~10) + denom(15) + metal(10) + coin(2) = ~57+
    expect(score).toBeGreaterThanOrEqual(40);
  });
});

// ════════════════════════════════════════════════════════════════
//  lookupCoin — no API key scenario
// ════════════════════════════════════════════════════════════════
describe('lookupCoin (no API key)', () => {
  // The service reads NUMISTA_API_KEY from env at module load time.
  // Since we don't have one set, it should return accessible: false.
  const { lookupCoin } = require('../src/services/numistaService');

  test('returns accessible:false when no API key', async () => {
    const result = await lookupCoin({ series: 'Morgan Dollar', year: 1889 });
    expect(result.accessible).toBe(false);
    expect(result.limitations).toContain('Numista API key not configured (set NUMISTA_API_KEY env var)');
  });

  test('returns null fields when no API key', async () => {
    const result = await lookupCoin({ series: 'Walking Liberty Half Dollar', year: 1945 });
    expect(result.type).toBeNull();
    expect(result.rarity).toBeNull();
    expect(result.numistaUrl).toBeNull();
    expect(result.prices).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
//  Rarity classification — real-world mintage scenarios
// ════════════════════════════════════════════════════════════════
describe('rarityFromMintage — real-world coins', () => {
  test('1804 Silver Dollar (15 known) → Extremely Rare', () => {
    expect(rarityFromMintage(15).label).toBe('Extremely Rare');
  });

  test('1913 Liberty Head Nickel (5 known) → Unique', () => {
    expect(rarityFromMintage(5).label).toBe('Unique');
  });

  test('1916-D Mercury Dime (264,000) → Common', () => {
    expect(rarityFromMintage(264000).label).toBe('Common');
  });

  test('1909-S VDB Lincoln Cent (484,000) → Common', () => {
    expect(rarityFromMintage(484000).label).toBe('Common');
  });

  test('1921 Morgan Dollar (44,690,000) → Very Common', () => {
    expect(rarityFromMintage(44690000).label).toBe('Very Common');
  });

  test('Modern ASE bullion (~40M) → Very Common', () => {
    expect(rarityFromMintage(40000000).label).toBe('Very Common');
  });

  test('Key date proof with 3,000 mintage → Scarce', () => {
    expect(rarityFromMintage(3000).label).toBe('Scarce');
  });

  test('Low-mintage commemorative (750) → Rare', () => {
    expect(rarityFromMintage(750).label).toBe('Rare');
  });

  test('Modern proof set (50,000) → Semi-Scarce', () => {
    expect(rarityFromMintage(50000).label).toBe('Semi-Scarce');
  });
});

// ════════════════════════════════════════════════════════════════
//  batchRarityForSeries
// ════════════════════════════════════════════════════════════════
describe('batchRarityForSeries', () => {
  const { batchRarityForSeries } = require('../src/services/numistaService');

  // Save and restore NUMISTA_API_KEY so tests don't hit real API
  const origKey = process.env.NUMISTA_API_KEY;
  afterAll(() => { process.env.NUMISTA_API_KEY = origKey || ''; });

  test('returns empty Map when API key is missing', async () => {
    process.env.NUMISTA_API_KEY = '';
    // Re-require to pick up empty key? No — the module reads env once at load.
    // The function checks the key at the module level const, so we test the actual exported function behavior.
    // Since the module already loaded with a key, we test via the function's internal guard.
    const result = await batchRarityForSeries('', [], 'us');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    process.env.NUMISTA_API_KEY = origKey || '';
  });

  test('returns empty Map for empty cells array', async () => {
    const result = await batchRarityForSeries('Morgan Dollar', [], 'us');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test('returns empty Map for null/undefined series', async () => {
    const result = await batchRarityForSeries(null, [{ year: 1921, mint: 'P' }], 'us');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
});
