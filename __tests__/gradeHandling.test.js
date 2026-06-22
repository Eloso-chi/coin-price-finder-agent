/**
 * gradeHandling.test.js
 *
 * Tests for grade parsing (parseDescription) and grade-aware scoring
 * (scoreMatch) covering:
 *
 *   1. Formal grades: MS-65, PR69, PF-70, EF-40, AU58+
 *   2. EF→XF / PF→PR normalisation
 *   3. BU terms: BU, UNC, Choice BU, Gem BU, Superb Gem BU
 *   4. Word grades: About Uncirculated, Extremely Fine, Very Fine, etc.
 *   5. False-positive exclusions: "fine silver", "good condition"
 *   6. Priority: formal grade wins over BU/word grades
 *   7. scoreMatch — EF↔XF cross-credit
 *   8. scoreMatch — BU-term bonus
 *
 *   npm test -- __tests__/gradeHandling.test.js
 */

'use strict';

const { parseDescription }  = require('../src/services/pcgsService');
const { scoreMatch }        = require('../src/services/ebayService');

/* ═══════════════════════════════════════════════════════════════
 *  1. Formal grades — numeric prefix + number
 * ═══════════════════════════════════════════════════════════════ */
describe('parseDescription — formal grades', () => {

  const cases = [
    ['1881 S Morgan Dollar MS65',  'MS65',  65],
    ['1964 Kennedy Half MS-63',    'MS63',  63],
    ['2023 Silver Eagle PR70',     'PR70',  70],
    ['1955 Lincoln Cent AU58+',    'AU58+', 58],
    ['1916 D Mercury Dime VF20',   'VF20',  20],
    ['1909 S VDB Lincoln Cent G4', 'G4',    4],
    ['1876 CC Trade Dollar VG8',   'VG8',   8],
    ['1793 Chain Cent AG3',        'AG3',   3],
    ['1856 Flying Eagle Cent PO1', 'PO1',   1],
    ['2024 ASE SP70',              'SP70',  70],
    ['1942 Walking Liberty F12',   'F12',   12],
    ['1921 Morgan Dollar MS 60',   'MS60',  60],
  ];

  test.each(cases)('"%s" → grade=%s, gradeNum=%d', (q, grade, num) => {
    const p = parseDescription(q);
    expect(p.grade).toBe(grade);
    expect(p.gradeNum).toBe(num);
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  2. EF→XF and PF→PR normalisation
 * ═══════════════════════════════════════════════════════════════ */
describe('parseDescription — EF/PF normalisation', () => {

  test('EF-40 normalises to XF40', () => {
    const p = parseDescription('1916 Standing Liberty Quarter EF-40');
    expect(p.grade).toBe('XF40');
    expect(p.gradeNum).toBe(40);
  });

  test('EF45 normalises to XF45', () => {
    const p = parseDescription('1892 Barber Dime EF45');
    expect(p.grade).toBe('XF45');
  });

  test('PF65 normalises to PR65', () => {
    const p = parseDescription('1956 Franklin Half PF65');
    expect(p.grade).toBe('PR65');
    expect(p.gradeNum).toBe(65);
  });

  test('PF-69 normalises to PR69', () => {
    const p = parseDescription('2023 Silver Eagle PF-69');
    expect(p.grade).toBe('PR69');
  });

  test('XF40 stays XF40 (no double conversion)', () => {
    const p = parseDescription('1892 Barber Quarter XF40');
    expect(p.grade).toBe('XF40');
  });

  test('PR70 stays PR70', () => {
    const p = parseDescription('2024 Gold Eagle PR70');
    expect(p.grade).toBe('PR70');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  3. BU term mapping
 * ═══════════════════════════════════════════════════════════════ */
describe('parseDescription — BU terms', () => {

  test('BU → MS60', () => {
    const p = parseDescription('1964 Kennedy Half Dollar BU');
    expect(p.grade).toBe('MS60');
    expect(p.gradeNum).toBe(60);
    expect(p._gradeSource).toBe('bu-term');
  });

  test('UNC → MS60', () => {
    const p = parseDescription('1958 Lincoln Cent UNC');
    expect(p.grade).toBe('MS60');
    expect(p.gradeNum).toBe(60);
    expect(p._gradeSource).toBe('bu-term');
  });

  test('Choice BU → MS63', () => {
    const p = parseDescription('1881 S Morgan Dollar Choice BU');
    expect(p.grade).toBe('MS63');
    expect(p.gradeNum).toBe(63);
    expect(p._gradeSource).toBe('bu-term');
  });

  test('Gem BU → MS65', () => {
    const p = parseDescription('1923 Peace Dollar Gem BU');
    expect(p.grade).toBe('MS65');
    expect(p.gradeNum).toBe(65);
    expect(p._gradeSource).toBe('bu-term');
  });

  test('Superb Gem BU → MS67', () => {
    const p = parseDescription('2021 Morgan Dollar Superb Gem BU');
    expect(p.grade).toBe('MS67');
    expect(p.gradeNum).toBe(67);
    expect(p._gradeSource).toBe('bu-term');
  });

  test('BU terms are case-insensitive', () => {
    expect(parseDescription('1964 Half bu').grade).toBe('MS60');
    expect(parseDescription('1964 Half CHOICE BU').grade).toBe('MS63');
    expect(parseDescription('1964 Half gem bu').grade).toBe('MS65');
    expect(parseDescription('1964 Half SUPERB GEM BU').grade).toBe('MS67');
  });

  test('_gradeSource is absent for formal grades', () => {
    const p = parseDescription('1964 Kennedy Half MS65');
    expect(p._gradeSource).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  4. Word grade mapping
 * ═══════════════════════════════════════════════════════════════ */
describe('parseDescription — word grades', () => {

  const cases = [
    ['1892 Barber Dime About Uncirculated', 'AU50', 50, 'word-grade'],
    ['1916 Standing Liberty Quarter Extremely Fine', 'XF40', 40, 'word-grade'],
    ['1921 Morgan Dollar Very Fine', 'VF20', 20, 'word-grade'],
    ['1913 Liberty Nickel Very Good', 'VG8', 8, 'word-grade'],
    ['1909 S VDB Lincoln Cent Fine',  'F12', 12, 'word-grade'],
    ['1859 Indian Head Cent Good',    'G4',  4,  'word-grade'],
    ['1793 Chain Cent Poor',          'PO1', 1,  'word-grade'],
  ];

  test.each(cases)('"%s" → grade=%s, gradeNum=%d', (q, grade, num, source) => {
    const p = parseDescription(q);
    expect(p.grade).toBe(grade);
    expect(p.gradeNum).toBe(num);
    expect(p._gradeSource).toBe(source);
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  5. False-positive exclusions
 * ═══════════════════════════════════════════════════════════════ */
describe('parseDescription — word-grade exclusions', () => {

  test('"1 oz Fine Silver Eagle" does NOT parse as Fine', () => {
    const p = parseDescription('2023 1 oz Fine Silver Eagle');
    // Should not have grade "F12"
    expect(p.grade).not.toBe('F12');
    expect(p._gradeSource).not.toBe('word-grade');
  });

  test('"Good condition" does NOT parse as Good', () => {
    const p = parseDescription('1964 Kennedy Half Good condition');
    expect(p.grade).not.toBe('G4');
  });

  test('"Good luck" does NOT parse as Good', () => {
    const p = parseDescription('1964 Kennedy Half Good luck coin');
    expect(p.grade).not.toBe('G4');
  });

  test('"Good deal" does NOT parse as Good', () => {
    const p = parseDescription('1964 Kennedy Half Good deal');
    expect(p.grade).not.toBe('G4');
  });

  test('"Good quality" does NOT parse as Good', () => {
    const p = parseDescription('1964 Kennedy Half Good quality');
    expect(p.grade).not.toBe('G4');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  6. Priority: formal grade wins over BU/word grades
 * ═══════════════════════════════════════════════════════════════ */
describe('parseDescription — grade priority', () => {

  test('MS-65 BU → grade is MS65 (formal wins over BU)', () => {
    const p = parseDescription('1881 S Morgan Dollar MS-65 BU');
    expect(p.grade).toBe('MS65');
    expect(p.gradeNum).toBe(65);
    expect(p._gradeSource).toBeUndefined();  // formal → no _gradeSource
  });

  test('MS63 Choice BU → grade is MS63 (formal wins)', () => {
    const p = parseDescription('1923 Peace Dollar MS63 Choice BU');
    expect(p.grade).toBe('MS63');
    expect(p._gradeSource).toBeUndefined();
  });

  test('VF20 Very Fine → grade is VF20 (formal wins over word)', () => {
    const p = parseDescription('1892 Barber Quarter VF20 Very Fine');
    expect(p.grade).toBe('VF20');
    expect(p._gradeSource).toBeUndefined();
  });

  test('No grade → no grade field', () => {
    const p = parseDescription('1964 Kennedy Half Dollar');
    expect(p.grade).toBeUndefined();
    expect(p._gradeSource).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  7. scoreMatch — EF↔XF cross-credit
 * ═══════════════════════════════════════════════════════════════ */
describe('scoreMatch — EF↔XF cross-credit', () => {

  test('expected XF40, comp title has "EF40" → grade-exact credit', () => {
    const comp = { title: '1892 Barber Dime EF40', price: 50 };
    scoreMatch(comp, { grade: 'XF40', year: 1892 });
    expect(comp.matchNotes).toContain('grade-exact');
  });

  test('expected XF45, comp title has "XF45" → grade-exact credit', () => {
    const comp = { title: '1892 Barber Dime XF45', price: 50 };
    scoreMatch(comp, { grade: 'XF45', year: 1892 });
    expect(comp.matchNotes).toContain('grade-exact');
  });

  test('expected XF40, comp title has "VF20" → no grade-exact', () => {
    const comp = { title: '1892 Barber Dime VF20', price: 30 };
    scoreMatch(comp, { grade: 'XF40', year: 1892 });
    expect(comp.matchNotes).not.toContain('grade-exact');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  8. scoreMatch — BU-term bonus
 * ═══════════════════════════════════════════════════════════════ */
describe('scoreMatch — BU-term bonus', () => {

  test('_gradeSource bu-term + comp has "BU" → bu-match bonus', () => {
    const comp = { title: '1964 Kennedy Half Dollar BU', price: 10 };
    scoreMatch(comp, { grade: 'MS60', _gradeSource: 'bu-term', year: 1964 });
    expect(comp.matchNotes).toContain('bu-match');
  });

  test('_gradeSource bu-term + comp has "Uncirculated" → bu-match bonus', () => {
    const comp = { title: '1964 Kennedy Half Dollar Uncirculated', price: 10 };
    scoreMatch(comp, { grade: 'MS60', _gradeSource: 'bu-term', year: 1964 });
    expect(comp.matchNotes).toContain('bu-match');
  });

  test('_gradeSource bu-term + comp has "Brilliant" → bu-match bonus', () => {
    const comp = { title: '1964 Kennedy Half Dollar Brilliant Uncirculated', price: 10 };
    scoreMatch(comp, { grade: 'MS60', _gradeSource: 'bu-term', year: 1964 });
    expect(comp.matchNotes).toContain('bu-match');
  });

  test('_gradeSource bu-term + comp has only "Fine" → no bu-match', () => {
    const comp = { title: '1964 Kennedy Half Dollar Fine', price: 5 };
    scoreMatch(comp, { grade: 'MS60', _gradeSource: 'bu-term', year: 1964 });
    expect(comp.matchNotes).not.toContain('bu-match');
  });

  test('formal grade (no _gradeSource) + comp has "BU" → no bu-match', () => {
    const comp = { title: '1964 Kennedy Half Dollar BU', price: 10 };
    scoreMatch(comp, { grade: 'MS65', year: 1964 });
    expect(comp.matchNotes).not.toContain('bu-match');
  });

  test('grade MS60 without _gradeSource → no bu-match even with BU comp', () => {
    // grade alone (ms60) doesn't contain "bu" or "unc",
    // and _gradeSource is not set → skip BU-term matching
    const comp = { title: '1964 Kennedy Half Dollar BU', price: 10 };
    scoreMatch(comp, { grade: 'MS60', year: 1964 });
    expect(comp.matchNotes).not.toContain('bu-match');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  9. Edge cases
 * ═══════════════════════════════════════════════════════════════ */
describe('parseDescription — edge cases', () => {

  test('Mixed case "choice bu" → MS63', () => {
    const p = parseDescription('1881 S Morgan Dollar choice bu');
    expect(p.grade).toBe('MS63');
  });

  test('"About Uncirculated" as two words → AU50', () => {
    const p = parseDescription('1892 Barber Quarter About Uncirculated');
    expect(p.grade).toBe('AU50');
    expect(p._gradeSource).toBe('word-grade');
  });

  test('"Extremely Fine" → XF40 (not EF40)', () => {
    // word grade maps to XF40 directly
    const p = parseDescription('1916 Standing Liberty Extremely Fine');
    expect(p.grade).toBe('XF40');
  });

  test('AU58+ preserves plus sign', () => {
    const p = parseDescription('1892 O Morgan Dollar AU58+');
    expect(p.grade).toBe('AU58+');
    expect(p.gradeNum).toBe(58);
  });

  test('No grade at all returns undefined grade', () => {
    const p = parseDescription('1964 Kennedy Half Dollar');
    expect(p.grade).toBeUndefined();
    expect(p.gradeNum).toBeUndefined();
  });

  test('"Poor" alone → PO1', () => {
    const p = parseDescription('1793 Large Cent Poor');
    expect(p.grade).toBe('PO1');
    expect(p.gradeNum).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  Finish / special strike detection — parseDescription
 * ═══════════════════════════════════════════════════════════════ */
describe('parseDescription — finish detection', () => {

  test.each([
    ['2023 American Silver Eagle Enhanced Reverse Proof', 'Enhanced Reverse Proof'],
    ['2021 American Silver Eagle Reverse Proof',         'Reverse Proof'],
    ['2015 American Silver Eagle Burnished',             'Burnished'],
    ['2005 American Silver Eagle Satin Finish',          'Satin Finish'],
    ['2022 Libertad 1 oz Silver Antiqued',               'Antiqued'],
    ['2009 Ultra High Relief Gold Double Eagle',         'High Relief'],
    ['2024 Kookaburra 1 oz Silver Colorized',            'Colorized'],
    ['2024 Britannia 1 oz Silver Coloured',              'Colorized'],
  ])('%s → finish=%s', (query, expectedFinish) => {
    const p = parseDescription(query);
    expect(p.finish).toBe(expectedFinish);
  });

  test('finish "Reverse Proof" prevents "Proof" grade assignment', () => {
    const p = parseDescription('2021 Morgan Dollar Reverse Proof');
    expect(p.finish).toBe('Reverse Proof');
    expect(p.grade).not.toBe('Proof');
  });

  test('finish "Enhanced Reverse Proof" takes priority over "Reverse Proof"', () => {
    const p = parseDescription('2019 American Silver Eagle Enhanced Reverse Proof');
    expect(p.finish).toBe('Enhanced Reverse Proof');
  });

  test('BU coin without finish keywords has no finish', () => {
    const p = parseDescription('2024 American Silver Eagle');
    expect(p.finish).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  Designation extraction — parseDescription
 * ═══════════════════════════════════════════════════════════════ */
describe('parseDescription — designation extraction', () => {

  test.each([
    ['1963 Franklin Half Dollar PR67 DCAM', 'DCAM'],
    ['1963 Franklin Half Dollar PR67 CAM',  'CAM'],
    ['1881-S Morgan Dollar MS65 PL',        'PL'],
    ['1884-CC Morgan Dollar MS63 DPL',      'DPL'],
    ['1945 Mercury Dime MS67 FB',           'FB'],
    ['1942 Walking Liberty Half MS65 FBL',  'FBL'],
    ['2020 Standing Liberty Quarter MS67 FS','FS'],
    ['1916-D Mercury Dime MS65 FH',         'FH'],
    ['1909 S VDB Lincoln Cent MS65 RD',     'RD'],
    ['1909 VDB Lincoln Cent MS64 RB',       'RB'],
    ['1864 Indian Head Cent MS63 BN',       'BN'],
  ])('%s → designation=%s', (query, expectedDes) => {
    const p = parseDescription(query);
    expect(p.designation).toBe(expectedDes);
  });

  test('no designation when not present', () => {
    const p = parseDescription('1921 Morgan Dollar MS65');
    expect(p.designation).toBeFalsy();
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  Standalone "Proof" keyword → finish + grade
 * ═══════════════════════════════════════════════════════════════ */
describe('parseDescription — standalone Proof keyword', () => {

  test('"Proof" without grade or finish sets finish=Proof and grade=Proof', () => {
    const p = parseDescription('2024 Silver Eagle Proof');
    expect(p.finish).toBe('Proof');
    expect(p.grade).toBe('Proof');
  });

  test('"Proof Set" does NOT set finish=Proof (it sets series/setType)', () => {
    const p = parseDescription('2024 US Proof Set');
    expect(p.setType).toBeDefined();
    expect(p.finish).not.toBe('Proof');
  });

  test('"Proof" with explicit grade PF69 does NOT override the grade', () => {
    const p = parseDescription('2024 Silver Eagle Proof PF69');
    expect(p.grade).toBe('PR69');
    expect(p.gradeNum).toBe(69);
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  scoreMatch — finish-aware scoring
 * ═══════════════════════════════════════════════════════════════ */
describe('scoreMatch — finish-aware variant scoring', () => {

  test('Reverse Proof comp penalized when query is plain BU', () => {
    const comp = { title: '2021 American Silver Eagle Reverse Proof', totalUsd: 80, matchScore: 70 };
    const expected = { year: 2021, series: 'American Silver Eagle', _rawQuery: '2021 American Silver Eagle' };
    scoreMatch(comp, expected);
    // Post-#277H tag taxonomy (see src/services/ebayService.js L637/L720):
    //   `variant-mismatch`            -- emitted ONLY for colorized titles
    //                                    on a non-colorized query (-30).
    //   `variant-specialty-mismatch`  -- emitted for non-colorized specialty
    //                                    variants on a non-colorized query (-20).
    //   `proof-mismatch-unwanted-proof` -- emitted when title is in the proof
    //                                    family and the user did not ask for
    //                                    proof (-25).
    // A Reverse Proof comp on a plain-BU query is both a proof-family title
    // and a non-colorized specialty variant, so both penalty notes fire.
    expect(comp.matchNotes).toContain('proof-mismatch-unwanted-proof');
    expect(comp.matchNotes).toContain('variant-specialty-mismatch');
  });

  test('Burnished comp penalized when query is plain BU', () => {
    const comp = { title: '2015 American Silver Eagle Burnished W Mint', totalUsd: 60, matchScore: 70 };
    const expected = { year: 2015, series: 'American Silver Eagle', _rawQuery: '2015 American Silver Eagle' };
    scoreMatch(comp, expected);
    // Post-#277H: Burnished is not in the proof family, so only the generic
    // specialty-variant penalty fires (not proof-mismatch).
    expect(comp.matchNotes).toContain('variant-specialty-mismatch');
  });

  test('Reverse Proof comp NOT penalized when query asks for Reverse Proof', () => {
    const comp = { title: '2021 American Silver Eagle Reverse Proof', totalUsd: 80, matchScore: 70 };
    const expected = { year: 2021, series: 'American Silver Eagle', finish: 'Reverse Proof', _rawQuery: '2021 American Silver Eagle Reverse Proof' };
    scoreMatch(comp, expected);
    // Post-#277H: `variant-mismatch` is reserved for colorized-only and is
    // never emitted in this flow.  Original assertion preserved.
    // TODO(#173): scoreMatch's `userWantsProof` detector currently treats
    // finish='Reverse Proof' as NOT-wanting-proof (exact-match against the
    // literal 'Proof' at src/services/ebayService.js L636), so this comp
    // still accrues `proof-mismatch-unwanted-proof` and `variant-specialty-mismatch`
    // even when the user asked for Reverse Proof.  When #173 lands, the
    // negative assertion below should be strengthened to also check those
    // two tags are absent.
    expect(comp.matchNotes || []).not.toContain('variant-mismatch');
  });
});
