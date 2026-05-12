// __tests__/proofDesignationScoring.test.js
// #183: Verify designation-aware scoring (DCAM/CAM) on proof coins.
// #184: Verify proof pool never falls back to BU comps.
'use strict';

const { scoreMatch } = require('../src/services/ebayService');
const { computeValuation } = require('../src/services/valuationService');

// ── #183: Designation scoring ──────────────────────────────────

describe('#183 — Designation scoring in scoreMatch', () => {

  const proofExpected = {
    isProof: true,
    grade: 'PF69',
    designation: 'DCAM',
    series: 'Silver Eagle',
    year: 2023,
  };

  it('awards +10 when designation matches', () => {
    const comp = { title: '2023 American Silver Eagle PF69 DCAM Proof', totalUsd: 80 };
    const scored = scoreMatch(comp, proofExpected);
    expect(scored.matchNotes).toContain('designation-match');
    expect(scored.matchScore).toBeGreaterThan(50);
  });

  it('penalizes -15 when designation mismatches (CAM vs DCAM)', () => {
    const comp = { title: '2023 American Silver Eagle PF69 CAM Proof', totalUsd: 60 };
    const scored = scoreMatch(comp, proofExpected);
    expect(scored.matchNotes).toContain('designation-mismatch');
  });

  it('penalizes -15 when designation absent from title', () => {
    const comp = { title: '2023 American Silver Eagle PF69 Proof', totalUsd: 70 };
    const scored = scoreMatch(comp, proofExpected);
    expect(scored.matchNotes).toContain('designation-mismatch');
  });

  it('does NOT apply designation scoring for non-proof queries', () => {
    const buExpected = { grade: 'MS69', designation: 'DCAM', series: 'Silver Eagle', year: 2023 };
    const comp = { title: '2023 American Silver Eagle MS69', totalUsd: 40 };
    const scored = scoreMatch(comp, buExpected);
    expect(scored.matchNotes).not.toContain('designation-match');
    expect(scored.matchNotes).not.toContain('designation-mismatch');
  });

  it('does NOT apply designation scoring when expected has no designation', () => {
    const noDesig = { isProof: true, grade: 'PF69', series: 'Silver Eagle', year: 2023 };
    const comp = { title: '2023 American Silver Eagle PF69 DCAM Proof', totalUsd: 80 };
    const scored = scoreMatch(comp, noDesig);
    expect(scored.matchNotes).not.toContain('designation-match');
    expect(scored.matchNotes).not.toContain('designation-mismatch');
  });
});

// ── #184: Proof pool never falls back to BU ────────────────────

describe('#184 — Proof pool isolation in computeValuation', () => {

  const mockPcgs = { verified: false };

  function makeComp(gradeType, price) {
    return { totalUsd: price, gradeType, _source: 'terapeak', soldDate: new Date().toISOString() };
  }

  it('uses only proof comps when >= 3 exist', () => {
    const ebay = {
      us: { comps: [
        makeComp('proof', 80), makeComp('proof', 85), makeComp('proof', 90),
        makeComp('graded', 40), makeComp('graded', 42), makeComp('raw', 30),
      ]},
      global: { comps: [] },
    };
    const { valuation } = computeValuation(mockPcgs, ebay, null, 'Proof', { isProof: true });
    expect(valuation.gradePool.usedPool).toBe('proof');
    expect(valuation.gradePool.poolCount).toBe(3);
    expect(valuation.fmvCore).toBeGreaterThan(70); // should be near 80-90, not 40
  });

  it('uses proof pool even when only 1-2 comps (no BU fallback)', () => {
    const ebay = {
      us: { comps: [
        makeComp('proof', 80), makeComp('proof', 85),
        makeComp('graded', 40), makeComp('graded', 42), makeComp('graded', 38),
        makeComp('raw', 30), makeComp('raw', 32),
      ]},
      global: { comps: [] },
    };
    const { valuation } = computeValuation(mockPcgs, ebay, null, 'PF69', { isProof: true });
    expect(valuation.gradePool.usedPool).toBe('proof');
    expect(valuation.gradePool.poolCount).toBe(2);
    expect(valuation.lowData).toBe(true);
    // FMV should still be proof-level (80-85), not dragged down by BU (38-42)
    expect(valuation.fmvCore).toBeGreaterThan(70);
  });

  it('returns null FMV when 0 proof comps (never uses BU)', () => {
    const ebay = {
      us: { comps: [
        makeComp('graded', 40), makeComp('graded', 42), makeComp('graded', 38),
        makeComp('raw', 30), makeComp('raw', 32),
      ]},
      global: { comps: [] },
    };
    const { valuation } = computeValuation(mockPcgs, ebay, null, 'Proof', { isProof: true });
    expect(valuation.fmvCore).toBeNull();
    expect(valuation.confidence).toBe(0);
    // Should mention no proof comps in explanation
    expect(valuation.explanation.some(e => /no proof comps/i.test(e))).toBe(true);
  });

  it('detects proof from userGrade "PF69" without opts.isProof', () => {
    const ebay = {
      us: { comps: [
        makeComp('proof', 80), makeComp('proof', 85), makeComp('proof', 90),
        makeComp('graded', 40), makeComp('graded', 42),
      ]},
      global: { comps: [] },
    };
    const { valuation } = computeValuation(mockPcgs, ebay, null, 'PF69');
    expect(valuation.gradePool.wantsProof).toBe(true);
    expect(valuation.gradePool.usedPool).toBe('proof');
  });

  it('detects proof from opts.isProof even with numeric userGrade', () => {
    const ebay = {
      us: { comps: [
        makeComp('proof', 80), makeComp('proof', 85), makeComp('proof', 90),
        makeComp('graded', 40),
      ]},
      global: { comps: [] },
    };
    // Batch route passes gradeNum (69) as userGrade, but also passes isProof
    const { valuation } = computeValuation(mockPcgs, ebay, null, 69, { isProof: true });
    expect(valuation.gradePool.wantsProof).toBe(true);
    expect(valuation.gradePool.usedPool).toBe('proof');
  });
});
