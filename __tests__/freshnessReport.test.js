// __tests__/freshnessReport.test.js -- Tests for freshness classification logic
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const META_PATH = process.env.META_PATH || path.join(__dirname, '..', 'data', 'terapeak-meta.json');
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
  // Pass env explicitly so the META_PATH override from __tests__/setup/meta-path.js
  // (#273H) reaches the subprocess -- jest sandboxes process.env so child_process
  // does NOT inherit mutations by default.
  execFileSync('node', [SCRIPT, ...extraArgs], { encoding: 'utf8', env: process.env });
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
    expect(ds.actions).toContain('refresh');
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
    expect(ds.freshnessReason).toMatch(/thin market/i);
    // #248: Medium-conf low-vol + refreshCount=0 routes to `evidence-probe`
    // (single P3 page-1 probe), not the older `monitor-refresh`. Behavioral
    // change is intentional -- see BACKLOG #248 and the dedicated test file
    // __tests__/freshnessReportEvidenceGates.test.js.
    expect(ds.actions).toContain('evidence-probe');
    expect(ds.priority).toBe('P3');
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
    expect(ds.actions).toContain('monitor-refresh');
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
    expect(ds.actions).toContain('initial-fetch');
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

  // ── Dry-refresh backoff ──────────────────────────────────
  test('dry-refresh-backoff skips stale coin after 2 consecutive dry refreshes within 30d', () => {
    const meta = {
      '2020 american silver eagle': {
        compCount: 80,
        newestSaleDate: daysAgo(20), // stale
        lastRefreshAt: daysAgo(16),  // refreshed 16 days ago (past 14d recently-confirmed, within 30d tier1)
        refreshCount: 4,
        consecutiveDryRefreshes: 2,  // 2 dry refreshes in a row
        lastRefreshNewComps: 0,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.actions).toContain('dry-refresh-backoff');
    expect(ds.priority).toBeNull();
  });

  test('dry-refresh tier 2 (>=4 dry) extends cadence to 60d', () => {
    const meta = {
      '2019 american gold eagle': {
        compCount: 60,
        newestSaleDate: daysAgo(35), // very-stale
        lastRefreshAt: daysAgo(35),  // refreshed 35d ago (past tier1 30d, within tier2 60d)
        refreshCount: 6,
        consecutiveDryRefreshes: 4,
        lastRefreshNewComps: 0,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.actions).toContain('dry-refresh-backoff');
    expect(ds.priority).toBeNull();
  });

  test('dry-refresh backoff allows refresh when cadence expires', () => {
    const meta = {
      '2018 american silver eagle': {
        compCount: 80,
        newestSaleDate: daysAgo(20),
        lastRefreshAt: daysAgo(35),  // 35d ago -- past the 30d tier1 cadence
        refreshCount: 4,
        consecutiveDryRefreshes: 2,
        lastRefreshNewComps: 0,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.actions).toContain('refresh');
    expect(ds.priority).toBe('P1');
  });

  test('no backoff when consecutiveDryRefreshes is 0', () => {
    const meta = {
      '2021 morgan silver dollar': {
        compCount: 100,
        newestSaleDate: daysAgo(18),
        lastRefreshAt: daysAgo(16),
        refreshCount: 3,
        consecutiveDryRefreshes: 0,
        lastRefreshNewComps: 5,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.actions).toContain('refresh');
    expect(ds.priority).toBe('P1');
  });

  test('summary includes dryRefreshBackoff count', () => {
    const meta = {
      'backed off coin': {
        compCount: 80,
        newestSaleDate: daysAgo(20),
        lastRefreshAt: daysAgo(16),
        refreshCount: 4,
        consecutiveDryRefreshes: 3,
        lastRefreshNewComps: 0,
      },
      'normal stale coin': {
        compCount: 80,
        newestSaleDate: daysAgo(20),
        refreshCount: 2,
      },
    };
    const report = runReport(meta);
    expect(report.summary.priorityCounts.dryRefreshBackoff).toBe(1);
  });
});
