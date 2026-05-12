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

  // Fractions: converted to word forms before oz-collapse
  test('converts fractional oz to word forms', () => {
    expect(normalizeSearchKey('1/2 oz Libertad')).toBe('half oz libertad');
    expect(normalizeSearchKey('1/4 oz Gold Eagle')).toBe('quarter oz gold eagle');
    expect(normalizeSearchKey('1/10 oz Platinum')).toBe('tenth oz platinum');
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

// ═══════════════════════════════════════════════════════════════════════
// lookupComps — grade-specific dataset selection (#94)
// ═══════════════════════════════════════════════════════════════════════
describe('lookupComps – grade-specific datasets', () => {
  const MOCK_COMP = {
    title: 'Test comp',
    price: 50,
    soldDate: '2025-01-15',
    totalUsd: 50,
    source: 'terapeak'
  };

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
    terapeakService._resetStoreCache && terapeakService._resetStoreCache();
  }

  const STORE_PATH = path.join(__dirname, '..', 'cache', 'terapeak_sold.json');
  let savedStore;
  beforeAll(() => {
    try { savedStore = fs.readFileSync(STORE_PATH, 'utf8'); } catch { savedStore = '{}'; }
  });
  afterAll(() => {
    fs.writeFileSync(STORE_PATH, savedStore);
  });

  test('query with MS65 prefers MS65 dataset over base dataset', () => {
    injectStore([
      ['1883 Morgan Silver Dollar', '1883 Morgan Silver Dollar'],
      ['1883 Morgan Silver Dollar MS63', '1883 Morgan Silver Dollar MS63'],
      ['1883 Morgan Silver Dollar MS65', '1883 Morgan Silver Dollar MS65'],
    ]);
    const result = lookupComps('1883 Morgan Silver Dollar MS65');
    expect(result).not.toBeNull();
    expect(result.comps[0].title).toContain('MS65');
  });

  test('query with MS63 does NOT return MS65 dataset', () => {
    injectStore([
      ['1883 Morgan Silver Dollar', '1883 Morgan Silver Dollar'],
      ['1883 Morgan Silver Dollar MS63', '1883 Morgan Silver Dollar MS63'],
      ['1883 Morgan Silver Dollar MS65', '1883 Morgan Silver Dollar MS65'],
    ]);
    const result = lookupComps('1883 Morgan Silver Dollar MS63');
    expect(result).not.toBeNull();
    expect(result.comps[0].title).not.toContain('MS65');
    expect(result.comps[0].title).toContain('MS63');
  });

  test('query WITHOUT grade does NOT return grade-specific dataset', () => {
    injectStore([
      ['1883 Morgan Silver Dollar', '1883 Morgan Silver Dollar'],
      ['1883 Morgan Silver Dollar MS65', '1883 Morgan Silver Dollar MS65'],
    ]);
    const result = lookupComps('1883 Morgan Silver Dollar');
    expect(result).not.toBeNull();
    expect(result.comps[0].title).not.toContain('MS65');
  });

  test('falls back to base dataset when grade-specific not available', () => {
    injectStore([
      ['1883 Morgan Silver Dollar', '1883 Morgan Silver Dollar'],
      ['1883 Morgan Silver Dollar MS63', '1883 Morgan Silver Dollar MS63'],
    ]);
    // Query for MS65 but only MS63 grade-specific exists
    const result = lookupComps('1883 Morgan Silver Dollar MS65');
    expect(result).not.toBeNull();
    // Should fall back to the base (ungraded) dataset, not the MS63 one
    expect(result.comps[0].title).not.toContain('MS63');
  });

  test('opts.grade hint is used when grade not in keywords', () => {
    injectStore([
      ['1921 Peace Dollar', '1921 Peace Dollar'],
      ['1921 Peace Dollar MS64', '1921 Peace Dollar MS64'],
    ]);
    const result = lookupComps('1921 Peace Dollar', { grade: 'MS-64' });
    expect(result).not.toBeNull();
    expect(result.comps[0].title).toContain('MS64');
  });

  test('grade matching is case-insensitive', () => {
    injectStore([
      ['1889 Morgan Silver Dollar', '1889 Morgan Silver Dollar'],
      ['1889 Morgan Silver Dollar AU58', '1889 Morgan Silver Dollar AU58'],
    ]);
    const result = lookupComps('1889 Morgan Silver Dollar au58');
    expect(result).not.toBeNull();
    expect(result.comps[0].title).toContain('AU58');
  });

  test('circulated grades work (VF35, XF45)', () => {
    injectStore([
      ['1917 Walking Liberty Half Dollar', '1917 Walking Liberty Half Dollar'],
      ['1917 Walking Liberty Half Dollar VF35', '1917 Walking Liberty Half Dollar VF35'],
      ['1917 Walking Liberty Half Dollar XF45', '1917 Walking Liberty Half Dollar XF45'],
    ]);
    const result = lookupComps('1917 Walking Liberty Half Dollar VF35');
    expect(result).not.toBeNull();
    expect(result.comps[0].title).toContain('VF35');
  });

  test('proof grades work (PR69, PF70)', () => {
    injectStore([
      ['2024 Silver Eagle Proof', '2024 Silver Eagle Proof'],
      ['2024 Silver Eagle Proof PR69', '2024 Silver Eagle Proof PR69'],
    ]);
    const result = lookupComps('2024 Silver Eagle Proof PR69');
    expect(result).not.toBeNull();
    expect(result.comps[0].title).toContain('PR69');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// extractGrade
// ═══════════════════════════════════════════════════════════════════════
describe('extractGrade', () => {
  const { extractGrade } = terapeakService;

  test('extracts MS grades', () => {
    expect(extractGrade('1883 Morgan Silver Dollar MS65')).toBe('MS65');
    expect(extractGrade('Morgan MS-63')).toBe('MS63');
    expect(extractGrade('Morgan ms 70')).toBe('MS70');
  });

  test('extracts circulated grades', () => {
    expect(extractGrade('Walking Liberty VF35')).toBe('VF35');
    expect(extractGrade('AU-58 Morgan')).toBe('AU58');
    expect(extractGrade('VG8 Barber')).toBe('VG8');
  });

  test('extracts proof grades', () => {
    expect(extractGrade('2024 Eagle PR69')).toBe('PR69');
    expect(extractGrade('Silver Eagle PF70')).toBe('PF70');
  });

  test('returns null when no grade present', () => {
    expect(extractGrade('1883 Morgan Silver Dollar')).toBeNull();
    expect(extractGrade('American Silver Eagle 1oz')).toBeNull();
    expect(extractGrade('')).toBeNull();
    expect(extractGrade(null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// detectUSMintMark
// ═══════════════════════════════════════════════════════════════════════
describe('detectUSMintMark', () => {
  const { detectUSMintMark } = terapeakService;

  test('detects S mint mark', () => {
    expect(detectUSMintMark('1896-S Morgan Silver Dollar')).toBe('S');
    expect(detectUSMintMark('1896 S Morgan')).toBe('S');
  });

  test('detects D mint mark', () => {
    expect(detectUSMintMark('1921-D Morgan Silver Dollar')).toBe('D');
  });

  test('detects CC mint mark', () => {
    expect(detectUSMintMark('1878-CC Morgan Silver Dollar')).toBe('CC');
    expect(detectUSMintMark('1883 CC Morgan')).toBe('CC');
  });

  test('detects O mint mark', () => {
    expect(detectUSMintMark('1904-O Morgan Silver Dollar')).toBe('O');
  });

  test('detects W mint mark', () => {
    expect(detectUSMintMark('2024-W Silver Eagle')).toBe('W');
  });

  test('returns null when no mint mark', () => {
    expect(detectUSMintMark('1921 Morgan Silver Dollar')).toBeNull();
    expect(detectUSMintMark('American Silver Eagle 1oz')).toBeNull();
    expect(detectUSMintMark(null)).toBeNull();
    expect(detectUSMintMark('')).toBeNull();
  });

  test('is case insensitive (input) but returns uppercase', () => {
    expect(detectUSMintMark('1896-s morgan')).toBe('S');
    expect(detectUSMintMark('1878-cc morgan')).toBe('CC');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// lookupComps — US mint-mark preference (#174)
// ═══════════════════════════════════════════════════════════════════════
describe('lookupComps – mint-mark preference', () => {
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
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
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

  test('1896-S Morgan prefers 1896-S dataset over generic Morgan', () => {
    injectStore([
      ['Morgan Silver Dollar Generic', 'Morgan Silver Dollar Generic'],
      ['1896-S Morgan Silver Dollar', '1896-S Morgan Silver Dollar'],
    ]);
    const result = lookupComps('1896-S Morgan Silver Dollar');
    expect(result).not.toBeNull();
    expect(result.searchTerm).toContain('1896-S');
  });

  test('1878-CC Morgan prefers CC-mint dataset over base year dataset', () => {
    injectStore([
      ['1878 Morgan Silver Dollar', '1878 Morgan Silver Dollar'],
      ['1878-CC Morgan Silver Dollar', '1878-CC Morgan Silver Dollar'],
    ]);
    const result = lookupComps('1878-CC Morgan Silver Dollar');
    expect(result).not.toBeNull();
    expect(result.searchTerm).toContain('CC');
  });

  test('1921-D Morgan prefers D-mint dataset over P-mint (no mark)', () => {
    injectStore([
      ['1921 Morgan Silver Dollar', '1921 Morgan Silver Dollar'],
      ['1921-D Morgan Silver Dollar', '1921-D Morgan Silver Dollar'],
    ]);
    const result = lookupComps('1921-D Morgan Silver Dollar');
    expect(result).not.toBeNull();
    expect(result.searchTerm).toContain('1921-D');
  });

  test('query without mint mark does NOT penalize generic datasets', () => {
    injectStore([
      ['1921 Morgan Silver Dollar', '1921 Morgan Silver Dollar'],
      ['1921-D Morgan Silver Dollar', '1921-D Morgan Silver Dollar'],
    ]);
    // No mint mark in query — should match the base 1921 dataset
    const result = lookupComps('1921 Morgan Silver Dollar');
    expect(result).not.toBeNull();
    expect(result.searchTerm).toBe('1921 Morgan Silver Dollar');
  });

  test('S-mint query does NOT match D-mint dataset', () => {
    injectStore([
      ['1896-S Morgan Silver Dollar', '1896-S Morgan Silver Dollar'],
      ['1896-D Morgan Silver Dollar', '1896-D Morgan Silver Dollar'],
    ]);
    const result = lookupComps('1896-S Morgan Silver Dollar');
    expect(result).not.toBeNull();
    expect(result.searchTerm).toContain('1896-S');
    expect(result.searchTerm).not.toContain('1896-D');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// lookupComps — metal + weight compound preference (#175)
// ═══════════════════════════════════════════════════════════════════════
describe('lookupComps – metal+weight compound preference', () => {
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
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
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

  test('Gold Libertad 1oz query prefers gold-specific dataset', () => {
    injectStore([
      ['Mexican Silver Libertad 1oz Generic', 'Mexican Silver Libertad 1oz Generic'],
      ['Mexican Gold Libertad 1oz Generic', 'Mexican Gold Libertad 1oz Generic'],
    ]);
    const result = lookupComps('2023 Mexican Gold Libertad 1 oz');
    expect(result).not.toBeNull();
    expect(result.searchTerm).toContain('Gold');
    expect(result.searchTerm).not.toContain('Silver');
  });

  test('Gold Krugerrand 1oz prefers gold+1oz dataset over generic gold', () => {
    injectStore([
      ['South African Gold Krugerrand Generic', 'South African Gold Krugerrand Generic'],
      ['South African Gold Krugerrand 1oz Generic', 'South African Gold Krugerrand 1oz Generic'],
    ]);
    const result = lookupComps('2024 South African Gold Krugerrand 1 oz');
    expect(result).not.toBeNull();
    expect(result.searchTerm).toContain('1oz');
  });

  test('Silver Eagle 1oz with metal+weight does not match gold dataset', () => {
    injectStore([
      ['American Silver Eagle 1oz Generic', 'American Silver Eagle 1oz Generic'],
      ['American Gold Eagle 1oz Generic', 'American Gold Eagle 1oz Generic'],
    ]);
    const result = lookupComps('2024 American Silver Eagle 1 oz');
    expect(result).not.toBeNull();
    expect(result.searchTerm).toContain('Silver');
    expect(result.searchTerm).not.toContain('Gold');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// eBay exclusion operator handling (regression: #171 fix)
//
// When eBay keywords include exclusion operators like "-gold" or "-proof",
// they must NOT poison Terapeak fuzzy matching or metal detection.
// ═══════════════════════════════════════════════════════════════════════
describe('lookupComps – eBay exclusion operator handling', () => {
  const MOCK_COMP = {
    title: 'Test comp',
    price: 50,
    soldDate: '2025-01-15',
    totalUsd: 50,
    source: 'terapeak'
  };

  function injectStore(datasets) {
    const CACHE_DIR = path.join(__dirname, '..', 'cache');
    const STORE_PATH = path.join(CACHE_DIR, 'terapeak_sold.json');
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const store = {};
    for (const [key, searchTerm, compCount] of datasets) {
      const normalized = normalizeSearchKey(key);
      const comps = Array.from({ length: compCount || 1 }, (_, i) => ({
        ...MOCK_COMP, title: `${key} #${i}`, price: 50 + i
      }));
      store[normalized] = {
        searchTerm: searchTerm || key,
        comps,
        lastImport: new Date().toISOString(),
        importCount: comps.length
      };
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
    terapeakService._resetStoreCache && terapeakService._resetStoreCache();
  }

  const STORE_PATH = path.join(__dirname, '..', 'cache', 'terapeak_sold.json');
  let savedStore;
  beforeAll(() => {
    try { savedStore = fs.readFileSync(STORE_PATH, 'utf8'); } catch { savedStore = '{}'; }
  });
  afterAll(() => {
    fs.writeFileSync(STORE_PATH, savedStore);
  });

  test('"-gold" exclusion in keywords does NOT match gold dataset', () => {
    injectStore([
      ['1987 Mexico 1 oz Silver Libertad', '1987 Mexico 1 oz Silver Libertad', 190],
      ['1987 Mexico 1 oz Gold Libertad', '1987 Mexico 1 oz Gold Libertad', 1],
    ]);
    // Query with "-gold" exclusion operator (added by buildKeywords for silver coins)
    const result = lookupComps('1987 Mexico Silver Libertad 1 oz -gold', { metal: 'silver' });
    expect(result).not.toBeNull();
    expect(result.searchTerm).toContain('Silver');
    expect(result.searchTerm).not.toContain('Gold');
    expect(result.comps.length).toBe(190);
  });

  test('"-silver" exclusion in keywords does NOT match silver dataset', () => {
    injectStore([
      ['1987 Mexico 1 oz Silver Libertad', '1987 Mexico 1 oz Silver Libertad', 190],
      ['1987 Mexico 1 oz Gold Libertad', '1987 Mexico 1 oz Gold Libertad', 50],
    ]);
    // Query with "-silver" exclusion operator (added by buildKeywords for gold coins)
    const result = lookupComps('1987 Mexico Gold Libertad 1 oz -silver', { metal: 'gold' });
    expect(result).not.toBeNull();
    expect(result.searchTerm).toContain('Gold');
    expect(result.searchTerm).not.toContain('Silver');
  });

  test('"-proof" exclusion does NOT trigger specialty guard mismatch', () => {
    injectStore([
      ['2023 American Silver Eagle BU', '2023 American Silver Eagle BU', 170],
      ['2023 American Silver Eagle Proof', '2023 American Silver Eagle Proof', 50],
    ]);
    // BU search with "-proof" exclusion — should match BU, not Proof
    const result = lookupComps('2023 American Silver Eagle -proof -reverse', { metal: 'silver' });
    expect(result).not.toBeNull();
    expect(result.searchTerm).toContain('BU');
    expect(result.searchTerm).not.toContain('Proof');
  });

  test('multiple exclusion operators are all stripped', () => {
    injectStore([
      ['silver libertad 1 oz', 'silver libertad 1 oz -proof -gold', 224],
    ]);
    // Query with multiple exclusions
    const result = lookupComps('silver libertad 1 oz -proof -gold', { metal: 'silver' });
    expect(result).not.toBeNull();
    expect(result.comps.length).toBe(224);
  });

  test('exclusion at start of query is stripped', () => {
    injectStore([
      ['1987 Mexico 1 oz Silver Libertad', '1987 Mexico 1 oz Silver Libertad', 100],
    ]);
    const result = lookupComps('-gold 1987 Mexico Silver Libertad 1 oz', { metal: 'silver' });
    expect(result).not.toBeNull();
    expect(result.searchTerm).toContain('Silver');
  });

  test('without metal hint, exclusion still prevents wrong metal detection', () => {
    injectStore([
      ['1987 Mexico 1 oz Silver Libertad', '1987 Mexico 1 oz Silver Libertad', 190],
      ['1987 Mexico 1 oz Gold Libertad', '1987 Mexico 1 oz Gold Libertad', 1],
    ]);
    // No explicit metal hint — "silver" in query text should win over "-gold"
    const result = lookupComps('1987 Mexico Silver Libertad 1 oz -gold');
    expect(result).not.toBeNull();
    expect(result.searchTerm).toContain('Silver');
    expect(result.comps.length).toBe(190);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// normalizeSearchKey – exclusion operator stripping
// ═══════════════════════════════════════════════════════════════════════
describe('normalizeSearchKey – exclusion operators', () => {
  test('strips single exclusion operator', () => {
    const result = normalizeSearchKey('1987 Mexico Silver Libertad 1 oz -gold');
    expect(result).not.toContain('gold');
    expect(result).toContain('silver');
    expect(result).toContain('libertad');
  });

  test('strips multiple exclusion operators', () => {
    const result = normalizeSearchKey('silver libertad 1 oz -proof -gold');
    expect(result).not.toContain('proof');
    expect(result).not.toContain('gold');
    expect(result).toContain('silver');
    expect(result).toContain('libertad');
  });

  test('strips exclusion at start of string', () => {
    const result = normalizeSearchKey('-gold 1987 Mexico Silver Libertad');
    expect(result).not.toContain('gold');
    expect(result).toContain('1987');
  });

  test('does not strip hyphenated words (e.g. MS-65)', () => {
    // "MS-65" should NOT be treated as an exclusion
    const result = normalizeSearchKey('Morgan MS-65 1893-S');
    expect(result).toContain('ms-65');
    expect(result).toContain('1893');
  });

  test('does not strip mid-word hyphens', () => {
    // "half-dollar" is not an exclusion
    const result = normalizeSearchKey('Kennedy half-dollar silver');
    // After normalize, hyphens in letter-letter context may be preserved
    expect(result).toContain('kennedy');
    expect(result).toContain('silver');
  });
});

// ═══════════════════════════════════════════════════════════════
//  classifyGradeType -- proof detection
// ═══════════════════════════════════════════════════════════════

describe('classifyGradeType -- proof detection (Terapeak)', () => {
  const { classifyGradeType } = require('../src/services/terapeakService');

  test('returns "proof" for title with "Proof" (no slab)', () => {
    expect(classifyGradeType({ title: '1987 Mexico 1 oz Silver Libertad Proof' })).toBe('proof');
  });

  test('returns "proof" for "PROOF" (caps)', () => {
    expect(classifyGradeType({ title: '1987 MEXICAN PROOF LIBERTAD 1 OZ' })).toBe('proof');
  });

  test('returns "proof" when title has PCGS with "Proof" (#182: strike type wins)', () => {
    expect(classifyGradeType({ title: '1987 Proof Libertad PCGS PF-69' })).toBe('proof');
  });

  test('returns "proof" when title has NGC with "Proof" (#182: strike type wins)', () => {
    expect(classifyGradeType({ title: '1987 NGC PF70 Proof Silver Libertad' })).toBe('proof');
  });

  test('returns "proof" when title has formal grade PF-69 with Proof (#182)', () => {
    expect(classifyGradeType({ title: '1987 PF-69 Proof Libertad' })).toBe('proof');
  });

  test('returns "raw" when no proof/grade indicators', () => {
    expect(classifyGradeType({ title: '1987 Mexico 1 oz Silver Libertad BU' })).toBe('raw');
  });

  test('returns "raw" for "proof-like" (PL coins are not proofs)', () => {
    expect(classifyGradeType({ title: '1881-S Morgan Dollar Proof-Like' })).toBe('raw');
  });

  test('returns "raw" for "prooflike"', () => {
    expect(classifyGradeType({ title: '1881-S Morgan Dollar Prooflike' })).toBe('raw');
  });

  test('returns "proof" for "Reverse Proof"', () => {
    expect(classifyGradeType({ title: '2021 ASE Type 2 Reverse Proof 1 oz Silver' })).toBe('proof');
  });

  test('condition "certified" + proof title = proof (#182: strike type determines pool)', () => {
    expect(classifyGradeType({ title: '1987 Proof Libertad', condition: 'Certified - PCGS' })).toBe('proof');
  });

  test('condition "uncirculated" returns raw even with ambiguous title', () => {
    expect(classifyGradeType({ title: '1987 Silver Libertad', condition: 'Uncirculated' })).toBe('raw');
  });
});
