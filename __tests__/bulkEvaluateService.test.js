// __tests__/bulkEvaluateService.test.js -- Tests for Bulk Collection Evaluator
'use strict';

const {
  sizeDiscount,
  confidencePenalty,
  concentrationPenalty,
  computeLotSummary,
  evaluateOneCoin,
  MAX_COINS,
  MAX_ACTIVE_JOBS,
  _cache,
} = require('../src/services/bulkEvaluateService');

// ── Lot formula unit tests ───────────────────────────────────

describe('sizeDiscount', () => {
  it('returns 0% for 1-10 coins', () => {
    expect(sizeDiscount(1)).toBe(0);
    expect(sizeDiscount(10)).toBe(0);
  });
  it('returns 5% for 11-50 coins', () => {
    expect(sizeDiscount(11)).toBe(0.05);
    expect(sizeDiscount(50)).toBe(0.05);
  });
  it('returns 10% for 51-100 coins', () => {
    expect(sizeDiscount(51)).toBe(0.10);
    expect(sizeDiscount(100)).toBe(0.10);
  });
  it('returns 15% for 101-250 coins', () => {
    expect(sizeDiscount(200)).toBe(0.15);
  });
  it('returns 20% for 251-500 coins', () => {
    expect(sizeDiscount(300)).toBe(0.20);
    expect(sizeDiscount(500)).toBe(0.20);
  });
});

describe('confidencePenalty', () => {
  it('returns 5% penalty for avg confidence < 60', () => {
    expect(confidencePenalty(50)).toBe(0.05);
    expect(confidencePenalty(0)).toBe(0.05);
  });
  it('returns 0% for avg confidence >= 60', () => {
    expect(confidencePenalty(60)).toBe(0);
    expect(confidencePenalty(80)).toBe(0);
  });
});

describe('concentrationPenalty', () => {
  it('returns 0% with evenly spread values', () => {
    const results = [
      { query: 'A', totalFmv: 100 },
      { query: 'B', totalFmv: 100 },
      { query: 'C', totalFmv: 100 },
      { query: 'D', totalFmv: 100 },
    ];
    const { penalty, flags } = concentrationPenalty(results);
    expect(penalty).toBe(0);
    expect(flags).toHaveLength(0);
  });

  it('flags >25% concentration as moderate', () => {
    const results = [
      { query: 'Big Coin', totalFmv: 350 },
      { query: 'B', totalFmv: 100 },
      { query: 'C', totalFmv: 100 },
      { query: 'D', totalFmv: 100 },
      { query: 'E', totalFmv: 100 },
    ];
    const { penalty, flags } = concentrationPenalty(results);
    expect(penalty).toBe(0); // moderate = flag only, no extra penalty
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0].risk).toBe('moderate');
  });

  it('adds 3% penalty for >50% concentration', () => {
    const results = [
      { query: 'Whale', totalFmv: 600 },
      { query: 'B', totalFmv: 100 },
      { query: 'C', totalFmv: 100 },
    ];
    const { penalty, flags } = concentrationPenalty(results);
    expect(penalty).toBe(0.03);
    expect(flags.some(f => f.risk === 'high')).toBe(true);
  });

  it('handles empty/zero-value results', () => {
    const { penalty, flags } = concentrationPenalty([]);
    expect(penalty).toBe(0);
    expect(flags).toHaveLength(0);
  });
});

describe('computeLotSummary', () => {
  it('computes correct summary for a small lot', () => {
    const results = [
      { fmv: 100, totalFmv: 100, confidence: 80, isBullion: false, meltValue: 30 },
      { fmv: 200, totalFmv: 400, confidence: 70, isBullion: true, meltValue: 180 },
      { fmv: 50, totalFmv: 50, confidence: 60, isBullion: false, meltValue: 20 },
    ];
    const s = computeLotSummary(results);
    expect(s.coinCount).toBe(3);
    expect(s.pricedCount).toBe(3);
    expect(s.failedCount).toBe(0);
    expect(s.totalFmv).toBe(550);
    expect(s.totalMelt).toBe(230);
    expect(s.avgConfidence).toBe(70);
    expect(s.bullionCount).toBe(1);
    expect(s.buyTiers.cherryPick).toBeLessThan(s.buyTiers.fairLot);
    expect(s.buyTiers.fairLot).toBeLessThan(s.buyTiers.fullRetail);
    expect(s.buyTiers.fullRetail).toBeLessThan(s.totalFmv);
  });

  it('handles errors and no-price results', () => {
    const results = [
      { fmv: 100, totalFmv: 100, confidence: 70, isBullion: false, meltValue: 30 },
      { error: 'timeout' },
      { fmv: null, totalFmv: null, confidence: null, isBullion: false },
    ];
    const s = computeLotSummary(results);
    expect(s.coinCount).toBe(3);
    expect(s.pricedCount).toBe(1);
    expect(s.failedCount).toBe(1);
    expect(s.noPriceCount).toBe(1);
  });

  it('applies size discount for larger lots', () => {
    const results = Array.from({ length: 60 }, (_, i) => ({
      fmv: 50, totalFmv: 50, confidence: 75, isBullion: false, meltValue: 20,
      query: 'coin-' + i,
    }));
    const s = computeLotSummary(results);
    expect(s.discounts.size).toBe(10); // 10% for 51-100
    expect(s.buyTiers.fairLot).toBeLessThan(s.totalFmv * 0.75);
  });

  it('applies confidence penalty for low-confidence lots', () => {
    const results = [
      { fmv: 100, totalFmv: 100, confidence: 30, isBullion: false, meltValue: 50 },
      { fmv: 100, totalFmv: 100, confidence: 40, isBullion: false, meltValue: 50 },
    ];
    const s = computeLotSummary(results);
    expect(s.discounts.confidence).toBe(5); // 5% penalty
  });
});

// ── Constants ────────────────────────────────────────────────

describe('constants', () => {
  it('MAX_COINS is 500', () => expect(MAX_COINS).toBe(500));
  it('MAX_ACTIVE_JOBS is 3', () => expect(MAX_ACTIVE_JOBS).toBe(3));
});
