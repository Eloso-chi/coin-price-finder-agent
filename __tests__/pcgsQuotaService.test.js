'use strict';

const fs = require('fs');
const path = require('path');

// Mock fs to avoid touching real quota files
jest.mock('fs');
// Mock cachePath to provide a fake directory
jest.mock('../src/utils/cachePath', () => ({ CACHE_DIR: '/tmp/test-cache' }));

describe('pcgsQuotaService', () => {
  let quota;

  beforeEach(() => {
    jest.resetModules();
    // Default: no existing state file
    fs.existsSync.mockReturnValue(false);
    fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    fs.writeFileSync.mockImplementation(() => {});
    fs.mkdirSync.mockImplementation(() => {});
    quota = require('../src/services/pcgsQuotaService');
  });

  describe('getStatus()', () => {
    it('returns fresh state on first access', () => {
      const status = quota.getStatus();
      expect(status.used).toBe(0);
      expect(status.remaining).toBe(1000);
      expect(status.limit).toBe(1000);
      expect(status.breakerTripped).toBe(false);
      expect(status.pct).toBe(0);
    });
  });

  describe('recordCall()', () => {
    it('decrements remaining and increments used', () => {
      const result = quota.recordCall('coinfacts', 'test call');
      expect(result.used).toBe(1);
      expect(result.remaining).toBe(999);
    });

    it('tracks multiple calls correctly', () => {
      quota.recordCall('apr');
      quota.recordCall('apr');
      const result = quota.recordCall('prefetch');
      expect(result.used).toBe(3);
      expect(result.remaining).toBe(997);
    });

    it('does not go below zero remaining', () => {
      // Burn through quota
      for (let i = 0; i < 1001; i++) {
        quota.recordCall('apr');
      }
      const status = quota.getStatus();
      expect(status.remaining).toBe(0);
    });
  });

  describe('syncFromHeaders()', () => {
    it('overrides local count with authoritative remaining from headers', () => {
      quota.recordCall('coinfacts');
      quota.recordCall('coinfacts');
      // Server says 950 remaining
      quota.syncFromHeaders(950, 1000);
      const status = quota.getStatus();
      expect(status.remaining).toBe(950);
      expect(status.used).toBe(50);
      expect(status.headerSynced).toBe(true);
    });

    it('handles NaN remaining gracefully (no update)', () => {
      quota.syncFromHeaders(NaN, 1000);
      const status = quota.getStatus();
      expect(status.remaining).toBe(1000);
      expect(status.headerSynced).toBe(false);
    });
  });

  describe('circuit breaker', () => {
    it('isBreakerTripped() returns false initially', () => {
      expect(quota.isBreakerTripped()).toBe(false);
    });

    it('tripBreaker() trips the breaker and zeros remaining', () => {
      quota.tripBreaker();
      expect(quota.isBreakerTripped()).toBe(true);
      const status = quota.getStatus();
      expect(status.remaining).toBe(0);
      expect(status.breakerTrippedAt).toBeTruthy();
    });
  });

  describe('getAvailableForPrefetch()', () => {
    it('returns remaining minus reserve', () => {
      expect(quota.getAvailableForPrefetch(10)).toBe(990);
    });

    it('returns 0 when breaker is tripped', () => {
      quota.tripBreaker();
      expect(quota.getAvailableForPrefetch(10)).toBe(0);
    });

    it('returns 0 when remaining is less than reserve', () => {
      quota.syncFromHeaders(5, 1000);
      expect(quota.getAvailableForPrefetch(10)).toBe(0);
    });
  });

  describe('DAILY_LIMIT constant', () => {
    it('exports 1000 as the daily limit', () => {
      expect(quota.DAILY_LIMIT).toBe(1000);
    });
  });
});
