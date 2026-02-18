// __tests__/marketAggregator.test.js — Unit tests for eBay market matrix aggregator
// Tests the pure functions (buildMarketMatrix, extractYear, extractMint, matchesGrade)
// and the async fetchMarketMatrix with a mocked ebayService.

'use strict';

const {
  buildMarketMatrix,
  fetchMarketMatrix,
  extractYear,
  extractMint,
  matchesGrade,
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
  });

  const mockEbayService = {
    fetchSoldComps: jest.fn(),
  };

  const mockLookupKeyDate = () => ({ isKeyDate: false });

  test('calls ebayService.fetchSoldComps for completed and active', async () => {
    mockEbayService.fetchSoldComps
      .mockResolvedValueOnce({
        us: { comps: [{ title: '1956-D Franklin', totalUsd: 30, url: 'http://1' }] },
        global: { comps: [] },
      })
      .mockResolvedValueOnce({
        us: { comps: [{ title: '1956-D Franklin BIN', totalUsd: 35, url: 'http://bin1', _source: 'browse', listingType: 'FixedPrice' }] },
        global: { comps: [] },
      });

    const result = await fetchMarketMatrix({
      series: 'Franklin Half Dollar',
      grade: 'All',
      timeWindowDays: 90,
      lookupKeyDate: mockLookupKeyDate,
      ebayService: mockEbayService,
    });

    expect(mockEbayService.fetchSoldComps).toHaveBeenCalledTimes(2);
    expect(result.series).toBe('Franklin Half Dollar');
    expect(result.cells.length).toBeGreaterThan(0);

    const cell = result.cells.find(c => c.year === 1956 && c.mint === 'D');
    expect(cell.medianCompleted.value).toBe(30);
    expect(cell.cheapestBin.value).toBe(35);
  });

  test('caches results (second call does not invoke ebayService)', async () => {
    mockEbayService.fetchSoldComps
      .mockResolvedValueOnce({ us: { comps: [] }, global: { comps: [] } })
      .mockResolvedValueOnce({ us: { comps: [] }, global: { comps: [] } });

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

    // Should have called 4 times total (2 per invocation: completed + active)
    expect(mockEbayService.fetchSoldComps).toHaveBeenCalledTimes(4);
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
      })
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
