// __tests__/importMetalsHistoryScript.test.js -- #333H: scripts/import-metals-history.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const axios = require('axios');
const MockAdapter = require('axios-mock-adapter');

const script = require('../scripts/import-metals-history');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'import-metals-history.js');

describe('cleanHistory', () => {
  test('keeps known metals with valid day and price pairs and counts the rest', () => {
    const { history, dropped } = script.cleanHistory({
      XAU: { '2026-01-01': 5, '2026-02-30': 6, soon: 7, '2026-01-02': -1, '2026-01-03': '8' },
      XYZ: { '2026-01-01': 1 },
      XAG: {},
    });
    expect(history).toEqual({ XAU: { '2026-01-01': 5 }, XAG: {} });
    expect(dropped).toBe(4);
  });

  test('today and later days are left out, because the server records today itself', () => {
    const { history, dropped } = script.cleanHistory({ XAU: { '2026-05-01': 1, '2026-05-02': 2, '2026-05-03': 3 } }, '2026-05-02');
    expect(history).toEqual({ XAU: { '2026-05-01': 1 } });
    expect(dropped).toBe(2);
  });

  test.each([[null], [[]], [{}], [{ XYZ: { '2026-01-01': 1 } }]])('%j is rejected', (raw) => {
    expect(() => script.cleanHistory(raw)).toThrow();
  });
});

describe('checkAppUrl', () => {
  test('https and local http are accepted and reduced to the origin', () => {
    expect(script.checkAppUrl('https://app.example.test/some/path')).toBe('https://app.example.test');
    expect(script.checkAppUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(script.checkAppUrl('http://127.0.0.1:3000/x')).toBe('http://127.0.0.1:3000');
  });

  test.each([[''], ['not a url'], ['http://app.example.test'], ['ftp://app.example.test']])('%p is refused', (url) => {
    expect(() => script.checkAppUrl(url)).toThrow();
  });
});

describe('importHistory', () => {
  let mock;
  beforeEach(() => { mock = new MockAdapter(axios); });
  afterEach(() => { mock.restore(); });

  test('posts the history with the key in a header only and returns the body', async () => {
    mock.onPost('https://app.example.test/api/admin/metals-history/import').reply((config) => {
      expect(config.headers['x-api-key']).toBe('test-key');
      expect(JSON.parse(config.data)).toEqual({ history: { XAU: { '2026-01-01': 5 } }, replaceDays: ['2026-01-01'] });
      expect(config.url).not.toContain('test-key');
      expect(config.maxRedirects).toBe(0);
      return [200, { ok: true, summary: { XAU: { added: 1, replaced: 0, kept: 0, skippedOld: 0, previous: {} } }, persisted: { file: 'ok', cosmos: 'disabled' } }];
    });
    const out = await script.importHistory({ origin: 'https://app.example.test', key: 'test-key', history: { XAU: { '2026-01-01': 5 } }, replaceDays: ['2026-01-01'] });
    expect(out.ok).toBe(true);
  });

  test('an HTTP error reports the status and the server message, never the key', async () => {
    mock.onPost().reply(400, { error: 'unknown metal in history' });
    let message = '';
    try {
      await script.importHistory({ origin: 'https://app.example.test', key: 'secret-test-key', history: { XAU: {} }, replaceDays: [] });
    } catch (err) { message = err.message; }
    expect(message).toBe('import failed (400): unknown metal in history');
    expect(message).not.toContain('secret-test-key');
  });

  test('a network error reports its code', async () => {
    mock.onPost().networkError();
    await expect(script.importHistory({ origin: 'https://app.example.test', key: 'k', history: { XAU: {} }, replaceDays: [] })).rejects.toThrow(/import failed \(/);
  });
});

describe('parseArgs', () => {
  test('reads every option', () => {
    expect(script.parseArgs(['--file', 'f.json', '--replace-days', '2026-01-01,2026-01-02', '--app-url', 'https://a.test', '--env', '.env', '--dry-run']))
      .toEqual({ file: 'f.json', replaceDays: ['2026-01-01', '2026-01-02'], appUrl: 'https://a.test', env: '.env', dryRun: true });
  });

  test.each([
    [[], /--file is required/],
    [['--file'], /needs a value/],
    [['--file', '--dry-run'], /needs a value/],
    [['--file', 'f', '--bogus'], /Unknown argument/],
    [['--file', 'f', '--replace-days', 'soon'], /real YYYY-MM-DD/],
  ])('%j is rejected', (argv, pattern) => {
    expect(() => script.parseArgs(argv)).toThrow(pattern);
  });
});

describe('command line', () => {
  const tmpFile = () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'import-history-')), 'h.json');
    fs.writeFileSync(file, JSON.stringify({ XAU: { '2026-01-01': 5, '2026-01-02': 6 }, XAG: { '2026-01-01': 30 } }));
    return file;
  };
  const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8', env: { ...process.env, APP_URL: '', ADMIN_API_KEY: '', ...env } });

  test('--dry-run prints the plan and sends nothing', () => {
    const res = run(['--file', tmpFile(), '--replace-days', '2026-01-01', '--dry-run'], { APP_URL: 'https://app.example.test' });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('Plan: send XAU:2 XAG:1 to https://app.example.test, replacing 2026-01-01');
  });

  test('a missing key stops the run with a clear message', () => {
    const res = run(['--file', tmpFile()], { APP_URL: 'https://app.example.test' });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/ADMIN_API_KEY is not set/);
  });

  test('a plain-http remote URL is refused before any key is read', () => {
    const res = run(['--file', tmpFile()], { APP_URL: 'http://app.example.test', ADMIN_API_KEY: 'k' });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/APP_URL must be https/);
  });
});
