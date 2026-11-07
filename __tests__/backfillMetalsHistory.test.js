// __tests__/backfillMetalsHistory.test.js -- #333H: scripts/backfill-metals-history.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const axios = require('axios');
const MockAdapter = require('axios-mock-adapter');

const script = require('../scripts/backfill-metals-history');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'backfill-metals-history.js');

describe('buildWindows', () => {
  test('a range inside 90 days is one window', () => {
    expect(script.buildWindows('2026-01-01', '2026-03-31')).toEqual([{ from: '2026-01-01', to: '2026-03-31' }]);
    expect(script.buildWindows('2026-01-05', '2026-01-05')).toEqual([{ from: '2026-01-05', to: '2026-01-05' }]);
  });

  test('longer ranges split into inclusive 90-day windows with no gap or overlap', () => {
    const w = script.buildWindows('2026-01-01', '2026-07-01');
    expect(w[0]).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(w[1]).toEqual({ from: '2026-04-01', to: '2026-06-29' });
    expect(w[2]).toEqual({ from: '2026-06-30', to: '2026-07-01' });
    expect(w).toHaveLength(3);
  });

  test.each([
    ['2026-02-30', '2026-03-01'],
    ['2026-03-01', '2026-13-01'],
    ['soon', '2026-03-01'],
    ['2026-03-02', '2026-03-01'],
    [null, '2026-03-01'],
  ])('from %p to %p is rejected', (from, to) => {
    expect(() => script.buildWindows(from, to)).toThrow();
  });
});

describe('parseHistoryBody', () => {
  const body = (prices, metal = 'XAU') => ({ metal, currency: 'USD', from: '2026-01-01', to: '2026-01-05', prices });

  test('keeps real days with positive prices, rounds to cents and counts the rest as dropped', () => {
    const out = script.parseHistoryBody(body([
      { date: '2026-01-01', price: 2000.126 },
      { date: '2026-01-02', price: -1 },
      { date: '2026-01-03', price: '2000' },
      { date: '2026-02-30', price: 10 },
      { date: 'x', price: 10 },
      { date: '2026-01-04', price: Infinity },
      null,
    ]), 'XAU');
    expect(out.rows).toEqual({ '2026-01-01': 2000.13 });
    expect(out.dropped).toBe(6);
  });

  test('a response for another metal, or without a price list, is rejected', () => {
    expect(() => script.parseHistoryBody(body([], 'XAG'), 'XAU')).toThrow(/unexpected history response/);
    expect(() => script.parseHistoryBody({ metal: 'XAU' }, 'XAU')).toThrow(/unexpected history response/);
    expect(() => script.parseHistoryBody(null, 'XAU')).toThrow(/unexpected history response/);
  });
});

