'use strict';

const {
  SPECIAL_MARKS_REGISTRY_VERSION,
  SPECIAL_MARKS,
  listApplicableMarks,
  resolveSpecialMark,
  detectMarksInTitle,
  validateRegistry,
  inferProgramMetal,
} = require('../src/data/specialMarksRegistry');

describe('special marks registry', () => {
  test('contains unique, provenance-backed records', () => {
    expect(SPECIAL_MARKS_REGISTRY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(SPECIAL_MARKS.map(mark => mark.markId)).size).toBe(SPECIAL_MARKS.length);
    for (const mark of SPECIAL_MARKS) {
      expect(mark).toEqual(expect.objectContaining({
        issueId: expect.stringMatching(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
        markId: expect.stringMatching(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
        canonicalName: expect.any(String),
        officialStatus: 'official',
        verificationStatus: expect.any(String),
        sourceReferences: expect.arrayContaining([expect.stringMatching(/^https:\/\//)]),
        verificationDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }));
    }
    expect(validateRegistry()).toEqual([]);
  });

  test.each([
    ['empty source references', mark => ({ ...mark, sourceReferences: [] })],
    ['secondary-only verification', mark => ({ ...mark, verificationStatus: 'secondary-corroborated' })],
    ['unsupported mintage type', mark => ({ ...mark, mintage: { ...mark.mintage, type: 'estimate' } })],
    ['unlinked mintage evidence', mark => ({ ...mark, mintage: { ...mark.mintage, sourceReference: 'https://example.test/unlisted' } })],
    ['linked but untrusted issuer evidence', mark => ({
      ...mark,
      sourceReferences: ['https://example.test/fake'],
      mintage: { ...mark.mintage, sourceReference: 'https://example.test/fake' },
    })],
  ])('rejects registry records with %s', (_label, mutate) => {
    expect(validateRegistry([mutate(SPECIAL_MARKS[0])])).not.toEqual([]);
  });

  test('infers metal only from an explicitly metal-named Maple Leaf program', () => {
    expect(inferProgramMetal('Canadian Silver Maple Leaf')).toBe('silver');
    expect(inferProgramMetal('Canadian Gold Maple Leaf')).toBe('gold');
    expect(inferProgramMetal('Canadian Maple Leaf')).toBeNull();
  });

  test.each([
    [2016, ['Howling Wolf', 'Roaring Grizzly Bear']],
    [2017, ['Cougar', 'Moose']],
    [2018, ['Pronghorn Antelope', 'Wood Bison']],
  ])('lists the verified Wild Canada issues for %s', (year, names) => {
    const marks = listApplicableMarks({
      program: 'Canadian Silver Maple Leaf', year, metal: 'silver', weight: 1,
      denomination: 5, finish: 'Reverse Proof',
    });
    expect(marks.map(mark => mark.canonicalName)).toEqual(names);
    expect(marks.every(mark => mark.issueId && mark.mintage.value === 50000)).toBe(true);
  });

  test('keeps the two 2018 Wild Canada privies isolated by title', () => {
    const context = {
      program: 'Canadian Silver Maple Leaf', year: 2018, metal: 'silver', weight: 1,
      denomination: 5, finish: 'Reverse Proof',
    };
    expect(detectMarksInTitle('2018 Canada 1 oz Silver Maple Leaf Pronghorn Antelope Reverse Proof', context)
      .map(mark => mark.markId)).toEqual(['rcm.maple.pronghorn-antelope.2018']);
    expect(detectMarksInTitle('2018 Canada 1 oz Silver Maple Leaf Wood Bison Reverse Proof', context)
      .map(mark => mark.markId)).toEqual(['rcm.maple.wood-bison.2018']);
  });

  test.each([
    ['2017 Canada Silver Maple Leaf Cougar Reverse Proof', 'rcm.maple.cougar.2017'],
    ['2017 Canada Silver Maple Leaf Moose Reverse Proof', 'rcm.maple.moose.2017'],
  ])('recognizes a canonical 2017 Wild Canada title: %s', (title, markId) => {
    const context = {
      program: 'Canadian Silver Maple Leaf', year: 2017, metal: 'silver', weight: 1,
      denomination: 5, finish: 'Reverse Proof',
    };
    expect(detectMarksInTitle(title, context).map(mark => mark.markId)).toEqual([markId]);
  });

  test('grounds every Wild Canada runtime issue in issuer-authored series evidence', () => {
    const wildCanada = SPECIAL_MARKS.filter(mark => /^rcm\.sml\.201[678]\./.test(mark.issueId));
    expect(wildCanada).toHaveLength(6);
    expect(wildCanada.every(mark => mark.verificationStatus === 'issuer-authored-secondary-host')).toBe(true);
    expect(wildCanada.every(mark => mark.sourceReferences.some(source => source.includes('coinweek.com/royal-canadian-mint')))).toBe(true);
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
