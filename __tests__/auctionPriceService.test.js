'use strict';

const fs = require('fs');
const path = require('path');

// Mock all I/O dependencies
jest.mock('fs');
jest.mock('axios');
jest.mock('../src/utils/cachePath', () => ({ CACHE_DIR: '/tmp/test-cache' }));
jest.mock('../src/services/pcgsQuotaService', () => ({
  recordCall: jest.fn(() => ({ remaining: 999, used: 1 })),
  syncFromHeaders: jest.fn(),
  tripBreaker: jest.fn(),
  isBreakerTripped: jest.fn(() => false),
}));

describe('auctionPriceService', () => {
  let auctionPrice;

  beforeEach(() => {
    jest.resetModules();
    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockImplementation(() => {});
    fs.writeFileSync.mockImplementation(() => {});
    // Default: empty manifest + empty coin files
    fs.readFileSync.mockImplementation((filePath) => {
      if (String(filePath).includes('manifest')) {
        return JSON.stringify({ entries: {}, lastRun: null });
      }
      // Coin file
      return JSON.stringify({ pcgsNo: '1234', name: null, grades: {} });
    });
    auctionPrice = require('../src/services/auctionPriceService');
  });

  describe('computeStats()', () => {
    it('returns zeros for empty array', () => {
      const result = auctionPrice.computeStats([]);
      expect(result).toEqual({
        count: 0,
        medianUsd: null,
        highUsd: null,
        lowUsd: null,
        avgUsd: null,
      });
    });

    it('returns zeros for null input', () => {
      const result = auctionPrice.computeStats(null);
      expect(result.count).toBe(0);
      expect(result.medianUsd).toBeNull();
    });

    it('computes correct stats for odd-count price set', () => {
      const records = [
        { Price: 100, LotNo: '1', Auctioneer: 'A', Date: '01-2024' },
        { Price: 200, LotNo: '2', Auctioneer: 'B', Date: '02-2024' },
        { Price: 300, LotNo: '3', Auctioneer: 'C', Date: '03-2024' },
      ];
      const result = auctionPrice.computeStats(records);
      expect(result.count).toBe(3);
      expect(result.medianUsd).toBe(200);
      expect(result.lowUsd).toBe(100);
      expect(result.highUsd).toBe(300);
      expect(result.avgUsd).toBe(200);
    });

    it('computes correct median for even-count price set', () => {
      const records = [
        { Price: 100, LotNo: '1', Auctioneer: 'A', Date: '01-2024' },
        { Price: 200, LotNo: '2', Auctioneer: 'B', Date: '02-2024' },
        { Price: 300, LotNo: '3', Auctioneer: 'C', Date: '03-2024' },
        { Price: 400, LotNo: '4', Auctioneer: 'D', Date: '04-2024' },
      ];
      const result = auctionPrice.computeStats(records);
      expect(result.medianUsd).toBe(250);
    });

    it('excludes zero and null prices from calculations', () => {
      const records = [
        { Price: 0, LotNo: '1', Auctioneer: 'A', Date: '01-2024' },
        { Price: null, LotNo: '2', Auctioneer: 'B', Date: '02-2024' },
        { Price: 150, LotNo: '3', Auctioneer: 'C', Date: '03-2024' },
        { Price: 250, LotNo: '4', Auctioneer: 'D', Date: '04-2024' },
      ];
      const result = auctionPrice.computeStats(records);
      expect(result.count).toBe(2);
      expect(result.medianUsd).toBe(200);
      expect(result.lowUsd).toBe(150);
      expect(result.highUsd).toBe(250);
    });

    it('returns unique auction houses', () => {
      const records = [
        { Price: 100, LotNo: '1', Auctioneer: 'Heritage', Date: '01-2024' },
        { Price: 200, LotNo: '2', Auctioneer: 'Heritage', Date: '02-2024' },
        { Price: 300, LotNo: '3', Auctioneer: 'Stack\'s Bowers', Date: '03-2024' },
      ];
      const result = auctionPrice.computeStats(records);
      expect(result.auctionHouses).toEqual(expect.arrayContaining(['Heritage', "Stack's Bowers"]));
      expect(result.auctionHouses).toHaveLength(2);
    });

    it('returns date range from records', () => {
      const records = [
        { Price: 100, LotNo: '1', Auctioneer: 'A', Date: '01-2022' },
        { Price: 200, LotNo: '2', Auctioneer: 'A', Date: '06-2023' },
        { Price: 300, LotNo: '3', Auctioneer: 'A', Date: '12-2024' },
      ];
      const result = auctionPrice.computeStats(records);
      expect(result.dateRange.latest).toBe('01-2022');
      expect(result.dateRange.earliest).toBe('12-2024');
    });

    it('handles single record correctly', () => {
      const records = [{ Price: 500, LotNo: '1', Auctioneer: 'A', Date: '05-2024' }];
      const result = auctionPrice.computeStats(records);
      expect(result.count).toBe(1);
      expect(result.medianUsd).toBe(500);
      expect(result.lowUsd).toBe(500);
      expect(result.highUsd).toBe(500);
      expect(result.avgUsd).toBe(500);
    });
  });

  describe('needsRefresh()', () => {
    it('returns true when no manifest entry exists', () => {
      expect(auctionPrice.needsRefresh('99999', 65)).toBe(true);
    });

    it('returns true when freshUntil is in the past', () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      jest.resetModules();
      const fsMock = require('fs');
      fsMock.existsSync.mockReturnValue(true);
      fsMock.mkdirSync.mockImplementation(() => {});
      fsMock.writeFileSync.mockImplementation(() => {});
      fsMock.readFileSync.mockImplementation((fp) => {
        if (String(fp).includes('manifest')) {
          return JSON.stringify({
            entries: { '1234:65': { freshUntil: pastDate, lastFetched: '2024-01-01T00:00:00Z' } }
          });
        }
        return JSON.stringify({ pcgsNo: '1234', name: null, grades: {} });
      });
      const fresh = require('../src/services/auctionPriceService');
      expect(fresh.needsRefresh('1234', 65)).toBe(true);
    });

    it('returns false when freshUntil is in the future', () => {
      const futureDate = new Date(Date.now() + 86400000 * 30).toISOString();
      jest.resetModules();
      const fsMock = require('fs');
      fsMock.existsSync.mockReturnValue(true);
      fsMock.mkdirSync.mockImplementation(() => {});
      fsMock.writeFileSync.mockImplementation(() => {});
      fsMock.readFileSync.mockImplementation((fp) => {
        if (String(fp).includes('manifest')) {
          return JSON.stringify({
            entries: { '1234:65': { freshUntil: futureDate, lastFetched: '2024-01-01T00:00:00Z' } }
          });
        }
        return JSON.stringify({ pcgsNo: '1234', name: null, grades: {} });
      });
      const fresh = require('../src/services/auctionPriceService');
      expect(fresh.needsRefresh('1234', 65)).toBe(false);
    });
  });

  describe('getHistory()', () => {
    it('returns empty records for unknown pcgsNo', () => {
      const result = auctionPrice.getHistory('99999', 65);
      expect(result.records).toEqual([]);
      expect(result.stats.count).toBe(0);
      expect(result.pcgsNo).toBe('99999');
    });

    it('returns stored records and stats for known grade', () => {
      jest.resetModules();
      const fsMock = require('fs');
      fsMock.existsSync.mockReturnValue(true);
      fsMock.mkdirSync.mockImplementation(() => {});
      fsMock.writeFileSync.mockImplementation(() => {});
      fsMock.readFileSync.mockImplementation((fp) => {
        if (String(fp).includes('manifest')) {
          return JSON.stringify({
            entries: { '1234:65': { lastFetched: '2024-06-01T00:00:00Z', freshUntil: '2024-07-01T00:00:00Z' } }
          });
        }
        return JSON.stringify({
          pcgsNo: '1234',
          name: '1881-S Morgan Dollar',
          grades: {
            '65': {
              records: [
                { Price: 400, LotNo: 'A1', Auctioneer: 'Heritage', Date: '01-2024' },
                { Price: 500, LotNo: 'A2', Auctioneer: 'Heritage', Date: '03-2024' },
              ]
            }
          }
        });
      });
      const svc = require('../src/services/auctionPriceService');
      const result = svc.getHistory('1234', 65);
      expect(result.name).toBe('1881-S Morgan Dollar');
      expect(result.records).toHaveLength(2);
      expect(result.stats.count).toBe(2);
      expect(result.stats.medianUsd).toBe(450);
      expect(result.lastFetched).toBe('2024-06-01T00:00:00Z');
    });
  });

  describe('FRESHNESS_DAYS constant', () => {
    it('defaults to 30 days', () => {
      expect(auctionPrice.FRESHNESS_DAYS).toBe(30);
    });
  });

  describe('DATE_WINDOW_YEARS constant', () => {
    it('defaults to 3 years', () => {
      expect(auctionPrice.DATE_WINDOW_YEARS).toBe(3);
    });
  });

  describe('computeTrend', () => {
    function makeRecords(recentPrices, olderPrices) {
      const now = new Date();
      const records = [];
      // Recent records: within last 12 months
      for (const price of recentPrices) {
        const d = new Date(now);
        d.setMonth(d.getMonth() - Math.floor(Math.random() * 6));
        records.push({ Price: price, Date: `${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`, Auctioneer: 'Test' });
      }
      // Older records: 12-24 months ago
      for (const price of olderPrices) {
        const d = new Date(now);
        d.setMonth(d.getMonth() - 12 - Math.floor(Math.random() * 6));
        records.push({ Price: price, Date: `${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`, Auctioneer: 'Test' });
      }
      return records;
    }

    it('returns null for fewer than 4 records', () => {
      const result = auctionPrice.computeTrend([{ Price: 100, Date: '01-2025' }]);
      expect(result.direction).toBeNull();
      expect(result.pct).toBeNull();
    });

    it('returns null for empty input', () => {
      const result = auctionPrice.computeTrend([]);
      expect(result.direction).toBeNull();
    });

    it('returns null for null input', () => {
      const result = auctionPrice.computeTrend(null);
      expect(result.direction).toBeNull();
    });

    it('detects rising trend (>= +15%)', () => {
      const records = makeRecords([150, 155, 160, 145], [100, 105, 110, 95]);
      const result = auctionPrice.computeTrend(records);
      expect(result.direction).toBe('rising');
      expect(result.pct).toBeGreaterThanOrEqual(15);
    });

    it('detects falling trend (<= -15%)', () => {
      const records = makeRecords([80, 85, 75, 82], [120, 115, 125, 118]);
      const result = auctionPrice.computeTrend(records);
      expect(result.direction).toBe('falling');
      expect(result.pct).toBeLessThanOrEqual(-15);
    });

    it('detects stable trend (within +/-15%)', () => {
      const records = makeRecords([100, 105, 102, 98], [100, 95, 103, 97]);
      const result = auctionPrice.computeTrend(records);
      expect(result.direction).toBe('stable');
      expect(Math.abs(result.pct)).toBeLessThan(15);
    });

    it('returns null when not enough data in one window', () => {
      // Only recent data, no older
      const now = new Date();
      const records = [
        { Price: 100, Date: `${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`, Auctioneer: 'Test' },
        { Price: 105, Date: `${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`, Auctioneer: 'Test' },
        { Price: 110, Date: `${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`, Auctioneer: 'Test' },
        { Price: 115, Date: `${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`, Auctioneer: 'Test' },
      ];
      const result = auctionPrice.computeTrend(records);
      expect(result.direction).toBeNull();
    });
  });
});
