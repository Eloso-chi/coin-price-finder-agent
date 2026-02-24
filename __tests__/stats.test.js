/**
 * stats.test.js — Unit tests for src/utils/stats.js
 *
 * Covers: mean, median, percentile, stddev, mad, removeOutliersMAD,
 *         removeOutliersIQR, weightedMedian, summarize
 */

'use strict';

const stats = require('../src/utils/stats');

// ════════════════════════════════════════════════════════════════
//  Basic Statistical Functions
// ════════════════════════════════════════════════════════════════

describe('mean()', () => {
  test('returns null for empty array', () => {
    expect(stats.mean([])).toBeNull();
  });

  test('single element', () => {
    expect(stats.mean([42])).toBe(42);
  });

  test('simple average', () => {
    expect(stats.mean([10, 20, 30])).toBeCloseTo(20, 5);
  });

  test('handles negative values', () => {
    expect(stats.mean([-10, 10])).toBeCloseTo(0, 5);
  });

  test('decimal precision', () => {
    expect(stats.mean([1.1, 2.2, 3.3])).toBeCloseTo(2.2, 5);
  });
});

describe('median()', () => {
  test('returns null for empty array', () => {
    expect(stats.median([])).toBeNull();
  });

  test('single element', () => {
    expect(stats.median([42])).toBe(42);
  });

  test('odd count (middle element)', () => {
    expect(stats.median([1, 3, 5])).toBe(3);
  });

  test('even count (average of two middle)', () => {
    expect(stats.median([1, 3, 5, 7])).toBe(4);
  });

  test('unsorted input is handled', () => {
    expect(stats.median([5, 1, 3])).toBe(3);
  });

  test('does not mutate input', () => {
    const arr = [5, 1, 3];
    stats.median(arr);
    expect(arr).toEqual([5, 1, 3]);
  });
});

describe('percentile()', () => {
  test('returns null for empty array', () => {
    expect(stats.percentile([], 50)).toBeNull();
  });

  test('p=0 returns min', () => {
    expect(stats.percentile([10, 20, 30], 0)).toBe(10);
  });

  test('p=100 returns max', () => {
    expect(stats.percentile([10, 20, 30], 100)).toBe(30);
  });

  test('p=50 matches median for odd count', () => {
    const arr = [10, 20, 30, 40, 50];
    expect(stats.percentile(arr, 50)).toBe(30);
  });

  test('interpolation at p=25', () => {
    const arr = [10, 20, 30, 40, 50];
    // idx = 0.25 * 4 = 1.0 → exactly arr[1] = 20
    expect(stats.percentile(arr, 25)).toBe(20);
  });
});

describe('stddev()', () => {
  test('returns 0 for empty array', () => {
    expect(stats.stddev([])).toBe(0);
  });

  test('returns 0 for single element', () => {
    expect(stats.stddev([42])).toBe(0);
  });

  test('known values', () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] → sample stddev ≈ 2.138
    expect(stats.stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });

  test('identical values → 0', () => {
    expect(stats.stddev([5, 5, 5, 5])).toBe(0);
  });
});

