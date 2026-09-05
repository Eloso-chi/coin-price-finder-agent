'use strict';

let fs = require('fs');

// Mock fs to avoid touching real quota files
jest.mock('fs');
// Mock cachePath to provide a fake directory
jest.mock('../src/utils/cachePath', () => ({ CACHE_DIR: '/tmp/test-cache' }));

describe('pcgsQuotaService', () => {
  let quota;

  beforeEach(() => {
    jest.resetModules();
    fs = require('fs');
    // Default: no existing state file
    fs.existsSync.mockReturnValue(false);
    fs.readFileSync.mockImplementation(() => {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    });
    fs.writeFileSync.mockImplementation(() => {});
    fs.mkdirSync.mockImplementation(() => {});
    fs.openSync.mockReturnValue(123);
    fs.closeSync.mockImplementation(() => {});
    fs.unlinkSync.mockImplementation(() => {});
    fs.statSync.mockReturnValue({ mtimeMs: Date.now() });
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
      expect(status.upstreamAvailability).toBe('available');
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

    it('rejects remaining values above the reported limit', () => {
      quota.syncFromHeaders(101, 100);
      expect(quota.getStatus()).toEqual(expect.objectContaining({
        used: 0,
        remaining: 1000,
        limit: 1000,
        headerSynced: false
      }));
    });

    it('fails closed when persisted quota counters are inconsistent', () => {
      jest.resetModules();
      fs = require('fs');
      fs.readFileSync.mockReturnValue(JSON.stringify({
        date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
        used: -900,
        remaining: 1000,
        limit: 100
      }));
      quota = require('../src/services/pcgsQuotaService');

      expect(quota.getStatus()).toEqual(expect.objectContaining({
        used: 100,
        remaining: 0,
        limit: 100
      }));
    });
  });

  describe('circuit breaker', () => {
    it('isBreakerTripped() returns false initially', () => {
      expect(quota.isBreakerTripped()).toBe(false);
    });

    it('tripBreaker() preserves local quota and records upstream cooldown', () => {
      quota.tripBreaker({ retryAfter: '3600', upstreamRemaining: 0, upstreamLimit: 100 });
      expect(quota.isBreakerTripped()).toBe(true);
      const status = quota.getStatus();
      expect(status.remaining).toBe(1000);
      expect(status.breakerTrippedAt).toBeTruthy();
      expect(status.upstreamAvailability).toBe('cooldown');
      expect(status.upstreamBlockType).toBe('rate-limit');
      expect(status.upstreamReportedRemaining).toBe(0);
      expect(status.upstreamReportedLimit).toBe(100);
      expect(Date.parse(status.nextEligibleProbeAt)).toBeGreaterThan(Date.now());
    });

    it('drops malformed upstream quota values from persisted status', () => {
      quota.tripBreaker({ upstreamRemaining: null, upstreamLimit: undefined });
      expect(quota.getStatus()).toEqual(expect.objectContaining({
        upstreamReportedRemaining: null,
        upstreamReportedLimit: null
      }));
    });

    it('uses a valid upstream reset timestamp when supplied', () => {
      const resetAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      quota.tripBreaker({ resetAt, retryAfter: 'not-valid' });
      expect(quota.getStatus().nextEligibleProbeAt).toBe(resetAt);
    });

    it('falls back to a bounded cooldown for malformed headers', () => {
      quota.tripBreaker({ resetAt: 'bad', retryAfter: 'also-bad' });
      const delay = Date.parse(quota.getStatus().nextEligibleProbeAt) - Date.now();
      expect(delay).toBeGreaterThan(59 * 60 * 1000);
      expect(delay).toBeLessThanOrEqual(60 * 60 * 1000);
    });

    it('falls back safely for out-of-range numeric reset headers', () => {
      expect(() => quota.tripBreaker({
        resetAt: Number.MAX_VALUE,
        retryAfter: Number.MAX_VALUE
      })).not.toThrow();
      const delay = Date.parse(quota.getStatus().nextEligibleProbeAt) - Date.now();
      expect(delay).toBeGreaterThan(59 * 60 * 1000);
      expect(delay).toBeLessThanOrEqual(60 * 60 * 1000);
    });

    it('requires one recovery probe after cooldown expires', () => {
      quota.tripBreaker({ retryAfter: '0' });
      expect(quota.isBreakerTripped()).toBe(false);
      expect(quota.isRecoveryProbeRequired()).toBe(true);
      expect(quota.getAvailableForPrefetch(10)).toBe(1);

      quota.recordCall('prefetch', 'recovery probe');
      expect(quota.isRecoveryProbeRequired()).toBe(false);
      expect(quota.getStatus().upstreamAvailability).toBe('available');
      expect(quota.getAvailableForPrefetch(10)).toBe(989);
    });

    it('atomically reserves one recovery probe', () => {
      quota.tripBreaker({ retryAfter: '0' });

      expect(quota.acquireRequestPermit()).toBe(true);
      expect(quota.acquireRequestPermit()).toBe(false);
      expect(quota.getStatus().upstreamAvailability).toBe('probe-in-flight');

      expect(quota.releaseRecoveryProbe('failed')).toBe(true);
      expect(quota.getStatus()).toEqual(expect.objectContaining({
        upstreamAvailability: 'probe-required',
        lastProbeOutcome: 'failed'
      }));
    });

    it('does not issue a recovery permit while another process owns the probe lock', () => {
      quota.tripBreaker({ retryAfter: '0' });
      fs.openSync.mockImplementation(() => {
        const error = new Error('EEXIST');
        error.code = 'EEXIST';
        throw error;
      });
      fs.statSync.mockReturnValue({ mtimeMs: Date.now() });

      expect(quota.acquireRequestPermit()).toBe(false);
      expect(quota.getStatus().upstreamAvailability).toBe('probe-required');
    });

    it('does not clear a recovery probe when error headers are synchronized', () => {
      quota.tripBreaker({ retryAfter: '0' });
      expect(quota.acquireRequestPermit()).toBe(true);

      quota.syncFromHeaders(42, 100);

      expect(quota.getStatus().upstreamAvailability).toBe('probe-in-flight');
    });

    it('counts an invalid response but leaves recovery in probe-required state', () => {
      quota.tripBreaker({ retryAfter: '0' });
      expect(quota.acquireRequestPermit()).toBe(true);

      const result = quota.recordCall('apr', 'invalid-response', { recoverySucceeded: false });

      expect(result.used).toBe(1);
      expect(quota.getStatus()).toEqual(expect.objectContaining({
        upstreamAvailability: 'probe-required',
        lastProbeOutcome: 'failed'
      }));
    });

    it('reloads an unexpired cooldown from persisted state after restart', () => {
      let persisted;
      fs.writeFileSync.mockImplementation((_file, content) => { persisted = content; });
      fs.renameSync.mockImplementation(() => {});
      quota.tripBreaker({ retryAfter: '900' });

      jest.resetModules();
      fs.readFileSync.mockImplementation(() => persisted);
      quota = require('../src/services/pcgsQuotaService');

      expect(quota.getStatus().upstreamAvailability).toBe('cooldown');
      expect(quota.getAvailableForPrefetch(10)).toBe(0);
    });

    it('fails closed when persisted state is corrupt', () => {
      jest.resetModules();
      fs.readFileSync.mockImplementation(() => '{broken-json');
      quota = require('../src/services/pcgsQuotaService');

      expect(quota.getStatus()).toEqual(expect.objectContaining({
        upstreamAvailability: 'cooldown',
        rateLimitReason: 'PCGS quota state could not be read'
      }));
    });

    it('preserves an unexpired cooldown across a Pacific day rollover', () => {
      jest.useFakeTimers({ now: new Date('2026-08-01T06:55:00.000Z') });
      try {
        quota.tripBreaker({ retryAfter: '900' });
        jest.setSystemTime(new Date('2026-08-01T07:05:00.000Z'));

        expect(quota.getStatus()).toEqual(expect.objectContaining({
          date: '2026-08-01',
          upstreamAvailability: 'cooldown',
          nextEligibleProbeAt: '2026-08-01T07:10:00.000Z'
        }));
        expect(quota.getAvailableForPrefetch(10)).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('persists a distinct systemic rejection cooldown and requires one probe', () => {
      let persisted;
      fs.writeFileSync.mockImplementation((_file, content) => { persisted = content; });
      fs.renameSync.mockImplementation(() => {});
      quota.tripSystemicRejection({ reason: 'IsValidRequest=false' });

      expect(quota.getStatus()).toEqual(expect.objectContaining({
        upstreamAvailability: 'cooldown',
        upstreamBlockType: 'systemic-invalid-response',
        rateLimitReason: 'IsValidRequest=false'
      }));
      expect(quota.isSystemicRecoveryProbeRequired()).toBe(false);

      const raw = JSON.parse(persisted);
      raw.upstreamCooldown.resetAt = new Date(Date.now() - 1).toISOString();
      jest.resetModules();
      fs = require('fs');
      fs.readFileSync.mockReturnValue(JSON.stringify(raw));
      quota = require('../src/services/pcgsQuotaService');

      expect(quota.isSystemicRecoveryProbeRequired()).toBe(true);
      expect(quota.getAvailableForPrefetch(10)).toBe(1);
      expect(quota.acquireRequestPermit()).toBe(false);
      expect(quota.acquireRequestPermit({ allowSystemicRecovery: true })).toBe(true);
    });

    it('preserves an expired cooldown across Pacific day rollover until recovery', () => {
      jest.useFakeTimers({ now: new Date('2026-08-01T06:55:00.000Z') });
      try {
        quota.tripBreaker({ retryAfter: '0' });
        jest.setSystemTime(new Date('2026-08-01T07:05:00.000Z'));

        expect(quota.getStatus()).toEqual(expect.objectContaining({
          date: '2026-08-01',
          upstreamAvailability: 'probe-required'
        }));
        expect(quota.getAvailableForPrefetch(10)).toBe(1);
      } finally {
        jest.useRealTimers();
      }
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

    it('uses a one-hour default cooldown', () => {
      expect(quota.DEFAULT_COOLDOWN_MS).toBe(60 * 60 * 1000);
    });
  });
});
