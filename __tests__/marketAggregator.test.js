// __tests__/marketAggregator.test.js — Unit tests for eBay market matrix aggregator
// Tests the pure functions (buildMarketMatrix, extractYear, extractMint, matchesGrade)
// and the async fetchMarketMatrix with a mocked ebayService.

'use strict';

const {
  buildMarketMatrix,
  buildGradeMatrix,
  buildBarMatrix,
  fetchMarketMatrix,
  extractYear,
  extractMint,
  extractGrade,
  extractBrand,
  matchesGrade,
  isBullionSeries,
  isBarSeries,
  clearCache,
} = require('../src/services/marketAggregator');

/* ═══════════════════════════════════════════════════════════
 *  extractYear
 * ═══════════════════════════════════════════════════════════ */
describe('extractYear', () => {
  test('extracts 4-digit year from typical eBay title', () => {
    expect(extractYear('1956-D Franklin Half Dollar 50c NGC MS64')).toBe(1956);
  });

  test('extracts year from title with dash-mint', () => {
    expect(extractYear('1881-CC Morgan Dollar')).toBe(1881);
  });

  test('extracts modern year', () => {
    expect(extractYear('2024-W American Silver Eagle')).toBe(2024);
  });

  test('extracts earliest possible year', () => {
    expect(extractYear('1793 Large Cent')).toBe(1793);
  });

  test('returns null for no year', () => {
    expect(extractYear('Morgan Dollar NGC MS65')).toBeNull();
  });

  test('returns null for empty/undefined', () => {
    expect(extractYear('')).toBeNull();
    expect(extractYear(null)).toBeNull();
    expect(extractYear(undefined)).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════
 *  extractMint
 * ═══════════════════════════════════════════════════════════ */
describe('extractMint', () => {
  test('extracts D from year-adjacent "1956-D"', () => {
    expect(extractMint('1956-D Franklin Half Dollar')).toBe('D');
  });

  test('extracts S from year-adjacent "1971-S"', () => {
    expect(extractMint('1971-S Eisenhower Dollar Proof')).toBe('S');
  });

  test('extracts CC from "1881-CC"', () => {
    expect(extractMint('1881-CC Morgan Dollar')).toBe('CC');
  });

  test('extracts CC from "1881 CC" (space separated)', () => {
    expect(extractMint('1881 CC Morgan Dollar')).toBe('CC');
  });

  test('extracts W from "2024-W"', () => {
    expect(extractMint('2024-W American Silver Eagle')).toBe('W');
  });

  test('defaults to P when no mint mark found', () => {
    expect(extractMint('1956 Franklin Half Dollar')).toBe('P');
  });

  test('defaults to P for empty/null input', () => {
    expect(extractMint('')).toBe('P');
    expect(extractMint(null)).toBe('P');
  });
});

/* ═══════════════════════════════════════════════════════════
 *  matchesGrade
 * ═══════════════════════════════════════════════════════════ */
describe('matchesGrade', () => {
  test('returns true for null/empty/"All" filter', () => {
    expect(matchesGrade('1956-D MS65', null)).toBe(true);
    expect(matchesGrade('1956-D MS65', '')).toBe(true);
    expect(matchesGrade('1956-D MS65', 'All')).toBe(true);
  });

  test('matches MS65 in title', () => {
    expect(matchesGrade('1956-D Franklin Half Dollar MS65', 'MS65')).toBe(true);
  });

  test('matches MS-65 with dash', () => {
    expect(matchesGrade('1956-D Franklin MS-65', 'MS65')).toBe(true);
  });

  test('rejects non-matching grade', () => {
    expect(matchesGrade('1956-D Franklin MS64', 'MS65')).toBe(false);
  });

  test('matches PR69 proof grade', () => {
    expect(matchesGrade('1971-S Proof PR69 DCAM', 'PR69')).toBe(true);
  });

  test('rejects wrong proof grade', () => {
    expect(matchesGrade('1971-S Proof PR68 DCAM', 'PR69')).toBe(false);
  });

  test('returns true for unparseable filter', () => {
    expect(matchesGrade('some title', 'GARBAGE')).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════
 *  buildMarketMatrix
 * ═══════════════════════════════════════════════════════════ */
describe('buildMarketMatrix', () => {
  const mockLookupKeyDate = (series, year, mint) => {
    if (series === 'Franklin Half Dollar' && year === 1955 && !mint) {
      return { isKeyDate: true, tier: 'semi-key', note: 'Low mintage' };
    }
    return { isKeyDate: false };
  };

  const sampleCompleted = [
    { title: '1955 Franklin Half Dollar MS64', totalUsd: 120, url: 'http://1' },
    { title: '1955 Franklin Half Dollar MS65', totalUsd: 200, url: 'http://2' },
    { title: '1955 Franklin Half Dollar MS63', totalUsd: 80, url: 'http://3' },
    { title: '1956-D Franklin Half Dollar MS65', totalUsd: 30, url: 'http://4' },
    { title: '1956-D Franklin Half Dollar MS64', totalUsd: 25, url: 'http://5' },
    { title: '1957 Franklin Half Dollar MS65', totalUsd: 28, url: 'http://6' },
    { title: '1957-D Franklin Half Dollar', totalUsd: 15, url: 'http://7' },
  ];

  const sampleActive = [
    { title: '1955 Franklin Half Dollar MS64 BIN', totalUsd: 150, url: 'http://bin1', listingType: 'FixedPrice' },
    { title: '1956-D Franklin Half Dollar', totalUsd: 35, url: 'http://bin2', listingType: 'FixedPrice' },
    { title: '1956-D Franklin Half Dollar', totalUsd: 28, url: 'http://bin3', listingType: 'FixedPrice' },
    { title: '1957 Franklin Half Dollar Auction', totalUsd: 20, url: 'http://auction1', listingType: 'Auction' },
  ];

  test('builds matrix with correct structure', () => {
    const result = buildMarketMatrix({
      completedComps: sampleCompleted,
      activeComps: sampleActive,
      series: 'Franklin Half Dollar',
      grade: null,
      lookbackDays: 90,
      lookupKeyDate: mockLookupKeyDate,
    });

    expect(result).toHaveProperty('grade', 'All');
    expect(result).toHaveProperty('years');
    expect(result).toHaveProperty('mintMarks');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('cells');
    expect(Array.isArray(result.years)).toBe(true);
    expect(Array.isArray(result.mintMarks)).toBe(true);
    expect(Array.isArray(result.cells)).toBe(true);
  });

  test('years are sorted ascending', () => {
    const result = buildMarketMatrix({
      completedComps: sampleCompleted,
      activeComps: [],
      series: 'Franklin Half Dollar',
      lookupKeyDate: mockLookupKeyDate,
    });
    expect(result.years).toEqual([1955, 1956, 1957]);
  });

  test('mint marks are sorted by standard order (P, D, S, ...)', () => {
    const result = buildMarketMatrix({
      completedComps: sampleCompleted,
      activeComps: [],
      series: 'Franklin Half Dollar',
      lookupKeyDate: mockLookupKeyDate,
    });
    expect(result.mintMarks).toEqual(['P', 'D']);
  });

  test('computes correct median for odd-count prices', () => {
    // 1955-P has 3 completed: 80, 120, 200 → median 120
    const result = buildMarketMatrix({
      completedComps: sampleCompleted,
      activeComps: [],
      series: 'Franklin Half Dollar',
      lookupKeyDate: mockLookupKeyDate,
    });
    const cell1955P = result.cells.find(c => c.year === 1955 && c.mint === 'P');
    expect(cell1955P.medianCompleted.value).toBe(120);
    expect(cell1955P.medianCompleted.sampleSize).toBe(3);
  });

  test('computes correct median for even-count prices', () => {
    // 1956-D has 2 completed: 25, 30 → median 27.50
    const result = buildMarketMatrix({
      completedComps: sampleCompleted,
      activeComps: [],
      series: 'Franklin Half Dollar',
      lookupKeyDate: mockLookupKeyDate,
    });
    const cell1956D = result.cells.find(c => c.year === 1956 && c.mint === 'D');
    expect(cell1956D.medianCompleted.value).toBe(27.50);
    expect(cell1956D.medianCompleted.sampleSize).toBe(2);
  });

  test('finds cheapest BIN correctly', () => {
    // 1956-D has 2 active BIN: 35 and 28 → cheapest 28
    const result = buildMarketMatrix({
      completedComps: [],
      activeComps: sampleActive,
      series: 'Franklin Half Dollar',
      lookupKeyDate: mockLookupKeyDate,
    });
    const cell1956D = result.cells.find(c => c.year === 1956 && c.mint === 'D');
    expect(cell1956D.cheapestBin.value).toBe(28);
    expect(cell1956D.cheapestBin.url).toBe('http://bin3');
  });

  test('nextCheapestBin is the second cheapest BIN listing', () => {
    // 1956-D has 2 active BIN: 35 and 28 → next cheapest is 35
    const result = buildMarketMatrix({
      completedComps: [],
      activeComps: sampleActive,
      series: 'Franklin Half Dollar',
      lookupKeyDate: mockLookupKeyDate,
    });
    const cell1956D = result.cells.find(c => c.year === 1956 && c.mint === 'D');
    expect(cell1956D.nextCheapestBin).not.toBeNull();
    expect(cell1956D.nextCheapestBin.value).toBe(35);
  });

  test('nextCheapestBin is null when only one BIN listing', () => {
    const result = buildMarketMatrix({
      completedComps: [],
      activeComps: [
        { title: '1956 Franklin Half Dollar', totalUsd: 30, url: 'http://solo', listingType: 'FixedPrice' },
      ],
      series: 'Franklin Half Dollar',
      lookupKeyDate: mockLookupKeyDate,
    });
    const cell = result.cells[0];
    expect(cell.cheapestBin.value).toBe(30);
    expect(cell.nextCheapestBin).toBeNull();
  });

  test('filters out auction listings from active BIN', () => {
    // 1957-P has only an "Auction" type → should not appear as BIN
    const result = buildMarketMatrix({
      completedComps: [],
      activeComps: sampleActive,
      series: 'Franklin Half Dollar',
      lookupKeyDate: mockLookupKeyDate,
    });
    const cell1957P = result.cells.find(c => c.year === 1957 && c.mint === 'P');
    // The auction listing should be filtered out
    expect(cell1957P).toBeUndefined();
  });

  test('marks key dates correctly', () => {
    const result = buildMarketMatrix({
      completedComps: sampleCompleted,
      activeComps: [],
      series: 'Franklin Half Dollar',
      lookupKeyDate: mockLookupKeyDate,
    });
    const cell1955P = result.cells.find(c => c.year === 1955 && c.mint === 'P');
    expect(cell1955P.keyDate).toBe(true);
    expect(cell1955P.keyDateTier).toBe('semi-key');

    const cell1956D = result.cells.find(c => c.year === 1956 && c.mint === 'D');
    expect(cell1956D.keyDate).toBe(false);
  });

  test('summary has correct counts', () => {
    const result = buildMarketMatrix({
      completedComps: sampleCompleted,
      activeComps: sampleActive,
      series: 'Franklin Half Dollar',
      lookupKeyDate: mockLookupKeyDate,
    });
    expect(result.summary.yearMin).toBe(1955);
    expect(result.summary.yearMax).toBe(1957);
    expect(result.summary.mintCount).toBe(2);
    expect(result.summary.cellsWithPriceData).toBeGreaterThan(0);
  });

  test('grade filter narrows results', () => {
    const result = buildMarketMatrix({
      completedComps: sampleCompleted,
      activeComps: [],
      series: 'Franklin Half Dollar',
      grade: 'MS65',
      lookupKeyDate: mockLookupKeyDate,
    });
    // Only comps with MS65 in title should be counted
    // 1955-P MS65 → 1 comp (price 200), 1956-D MS65 → 1 comp (price 30), 1957-P MS65 → 1 comp (28)
    const cell1955P = result.cells.find(c => c.year === 1955 && c.mint === 'P');
    expect(cell1955P.medianCompleted.value).toBe(200);
    expect(cell1955P.medianCompleted.sampleSize).toBe(1);
  });

  test('only years with listings appear', () => {
    const result = buildMarketMatrix({
      completedComps: [
        { title: '1956-D Franklin Half Dollar', totalUsd: 30, url: 'http://1' },
      ],
      activeComps: [],
      series: 'Franklin Half Dollar',
      lookupKeyDate: () => ({ isKeyDate: false }),
    });
    expect(result.years).toEqual([1956]);
    expect(result.cells).toHaveLength(1);
  });

  test('handles empty inputs gracefully', () => {
    const result = buildMarketMatrix({
      completedComps: [],
      activeComps: [],
      series: 'Test',
      lookupKeyDate: () => ({ isKeyDate: false }),
    });
    expect(result.years).toEqual([]);
    expect(result.mintMarks).toEqual([]);
    expect(result.cells).toEqual([]);
    expect(result.summary.totalCells).toBe(0);
    expect(result.summary.cellsWithPriceData).toBe(0);
  });

  test('cells without prices show null medianCompleted/cheapestBin', () => {
    const result = buildMarketMatrix({
      completedComps: [
        // Title has no price (totalUsd = 0 or null)
        { title: '1956-D Franklin Half Dollar', totalUsd: 0, url: 'http://1' },
      ],
      activeComps: [],
      series: 'Franklin Half Dollar',
      lookupKeyDate: () => ({ isKeyDate: false }),
    });
    // The year-mint key is created from the title, but zero prices are excluded
    // so the cell exists but has null medianCompleted and null cheapestBin
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].medianCompleted).toBeNull();
    expect(result.cells[0].cheapestBin).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════
 *  fetchMarketMatrix (with mocked ebayService)
 * ═══════════════════════════════════════════════════════════ */
describe('fetchMarketMatrix', () => {
  beforeEach(() => {
    clearCache();
    mockEbayService.fetchSoldComps.mockReset();
    mockEbayService.browseSearch.mockReset();
  });

  const mockEbayService = {
    fetchSoldComps: jest.fn(),
    browseSearch: jest.fn().mockResolvedValue([]),
    scoreMatch: (comp) => ({ ...comp, matchScore: 50, matchNotes: [] }),
    applyFilters: (comps) => ({ kept: comps, removed: {} }),
  };

  const mockLookupKeyDate = () => ({ isKeyDate: false });

  test('calls ebayService.fetchSoldComps for completed and browseSearch for active', async () => {
    mockEbayService.fetchSoldComps
      .mockResolvedValueOnce({
        us: { comps: [{ title: '1956-D Franklin', totalUsd: 30, url: 'http://1' }] },
        global: { comps: [] },
      });

    mockEbayService.browseSearch
      .mockResolvedValueOnce([
        { title: '1956-D Franklin BIN', totalUsd: 35, url: 'http://bin1', _source: 'browse', listingType: 'FixedPrice' },
      ]);

    const result = await fetchMarketMatrix({
      series: 'Franklin Half Dollar',
      grade: 'All',
      timeWindowDays: 90,
      lookupKeyDate: mockLookupKeyDate,
      ebayService: mockEbayService,
    });

    expect(mockEbayService.fetchSoldComps).toHaveBeenCalledTimes(1);
    expect(mockEbayService.browseSearch).toHaveBeenCalledTimes(1);
    expect(result.series).toBe('Franklin Half Dollar');
    expect(result.cells.length).toBeGreaterThan(0);

    const cell = result.cells.find(c => c.year === 1956 && c.mint === 'D');
    expect(cell.medianCompleted.value).toBe(30);
    expect(cell.cheapestBin.value).toBe(35);
  });

  test('caches results (second call does not invoke ebayService)', async () => {
    mockEbayService.fetchSoldComps
      .mockResolvedValueOnce({ us: { comps: [] }, global: { comps: [] } });
    mockEbayService.browseSearch
      .mockResolvedValueOnce([]);

    await fetchMarketMatrix({
      series: 'Test Series',
      grade: 'All',
      timeWindowDays: 90,
      lookupKeyDate: mockLookupKeyDate,
      ebayService: mockEbayService,
    });

    const callsBefore = mockEbayService.fetchSoldComps.mock.calls.length;

    await fetchMarketMatrix({
      series: 'Test Series',
      grade: 'All',
      timeWindowDays: 90,
      lookupKeyDate: mockLookupKeyDate,
      ebayService: mockEbayService,
    });

    // Should not have made additional calls
    expect(mockEbayService.fetchSoldComps.mock.calls.length).toBe(callsBefore);
  });

  test('clearCache allows fresh fetch', async () => {
    mockEbayService.fetchSoldComps
      .mockResolvedValue({ us: { comps: [] }, global: { comps: [] } });
    mockEbayService.browseSearch
      .mockResolvedValue([]);

    await fetchMarketMatrix({
      series: 'Cache Test',
      grade: 'All',
      timeWindowDays: 90,
      lookupKeyDate: mockLookupKeyDate,
      ebayService: mockEbayService,
    });

    clearCache();

    await fetchMarketMatrix({
      series: 'Cache Test',
      grade: 'All',
      timeWindowDays: 90,
      lookupKeyDate: mockLookupKeyDate,
      ebayService: mockEbayService,
    });

    // Should have called 2 times total (1 per invocation: completed only)
    expect(mockEbayService.fetchSoldComps).toHaveBeenCalledTimes(2);
    expect(mockEbayService.browseSearch).toHaveBeenCalledTimes(2);
  });

  test('throws when series is missing', async () => {
    await expect(
      fetchMarketMatrix({
        series: '',
        lookupKeyDate: mockLookupKeyDate,
        ebayService: mockEbayService,
      })
    ).rejects.toThrow('series is required');
  });

  test('handles Browse API failure gracefully (still returns completed data)', async () => {
    mockEbayService.fetchSoldComps
      .mockResolvedValueOnce({
        us: { comps: [{ title: '1956 Franklin', totalUsd: 30, url: 'http://1' }] },
        global: { comps: [] },
      });

    mockEbayService.browseSearch
      .mockRejectedValueOnce(new Error('Browse API down'));

    const result = await fetchMarketMatrix({
      series: 'Franklin Half Dollar',
      grade: 'All',
      timeWindowDays: 90,
      lookupKeyDate: mockLookupKeyDate,
      ebayService: mockEbayService,
    });

    // Should still have completed data
    expect(result.cells.length).toBe(1);
    const cell = result.cells[0];
    expect(cell.medianCompleted.value).toBe(30);
    expect(cell.cheapestBin).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════
 *  isBullionSeries
 * ═══════════════════════════════════════════════════════════ */
describe('isBullionSeries', () => {
  test.each([
    'American Silver Eagle',
    'American Gold Eagle',
    'American Platinum Eagle',
    'Mexican Silver Libertad',
    'Canadian Maple Leaf',
    'Austrian Philharmonic',
    'British Britannia',
    'South African Krugerrand',
    'Chinese Panda',
    'Australian Kookaburra',
    'Australian Kangaroo',
    'Perth Mint',
    'Gold Buffalo',
    'Buffalo Gold',
    'Perth Mint Australian Lunar Silver',
    'Royal Mint Year of the Dragon',
    'Year of the Rabbit',
    'Australian Lunar Gold',
  ])('detects "%s" as bullion', (series) => {
    expect(isBullionSeries(series)).toBe(true);
  });

  test.each([
    'Franklin Half Dollar',
    'Morgan Dollar',
    'Walking Liberty Half',
    'Mercury Dime',
    'Buffalo Nickel',
    'Lincoln Cent',
    '',
    null,
  ])('"%s" is NOT bullion', (series) => {
    expect(isBullionSeries(series)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════
 *  extractGrade
 * ═══════════════════════════════════════════════════════════ */
describe('extractGrade', () => {
  test('extracts MS69 from title', () => {
    expect(extractGrade('2021 American Silver Eagle MS69 NGC')).toBe('MS69');
  });

  test('extracts MS70 from title', () => {
    expect(extractGrade('2024-W Silver Eagle MS70 First Day')).toBe('MS70');
  });

  test('extracts PR70 and normalizes PF → PR', () => {
    expect(extractGrade('2023-S Silver Eagle PF70 Ultra Cameo')).toBe('PR70');
  });

  test('extracts PR69 from title', () => {
    expect(extractGrade('2020 Eagle PR69 Deep Cameo')).toBe('PR69');
  });

  test('extracts AU58', () => {
    expect(extractGrade('1986 Silver Eagle AU58 NGC')).toBe('AU58');
  });

  test('returns RAW when no grade in title', () => {
    expect(extractGrade('2020 American Silver Eagle 1oz .999 BU')).toBe('RAW');
  });

  test('returns RAW for null/undefined/empty', () => {
    expect(extractGrade(null)).toBe('RAW');
    expect(extractGrade(undefined)).toBe('RAW');
    expect(extractGrade('')).toBe('RAW');
  });

  test('handles MS 69 with space', () => {
    expect(extractGrade('2021 Eagle MS 69 PCGS')).toBe('MS69');
  });

  test('handles MS-70 with dash', () => {
    expect(extractGrade('2021 Eagle MS-70 NGC')).toBe('MS70');
  });
});

/* ═══════════════════════════════════════════════════════════
 *  buildGradeMatrix
 * ═══════════════════════════════════════════════════════════ */
describe('buildGradeMatrix', () => {
  const mockLookupKeyDate = () => ({ isKeyDate: false });

  test('builds year×grade matrix from completed comps', () => {
    const comps = [
      { title: '2021 American Silver Eagle MS69 NGC', totalUsd: 35 },
      { title: '2021 American Silver Eagle MS70 NGC', totalUsd: 55 },
      { title: '2021 American Silver Eagle BU', totalUsd: 30 },
      { title: '2022 American Silver Eagle MS69 NGC', totalUsd: 36 },
    ];
    const result = buildGradeMatrix({
      completedComps: comps,
      activeComps: [],
      series: 'American Silver Eagle',
      lookbackDays: 90,
      lookupKeyDate: mockLookupKeyDate,
    });

    expect(result.mode).toBe('grade');
    expect(result.years).toEqual([2021, 2022]);
    expect(result.grades[0]).toBe('RAW'); // RAW always first
    expect(result.grades).toContain('MS69');
    expect(result.grades).toContain('MS70');
    expect(result.cells.length).toBe(4); // 2021-RAW, 2021-MS69, 2021-MS70, 2022-MS69
  });

  test('RAW is always first grade column', () => {
    const comps = [
      { title: '2020 Silver Eagle MS70 NGC', totalUsd: 60 },
      { title: '2020 Silver Eagle BU', totalUsd: 28 },
    ];
    const result = buildGradeMatrix({
      completedComps: comps,
      activeComps: [],
      series: 'Silver Eagle',
      lookbackDays: 90,
      lookupKeyDate: mockLookupKeyDate,
    });

    expect(result.grades[0]).toBe('RAW');
  });

  test('sorts grades: RAW, MS70, MS69, PR70, PR69', () => {
    const comps = [
      { title: '2021 Eagle PR69 DCAM', totalUsd: 45 },
      { title: '2021 Eagle MS69', totalUsd: 35 },
      { title: '2021 Eagle MS70', totalUsd: 55 },
      { title: '2021 Eagle PR70', totalUsd: 75 },
      { title: '2021 Eagle BU', totalUsd: 30 },
    ];
    const result = buildGradeMatrix({
      completedComps: comps,
      activeComps: [],
      series: 'Silver Eagle',
      lookbackDays: 90,
      lookupKeyDate: mockLookupKeyDate,
    });

    expect(result.grades[0]).toBe('RAW');
    expect(result.grades.indexOf('MS70')).toBeLessThan(result.grades.indexOf('MS69'));
    expect(result.grades.indexOf('MS69')).toBeLessThan(result.grades.indexOf('PR70'));
    expect(result.grades.indexOf('PR70')).toBeLessThan(result.grades.indexOf('PR69'));
  });

  test('only includes grades that have data', () => {
    const comps = [
      { title: '2021 Eagle MS69', totalUsd: 35 },
      { title: '2022 Eagle MS69', totalUsd: 36 },
    ];
    const result = buildGradeMatrix({
      completedComps: comps,
      activeComps: [],
      series: 'Silver Eagle',
      lookbackDays: 90,
      lookupKeyDate: mockLookupKeyDate,
    });

    expect(result.grades).toEqual(['MS69']);
    expect(result.grades).not.toContain('RAW');
    expect(result.grades).not.toContain('MS70');
  });

  test('includes active BIN data in cells', () => {
    const result = buildGradeMatrix({
      completedComps: [],
      activeComps: [
        { title: '2023 Eagle MS70', totalUsd: 50, url: 'http://ebay/1', listingType: 'FixedPrice' },
      ],
      series: 'Silver Eagle',
      lookbackDays: 90,
      lookupKeyDate: mockLookupKeyDate,
    });

    expect(result.cells.length).toBe(1);
    expect(result.cells[0].cheapestBin.value).toBe(50);
  });

  test('nextCheapestBin in grade matrix with multiple BINs', () => {
    const result = buildGradeMatrix({
      completedComps: [],
      activeComps: [
        { title: '2023 Eagle MS70', totalUsd: 50, url: 'http://ebay/1', listingType: 'FixedPrice' },
        { title: '2023 Eagle MS70', totalUsd: 65, url: 'http://ebay/2', listingType: 'FixedPrice' },
      ],
      series: 'Silver Eagle',
      lookbackDays: 90,
      lookupKeyDate: mockLookupKeyDate,
    });

    expect(result.cells[0].cheapestBin.value).toBe(50);
    expect(result.cells[0].nextCheapestBin).not.toBeNull();
    expect(result.cells[0].nextCheapestBin.value).toBe(65);
  });

  test('returns empty matrix for no comps', () => {
    const result = buildGradeMatrix({
      completedComps: [],
      activeComps: [],
      series: 'Silver Eagle',
      lookbackDays: 90,
      lookupKeyDate: mockLookupKeyDate,
    });

    expect(result.mode).toBe('grade');
    expect(result.years).toEqual([]);
    expect(result.grades).toEqual([]);
    expect(result.cells).toEqual([]);
  });

  test('summary includes gradeCount', () => {
    const comps = [
      { title: '2021 Eagle MS69', totalUsd: 35 },
      { title: '2021 Eagle MS70', totalUsd: 55 },
      { title: '2021 Eagle BU', totalUsd: 30 },
    ];
    const result = buildGradeMatrix({
      completedComps: comps,
      activeComps: [],
      series: 'Silver Eagle',
      lookbackDays: 90,
      lookupKeyDate: mockLookupKeyDate,
    });

    expect(result.summary.gradeCount).toBe(3);
    expect(result.summary.yearMin).toBe(2021);
    expect(result.summary.yearMax).toBe(2021);
  });
});

/* ═══════════════════════════════════════════════════════════
 *  fetchMarketMatrix — bullion mode selection
 * ═══════════════════════════════════════════════════════════ */
describe('fetchMarketMatrix — bullion auto-detection', () => {
  const mockLookupKeyDate = () => ({ isKeyDate: false });

  const mockEbayService = {
    fetchSoldComps: jest.fn(),
    browseSearch: jest.fn().mockResolvedValue([]),
    scoreMatch: (comp) => ({ ...comp, matchScore: 50, matchNotes: [] }),
    applyFilters: (comps) => ({ kept: comps, removed: {} }),
  };

  beforeEach(() => {
    clearCache();
    mockEbayService.fetchSoldComps.mockReset();
    mockEbayService.browseSearch.mockReset();
    mockEbayService.browseSearch.mockResolvedValue([]);
  });

  test('returns mode "grade" for bullion series', async () => {
    mockEbayService.fetchSoldComps
      .mockResolvedValueOnce({
        us: { comps: [{ title: '2021 American Silver Eagle MS69', totalUsd: 35 }] },
        global: { comps: [] },
      });

    const result = await fetchMarketMatrix({
      series: 'American Silver Eagle',
      grade: 'All',
      timeWindowDays: 90,
      lookupKeyDate: mockLookupKeyDate,
      ebayService: mockEbayService,
    });

    expect(result.mode).toBe('grade');
    expect(result.grades).toBeDefined();
  });

  test('returns mode "year-mint" for non-bullion series', async () => {
    mockEbayService.fetchSoldComps
      .mockResolvedValueOnce({
        us: { comps: [{ title: '1956-D Franklin Half Dollar', totalUsd: 30 }] },
        global: { comps: [] },
      });

    const result = await fetchMarketMatrix({
      series: 'Franklin Half Dollar',
      grade: 'All',
      timeWindowDays: 90,
      lookupKeyDate: mockLookupKeyDate,
      ebayService: mockEbayService,
    });

    expect(result.mode).toBe('year-mint');
    expect(result.mintMarks).toBeDefined();
  });

  test('filters pre-first-year comps for bullion (e.g. pre-1982 Libertad)', async () => {
    mockEbayService.fetchSoldComps
      .mockResolvedValueOnce({
        us: { comps: [
          { title: '1975 Mexico Gold Libertad Peso', totalUsd: 800 },  // pre-1982 — should be filtered
          { title: '1990 Mexico Silver Libertad 1oz BU', totalUsd: 35 },  // post-1982 — keep
        ] },
        global: { comps: [] },
      });

    const result = await fetchMarketMatrix({
      series: 'Mexico Silver Libertad',
      grade: 'All',
      timeWindowDays: 90,
      lookupKeyDate: mockLookupKeyDate,
      ebayService: mockEbayService,
    });

    // The 1975 comp should be filtered — only 1990 should remain
    const years = result.years || [];
    expect(years).not.toContain(1975);
    if (result.cells.length > 0) {
      expect(result.cells.every(c => c.year >= 1982)).toBe(true);
    }
  });

  test('filters non-bullion denomination comps (centavos, pesos)', async () => {
    mockEbayService.fetchSoldComps
      .mockResolvedValueOnce({
        us: { comps: [
          { title: '1986 Mexico 50 Centavos Libertad', totalUsd: 2 },  // centavos — should be filtered
          { title: '2020 Mexico Silver Libertad 1 oz BU', totalUsd: 38 },  // bullion — keep
        ] },
        global: { comps: [] },
      });

    const result = await fetchMarketMatrix({
      series: 'Mexico Silver Libertad',
      grade: 'All',
      timeWindowDays: 90,
      lookupKeyDate: mockLookupKeyDate,
      ebayService: mockEbayService,
    });

    // centavos comp should be filtered by BULLION_DENY_DENOM_RE
    const allTitles = result.cells.map(c => c.year);
    // If centavos was filtered, we should not see a $2 cell
    if (result.cells.length > 0) {
      const cheapCells = result.cells.filter(c => c.medianCompleted && c.medianCompleted.value < 5);
      expect(cheapCells.length).toBe(0);
    }
  });

  test('returns mode "bar" for bar series', async () => {
    mockEbayService.fetchSoldComps
      .mockResolvedValueOnce({
        us: { comps: [
          { title: 'PAMP Suisse 1 oz Gold Bar .9999', totalUsd: 2500 },
          { title: 'Valcambi 1 oz Gold Bar .9999', totalUsd: 2480 },
        ] },
        global: { comps: [] },
      });

    const result = await fetchMarketMatrix({
      series: 'Gold Bar 1 oz',
      grade: 'All',
      timeWindowDays: 90,
      lookupKeyDate: mockLookupKeyDate,
      ebayService: mockEbayService,
    });

    expect(result.mode).toBe('bar');
    expect(result.brands).toBeDefined();
    expect(result.summary.brandCount).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════════════════════════════════════
 *  buildBarMatrix
 * ═══════════════════════════════════════════════════════════ */
describe('buildBarMatrix', () => {
  test('groups by brand and calculates medians', () => {
    const comps = [
      { title: 'PAMP Suisse 1oz Gold Bar', totalUsd: 2500 },
      { title: 'PAMP Suisse 1oz Gold Bar', totalUsd: 2480 },
      { title: 'Valcambi 1oz Gold Bar', totalUsd: 2470 },
      { title: 'Generic Refiner 1oz Gold Bar', totalUsd: 2450 },
    ];

    const result = buildBarMatrix({
      completedComps: comps,
      activeComps: [],
      series: 'Gold Bar 1 oz',
      lookbackDays: 90,
    });

    expect(result.mode).toBe('bar');
    expect(result.brands).toContain('PAMP');
    expect(result.brands).toContain('Valcambi');
    // PAMP has 2 comps, should have a median
    const pamp = result.cells.find(c => c.brand === 'PAMP');
    expect(pamp.medianCompleted.value).toBe(2490);
    expect(pamp.medianCompleted.sampleSize).toBe(2);
  });

  test('classifies unknown brand as Generic', () => {
    const comps = [
      { title: '1oz Gold Bar .9999 Fine', totalUsd: 2450 },
    ];
    const result = buildBarMatrix({ completedComps: comps, activeComps: [] });
    expect(result.brands).toContain('Generic');
  });

  test('includes active BIN listings', () => {
    const result = buildBarMatrix({
      completedComps: [],
      activeComps: [
        { title: 'PAMP 1oz Gold Bar', totalUsd: 2600, listingType: 'Fixed price' },
      ],
    });
    const pamp = result.cells.find(c => c.brand === 'PAMP');
    expect(pamp.cheapestBin.value).toBe(2600);
  });
});

/* ═══════════════════════════════════════════════════════════
 *  extractBrand
 * ═══════════════════════════════════════════════════════════ */
describe('extractBrand', () => {
  test('identifies known brands', () => {
    expect(extractBrand('PAMP Suisse 1oz Gold Bar')).toBe('PAMP');
    expect(extractBrand('Valcambi 1oz Silver Bar')).toBe('Valcambi');
    expect(extractBrand('Credit Suisse 10oz Gold Bar')).toBe('Credit Suisse');
    expect(extractBrand('Johnson Matthey 100oz Silver')).toBe('JM');
    expect(extractBrand('Engelhard 1oz Gold')).toBe('Engelhard');
  });

  test('returns Generic for unknown brand', () => {
    expect(extractBrand('Random Gold Bar 1oz')).toBe('Generic');
  });

  test('returns Generic for empty/null', () => {
    expect(extractBrand('')).toBe('Generic');
    expect(extractBrand(null)).toBe('Generic');
  });

  test('is case-insensitive', () => {
    expect(extractBrand('pamp suisse gold bar')).toBe('PAMP');
    expect(extractBrand('ENGELHARD silver bar')).toBe('Engelhard');
  });
});

/* ═══════════════════════════════════════════════════════════
 *  isBarSeries
 * ═══════════════════════════════════════════════════════════ */
describe('isBarSeries', () => {
  test('detects gold/silver bar queries', () => {
    expect(isBarSeries('Gold Bar 1 oz')).toBe(true);
    expect(isBarSeries('Silver Bar 10 oz')).toBe(true);
    expect(isBarSeries('Platinum Bar')).toBe(true);
  });

  test('does not match non-bar series', () => {
    expect(isBarSeries('American Silver Eagle')).toBe(false);
    expect(isBarSeries('Morgan Dollar')).toBe(false);
  });
});