describe('mad()', () => {
  test('returns 0 for empty array', () => {
    expect(stats.mad([])).toBe(0);
  });

  test('single element', () => {
    expect(stats.mad([42])).toBe(0);
  });

  test('known values', () => {
    // [1, 1, 2, 2, 4, 6, 9] → median=2, deviations=[1,1,0,0,2,4,7] → MAD=1
    expect(stats.mad([1, 1, 2, 2, 4, 6, 9])).toBe(1);
  });

  test('identical values → 0', () => {
    expect(stats.mad([10, 10, 10])).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
//  Outlier Removal — MAD
// ════════════════════════════════════════════════════════════════

describe('removeOutliersMAD()', () => {
  test('returns all for < 4 elements (skip threshold)', () => {
    const { kept, removed } = stats.removeOutliersMAD([1, 2, 100]);
    expect(kept).toEqual([1, 2, 100]);
    expect(removed).toHaveLength(0);
  });

  test('no outliers in tight cluster', () => {
    const arr = [50, 51, 49, 50, 52, 48, 50];
    const { kept, removed } = stats.removeOutliersMAD(arr);
    expect(removed).toHaveLength(0);
    expect(kept.length).toBe(arr.length);
  });

  test('removes extreme outlier', () => {
    // Cluster around 50, with one extreme at 500
    const arr = [48, 49, 50, 51, 52, 500];
    const { kept, removed } = stats.removeOutliersMAD(arr);
    expect(removed).toContain(500);
    expect(kept).not.toContain(500);
  });

  test('removes low extreme outlier', () => {
    const arr = [100, 101, 99, 102, 98, 1];
    const { kept, removed } = stats.removeOutliersMAD(arr);
    expect(removed).toContain(1);
  });

  test('symmetric removal', () => {
    // Outliers on both sides
    const arr = [1, 50, 50, 50, 50, 50, 50, 50, 50, 50, 200];
    const { kept, removed } = stats.removeOutliersMAD(arr);
    expect(removed).toContain(1);
    expect(removed).toContain(200);
  });

  test('custom k-factor tightens filter', () => {
    const arr = [10, 20, 20, 20, 20, 20, 20, 80];
    // Default k=3.5 is permissive; k=2 should catch 80
    const defaultResult = stats.removeOutliersMAD(arr, 3.5);
    const tightResult = stats.removeOutliersMAD(arr, 2);
    expect(tightResult.removed.length).toBeGreaterThanOrEqual(defaultResult.removed.length);
  });

  test('identical values with one outlier', () => {
    const arr = [100, 100, 100, 100, 100, 100, 5000];
    const { kept, removed } = stats.removeOutliersMAD(arr);
    // When MAD=0, sigma=0, range collapses to [median, median]
    // so anything ≠ median is removed
    expect(removed).toContain(5000);
  });

  test('single extreme sale does not inflate FMV', () => {
    // One $32,247 sale among $30-$50 comps should be removed
    const prices = [30, 32, 35, 37, 38, 40, 42, 45, 32247];
    const { kept, removed } = stats.removeOutliersMAD(prices, 3.5);
    expect(removed).toContain(32247);
    const fmvBefore = prices.reduce((a, b) => a + b, 0) / prices.length;
    const fmvAfter = kept.reduce((a, b) => a + b, 0) / kept.length;
    // FMV after should be < $50 (without the extreme sale)
    expect(fmvAfter).toBeLessThan(50);
    // FMV before was inflated to ~$3600+
    expect(fmvBefore).toBeGreaterThan(3000);
  });
});

// ════════════════════════════════════════════════════════════════
//  Outlier Removal — IQR
// ════════════════════════════════════════════════════════════════

describe('removeOutliersIQR()', () => {
  test('returns all for < 4 elements', () => {
    const { kept, removed } = stats.removeOutliersIQR([1, 2, 100]);
    expect(kept).toEqual([1, 2, 100]);
    expect(removed).toHaveLength(0);
  });

  test('no outliers in tight cluster', () => {
    const arr = [50, 51, 49, 50, 52, 48, 50];
    const { removed } = stats.removeOutliersIQR(arr);
    expect(removed).toHaveLength(0);
  });

  test('removes extreme outlier', () => {
    const arr = [48, 49, 50, 51, 52, 500];
    const { removed } = stats.removeOutliersIQR(arr);
    expect(removed).toContain(500);
  });

  test('custom factor tightens filter', () => {
    const arr = [10, 20, 20, 20, 20, 20, 20, 80];
    const loose = stats.removeOutliersIQR(arr, 3.0);
    const tight = stats.removeOutliersIQR(arr, 1.0);
    expect(tight.removed.length).toBeGreaterThanOrEqual(loose.removed.length);
  });
});

// ════════════════════════════════════════════════════════════════
//  Weighted Median
// ════════════════════════════════════════════════════════════════

describe('weightedMedian()', () => {
  test('returns null for empty arrays', () => {
    expect(stats.weightedMedian([], [])).toBeNull();
  });

  test('single value', () => {
    expect(stats.weightedMedian([100], [1])).toBe(100);
  });

  test('equal weights → regular median', () => {
    const result = stats.weightedMedian([10, 20, 30], [1, 1, 1]);
    expect(result).toBe(20);
  });

  test('heavy weight shifts median', () => {
    // Value 10 has weight 100, value 1000 has weight 1
    const result = stats.weightedMedian([10, 1000], [100, 1]);
    expect(result).toBe(10); // median should be near 10
  });

  test('all weight on last element', () => {
    const result = stats.weightedMedian([10, 20, 30], [0.01, 0.01, 100]);
    expect(result).toBe(30);
  });
});

// ════════════════════════════════════════════════════════════════
//  Summarize
// ════════════════════════════════════════════════════════════════

describe('summarize()', () => {
  test('empty array returns null stats', () => {
    const s = stats.summarize([]);
    expect(s.count).toBe(0);
    expect(s.mean).toBeNull();
    expect(s.median).toBeNull();
  });

  test('single price', () => {
    const s = stats.summarize([100]);
    expect(s.count).toBe(1);
    expect(s.mean).toBe(100);
    expect(s.median).toBe(100);
    expect(s.min).toBe(100);
    expect(s.max).toBe(100);
  });

  test('correct structure', () => {
    const prices = [10, 20, 30, 40, 50];
    const s = stats.summarize(prices);
    expect(s).toHaveProperty('count', 5);
    expect(s).toHaveProperty('mean');
    expect(s).toHaveProperty('median');
    expect(s).toHaveProperty('p25');
    expect(s).toHaveProperty('p75');
    expect(s).toHaveProperty('min');
    expect(s).toHaveProperty('max');
    expect(s).toHaveProperty('stddev');
    expect(s).toHaveProperty('mad');
    expect(s.min).toBeLessThanOrEqual(s.p25);
    expect(s.p25).toBeLessThanOrEqual(s.median);
    expect(s.median).toBeLessThanOrEqual(s.p75);
    expect(s.p75).toBeLessThanOrEqual(s.max);
  });

  test('all values are numbers (no NaN)', () => {
    const s = stats.summarize([15, 25, 35, 45]);
    for (const key of ['count', 'mean', 'median', 'p25', 'p75', 'min', 'max', 'stddev', 'mad']) {
      expect(typeof s[key]).toBe('number');
      expect(isNaN(s[key])).toBe(false);
    }
  });

  test('realistic coin prices', () => {
    // Simulate 1964 Kennedy Half Dollar sold prices
    const prices = [8.50, 9.00, 9.25, 9.50, 10.00, 10.50, 11.00, 12.00, 15.00];
    const s = stats.summarize(prices);
    expect(s.count).toBe(9);
    expect(s.mean).toBeGreaterThan(8);
    expect(s.mean).toBeLessThan(15);
    expect(s.median).toBe(10.00);
  });
});

// ════════════════════════════════════════════════════════════════
//  Sorted helper
// ════════════════════════════════════════════════════════════════

describe('sorted()', () => {
  test('returns sorted copy', () => {
    const arr = [5, 3, 1, 4, 2];
    const result = stats.sorted(arr);
    expect(result).toEqual([1, 2, 3, 4, 5]);
    expect(arr).toEqual([5, 3, 1, 4, 2]); // original unchanged
  });

  test('already sorted', () => {
    expect(stats.sorted([1, 2, 3])).toEqual([1, 2, 3]);
  });
});
