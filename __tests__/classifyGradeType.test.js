// __tests__/classifyGradeType.test.js
// #182: Verify slabbed proofs are classified as 'proof', not 'graded'.
'use strict';

const { classifyGradeType } = require('../src/services/ebayService');
const terapeak = require('../src/services/terapeakService');

// ── ebayService.classifyGradeType ──────────────────────────────

describe('ebayService.classifyGradeType', () => {

  // ── conditionId 2000 (Certified) ──

  describe('conditionId 2000 (Certified)', () => {
    it('classifies slabbed BU as graded', () => {
      expect(classifyGradeType({
        conditionId: 2000,
        title: '2023 American Silver Eagle PCGS MS69'
      })).toBe('graded');
    });

    it('classifies slabbed proof as proof (#182)', () => {
      expect(classifyGradeType({
        conditionId: 2000,
        title: '2023 American Silver Eagle PCGS PR69 DCAM Proof'
      })).toBe('proof');
    });

    it('classifies slabbed proof with just "Proof" in title (#182)', () => {
      expect(classifyGradeType({
        conditionId: 2000,
        title: '2023 Silver Eagle Proof NGC PF70'
      })).toBe('proof');
    });

    it('does NOT classify prooflike as proof', () => {
      expect(classifyGradeType({
        conditionId: 2000,
        title: '1881-S Morgan Dollar PCGS MS64 Prooflike PL'
      })).toBe('graded');
    });

    it('does NOT classify proof-like (hyphenated) as proof', () => {
      expect(classifyGradeType({
        conditionId: 2000,
        title: '1880-S Morgan PCGS MS63 Proof-Like'
      })).toBe('graded');
    });
  });

  // ── conditionId 3000/4000 (Raw) ──

  describe('conditionId 3000/4000 (Raw)', () => {
    it('classifies raw BU as raw', () => {
      expect(classifyGradeType({
        conditionId: 3000,
        title: '2023 American Silver Eagle BU'
      })).toBe('raw');
    });

    it('classifies raw proof as proof', () => {
      expect(classifyGradeType({
        conditionId: 3000,
        title: '2023 American Silver Eagle Proof'
      })).toBe('proof');
    });
  });

  // ── _certificationAspect (Browse API) ──

  describe('_certificationAspect (Browse API)', () => {
    it('classifies certified BU as graded', () => {
      expect(classifyGradeType({
        _certificationAspect: 'PCGS',
        title: '2023 ASE PCGS MS70 First Strike'
      })).toBe('graded');
    });

    it('classifies certified proof as proof (#182)', () => {
      expect(classifyGradeType({
        _certificationAspect: 'NGC',
        title: '2023 ASE NGC PF70 Ultra Cameo Proof'
      })).toBe('proof');
    });
  });

  // ── Title fallback (no conditionId, no aspect) ──

  describe('Title fallback', () => {
    it('classifies title with PCGS + MS grade as graded', () => {
      expect(classifyGradeType({
        title: '2023 Silver Eagle PCGS MS69'
      })).toBe('graded');
    });

    it('classifies title with "proof" as proof (not graded)', () => {
      expect(classifyGradeType({
        title: '2023 Silver Eagle Proof in OGP'
      })).toBe('proof');
    });

    it('classifies title with PR grade as proof over graded (#182)', () => {
      expect(classifyGradeType({
        title: 'PCGS PR69 DCAM 2023 ASE Proof'
      })).toBe('proof');
    });

    it('classifies plain title as raw', () => {
      expect(classifyGradeType({
        title: '2023 American Silver Eagle 1oz'
      })).toBe('raw');
    });
  });
});

// ── terapeakService.classifyGradeType ──────────────────────────

describe('terapeakService.classifyGradeType', () => {

  describe('condition "Certified" or "2000"', () => {
    it('classifies certified BU as graded', () => {
      expect(terapeak.classifyGradeType({
        condition: 'Certified',
        title: '2023 American Silver Eagle PCGS MS69'
      })).toBe('graded');
    });

    it('classifies certified proof as proof (#182)', () => {
      expect(terapeak.classifyGradeType({
        condition: 'Certified',
        title: '2023 American Silver Eagle PCGS PR69 DCAM Proof'
      })).toBe('proof');
    });

    it('classifies condition "2000" proof as proof (#182)', () => {
      expect(terapeak.classifyGradeType({
        condition: '2000',
        title: '2023 Silver Eagle Proof NGC PF70'
      })).toBe('proof');
    });

    it('does NOT classify prooflike as proof', () => {
      expect(terapeak.classifyGradeType({
        condition: 'Certified',
        title: '1881-S Morgan Dollar PCGS MS64 Prooflike'
      })).toBe('graded');
    });
  });

  describe('condition "Uncirculated"', () => {
    it('classifies raw BU as raw', () => {
      expect(terapeak.classifyGradeType({
        condition: 'Uncirculated',
        title: '2023 American Silver Eagle BU'
      })).toBe('raw');
    });

    it('classifies uncirculated proof as proof (#182)', () => {
      expect(terapeak.classifyGradeType({
        condition: 'Uncirculated',
        title: '2023 American Silver Eagle Proof'
      })).toBe('proof');
    });
  });

  describe('Title fallback', () => {
    it('classifies proof title as proof over graded (#182)', () => {
      expect(terapeak.classifyGradeType({
        condition: '',
        title: 'PCGS PR69 DCAM 2023 Silver Eagle Proof'
      })).toBe('proof');
    });
  });
});
