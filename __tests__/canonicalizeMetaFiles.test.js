// __tests__/canonicalizeMetaFiles.test.js
// Smoke tests for scripts/canonicalize-meta-files.js (#246 PR A).
// Verifies the rewrite rules apply to the documented patterns and are
// idempotent (re-running over already-canonical files is a no-op).
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'canonicalize-meta-files.js');

// The script hardcodes META_DIR = '<repo>/data/terapeak'. For an isolated unit
// test we'd have to refactor it to accept an env var. To stay non-invasive,
// these tests verify idempotency on the real META_DIR (PR A has already
// applied the rewrites, so a dry-run must report 0 changes).
describe('canonicalize-meta-files.js (#246 PR A)', () => {
  test('dry-run on the repo .meta tree reports 0 pending changes (idempotent)', () => {
    const out = execFileSync('node', [SCRIPT, '--dry-run'], { encoding: 'utf8' });
    expect(out).toMatch(/Files to change:\s+0\b/);
  });

  test('rewrite rules apply to documented inputs (in-process verification)', () => {
    // Load the script's RULES by requiring a temp wrapper that re-exports them.
    // The script is a CLI (no exports), so we test the regex contracts directly.
    const cases = [
      { in: '1990 Great Britain 1 oz Gold Britannia',     out: '1990 British Gold Britannia 1oz' },
      { in: '1997 Great Britain 1 oz Silver Britannia',   out: '1997 British Silver Britannia 1oz' },
      { in: '2024 Great Britain 1oz Platinum Britannia',  out: '2024 British Platinum Britannia 1oz' },
      { in: '1967 South Africa 1 oz Gold Krugerrand',     out: '1967 Gold Krugerrand 1oz' },
      { in: '2005 South African 1 oz Gold Krugerrand',    out: '2005 Gold Krugerrand 1oz' },
      { in: 'Great Britain 1/2 oz Gold Britannia',        out: 'British Gold Britannia Half oz Generic' },
      { in: 'Great Britain 1/10 oz Silver Britannia',     out: 'British Silver Britannia Tenth oz Generic' },
      // Unchanged inputs (don't match any rule):
      { in: '1990 American Silver Eagle',                  out: '1990 American Silver Eagle' },
      { in: '2024 Australian Lunar Dragon Silver 1oz',     out: '2024 Australian Lunar Dragon Silver 1oz' },
    ];

    // Re-implement the rule application by reading the script source and
    // extracting the regex/replace pairs. Safer than execFile per-case.
    // Use a tmpdir of single-file fixtures and run the script with cwd swap.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-test-'));
    const dataDir = path.join(tmp, 'data', 'terapeak');
    fs.mkdirSync(dataDir, { recursive: true });

    // Copy the script into the temp repo and patch META_DIR to point at our fixture
    const scriptSrc = fs.readFileSync(SCRIPT, 'utf8');
    const patched = scriptSrc.replace(
      /const META_DIR = .*;/,
      `const META_DIR = ${JSON.stringify(dataDir)};`
    );
    const scriptCopy = path.join(tmp, 'canon.js');
    fs.writeFileSync(scriptCopy, patched);

    // Write fixtures
    cases.forEach((c, i) => {
      fs.writeFileSync(path.join(dataDir, `case${i}.meta`), c.in);
    });

    execFileSync('node', [scriptCopy], { encoding: 'utf8' });

    cases.forEach((c, i) => {
      const got = fs.readFileSync(path.join(dataDir, `case${i}.meta`), 'utf8');
      expect(got).toBe(c.out);
    });

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
