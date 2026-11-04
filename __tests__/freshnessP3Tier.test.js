// __tests__/freshnessP3Tier.test.js -- P3 fallback tiers in the freshness report (#330H)
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  classifyP3Tier,
  p3SaleRatePerMonth,
  P3_FALLBACK_TIER_ORDER,
} = require('../src/services/freshnessClassifier');

const META_PATH = process.env.META_PATH || path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const REPORT_PATH = process.env.FRESHNESS_REPORT_PATH || path.join(__dirname, '..', 'cache', 'freshness-report.json');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'generate-freshness-report.js');

let originalMeta;
beforeAll(() => {
  if (fs.existsSync(META_PATH)) originalMeta = fs.readFileSync(META_PATH, 'utf8');
});
afterAll(() => {
  const terapeakService = require('../src/services/terapeakService');
  if (terapeakService._cancelPendingSaves) terapeakService._cancelPendingSaves();
  if (originalMeta != null) fs.writeFileSync(META_PATH, originalMeta);
  if (fs.existsSync(REPORT_PATH)) fs.unlinkSync(REPORT_PATH);
});

function runReport(meta) {
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  execFileSync('node', [SCRIPT], { encoding: 'utf8', env: process.env });
  return JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
}

const NOW = new Date('2026-11-04T12:00:00Z');
const isoDaysBefore = (n, from = NOW) => new Date(from.getTime() - n * 86400000).toISOString();

describe('P3_FALLBACK_TIER_ORDER', () => {
  test('lists the five fallback tiers in run order', () => {
    expect([...P3_FALLBACK_TIER_ORDER]).toEqual([
      'probe-with-data', 'near-viable', 'probe-no-data', 'thin-low', 'confirmed-thin',
    ]);
  });

  test('is frozen so callers cannot reorder the tiers', () => {
    expect(Object.isFrozen(P3_FALLBACK_TIER_ORDER)).toBe(true);
  });
});

describe('p3SaleRatePerMonth', () => {
  test('divides comps by the span between the oldest and newest sale', () => {
    // 182 days is just under six 30.4-day months, so 6 comps is one sale a month.
    expect(p3SaleRatePerMonth({ compCount: 6, newestSaleDate: '2026-04-01', oldestSaleDate: '2025-10-01' })).toBe(1);
  });

  test('never uses a span shorter than one month', () => {
    expect(p3SaleRatePerMonth({ compCount: 3, newestSaleDate: '2026-04-01', oldestSaleDate: '2026-04-01' })).toBe(3);
  });

  test.each([
    ['no comps', { compCount: 0, newestSaleDate: '2026-04-01', oldestSaleDate: '2025-10-01' }],
    ['no newest sale', { compCount: 4, newestSaleDate: null, oldestSaleDate: '2025-10-01' }],
    ['no oldest sale', { compCount: 4, newestSaleDate: '2026-04-01', oldestSaleDate: null }],
    ['unparseable dates', { compCount: 4, newestSaleDate: 'soon', oldestSaleDate: 'then' }],
    ['oldest after newest', { compCount: 4, newestSaleDate: '2025-10-01', oldestSaleDate: '2026-04-01' }],
  ])('is null for %s', (_label, input) => {
    expect(p3SaleRatePerMonth(input)).toBeNull();
  });
});

describe('classifyP3Tier', () => {
  const classify = (overrides) => classifyP3Tier({ now: NOW, ...overrides });

  test('generic benchmark items stay generic even when they are also probes', () => {
    expect(classify({ isGeneric: true, actions: ['evidence-probe'], marketDepth: 'thin', compCount: 3 })).toBe('generic');
  });

  test('evidence probes split on whether they already have comps', () => {
    expect(classify({ actions: ['evidence-probe'], marketDepth: 'viable', compCount: 20 })).toBe('probe-with-data');
    expect(classify({ actions: ['evidence-probe'], marketDepth: 'thin', compCount: 4 })).toBe('probe-with-data');
    expect(classify({ actions: ['evidence-probe'], marketDepth: 'untested', compCount: 0 })).toBe('probe-no-data');
    expect(classify({ actions: ['evidence-probe'], marketDepth: 'empty', compCount: 0 })).toBe('probe-no-data');
  });

  test('confirmed-thin datasets keep their own tier', () => {
    expect(classify({ actions: ['monitor-refresh'], marketDepth: 'confirmed-thin', compCount: 3 })).toBe('confirmed-thin');
  });

  describe('thin datasets', () => {
    test('are near-viable with 5+ comps and a sale in the last 365 days', () => {
      expect(classify({ marketDepth: 'thin', compCount: 5, staleDays: 365 })).toBe('near-viable');
      expect(classify({ marketDepth: 'thin', compCount: 9, staleDays: 0 })).toBe('near-viable');
    });

    test('are thin-low with fewer comps, an older newest sale, or no sale date', () => {
      expect(classify({ marketDepth: 'thin', compCount: 4, staleDays: 10 })).toBe('thin-low');
      expect(classify({ marketDepth: 'thin', compCount: 5, staleDays: 366 })).toBe('thin-low');
      expect(classify({ marketDepth: 'thin', compCount: 8, staleDays: null })).toBe('thin-low');
    });

    test('are near-viable when the sale rate predicts 2+ new sales since a page-1 fetch 60 to 180 days ago', () => {
      // 1 sale a month, fetched 90 days ago => about 2.96 new sales expected.
      expect(classify({ marketDepth: 'thin', compCount: 3, staleDays: 400, saleRate: 1, page1At: isoDaysBefore(90) })).toBe('near-viable');
    });

    test.each([
      ['fetched too recently to expect 2 sales', { saleRate: 1, page1At: isoDaysBefore(30) }],
      ['fetched outside the 180 day window', { saleRate: 5, page1At: isoDaysBefore(181) }],
      ['no sale rate', { saleRate: null, page1At: isoDaysBefore(90) }],
      ['no page-1 fetch recorded', { saleRate: 1, page1At: null }],
      ['a page-1 fetch dated in the future', { saleRate: 1, page1At: isoDaysBefore(-5) }],
    ])('stay thin-low when %s', (_label, extra) => {
      expect(classify({ marketDepth: 'thin', compCount: 3, staleDays: 400, ...extra })).toBe('thin-low');
    });
  });

  test('datasets that are not thin, probes, or generic have no tier', () => {
    expect(classify({ actions: ['refresh'], marketDepth: 'viable', compCount: 120 })).toBeNull();
    expect(classify({ actions: ['ok'], marketDepth: 'viable', compCount: 120, staleDays: 3 })).toBeNull();
  });
});

