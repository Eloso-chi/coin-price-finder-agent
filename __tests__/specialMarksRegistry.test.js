'use strict';

const {
  SPECIAL_MARKS_REGISTRY_VERSION,
  SPECIAL_MARKS,
  listApplicableMarks,
  resolveSpecialMark,
  detectMarksInTitle,
  validateRegistry,
} = require('../src/data/specialMarksRegistry');

describe('special marks registry', () => {
  test('contains unique, provenance-backed records', () => {
    expect(SPECIAL_MARKS_REGISTRY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(SPECIAL_MARKS.map(mark => mark.markId)).size).toBe(SPECIAL_MARKS.length);
    for (const mark of SPECIAL_MARKS) {
      expect(mark).toEqual(expect.objectContaining({
        markId: expect.stringMatching(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
        canonicalName: expect.any(String),
        officialStatus: 'official',
        sourceReferences: expect.arrayContaining([expect.stringMatching(/^https:\/\//)]),
        verificationDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }));
    }
    expect(validateRegistry()).toEqual([]);
  });

  test.each(['EMC2', 'E=mc2', 'E mc2', 'E=mc\u00b2'])(
    'resolves the E=mc2 alias %s within its exact issue context', (detail) => {
      const result = resolveSpecialMark({
        detail,
        context: { program: 'Canadian Maple Leaf', year: 2015, metal: 'silver', weight: 1, denomination: 5, finish: 'Reverse Proof' },
      });
      expect(result.status).toBe('resolved');
      expect(result.mark.markId).toBe('rcm.maple.emc2');
    }
  );

  test('rejects a registered mark outside its applicable issue context', () => {
    expect(resolveSpecialMark({
      markId: 'rcm.maple.emc2',
      context: { program: 'Canadian Maple Leaf', year: 2016, metal: 'silver', weight: 1, denomination: 5, finish: 'Reverse Proof' },
    }).status).toBe('inapplicable');
  });

  test('rejects a registered mark for a mismatched denomination', () => {
    expect(resolveSpecialMark({
      markId: 'rcm.maple.emc2',
      context: { program: 'Canadian Maple Leaf', year: 2015, metal: 'silver', weight: 1, denomination: 1, finish: 'Reverse Proof' },
    }).status).toBe('inapplicable');
  });

  test('keeps V75 silver and gold identities distinct by context', () => {
    const silver = listApplicableMarks({ program: 'American Silver Eagle', year: 2020, metal: 'silver', weight: 1, denomination: 1, finish: 'Proof', mint: 'W' });
    const gold = listApplicableMarks({ program: 'American Gold Eagle', year: 2020, metal: 'gold', weight: 1, denomination: 50, finish: 'Proof', mint: 'W' });
    expect(silver.map(mark => mark.markId)).toEqual(['usmint.eagle.v75.silver']);
    expect(gold.map(mark => mark.markId)).toEqual(['usmint.eagle.v75.gold']);
  });

  test('does not detect ordinary numbers as V75 or security text as a privy', () => {
    const context = { program: 'American Silver Eagle', year: 2020, metal: 'silver', weight: 1, finish: 'Proof' };
    expect(detectMarksInTitle('2020-W Silver Eagle Proof lot 75', context)).toEqual([]);
    expect(detectMarksInTitle('2020-W Silver Eagle Proof PCGS serial V751234', context)).toEqual([]);
    expect(detectMarksInTitle('2015 Maple Leaf E=mc20 Reverse Proof', {
      program: 'Silver Maple Leaf', year: 2015, metal: 'silver', weight: 1, finish: 'Reverse Proof',
    })).toEqual([]);
    expect(detectMarksInTitle('2015 Maple Leaf radial lines micro engraved security maple', {
      program: 'Silver Maple Leaf', year: 2015, metal: 'silver', weight: 1, finish: 'Reverse Proof',
    })).toEqual([]);
  });
});
