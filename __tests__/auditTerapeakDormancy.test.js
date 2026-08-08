'use strict';

const { auditDormancy } = require('../scripts/audit-terapeak-dormancy');

function event(coin, ts, status, runId = 'run-1') {
  return { coin, ts, status, run_id: runId };
}

describe('audit-terapeak-dormancy', () => {
  test('flags repeated empties after the latest success', () => {
    const rows = [
      event('Target Coin', '2026-08-01T00:00:00Z', 'ok'),
      event('Target Coin', '2026-08-02T00:00:00Z', 'empty'),
      event('Target Coin', '2026-08-03T00:00:00Z', 'empty', 'run-2'),
    ];

    const report = auditDormancy(rows, { 'coin target': { noDataCount: 1 } });

    expect(report.missingDormancy).toEqual([
      expect.objectContaining({ key: 'coin target', emptyAfterSuccess: 2, runCount: 2 }),
    ]);
  });

  test('does not treat a later refresh timestamp as proof of success', () => {
    const rows = [
      event('Target Coin', '2026-08-02T00:00:00Z', 'empty'),
      event('Target Coin', '2026-08-03T00:00:00Z', 'empty'),
    ];
    const meta = { 'coin target': { page1At: '2026-08-04T00:00:00Z' } };

    expect(auditDormancy(rows, meta).missingDormancy).toHaveLength(1);
  });

  test('orders canonical aliases in the same pass by ledger index', () => {
    const rows = [
      { ...event('Target Coin', '2026-08-02T00:00:00Z', 'ok'), pass: 1, idx: 1 },
      { ...event('Coin Target', '2026-08-02T00:00:00Z', 'empty'), pass: 1, idx: 2 },
      { ...event('Target Coin', '2026-08-03T00:00:00Z', 'empty'), pass: 2, idx: 1 },
    ];

    expect(auditDormancy(rows, {}).missingDormancy).toEqual([
      expect.objectContaining({ key: 'coin target', emptyAfterSuccess: 2 }),
    ]);
  });

  test('flags dormant metadata followed by a successful direct attempt', () => {
    const rows = [event('Recovered Coin', '2026-08-04T00:00:00Z', 'ok')];
    const meta = {
      'coin recovered': { noDataCount: 2, noDataAt: '2026-08-03T00:00:00Z' },
    };

    expect(auditDormancy(rows, meta).staleDormancy).toEqual([
      expect.objectContaining({ key: 'coin recovered', latestSuccessAt: '2026-08-04T00:00:00Z' }),
    ]);
  });
});