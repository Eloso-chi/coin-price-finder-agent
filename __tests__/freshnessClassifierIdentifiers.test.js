// __tests__/freshnessClassifierIdentifiers.test.js
// Fix A of BACKLOG #245: classifier honors meta.identifiers evidence.
// High-confidence is_low_volume_candidate -> skip refresh on quarterly
// cadence (EVIDENCE_LOW_VOL_CADENCE_DAYS = 90) regardless of freshness.
'use strict';

const { classify, shouldSkipRefresh, THRESHOLDS, _isHighConfidenceLowVolEvidence } =
  require('../src/services/freshnessClassifier');

const NOW = new Date('2026-07-01T00:00:00.000Z');
const daysAgoIso = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('freshnessClassifier -- evidence-low-vol gate (Fix A of #245)', () => {
  const HIGH_CONF_LOW_VOL = {
    is_low_volume_candidate: true,
    identifier_confidence: 'High',
    identifier_source: 'historical_evidence_index',
  };
  const MED_CONF_LOW_VOL = {
    is_low_volume_candidate: true,
    identifier_confidence: 'Medium',
    identifier_source: 'historical_evidence_index',
  };

  test('_isHighConfidenceLowVolEvidence true only for High + true', () => {
    expect(_isHighConfidenceLowVolEvidence({ identifiers: HIGH_CONF_LOW_VOL })).toBe(true);
    expect(_isHighConfidenceLowVolEvidence({ identifiers: MED_CONF_LOW_VOL })).toBe(false);
    expect(_isHighConfidenceLowVolEvidence({ identifiers: { is_low_volume_candidate: false, identifier_confidence: 'High' } })).toBe(false);
    expect(_isHighConfidenceLowVolEvidence({})).toBe(false);
    expect(_isHighConfidenceLowVolEvidence(null)).toBe(false);
  });

  test('High-conf low-vol with recent attempt is SKIPPED with reason=evidence-low-vol', () => {
    // 1968 Krugerrand: empty in 5/5 runs, last attempt 16 days ago
    const meta = {
      newestSaleDate: null,
      compCount: 0,
      refreshCount: 0,
      lastRefreshAt: daysAgoIso(16),
      page1At: daysAgoIso(16),
      identifiers: HIGH_CONF_LOW_VOL,
    };
    const decision = shouldSkipRefresh(meta, NOW);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('evidence-low-vol');
  });

  test('High-conf low-vol with no prior attempt (lastRefreshDays=null) is SKIPPED', () => {
    // Evidence-only orphan: identifiers present, no scrape counters yet.
    const meta = {
      newestSaleDate: null,
      compCount: 0,
      refreshCount: 0,
      lastRefreshAt: null,
      page1At: null,
      identifiers: HIGH_CONF_LOW_VOL,
    };
    const decision = shouldSkipRefresh(meta, NOW);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('evidence-low-vol');
  });

  test('High-conf low-vol with attempt >=90 days ago is ALLOWED through (quarterly probe)', () => {
    const meta = {
      newestSaleDate: null,
      compCount: 0,
      refreshCount: 0,
      lastRefreshAt: daysAgoIso(95),
      page1At: daysAgoIso(95),
      identifiers: HIGH_CONF_LOW_VOL,
    };
    const decision = shouldSkipRefresh(meta, NOW);
    // Quarterly window has elapsed; gate does not skip. Other rules (empty)
    // may still skip -- here marketDepth='empty' (compCount=0, refreshCount=0,
    // csvExists=false -> 'untested') so caller will queue as initial-fetch.
    // We only assert the evidence gate didn't catch it.
    expect(decision.reason).not.toBe('evidence-low-vol');
  });

  test('Medium-confidence low-vol evidence does NOT skip', () => {
    const meta = {
      newestSaleDate: null,
      compCount: 0,
      refreshCount: 0,
      lastRefreshAt: daysAgoIso(16),
      page1At: daysAgoIso(16),
      identifiers: MED_CONF_LOW_VOL,
    };
    const decision = shouldSkipRefresh(meta, NOW);
    expect(decision.reason).not.toBe('evidence-low-vol');
  });

  test('dormancy gate fires BEFORE evidence-low-vol gate (dormancy is stronger)', () => {
    const meta = {
      newestSaleDate: null,
      compCount: 0,
      refreshCount: 0,
      lastRefreshAt: daysAgoIso(20),
      noDataCount: 3,
      noDataAt: daysAgoIso(10),
      identifiers: HIGH_CONF_LOW_VOL,
    };
    const decision = shouldSkipRefresh(meta, NOW);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('dormant');
  });

  test('viable dataset with High-conf evidence still SKIPPED (evidence wins)', () => {
    // Edge: build-evidence-index flagged High low-vol, but the dataset has
    // viable comps from a later run. We still trust the evidence and skip
    // refresh on quarterly cadence -- the dataset is already "served" by
    // those comps, no need to re-probe.
    const meta = {
      newestSaleDate: daysAgoIso(30),
      compCount: 12,
      refreshCount: 1,
      lastRefreshAt: daysAgoIso(30),
      identifiers: HIGH_CONF_LOW_VOL,
    };
    const decision = shouldSkipRefresh(meta, NOW);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('evidence-low-vol');
  });

  test('THRESHOLDS exports EVIDENCE_LOW_VOL_CADENCE_DAYS=90', () => {
    expect(THRESHOLDS.EVIDENCE_LOW_VOL_CADENCE_DAYS).toBe(90);
  });
});
