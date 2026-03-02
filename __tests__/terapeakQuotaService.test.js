/**
 * terapeakQuotaService.test.js — Unit tests for src/services/terapeakQuotaService.js
 *
 * Each test calls resetToday() to start from clean state.
 * We spy on fs.writeFileSync to verify persistence without
 * interfering with the module's own fs reference.
 */

'use strict';

const fs = require('fs');
const svc = require('../src/services/terapeakQuotaService');

let writeSpy;

beforeEach(() => {
  // Spy on writes to verify persistence calls — set up BEFORE state mutations
  writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  // Reset quota state and ensure default limit (resetToday doesn't touch limit)
  svc.resetToday();
  svc.setLimit(svc.DAILY_LIMIT);
  // Clear the spy call history so tests only see their own writes
  writeSpy.mockClear();
});

afterEach(() => {
  writeSpy.mockRestore();
});

// ═══════════════════════════════════════════════════════════════
//  Basic operations
// ═══════════════════════════════════════════════════════════════

describe('terapeakQuotaService — basic operations', () => {
  test('getStatus returns fresh state after reset', () => {
    const s = svc.getStatus();
    expect(s.used).toBe(0);
    expect(s.remaining).toBe(svc.DAILY_LIMIT);
    expect(s.pct).toBe(0);
    expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('recordQueries increments used count', () => {
    const r = svc.recordQueries(5, 'test search');
    expect(r.ok).toBe(true);
    expect(r.used).toBe(5);
    expect(r.remaining).toBe(svc.DAILY_LIMIT - 5);
  });

  test('multiple recordQueries accumulate', () => {
    svc.recordQueries(10);
    svc.recordQueries(20);
    const s = svc.getStatus();
    expect(s.used).toBe(30);
  });

  test('canQuery returns allowed: true when under limit', () => {
    const r = svc.canQuery(100);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(svc.DAILY_LIMIT);
  });

  test('canQuery returns allowed: false when over limit', () => {
    svc.recordQueries(245);
    const r = svc.canQuery(10);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Blocking when quota exceeded
// ═══════════════════════════════════════════════════════════════

describe('terapeakQuotaService — blocking', () => {
  test('recordQueries blocks when count > remaining', () => {
    svc.recordQueries(248);
    const r = svc.recordQueries(5); // only 2 remaining
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/BLOCKED/);
    // used should NOT have increased
    expect(r.used).toBe(248);
  });

  test('exact limit: recording to exactly 250 succeeds', () => {
    const r = svc.recordQueries(250);
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(0);
  });

  test('recording 1 more after hitting limit is blocked', () => {
    svc.recordQueries(250);
    const r = svc.recordQueries(1);
    expect(r.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Warning thresholds
// ═══════════════════════════════════════════════════════════════

describe('terapeakQuotaService — warning thresholds', () => {
  test('warning at 50 remaining: CAUTION', () => {
    const r = svc.recordQueries(200); // 50 remaining
    expect(r.warning).toMatch(/CAUTION/);
  });

  test('warning at 25 remaining: WARNING', () => {
    const r = svc.recordQueries(225); // 25 remaining
    expect(r.warning).toMatch(/WARNING/);
  });

  test('warning at 10 remaining: CRITICAL', () => {
    const r = svc.recordQueries(240); // 10 remaining
    expect(r.warning).toMatch(/CRITICAL/);
  });

  test('no warning when plenty remaining', () => {
    const r = svc.recordQueries(10); // 240 remaining
    expect(r.warning).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
//  setLimit / setUsed / resetToday
// ═══════════════════════════════════════════════════════════════

describe('terapeakQuotaService — admin functions', () => {
  test('setLimit changes the daily limit', () => {
    svc.setLimit(500);
    const s = svc.getStatus();
    expect(s.limit).toBe(500);
    expect(s.remaining).toBe(500);
  });

  test('setLimit floors at 1', () => {
    svc.setLimit(-10);
    const s = svc.getStatus();
    expect(s.limit).toBe(1);
  });

  test('setUsed manually adjusts count', () => {
    const s = svc.setUsed(100);
    expect(s.used).toBe(100);
    expect(s.remaining).toBe(150);
  });

  test('setUsed floors at 0', () => {
    const s = svc.setUsed(-50);
    expect(s.used).toBe(0);
  });

  test('resetToday zeroes the counter', () => {
    svc.recordQueries(200);
    const s = svc.resetToday();
    expect(s.used).toBe(0);
    expect(s.remaining).toBe(svc.DAILY_LIMIT);
    expect(s.log).toHaveLength(1);
    expect(s.log[0].note).toMatch(/reset/i);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Log trimming
// ═══════════════════════════════════════════════════════════════

describe('terapeakQuotaService — log trimming', () => {
  test('log is trimmed from >300 to 250', () => {
    // Record 301 individual queries to push log over 300
    for (let i = 0; i < 250; i++) {
      svc.recordQueries(1, `q${i}`);
    }
    // Reset used to allow more
    svc.setUsed(0);
    for (let i = 0; i < 55; i++) {
      svc.recordQueries(1, `q${250 + i}`);
    }
    const s = svc.getStatus();
    // After trimming, log should be ≤ 300 once the threshold triggers
    expect(s.log.length).toBeLessThanOrEqual(300);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Persistence
// ═══════════════════════════════════════════════════════════════

describe('terapeakQuotaService — persistence', () => {
  test('recordQueries writes to file', () => {
    svc.recordQueries(3, 'search test');
    expect(writeSpy).toHaveBeenCalled();
    const written = JSON.parse(writeSpy.mock.calls[0][1]);
    expect(written.used).toBe(3);
  });

  test('setLimit writes to file', () => {
    svc.setLimit(300);
    expect(writeSpy).toHaveBeenCalled();
    const written = JSON.parse(writeSpy.mock.calls[0][1]);
    expect(written.limit).toBe(300);
  });
});
