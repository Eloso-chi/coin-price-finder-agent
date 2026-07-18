// __tests__/freshnessReportEvidenceGates.test.js
// Regression tests for BACKLOG #248: evidence-based refresh gating.
//
// Two related behaviors:
//   1. Medium-confidence low-volume candidates that have never been runtime
//      probed (refreshCount === 0) must be demoted to a single P3
//      `evidence-probe` action, not queued as P0/P1 refresh.
//   2. A single dry refresh (refreshCount >= 1 AND lastRefreshNewComps === 0)
//      on a thin market (compCount < THIN_MARKET_THRESHOLD) must escalate
//      marketDepth to 'confirmed-thin' immediately, instead of waiting for
//      CONFIRMED_THIN_REFRESHES (=3) cycles.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const META_PATH = process.env.META_PATH || path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const REPORT_PATH = process.env.FRESHNESS_REPORT_PATH || path.join(__dirname, '..', 'cache', 'freshness-report.json');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'generate-freshness-report.js');

const { classify, _isMediumConfidenceLowVolEvidence } = require('../src/services/freshnessClassifier');

let originalMeta;
beforeAll(() => {
  if (fs.existsSync(META_PATH)) {
    originalMeta = fs.readFileSync(META_PATH, 'utf8');
  }
});
afterAll(() => {
  const terapeakService = require('../src/services/terapeakService');
  if (terapeakService._cancelPendingSaves) terapeakService._cancelPendingSaves();
  if (originalMeta != null) {
    fs.writeFileSync(META_PATH, originalMeta);
  }
  if (fs.existsSync(REPORT_PATH)) fs.unlinkSync(REPORT_PATH);
});