describe('mergeHistory', () => {
  test('existing values win and only missing dates are added, sorted by date', () => {
    const merged = script.mergeHistory(
      { XAU: { '2026-01-02': 2, '2026-01-01': 1 } },
      { XAU: { '2026-01-01': 999, '2026-01-03': 3 }, XAG: { '2026-01-01': 30 } },
    );
    expect(merged.XAU).toEqual({ '2026-01-01': 1, '2026-01-02': 2, '2026-01-03': 3 });
    expect(Object.keys(merged.XAU)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
    expect(merged.XAG).toEqual({ '2026-01-01': 30 });
  });

  test('days in replaceDays take the fetched value, and only those days', () => {
    const merged = script.mergeHistory(
      { XAU: { '2026-01-01': 1, '2026-01-02': 2 } },
      { XAU: { '2026-01-01': 11, '2026-01-02': 22 } },
      ['2026-01-01'],
    );
    expect(merged.XAU).toEqual({ '2026-01-01': 11, '2026-01-02': 2 });
  });

  test('existing entries that are not real days or positive prices, and unknown metals, are dropped', () => {
    const existing = JSON.parse('{"XAU":{"2026-01-01":5,"bad":6,"2026-01-02":-1},"__proto__":{"2026-01-01":1},"XYZ":{"2026-01-01":1}}');
    const merged = script.mergeHistory(existing, {});
    expect(merged).toEqual({ XAU: { '2026-01-01': 5 } });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });
});

describe('backfill', () => {
  const fetchWindow = (calls) => async (metal, window) => {
    calls.push([metal, window.from, window.to]);
    return { metal, prices: [{ date: window.from, price: 100 }, { date: window.to, price: 101 }] };
  };

  test('fetches every window of every metal and merges them under the existing values', async () => {
    const calls = [];
    const { history, summary } = await script.backfill({
      from: '2026-01-01',
      to: '2026-05-01',
      metals: ['XAU', 'XAG'],
      fetchWindow: fetchWindow(calls),
      existing: { XAU: { '2026-01-01': 5 } },
    });
    expect(calls).toEqual([
      ['XAU', '2026-01-01', '2026-03-31'], ['XAU', '2026-04-01', '2026-05-01'],
      ['XAG', '2026-01-01', '2026-03-31'], ['XAG', '2026-04-01', '2026-05-01'],
    ]);
    expect(history.XAU['2026-01-01']).toBe(5);
    expect(history.XAU['2026-03-31']).toBe(101);
    expect(history.XAG['2026-01-01']).toBe(100);
    expect(summary).toEqual({ requests: 4, windows: 2, added: { XAU: 3, XAG: 4 }, dropped: 0 });
  });

  test('replaceDays overrides a known-bad existing value and counts it as added', async () => {
    const { history, summary } = await script.backfill({
      from: '2026-01-01',
      to: '2026-01-10',
      metals: ['XAU'],
      fetchWindow: fetchWindow([]),
      existing: { XAU: { '2026-01-01': 5 } },
      replaceDays: ['2026-01-01'],
    });
    expect(history.XAU['2026-01-01']).toBe(100);
    expect(summary.added.XAU).toBe(2);
  });

  test('a plan above maxRequests is refused before any request is made', async () => {
    const calls = [];
    await expect(script.backfill({
      from: '2024-01-01', to: '2026-01-01', metals: ['XAU', 'XAG', 'XPT'], fetchWindow: fetchWindow(calls), maxRequests: 5,
    })).rejects.toThrow(/above --max-requests 5/);
    expect(calls).toHaveLength(0);
  });

  test('a failing window stops the run and nothing is returned', async () => {
    const failing = async () => { throw new Error('GoldAPI XAU failed (429)'); };
    await expect(script.backfill({ from: '2026-01-01', to: '2026-01-10', metals: ['XAU'], fetchWindow: failing })).rejects.toThrow(/429/);
  });
});

describe('makeFetchWindow', () => {
  let mock;
  beforeEach(() => { mock = new MockAdapter(axios); });
  afterEach(() => { mock.restore(); });

  test('sends the key only as a header and the dates as query parameters', async () => {
    mock.onGet('https://example.test/api/history/XAU/USD').reply((config) => {
      expect(config.headers['x-access-token']).toBe('test-key');
      expect(config.params).toEqual({ from: '2026-01-01', to: '2026-01-05' });
      expect(config.url).not.toContain('test-key');
      return [200, { metal: 'XAU', prices: [] }];
    });
    const body = await script.makeFetchWindow('test-key', 'https://example.test/api')('XAU', { from: '2026-01-01', to: '2026-01-05' });
    expect(body).toEqual({ metal: 'XAU', prices: [] });
  });

  test('an HTTP error reports the status and never the key', async () => {
    mock.onGet().reply(403, { error: 'quota' });
    let message = '';
    try {
      await script.makeFetchWindow('secret-test-key')('XAG', { from: '2026-01-01', to: '2026-01-05' });
    } catch (err) { message = err.message; }
    expect(message).toBe('GoldAPI XAG 2026-01-01..2026-01-05 failed (403)');
    expect(message).not.toContain('secret-test-key');
  });

  test('a network error reports its code', async () => {
    mock.onGet().networkError();
    await expect(script.makeFetchWindow('k')('XAU', { from: '2026-01-01', to: '2026-01-05' })).rejects.toThrow(/failed \(/);
  });
});

describe('parseArgs', () => {
  test('reads every option', () => {
    expect(script.parseArgs(['--from', '2025-01-01', '--to', '2025-02-01', '--metals', 'xau, xag', '--existing', 'e.json',
      '--replace-days', '2025-01-02,2025-01-03', '--env', '.env', '--max-requests', '9', '--delay-ms', '0', '--dry-run', '--out', 'o.json']))
      .toEqual(expect.objectContaining({
        from: '2025-01-01', to: '2025-02-01', metals: ['XAU', 'XAG'], existing: 'e.json', env: '.env', maxRequests: 9, delayMs: 0,
        dryRun: true, replaceDays: ['2025-01-02', '2025-01-03'], out: path.resolve('o.json'),
      }));
  });

  test.each([
    [[], /--from is required/],
    [['--from'], /needs a value/],
    [['--from', '--dry-run'], /needs a value/],
    [['--from', '2025-01-01', '--bogus'], /Unknown argument/],
    [['--from', '2025-01-01', '--metals', 'XAU,DOGE'], /--metals must be from/],
    [['--from', '2025-01-01', '--max-requests', '-1'], /non-negative integer/],
    [['--from', '2025-01-01', '--delay-ms', 'x'], /non-negative integer/],
    [['--from', '2025-01-01', '--replace-days', 'soon'], /real YYYY-MM-DD/],
  ])('%j is rejected', (argv, pattern) => {
    expect(() => script.parseArgs(argv)).toThrow(pattern);
  });
});

describe('command line', () => {
  test('--dry-run prints the plan and makes no request or file', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-')), 'out.json');
    const text = execFileSync(process.execPath, [SCRIPT_PATH, '--from', '2026-01-01', '--to', '2026-01-02', '--dry-run', '--out', out], { encoding: 'utf8' });
    expect(text.trim()).toBe('Plan: XAU,XAG,XPT 2026-01-01..2026-01-02, 1 window(s) per metal, 3 request(s)');
    expect(fs.existsSync(out)).toBe(false);
  });

  test('a missing key stops the run with a clear message', () => {
    const env = { ...process.env };
    delete env.GOLDAPI_KEY;
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--from', '2026-01-01', '--to', '2026-01-02'], { encoding: 'utf8', env });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/GOLDAPI_KEY is not set/);
  });

  test('a future end date is refused', () => {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--from', '2026-01-01', '--to', '2999-01-01', '--dry-run'], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/--to must not be after/);
  });
});
