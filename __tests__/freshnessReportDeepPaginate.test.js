// __tests__/freshnessReportDeepPaginate.test.js
// Regression tests for backlog #247: deep-paginate gate must require
// refreshCount >= 1, NOT page1At/lastRefreshAt. Evidence-hydrated entries
// (refreshCount=0) must NOT be flagged for deep-pagination until at least one
// runtime page-1 confirms the listings are still live on eBay.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const META_PATH = process.env.META_PATH || path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const REPORT_PATH = path.join(__dirname, '..', 'cache', 'freshness-report.json');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'generate-freshness-report.js');

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

const bullionIds = {
  is_low_volume_candidate: false,
  is_bullion: true,
  identifier_reason: 'evidence-hydrated bullion',
  identifier_source: 'historical_evidence_index',
  identifier_confidence: 'High',
};

describe('generate-freshness-report.js -- deep-paginate gate (#247)', () => {
  test('refreshCount=0, pure evidence hydration -- does NOT deep-paginate', () => {
    const meta = {
      'silver round 1oz generic': {
        compCount: 500,
        newestSaleDate: daysAgo(5),
        refreshCount: 0,
        // no deepAt, no page1At, no lastRefreshAt
        identifiers: bullionIds,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.actions).not.toContain('deep-paginate');
  });

  test('refreshCount=0, Python-stamped lastRefreshAt only -- does NOT deep-paginate (53% of pre-fix flagged set)', () => {
    const meta = {
      'australian lunar silver 1oz generic': {
        compCount: 387,
        newestSaleDate: daysAgo(5),
        refreshCount: 0,
        lastRefreshAt: daysAgo(3),
        // no deepAt, no page1At
        identifiers: bullionIds,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.actions).not.toContain('deep-paginate');
  });

  test('refreshCount=1, viable, no deepAt -- DOES deep-paginate', () => {
    const meta = {
      '1982 mexican silver libertad 1oz': {
        compCount: 332,
        newestSaleDate: daysAgo(2),
        refreshCount: 1,
        page1At: daysAgo(2),
        // no deepAt
        identifiers: bullionIds,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.actions).toContain('deep-paginate');
  });

  test('refreshCount=0 evidence-only entry still receives a refresh action (gate fix is surgical to deep-paginate)', () => {
    const meta = {
      'chinese silver panda 1oz generic': {
        compCount: 325,
        newestSaleDate: daysAgo(20), // stale -> should be queued for refresh
        refreshCount: 0,
        identifiers: bullionIds,
      },
    };
    const report = runReport(meta);
    const ds = report.datasets[0];
    expect(ds.actions).not.toContain('deep-paginate');
    // Pre-existing refresh action must remain (the fix only touches the deep-paginate push).
    expect(ds.actions.some(a => a === 'refresh' || a === 'refresh-urgent' || a === 'monitor-refresh')).toBe(true);
  });
});
