// __tests__/freshnessReport.test.js -- Tests for freshness classification logic
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const META_PATH = path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const REPORT_PATH = path.join(__dirname, '..', 'cache', 'freshness-report.json');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'generate-freshness-report.js');

// Save and restore the real meta file around tests
let originalMeta;
beforeAll(() => {
  if (fs.existsSync(META_PATH)) {
    originalMeta = fs.readFileSync(META_PATH, 'utf8');
  }
});
afterAll(() => {
  // Cancel any pending debounced writes before restoring
  const terapeakService = require('../src/services/terapeakService');
  if (terapeakService._cancelPendingSaves) terapeakService._cancelPendingSaves();
  if (originalMeta != null) {
    fs.writeFileSync(META_PATH, originalMeta);
  }
  // Clean up test report
  if (fs.existsSync(REPORT_PATH)) fs.unlinkSync(REPORT_PATH);
});

function runReport(meta, extraArgs = []) {
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  execFileSync('node', [SCRIPT, ...extraArgs], { encoding: 'utf8' });
  return JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
}

// ── Freshness classification ────────────────────────────────
describe('generate-freshness-report.js', () => {
  const todayStr = new Date().toISOString().split('T')[0];
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().split('T')[0];
  };

  test('Fresh -- numismatic coin with recent comps', () => {
    const meta = {
      '1921 morgan silver dollar': {
        compCount: 150,
        newestSaleDate: daysAgo(3),
        identifiers: {
          is_low_volume_candidate: false,
          is_bullion: false,
          identifier_reason: 'test',
          identifier_source: 'historical_evidence_index',
          identifier_confidence: 'High',
        },
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.freshnessStatus).toBe('Fresh');
    expect(ds.compCount).toBe(150);
    expect(ds.identifiers.is_bullion).toBe(false);
    expect(ds.identifiers.is_low_volume_candidate).toBe(false);
  });

  test('Stale -- sufficient comps but old data', () => {
    const meta = {
      '1893 s morgan silver dollar': {
        compCount: 80,
        newestSaleDate: daysAgo(20),
        identifiers: {
          is_low_volume_candidate: false,
          is_bullion: false,
          identifier_reason: 'test',
          identifier_source: 'historical_evidence_index',
          identifier_confidence: 'High',
        },
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.freshnessStatus).toBe('Stale');
    expect(ds.freshnessReason).toMatch(/threshold/);
    expect(ds.actions).toContain('refresh-page1');
  });

  test('LowSignalMarketData -- few comps', () => {
    const meta = {
      '1895 o morgan silver dollar ms65': {
        compCount: 3,
        newestSaleDate: daysAgo(5),
        identifiers: {
          is_low_volume_candidate: true,
          is_bullion: false,
          identifier_reason: 'test',
          identifier_source: 'historical_evidence_index',
          identifier_confidence: 'Medium',
        },
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.freshnessStatus).toBe('LowSignalMarketData');
    expect(ds.freshnessReason).toMatch(/insufficient/i);
    expect(ds.actions).toContain('low-signal');
    expect(ds.identifiers.is_low_volume_candidate).toBe(true);
  });

  test('Bullion with comps -- fresh bullion item', () => {
    const meta = {
      '2024 american silver eagle': {
        compCount: 200,
        newestSaleDate: daysAgo(2),
        identifiers: {
          is_low_volume_candidate: false,
          is_bullion: true,
          identifier_reason: 'bullion via classifyComposition',
          identifier_source: 'historical_evidence_index',
          identifier_confidence: 'High',
        },
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.freshnessStatus).toBe('Fresh');
    expect(ds.identifiers.is_bullion).toBe(true);
    expect(ds.compCount).toBe(200);
  });

  test('Bullion with low comps -- LowSignalMarketData + bullion tag', () => {
    const meta = {
      '2019 perth lunar pig 1oz silver': {
        compCount: 5,
        newestSaleDate: daysAgo(10),
        identifiers: {
          is_low_volume_candidate: true,
          is_bullion: true,
          identifier_reason: 'bullion + low volume',
          identifier_source: 'historical_evidence_index',
          identifier_confidence: 'Low',
        },
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.freshnessStatus).toBe('LowSignalMarketData');
    expect(ds.identifiers.is_bullion).toBe(true);
    expect(ds.identifiers.is_low_volume_candidate).toBe(true);
    expect(ds.actions).toContain('low-signal');
  });

  test('Missing -- no data at all', () => {
    const meta = {
      '1794 flowing hair dollar': {
        compCount: 0,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.freshnessStatus).toBe('Missing');
    expect(ds.actions).toContain('needs-data');
  });

  // ── Summary counts ────────────────────────────────────────
  test('summary includes lowSignal count and threshold', () => {
    const meta = {
      'fresh coin': { compCount: 50, newestSaleDate: daysAgo(1) },
      'low signal coin': { compCount: 3, newestSaleDate: daysAgo(1) },
      'stale coin': { compCount: 50, newestSaleDate: daysAgo(20) },
      'missing coin': {},
    };
    const report = runReport(meta);
    expect(report.summary.lowSignal).toBe(1);
    expect(report.summary.lowSignalThreshold).toBe(10);
    expect(report.summary.fresh).toBe(1);
    expect(report.summary.stale15d).toBeGreaterThanOrEqual(1);
    expect(report.summary.missing).toBe(1);
  });

  // ── Batch mode filtering ──────────────────────────────────
  test('--mode low-signal includes only LowSignalMarketData items', () => {
    const meta = {
      'fresh coin': { compCount: 50, newestSaleDate: daysAgo(1) },
      'low signal coin': { compCount: 3, newestSaleDate: daysAgo(1) },
      'stale coin': { compCount: 50, newestSaleDate: daysAgo(20) },
    };
    const report = runReport(meta, ['--batch', '100', '--mode', 'low-signal']);
    // Check batch file
    const batchFile = path.join(__dirname, '..', 'cache', 'freshness-batch-100.json');
    if (fs.existsSync(batchFile)) {
      const batch = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
      expect(batch.batchMode).toBe('low-signal');
      expect(batch.datasets.every(d => d.freshnessStatus === 'LowSignalMarketData')).toBe(true);
      fs.unlinkSync(batchFile);
    }
  });
});
