// __tests__/freshnessReportUsSeed.test.js
// #334H: the freshness report queues US type seed terms as P2 initial-fetch datasets
// (in memory only) without touching real data files.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'generate-freshness-report.js');
const CSV_DIR = path.join(__dirname, '..', 'data', 'terapeak');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpf-seed-report-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const today = new Date().toISOString().slice(0, 10);
const BASE_KEY = '1900 baseline piece test';
// Seeds are skipped when meta is empty, so every run carries one real dataset.
const BASE = { [BASE_KEY]: { compCount: 100, newestSaleDate: today, refreshCount: 1 } };

const t = (term, phase) => ({ term, group: 'test-group', rank: 1, phase });
const SEED = [
  t('1850 Fantasy Test Piece Alpha', 0),
  t('1851 Fantasy Test Piece Beta', 1),
  t('1852 Fantasy Test Piece Gamma', 2),
];

function run({ meta = {}, seed = { terms: SEED }, env = {}, args = [], writeSeed = true, baseMeta = BASE } = {}) {
  const metaPath = path.join(dir, 'meta.json');
  const seedPath = path.join(dir, 'seed.json');
  const reportPath = path.join(dir, 'report.json');
  fs.writeFileSync(metaPath, JSON.stringify({ ...baseMeta, ...meta }));
  if (writeSeed) fs.writeFileSync(seedPath, JSON.stringify(seed));
  const result = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      META_PATH: metaPath,
      FRESHNESS_REPORT_PATH: reportPath,
      US_TYPE_SEED_PATH: seedPath,
      TERAPEAK_US_SEED_PHASE: '0',
      ...env,
    },
  });
  expect(result.status).toBe(0);
  return { report: JSON.parse(fs.readFileSync(reportPath, 'utf8')), stdout: result.stdout, stderr: result.stderr, metaPath };
}

const seeded = (report) => report.datasets.filter((d) => d.usSeed).map((d) => d.key).sort();
const find = (report, key) => report.datasets.find((d) => d.key === key);

