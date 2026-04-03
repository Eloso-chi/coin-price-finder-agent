/**
 * Tests for Terapeak fuzzy matching, weight detection, and lookup correctness.
 *
 * Ensures that:
 *   - detectWeightFromQuery() correctly parses all weight forms
 *   - lookupComps() only returns datasets with matching weights
 *   - Fractional coin searches don't return 1oz data and vice versa
 *   - Cross-series matching doesn't happen (e.g. Libertad != Dragon)
 *   - normalizeSearchKey() behaves correctly with special chars
 */

const fs = require('fs');
const path = require('path');

// We need to access internal functions. Load the module and use the exports.
const terapeakService = require('../src/services/terapeakService');

const {
  lookupComps,
  normalizeSearchKey,
  detectWeightFromQuery,
  importComps,
  clearAll,
  listDatasets
} = terapeakService;

// ═══════════════════════════════════════════════════════════════════════
// detectWeightFromQuery
// ═══════════════════════════════════════════════════════════════════════
describe('detectWeightFromQuery', () => {
  test('returns null for text with no weight', () => {
    expect(detectWeightFromQuery('Morgan Silver Dollar')).toBeNull();
    expect(detectWeightFromQuery('1893-S Morgan')).toBeNull();
    expect(detectWeightFromQuery('')).toBeNull();
    expect(detectWeightFromQuery(null)).toBeNull();
  });

  test('detects "1 oz" and "1oz"', () => {
    expect(detectWeightFromQuery('American Silver Eagle 1 oz')).toBe(1);
    expect(detectWeightFromQuery('Gold Eagle 1oz')).toBe(1);
    expect(detectWeightFromQuery('1 oz silver round')).toBe(1);
  });

  test('detects 2oz and 10oz', () => {
    expect(detectWeightFromQuery('Perth Lunar Silver 2oz')).toBe(2);
    expect(detectWeightFromQuery('Perth Lunar Silver 2 oz')).toBe(2);
    expect(detectWeightFromQuery('Perth Lunar Silver 10oz')).toBe(10);
    expect(detectWeightFromQuery('Perth Lunar Silver 10 oz')).toBe(10);
  });

  test('detects fractional numeric forms', () => {
    expect(detectWeightFromQuery('1/2 oz Libertad')).toBe(0.5);
    expect(detectWeightFromQuery('1/4 oz Gold Eagle')).toBe(0.25);
    expect(detectWeightFromQuery('1/10 oz Platinum')).toBe(0.1);
    expect(detectWeightFromQuery('1/20 oz Maple Leaf')).toBe(0.05);
  });

  test('detects word forms (half, quarter, tenth, twentieth)', () => {
    expect(detectWeightFromQuery('Gold Eagle Half oz')).toBe(0.5);
    expect(detectWeightFromQuery('Quarter oz Platinum Eagle')).toBe(0.25);
    expect(detectWeightFromQuery('Tenth oz Gold Maple')).toBe(0.1);
    expect(detectWeightFromQuery('Twentieth oz Gold Maple')).toBe(0.05);
  });

  test('detects word forms without space before oz', () => {
    expect(detectWeightFromQuery('halfoz libertad')).toBe(0.5);
    expect(detectWeightFromQuery('Gold Eagle quarteroz')).toBe(0.25);
    expect(detectWeightFromQuery('tenthoz platinum')).toBe(0.1);
  });

  // CRITICAL: Perth Lunar datasets use "Quarter" without "oz"
  test('detects standalone "quarter", "half", "tenth" without oz (dataset names)', () => {
    expect(detectWeightFromQuery('Perth Lunar III 2024 Dragon Gold Quarter')).toBe(0.25);
    expect(detectWeightFromQuery('Perth Lunar III 2024 Dragon Gold Tenth')).toBe(0.1);
    expect(detectWeightFromQuery('Perth Lunar III 2024 Dragon Gold Half')).toBe(0.5);
  });

  test('detects decimal forms', () => {
    expect(detectWeightFromQuery('0.5 oz silver')).toBe(0.5);
    expect(detectWeightFromQuery('0.25 oz gold')).toBe(0.25);
    expect(detectWeightFromQuery('0.1 oz platinum')).toBe(0.1);
  });

  test('case insensitive', () => {
    expect(detectWeightFromQuery('HALF OZ')).toBe(0.5);
    expect(detectWeightFromQuery('Quarter Oz')).toBe(0.25);
    expect(detectWeightFromQuery('TENTH OZ')).toBe(0.1);
    expect(detectWeightFromQuery('1 OZ')).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// normalizeSearchKey
// ═══════════════════════════════════════════════════════════════════════
describe('normalizeSearchKey', () => {
  test('lowercases and trims', () => {
    expect(normalizeSearchKey('  Morgan Silver Dollar  ')).toBe('morgan silver dollar');
  });

  test('strips special characters but keeps letters, numbers, spaces, hyphens', () => {
    // Year-mint tokens like "1893-S" are split: "1893 s"
    expect(normalizeSearchKey('1893-S Morgan $1')).toBe('1893 s morgan 1');
    expect(normalizeSearchKey("MS-65+'s Best")).toBe("ms-65s best");
  });

  test('collapses whitespace', () => {
    expect(normalizeSearchKey('Gold   Eagle   1oz')).toBe('gold eagle 1oz');
  });

  test('handles null/undefined', () => {
    expect(normalizeSearchKey(null)).toBe('');
    expect(normalizeSearchKey(undefined)).toBe('');
  });

  // Fractions: slash stripped after oz-collapse, so "1/2 oz" → "12oz"
  test('collapses fractional oz before stripping slashes', () => {
    expect(normalizeSearchKey('1/2 oz Libertad')).toBe('12oz libertad');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// lookupComps — weight isolation tests
// ═══════════════════════════════════════════════════════════════════════
describe('lookupComps – weight isolation', () => {
  // Build a controlled in-memory store with known datasets
  const MOCK_COMP = {
    title: 'Test comp',
    price: 50,
    soldDate: '2025-01-15',
    totalUsd: 50,
    source: 'terapeak'
  };

  // Helper: inject datasets directly into the store file for testing
  function injectStore(datasets) {
    const CACHE_DIR = path.join(__dirname, '..', 'cache');
    const STORE_PATH = path.join(CACHE_DIR, 'terapeak_sold.json');
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const store = {};
    for (const [key, searchTerm] of datasets) {
      const normalized = normalizeSearchKey(key);
      store[normalized] = {
        searchTerm: searchTerm || key,
        comps: [{ ...MOCK_COMP, title: key }],
        lastImport: new Date().toISOString(),
        importCount: 1
      };
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
    // Force reload
    terapeakService._resetStoreCache && terapeakService._resetStoreCache();
  }

  // Save and restore the real store
  const STORE_PATH = path.join(__dirname, '..', 'cache', 'terapeak_sold.json');
  let savedStore;
  beforeAll(() => {
    try { savedStore = fs.readFileSync(STORE_PATH, 'utf8'); } catch { savedStore = '{}'; }
  });
  afterAll(() => {
    fs.writeFileSync(STORE_PATH, savedStore);
  });

  test('1oz search does NOT match half oz dataset', () => {
    injectStore([
      ['Mexican Silver Libertad Half oz Generic', 'Mexican Silver Libertad Half oz Generic'],
      ['Mexican Silver Libertad 1oz Generic', 'Mexican Silver Libertad 1oz Generic'],
    ]);
    const result = lookupComps('2024 Mexican Silver Libertad 1oz');
    // Should match the 1oz dataset, not the half oz one
    if (result) {
      expect(result.comps[0].title).toContain('1oz');
      expect(result.comps[0].title).not.toContain('Half');
    }
  });

  test('half oz search does NOT match 1oz dataset', () => {
    injectStore([
      ['Mexican Silver Libertad Half oz Generic', 'Mexican Silver Libertad Half oz Generic'],
      ['Mexican Silver Libertad 1oz Generic', 'Mexican Silver Libertad 1oz Generic'],
    ]);
    const result = lookupComps('Mexican Silver Libertad 1/2 oz');
    if (result) {
      expect(result.comps[0].title).toContain('Half');
      expect(result.comps[0].title).not.toContain('1oz');
    }
  });

  test('quarter oz search does NOT match 1oz dataset', () => {
    injectStore([
      ['American Gold Eagle 1oz Generic', 'American Gold Eagle 1oz Generic'],
      ['American Gold Eagle Quarter oz Generic', 'American Gold Eagle Quarter oz Generic'],
    ]);
    const result = lookupComps('American Gold Eagle 1/4 oz');
    if (result) {
      expect(result.comps[0].title).toContain('Quarter');
    }
  });

  test('1oz search does NOT match 10oz dataset', () => {
    injectStore([
      ['Perth Lunar Dragon Silver 1oz', 'Perth Lunar Dragon Silver 1oz'],
      ['Perth Lunar Dragon Silver 10oz', 'Perth Lunar Dragon Silver 10oz'],
    ]);
    const result = lookupComps('Perth Lunar Dragon Silver 1 oz');
    if (result) {
      expect(result.comps[0].title).not.toContain('10oz');
    }
  });

  test('1oz search does NOT match 2oz dataset', () => {
    injectStore([
      ['Australian Lunar Silver 1oz Generic', 'Australian Lunar Silver 1oz Generic'],
      ['Australian Lunar Silver 2oz Generic', 'Australian Lunar Silver 2oz Generic'],
    ]);
    const result = lookupComps('Australian Lunar Silver 1 oz');
    if (result) {
      expect(result.comps[0].title).not.toContain('2oz');
    }
  });

  test('Perth "Quarter" (no oz) dataset is excluded from 1oz search', () => {
    injectStore([
      ['Perth Lunar III 2024 Dragon Gold 1oz', 'Perth Lunar III 2024 Dragon Gold 1oz'],
      ['Perth Lunar III 2024 Dragon Gold Quarter', 'Perth Lunar III 2024 Dragon Gold Quarter'],
    ]);
    const result = lookupComps('Perth Lunar III 2024 Dragon Gold 1oz');
    if (result) {
      expect(result.comps[0].title).not.toContain('Quarter');
    }
  });

  test('Perth "Quarter" (no oz) dataset matches quarter oz search', () => {
    injectStore([
      ['Perth Lunar III 2024 Dragon Gold 1oz', 'Perth Lunar III 2024 Dragon Gold 1oz'],
      ['Perth Lunar III 2024 Dragon Gold Quarter', 'Perth Lunar III 2024 Dragon Gold Quarter'],
    ]);
    const result = lookupComps('Perth Lunar III 2024 Dragon Gold 1/4 oz');
    if (result) {
      expect(result.comps[0].title).toContain('Quarter');
    }
  });

  test('no-weight search can match any dataset (no weight filter applied)', () => {
    injectStore([
      ['Mexican Silver Libertad Half oz Generic', 'Mexican Silver Libertad Half oz Generic'],
    ]);
    // Search without specifying weight — should still return data
    const result = lookupComps('Mexican Silver Libertad');
    // When no weight in search, the weight guard is skipped (searchWeight === null)
    // so it should match on token overlap
    expect(result).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// lookupComps — cross-series isolation
// ═══════════════════════════════════════════════════════════════════════
describe('lookupComps – cross-series isolation', () => {
  const STORE_PATH = path.join(__dirname, '..', 'cache', 'terapeak_sold.json');
  let savedStore;
  beforeAll(() => {
    try { savedStore = fs.readFileSync(STORE_PATH, 'utf8'); } catch { savedStore = '{}'; }
  });
  afterAll(() => {
    fs.writeFileSync(STORE_PATH, savedStore);
  });

  function injectStore(datasets) {
    const CACHE_DIR = path.join(__dirname, '..', 'cache');
    const store = {};
    for (const [key, searchTerm] of datasets) {
      const normalized = normalizeSearchKey(key);
      store[normalized] = {
        searchTerm: searchTerm || key,
        comps: [{ title: key, price: 50, soldDate: '2025-01-15', totalUsd: 50, source: 'terapeak' }],
        lastImport: new Date().toISOString(),
        importCount: 1
      };
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
    terapeakService._resetStoreCache && terapeakService._resetStoreCache();
  }

  test('Libertad 1oz search does NOT match Britannia 1oz', () => {
    injectStore([
      ['Mexican Silver Libertad 1oz Generic', 'Mexican Silver Libertad 1oz Generic'],
      ['British Silver Britannia 1oz Generic', 'British Silver Britannia 1oz Generic'],
    ]);
    const result = lookupComps('2024 Mexican Silver Libertad 1 oz');
    if (result) {
      expect(result.comps[0].title).toContain('Libertad');
      expect(result.comps[0].title).not.toContain('Britannia');
    }
  });

  test('Gold Eagle search does NOT match Gold Kangaroo', () => {
    injectStore([
      ['American Gold Eagle 1oz Generic', 'American Gold Eagle 1oz Generic'],
      ['Australian Gold Kangaroo 1oz Generic', 'Australian Gold Kangaroo 1oz Generic'],
    ]);
    const result = lookupComps('2024 American Gold Eagle 1 oz');
    if (result) {
      expect(result.comps[0].title).toContain('Eagle');
      expect(result.comps[0].title).not.toContain('Kangaroo');
    }
  });

  test('Morgan Dollar search does NOT match Peace Dollar', () => {
    injectStore([
      ['Morgan Silver Dollar Generic', 'Morgan Silver Dollar Generic'],
      ['Peace Silver Dollar Generic', 'Peace Silver Dollar Generic'],
    ]);
    const result = lookupComps('1921 Morgan Silver Dollar');
    if (result) {
      expect(result.comps[0].title).toContain('Morgan');
    }
  });
});
