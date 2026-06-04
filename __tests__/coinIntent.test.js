// __tests__/coinIntent.test.js -- #254 route-layer intent extraction
'use strict';

const { extractCoinIntent, FINISH_CANONICAL } = require('../src/utils/coinIntent');

describe('extractCoinIntent', () => {
  describe('grade', () => {
    test('coinData.grade takes precedence over parsed-from-text', () => {
      // The #254 headline bug: prior route code dropped coinData.grade
      // entirely (only read pcgs.grade || parsed.grade).
      const out = extractCoinIntent({
        coinData: { grade: 'MS-65' },
        parsed: { grade: 'MS-63' },
      });
      expect(out.grade).toBe('MS-65');
    });

    test('falls back to pcgs.grade then parsed.grade', () => {
      expect(extractCoinIntent({ pcgs: { grade: 'PR-69DCAM' } }).grade).toBe('PR-69DCAM');
      expect(extractCoinIntent({ parsed: { grade: 'MS-64' } }).grade).toBe('MS-64');
    });

    test('coinData.grade wins over a conflicting pcgs.grade (S4-#4)', () => {
      // User explicitly chose a grade -- never let a heuristic PCGS
      // lookup override the user's structured input.
      const out = extractCoinIntent({
        coinData: { grade: 'MS-65' },
        pcgs:     { grade: 'MS-63' },
        parsed:   { grade: 'MS-60' },
      });
      expect(out.grade).toBe('MS-65');
    });

    test('numeric grade is coerced to string (S4-#3)', () => {
      // Some API callers send grade as a number; downstream code does
      // grade.match(/\d+/) and would throw without coercion.
      const out = extractCoinIntent({ coinData: { grade: 65 } });
      expect(out.grade).toBe('65');
      expect(typeof out.grade).toBe('string');
    });

    test('isSet always nulls grade', () => {
      const out = extractCoinIntent({
        coinData: { grade: 'MS-65' },
        parsed: { grade: 'MS-63' },
        isSet: true,
      });
      expect(out.grade).toBeNull();
    });

    test('returns null when no source has a grade', () => {
      expect(extractCoinIntent({}).grade).toBeNull();
    });
  });

  describe('finish', () => {
    test('lowercase "proof" normalizes to "Proof"', () => {
      // Prior route code only matched literal 'Proof' (case-sensitive),
      // so coinData.finish: "proof" was silently dropped.
      const out = extractCoinIntent({ coinData: { finish: 'proof' } });
      expect(out.finish).toBe('Proof');
    });

    test('hyphenated reverse-proof variants normalize', () => {
      expect(extractCoinIntent({ coinData: { finish: 'reverse-proof' } }).finish).toBe('Reverse Proof');
      expect(extractCoinIntent({ coinData: { finish: 'enhanced reverse proof' } }).finish).toBe('Enhanced Reverse Proof');
      expect(extractCoinIntent({ coinData: { finish: 'matte-proof' } }).finish).toBe('Matte Proof');
    });

    test('non-proof finishes pass through canonical form', () => {
      expect(extractCoinIntent({ coinData: { finish: 'burnished' } }).finish).toBe('Burnished');
      expect(extractCoinIntent({ coinData: { finish: 'satin' } }).finish).toBe('Satin Finish');
      expect(extractCoinIntent({ coinData: { finish: 'antiqued' } }).finish).toBe('Antiqued');
    });

    test('unknown finishes pass through unchanged (no signal lost)', () => {
      const out = extractCoinIntent({ coinData: { finish: 'Specimen' } });
      expect(out.finish).toBe('Specimen');
    });

    test('empty / whitespace finish returns null', () => {
      expect(extractCoinIntent({ coinData: { finish: '' } }).finish).toBeNull();
      expect(extractCoinIntent({ coinData: { finish: '   ' } }).finish).toBeNull();
    });

    test('parsed.finish flows through when coinData.finish is absent (S4-#4)', () => {
      // Make sure the parser's read of the query text still feeds the
      // pipeline when structured input doesn't provide a finish.
      const out = extractCoinIntent({ parsed: { finish: 'proof' } });
      expect(out.finish).toBe('Proof');
      expect(out.isProof).toBe(true);
    });
  });

  describe('isProof', () => {
    test('explicit options.isProof:true sets isProof=true even with no finish', () => {
      // Prior route code never read options.isProof -- silently dropped.
      const out = extractCoinIntent({ options: { isProof: true } });
      expect(out.isProof).toBe(true);
    });

    test('string "true" for isProof is honored (S3-#1)', () => {
      // HTML forms and several JSON serializers emit the string "true".
      // We accept both to avoid resurrecting the silent-drop bug.
      expect(extractCoinIntent({ options:  { isProof: 'true' } }).isProof).toBe(true);
      expect(extractCoinIntent({ coinData: { isProof: 'true' } }).isProof).toBe(true);
    });

    test('other truthy values for isProof are NOT honored (avoid false positives)', () => {
      // Only explicit true / "true" should flip the flag; arbitrary
      // truthy values (e.g. an accidental "false" string) must not.
      expect(extractCoinIntent({ options:  { isProof: 'false' } }).isProof).toBe(false);
      expect(extractCoinIntent({ coinData: { isProof: 1 } }).isProof).toBe(false);
    });

    test('explicit coinData.isProof:true sets isProof=true', () => {
      expect(extractCoinIntent({ coinData: { isProof: true } }).isProof).toBe(true);
    });

    test('finish "Proof" sets isProof=true', () => {
      expect(extractCoinIntent({ coinData: { finish: 'Proof' } }).isProof).toBe(true);
    });

    test('lowercase finish "proof" sets isProof=true (was silently dropped)', () => {
      expect(extractCoinIntent({ coinData: { finish: 'proof' } }).isProof).toBe(true);
    });

    test('Reverse Proof / Enhanced Reverse Proof / Matte Proof all count as proof', () => {
      expect(extractCoinIntent({ coinData: { finish: 'Reverse Proof' } }).isProof).toBe(true);
      expect(extractCoinIntent({ coinData: { finish: 'enhanced reverse proof' } }).isProof).toBe(true);
      expect(extractCoinIntent({ coinData: { finish: 'matte proof' } }).isProof).toBe(true);
    });

    test('PR / PF grade prefix triggers isProof', () => {
      expect(extractCoinIntent({ coinData: { grade: 'PR-69DCAM' } }).isProof).toBe(true);
      expect(extractCoinIntent({ coinData: { grade: 'PF70' } }).isProof).toBe(true);
    });

    test('designation like "PR70" triggers isProof', () => {
      expect(extractCoinIntent({ coinData: { designation: 'PR70' } }).isProof).toBe(true);
    });

    test('parsed.grade === "Proof" triggers isProof', () => {
      expect(extractCoinIntent({ parsed: { grade: 'Proof' } }).isProof).toBe(true);
    });

    test('non-proof finish keeps isProof=false', () => {
      expect(extractCoinIntent({ coinData: { finish: 'Burnished' } }).isProof).toBe(false);
      expect(extractCoinIntent({ coinData: { finish: 'Satin Finish' } }).isProof).toBe(false);
      expect(extractCoinIntent({ coinData: { grade: 'MS-65' } }).isProof).toBe(false);
    });

    test('isSet forces isProof=false even when finish says Proof', () => {
      // Proof Set pricing uses a separate pool (the SET, not individual proofs).
      const out = extractCoinIntent({
        coinData: { finish: 'Proof' },
        isSet: true,
      });
      expect(out.isProof).toBe(false);
    });

    test('no signal returns isProof=false', () => {
      expect(extractCoinIntent({}).isProof).toBe(false);
    });
  });

  describe('designation', () => {
    test('pcgs.designation wins, then coinData, then parsed', () => {
      expect(extractCoinIntent({ pcgs: { designation: 'DCAM' }, coinData: { designation: 'CAM' } }).designation).toBe('DCAM');
      expect(extractCoinIntent({ coinData: { designation: 'CAM' } }).designation).toBe('CAM');
      expect(extractCoinIntent({ parsed: { designation: 'FS' } }).designation).toBe('FS');
    });

    test('coinData.designation is accepted (S3-#2: prior route code dropped it)', () => {
      // priceRoute's old expression was `pcgs.designation || parsed.designation`
      // -- coinData.designation was silently dropped.  The helper now
      // accepts it; this test guards against a future refactor undoing that.
      const out = extractCoinIntent({ coinData: { designation: 'CAM' } });
      expect(out.designation).toBe('CAM');
    });
  });

  describe('precedence interactions (the silent-drop regression matrix)', () => {
    test('headline regression: Morgan MS-65 via structured form alone', () => {
      // Reproduces the bug demonstrated in the route probe -- before #254
      // this returned grade=undefined and the pool flipped to raw.
      const out = extractCoinIntent({
        coinData: { name: 'Morgan Dollar', year: 1921, grade: 'MS-65' },
        parsed: { year: 1921, series: 'Morgan Dollar' },
      });
      expect(out.grade).toBe('MS-65');
      expect(out.isProof).toBe(false);
    });

    test('headline regression: Libertad proof via options.isProof', () => {
      // The exact payload shape an external API caller would likely send.
      const out = extractCoinIntent({
        coinData: { name: 'Mexican Silver Libertad', year: 2019 },
        options: { isProof: true },
        parsed: { year: 2019, series: 'Mexican Silver Libertad', metal: 'silver' },
      });
      expect(out.isProof).toBe(true);
    });

    test('headline regression: Libertad proof via lowercase finish', () => {
      const out = extractCoinIntent({
        coinData: { finish: 'proof' },
        parsed: { year: 2019, series: 'Mexican Silver Libertad' },
      });
      expect(out.isProof).toBe(true);
      expect(out.finish).toBe('Proof');
    });
  });

  describe('FINISH_CANONICAL export', () => {
    test('exports the canonical map for external reuse (UI dropdown source)', () => {
      expect(FINISH_CANONICAL.proof).toBe('Proof');
      expect(FINISH_CANONICAL['reverse proof']).toBe('Reverse Proof');
    });
  });
});