describe('US type seed in the freshness report', () => {
  test.each([undefined, '', 'banana'])('seeding is off when the phase is %p', (phase) => {
    const { report, stdout } = run({ env: { TERAPEAK_US_SEED_PHASE: phase === undefined ? '' : phase } });
    expect(seeded(report)).toEqual([]);
    expect(report.datasets).toHaveLength(1);
    expect(report.summary.usSeed).toBeUndefined();
    expect(stdout).not.toContain('US type seed');
  });

  test('phase 0 queues only probe terms as P2 initial-fetch', () => {
    const { report, stdout } = run();
    expect(seeded(report)).toEqual(['1850 alpha fantasy piece test']);
    expect(find(report, '1850 alpha fantasy piece test')).toMatchObject({
      searchTerm: '1850 Fantasy Test Piece Alpha',
      freshness: 'missing',
      marketDepth: 'untested',
      priority: 'P2',
      actions: ['initial-fetch'],
      usSeed: { group: 'test-group', rank: 1, phase: 0 },
    });
    expect(report.summary.usSeed).toEqual({
      phase: 0, added: 1, retried: 0, alreadyTracked: 0, csvOnDisk: 0, csvOnDiskTerms: [], duplicates: 0, groups: { 'test-group': 1 },
    });
    expect(stdout).toContain('US type seed (#334H): phase 0, 1 added, 0 retrying, 0 already tracked, 0 csv-only');
  });

  test('the real dataset in meta is untouched by seeding', () => {
    const { report } = run();
    expect(find(report, BASE_KEY)).toMatchObject({ compCount: 100 });
    expect(find(report, BASE_KEY).usSeed).toBeUndefined();
    expect(report.datasets).toHaveLength(2);
  });

  test('TERAPEAK_US_SEED_PHASE raises the phase', () => {
    const { report } = run({ env: { TERAPEAK_US_SEED_PHASE: '1' } });
    expect(seeded(report)).toEqual(['1850 alpha fantasy piece test', '1851 beta fantasy piece test']);
  });

  test('--us-seed-phase overrides the environment variable', () => {
    const { report } = run({ env: { TERAPEAK_US_SEED_PHASE: '0' }, args: ['--us-seed-phase', '2'] });
    expect(seeded(report)).toHaveLength(3);
    expect(report.summary.usSeed.phase).toBe(2);
  });

  test('--us-seed-phase can turn seeding on when the environment variable is unset', () => {
    const { report } = run({ env: { TERAPEAK_US_SEED_PHASE: '' }, args: ['--us-seed-phase', '1'] });
    expect(seeded(report)).toHaveLength(2);
  });

  test('--us-seed-phase without a value warns and falls back to the environment variable', () => {
    const { report, stderr } = run({ args: ['--us-seed-phase'] });
    expect(stderr).toContain('WARNING: --us-seed-phase needs a value');
    expect(seeded(report)).toHaveLength(1);
  });

  test.each(['off', '-1'])('%p adds nothing and prints no seed line', (phase) => {
    const { report, stdout } = run({ env: { TERAPEAK_US_SEED_PHASE: phase } });
    expect(seeded(report)).toEqual([]);
    expect(report.datasets).toHaveLength(1);
    expect(report.summary.usSeed).toBeUndefined();
    expect(stdout).not.toContain('US type seed');
  });

  test('an invalid phase warns on stderr and leaves seeding off', () => {
    const { report, stderr } = run({ env: { TERAPEAK_US_SEED_PHASE: 'banana' } });
    expect(stderr).toContain('WARNING: US type seed phase "banana"');
    expect(seeded(report)).toEqual([]);
  });

  test('an empty meta file gets no seeds, so the exporter still sees an empty report as invalid', () => {
    const { report, stdout, stderr } = run({ baseMeta: {} });
    expect(report.datasets).toEqual([]);
    expect(report.summary.usSeed).toBeUndefined();
    expect(stdout).not.toContain('US type seed (#334H)');
    expect(stderr).toContain('WARNING: US type seed skipped: terapeak-meta.json has no datasets');
  });

  test('a key already in meta keeps its own state and is not tagged as a seed', () => {
    const meta = { '1850 alpha fantasy piece test': { compCount: 60, newestSaleDate: today, refreshCount: 1 } };
    const { report } = run({ meta });
    const entry = find(report, '1850 alpha fantasy piece test');
    expect(entry.usSeed).toBeUndefined();
    expect(entry.compCount).toBe(60);
    expect(report.summary.usSeed).toMatchObject({ added: 0, alreadyTracked: 1 });
  });

  test('a dormant meta entry stays dormant and is never scheduled', () => {
    const meta = { '1850 alpha fantasy piece test': { compCount: 0, noDataCount: 2, noDataAt: new Date().toISOString() } };
    const { report } = run({ meta });
    const entry = find(report, '1850 alpha fantasy piece test');
    expect(entry.actions).toContain('dormant');
    expect(entry.priority).toBeNull();
  });

  test('after a first no-data report the retry keeps the seed term as its search text and stays tagged', () => {
    const meta = { '1850 alpha fantasy piece test': { compCount: 0, noDataCount: 1, noDataAt: new Date().toISOString() } };
    const { report } = run({ meta });
    expect(find(report, '1850 alpha fantasy piece test')).toMatchObject({
      searchTerm: '1850 Fantasy Test Piece Alpha',
      priority: 'P2',
      actions: ['initial-fetch'],
      usSeed: { group: 'test-group', rank: 1, phase: 0 },
    });
    expect(report.summary.usSeed).toMatchObject({ added: 0, retried: 1, alreadyTracked: 0 });
  });

  test('a term that already has a CSV on disk is not seeded and is named in a warning', () => {
    const csv = fs.readdirSync(CSV_DIR).find((f) => f.endsWith('.csv'));
    const existingTerm = csv.slice(0, -4).replace(/_+/g, ' ').trim();
    const { report, stderr, stdout } = run({ seed: { terms: [t(existingTerm, 0)] } });
    expect(seeded(report)).toEqual([]);
    expect(report.summary.usSeed).toMatchObject({ added: 0, alreadyTracked: 0, csvOnDisk: 1, csvOnDiskTerms: [existingTerm] });
    expect(stderr).toContain('1 term(s) have a CSV on disk but no app entry');
    expect(stdout).toContain('1 csv-only');
  });

  test('a seed term with contradictory weights is quarantined, not queued', () => {
    const { report } = run({ seed: { terms: [t('1850 Fantasy 1 oz half oz Test Piece', 0)] } });
    const entry = report.datasets.find((d) => d.usSeed);
    expect(entry).toMatchObject({ quarantined: true, quarantineReason: 'contradictory-weight', priority: null });
  });

  test('a missing seed file leaves the report unchanged', () => {
    const { report, stdout, stderr } = run({ writeSeed: false });
    expect(report.datasets).toHaveLength(1);
    expect(report.summary.usSeed).toBeUndefined();
    expect(stdout).not.toContain('US type seed');
    expect(stderr).toBe('');
  });

  test('an invalid seed entry is skipped with a warning and the rest still load', () => {
    const { report, stderr } = run({ seed: { terms: [t('1850 Fantasy Test Piece Alpha', 0), { term: '', group: 'g', rank: 1, phase: 0 }] } });
    expect(stderr).toContain('WARNING: US type seed: terms[1]');
    expect(seeded(report)).toHaveLength(1);
  });

  test('seed entries are never written to the meta file', () => {
    const { metaPath } = run();
    expect(JSON.parse(fs.readFileSync(metaPath, 'utf8'))).toEqual(BASE);
  });
});
