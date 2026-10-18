'use strict';

const {
  parseRefreshIntervalDays,
  needsRefresh,
} = require('../src/utils/greysheetRefreshSchedule');

describe('Greysheet refresh interval configuration', () => {
  test('defaults to seven days only when unset', () => {
    expect(parseRefreshIntervalDays(undefined)).toBe(7);
  });

  test.each(['', '0', '-1', '1.5', '7days', '7.0', 'abc', '31'])(
    'rejects invalid value %p',
    value => {
      expect(() => parseRefreshIntervalDays(value)).toThrow(
        'GS_REFRESH_INTERVAL_DAYS must be an integer from 1 to 30'
      );
    }
  );

  test.each([['1', 1], ['7', 7], ['30', 30], [' 14 ', 14]])(
    'accepts valid value %p',
    (value, expected) => {
      expect(parseRefreshIntervalDays(value)).toBe(expected);
    }
  );
});

describe('Greysheet refresh elapsed interval', () => {
  const now = new Date('2026-10-15T20:00:00.000Z');

  test('waits for seven full elapsed days after an ISO completion timestamp', () => {
    expect(needsRefresh('2026-10-08T20:00:00.001Z', 7, now)).toBe(false);
    expect(needsRefresh('2026-10-08T20:00:00.000Z', 7, now)).toBe(true);
  });

  test('supports legacy YYYY-MM-DD completion metadata', () => {
    expect(needsRefresh('2026-10-09', 7, now)).toBe(false);
    expect(needsRefresh('2026-10-08', 7, now)).toBe(true);
  });

  test('refreshes when completion metadata is absent or malformed', () => {
    expect(needsRefresh(null, 7, now)).toBe(true);
    expect(needsRefresh('not-a-date', 7, now)).toBe(true);
  });
});