function runReport(meta) {
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  // Pass env explicitly so the META_PATH override from __tests__/setup/meta-path.js
  // (#273H) reaches the subprocess -- jest sandboxes process.env so child_process
  // does NOT inherit mutations by default.
  execFileSync('node', [SCRIPT], { encoding: 'utf8', env: process.env });
  return JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

const mediumLowVolIds = {
  is_low_volume_candidate: true,
  is_bullion: false,
  identifier_reason: 'evidence: 2/3 historical runs returned 0 comps',
  identifier_source: 'historical_evidence_index',
  identifier_confidence: 'Medium',
};

const highLowVolIds = {
  is_low_volume_candidate: true,
  is_bullion: false,
  identifier_reason: 'evidence: 5/5 historical runs returned 0 comps',
  identifier_source: 'historical_evidence_index',
  identifier_confidence: 'High',
};

const viableIds = {
  is_low_volume_candidate: false,
  is_bullion: true,
  identifier_reason: 'evidence-hydrated bullion',
  identifier_source: 'historical_evidence_index',
  identifier_confidence: 'High',
};

describe('#248 -- Medium-confidence low-vol gating (evidence-probe)', () => {
  test('Medium-conf low-vol + refreshCount=0 + very-stale + viable -> evidence-probe at P3 (NOT refresh/P0)', () => {
    const meta = {
      '2024 american gold eagle 1oz bu': {
        compCount: 18,                  // viable on count alone
        newestSaleDate: daysAgo(45),    // very-stale (>30d)
        refreshCount: 0,
        identifiers: mediumLowVolIds,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.actions).toContain('evidence-probe');
    expect(ds.actions).not.toContain('refresh');
    expect(ds.priority).toBe('P3');
  });

  test('Medium-conf low-vol + refreshCount=1 -> NOT evidence-probe (one probe already happened, normal classification resumes)', () => {
    const meta = {
      '2013 china 1oz gold panda': {
        compCount: 14,
        newestSaleDate: daysAgo(20),    // stale
        refreshCount: 1,
        lastRefreshAt: daysAgo(30),     // outside RECENTLY_REFRESHED_DAYS window
        lastRefreshNewComps: 3,         // not dry
        identifiers: mediumLowVolIds,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.actions).not.toContain('evidence-probe');
    // compCount=14 is >= THIN_MARKET_THRESHOLD (10), so marketDepth is 'viable',
    // not 'thin'. The point of this test is: once refreshCount>=1, the
    // evidence-probe gate is bypassed and the entry flows back into normal
    // priority classification (refresh at P0/P1 depending on staleness).
    expect(ds.marketDepth).toBe('viable');
    expect(ds.actions).toContain('refresh');
  });

  test('High-conf low-vol still routes through evidence-low-vol (not evidence-probe)', () => {
    const meta = {
      'south africa krugerrand 1oz': {
        compCount: 0,
        refreshCount: 0,
        csvExists: true,
        identifiers: highLowVolIds,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.actions).toContain('evidence-low-vol');
    expect(ds.actions).not.toContain('evidence-probe');
    expect(ds.priority).toBeNull();
  });

  test('viable bullion (not low-vol) unaffected by #248 -- still gets P0/P1 refresh', () => {
    const meta = {
      '2025 american silver eagle': {
        compCount: 500,
        newestSaleDate: daysAgo(45),
        refreshCount: 1,                // refreshCount>=1 so not blocked
        lastRefreshAt: daysAgo(45),
        identifiers: viableIds,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.actions).toContain('refresh-bullion');
    expect(ds.actions).not.toContain('evidence-probe');
    expect(['P0', 'P1', 'P0.1']).toContain(ds.priority);
  });
});

describe('#248 -- dry-confirmed-thin escalation', () => {
  test('compCount=5 + refreshCount=1 + lastRefreshNewComps=0 -> marketDepth=confirmed-thin (was thin pre-#248)', () => {
    const now = new Date();
    const state = classify({
      compCount: 5,
      newestSaleDate: now.toISOString(),
      refreshCount: 1,
      lastRefreshAt: now.toISOString(),
      lastRefreshNewComps: 0,
    }, now);
    expect(state.marketDepth).toBe('confirmed-thin');
  });

  test('compCount=5 + refreshCount=1 + lastRefreshNewComps=2 -> marketDepth=thin (dry-confirmed gate requires lastRefreshNewComps===0)', () => {
    const now = new Date();
    const state = classify({
      compCount: 5,
      newestSaleDate: now.toISOString(),
      refreshCount: 1,
      lastRefreshAt: now.toISOString(),
      lastRefreshNewComps: 2,
    }, now);
    expect(state.marketDepth).toBe('thin');
  });

  test('compCount=5 + refreshCount=3 -> confirmed-thin (existing 3-refresh threshold preserved)', () => {
    const now = new Date();
    const state = classify({
      compCount: 5,
      newestSaleDate: now.toISOString(),
      refreshCount: 3,
      lastRefreshAt: now.toISOString(),
      lastRefreshNewComps: 1,            // not dry, but refreshCount alone qualifies
    }, now);
    expect(state.marketDepth).toBe('confirmed-thin');
  });

  test('report mirrors classifier: compCount=5 + refreshCount=1 + lastRefreshNewComps=0 -> confirmed-thin-skip, priority=null', () => {
    const meta = {
      '2003 china quarter oz gold panda': {
        compCount: 5,
        newestSaleDate: daysAgo(2),
        refreshCount: 1,
        lastRefreshAt: daysAgo(2),
        lastRefreshNewComps: 0,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.marketDepth).toBe('confirmed-thin');
    expect(ds.priority).toBeNull();
    expect(ds.actions).toContain('confirmed-thin-skip');
  });
});

describe('#248 -- helper functions', () => {
  test('_isMediumConfidenceLowVolEvidence: true for Medium + low-vol', () => {
    expect(_isMediumConfidenceLowVolEvidence({ identifiers: mediumLowVolIds })).toBe(true);
  });
  test('_isMediumConfidenceLowVolEvidence: false for High + low-vol', () => {
    expect(_isMediumConfidenceLowVolEvidence({ identifiers: highLowVolIds })).toBe(false);
  });
  test('_isMediumConfidenceLowVolEvidence: false for Medium but not low-vol', () => {
    expect(_isMediumConfidenceLowVolEvidence({
      identifiers: { ...mediumLowVolIds, is_low_volume_candidate: false },
    })).toBe(false);
  });
  test('_isMediumConfidenceLowVolEvidence: false for missing identifiers', () => {
    expect(_isMediumConfidenceLowVolEvidence({})).toBe(false);
    expect(_isMediumConfidenceLowVolEvidence({ identifiers: null })).toBe(false);
  });
});