describe('generate-freshness-report.js P3 tiers', () => {
  const daysAgo = (n) => isoDaysBefore(n, new Date()).split('T')[0];
  const nowIsoDaysAgo = (n) => isoDaysBefore(n, new Date());
  const mediumLowVol = {
    is_low_volume_candidate: true,
    is_bullion: false,
    identifier_reason: 'test',
    identifier_source: 'historical_evidence_index',
    identifier_confidence: 'Medium',
  };

  function fixtureMeta() {
    return {
      '1881 morgan silver dollar': { compCount: 20, newestSaleDate: daysAgo(100), refreshCount: 0, identifiers: mediumLowVol },
      '1882 morgan silver dollar': { compCount: 0, refreshCount: 0, identifiers: mediumLowVol },
      '1883 morgan silver dollar': { compCount: 6, newestSaleDate: daysAgo(100), refreshCount: 0 },
      '1884 morgan silver dollar': {
        compCount: 3,
        newestSaleDate: daysAgo(60),
        oldestSaleDate: daysAgo(151),
        refreshCount: 1,
        page1At: nowIsoDaysAgo(90),
      },
      '1885 morgan silver dollar': { compCount: 2, newestSaleDate: daysAgo(200), refreshCount: 0 },
      '1886 morgan silver dollar': {
        compCount: 4,
        newestSaleDate: daysAgo(200),
        refreshCount: 5,
        lastRefreshAt: nowIsoDaysAgo(120),
      },
      '1887 morgan silver dollar generic': { compCount: 50, newestSaleDate: daysAgo(5), refreshCount: 2 },
      '1888 morgan silver dollar': { compCount: 150, newestSaleDate: daysAgo(3), refreshCount: 2 },
      '1889 morgan silver dollar': { compCount: 80, newestSaleDate: daysAgo(20), refreshCount: 0 },
    };
  }

  let report;
  const byKey = (key) => report.datasets.find(d => d.key === key);
  beforeAll(() => {
    report = runReport(fixtureMeta());
  });

  test.each([
    ['1881 morgan silver dollar', 'probe-with-data'],
    ['1882 morgan silver dollar', 'probe-no-data'],
    ['1883 morgan silver dollar', 'near-viable'],
    ['1884 morgan silver dollar', 'near-viable'],
    ['1885 morgan silver dollar', 'thin-low'],
    ['1886 morgan silver dollar', 'confirmed-thin'],
    ['1887 morgan silver dollar generic', 'generic'],
  ])('%s is a P3 dataset in tier %s', (key, tier) => {
    expect(byKey(key).priority).toBe('P3');
    expect(byKey(key).p3Tier).toBe(tier);
  });

  test('datasets outside P3 carry no tier fields', () => {
    for (const key of ['1888 morgan silver dollar', '1889 morgan silver dollar']) {
      expect(byKey(key).priority).not.toBe('P3');
      expect(byKey(key)).not.toHaveProperty('p3Tier');
      expect(byKey(key)).not.toHaveProperty('p3SaleRate');
    }
  });

  test('p3SaleRate is the observed sales per month, null without a sale span', () => {
    expect(byKey('1884 morgan silver dollar').p3SaleRate).toBeCloseTo(1, 1);
    expect(byKey('1881 morgan silver dollar').p3SaleRate).toBeNull();
  });

  test('summary counts every tier, including empty ones', () => {
    expect(report.summary.p3TierCounts).toEqual({
      'probe-with-data': 1,
      'near-viable': 2,
      'probe-no-data': 1,
      'thin-low': 1,
      'confirmed-thin': 1,
      generic: 1,
    });
    expect(report.summary.priorityCounts.P3).toBe(7);
  });

  test('a report with no P3 datasets still lists all tiers with zero counts', () => {
    const empty = runReport({ '1888 morgan silver dollar': { compCount: 150, newestSaleDate: daysAgo(3), refreshCount: 2 } });
    expect(empty.summary.p3TierCounts).toEqual({
      'probe-with-data': 0,
      'near-viable': 0,
      'probe-no-data': 0,
      'thin-low': 0,
      'confirmed-thin': 0,
      generic: 0,
    });
  });
});
