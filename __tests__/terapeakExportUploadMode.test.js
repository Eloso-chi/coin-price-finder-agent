/**
 * #251 -- Local vs Codespaces parity guard.
 *
 * Source-level contract test for scripts/terapeak-export.py. The exporter
 * must expose an explicit UPLOAD_MODE selector (api|blob|auto) defaulting to
 * `api`, must have a blob branch that does NOT fall back to the API, and the
 * surface loop wrapper must select UPLOAD_MODE deterministically based on
 * whether blob storage is configured (api when not, blob when both
 * TERAPEAK_BLOB_ACCOUNT and TERAPEAK_BLOB_CONTAINER are set) -- with
 * operator overrides honored.
 *
 * This is a static-source assertion, not a runtime test. We do not invoke
 * Python from the JS test runner -- the goal is to fail loudly if a future
 * refactor silently drops the explicit upload-mode contract.
 */

const fs = require('fs');
const path = require('path');

const EXPORT_SCRIPT = path.join(__dirname, '..', 'scripts', 'terapeak-export.py');
const LOOP_SCRIPT = path.join(__dirname, '..', 'scripts', 'run-surface-freshness-loop.sh');

describe('#251 UPLOAD_MODE contract (terapeak-export.py)', () => {
  let source;

  beforeAll(() => {
    source = fs.readFileSync(EXPORT_SCRIPT, 'utf8');
  });

  test('declares UPLOAD_MODE with api default', () => {
    expect(source).toMatch(/UPLOAD_MODE\s*=\s*os\.environ\.get\(\s*["']UPLOAD_MODE["']\s*,\s*["']api["']\s*\)/);
  });

  test('validates UPLOAD_MODE against api|blob|auto', () => {
    expect(source).toMatch(/UPLOAD_MODE\s+not\s+in\s*\(\s*["']api["']\s*,\s*["']blob["']\s*,\s*["']auto["']\s*\)/);
  });

  test('blob mode has no API fallback', () => {
    // Locate the blob branch and confirm it returns directly without falling
    // through to the API POST block.
    const blobBranchMatch = source.match(/if\s+UPLOAD_MODE\s*==\s*["']blob["'][\s\S]{0,1200}/);
    expect(blobBranchMatch).not.toBeNull();
    const blobBranch = blobBranchMatch[0];
    // The blob branch must reach a `return` before any /api/terapeak/import URL is built.
    const returnIdx = blobBranch.indexOf('return');
    const apiIdx = blobBranch.indexOf('/api/terapeak/import');
    expect(returnIdx).toBeGreaterThan(-1);
    // Either no api ref in branch, or return comes first.
    expect(apiIdx === -1 || returnIdx < apiIdx).toBe(true);
  });

  test('declares VERIFY_IMPORT switch', () => {
    expect(source).toMatch(/VERIFY_IMPORT\s*=\s*os\.environ\.get\(\s*["']VERIFY_IMPORT["']/);
  });
});

describe('#251 surface loop selects UPLOAD_MODE based on blob env presence', () => {
  let loop;

  beforeAll(() => {
    loop = fs.readFileSync(LOOP_SCRIPT, 'utf8');
  });

  test('uses api default when TERAPEAK_BLOB_ACCOUNT/CONTAINER are unset', () => {
    // The script must contain an explicit `UPLOAD_MODE=api` fallback inside
    // the env-detection branch.  Catches accidental removal of the safe
    // default for Codespace/local dev environments without blob configured.
    expect(loop).toMatch(/UPLOAD_MODE=api/);
  });

  test('uses blob default when TERAPEAK_BLOB_ACCOUNT/CONTAINER are both set', () => {
    // The script must select `blob` mode automatically when blob storage is
    // configured (Surface laptop path).  The check must require BOTH env
    // vars so a half-configured environment doesn't silently fall through.
    expect(loop).toMatch(/TERAPEAK_BLOB_ACCOUNT[\s\S]{0,80}TERAPEAK_BLOB_CONTAINER/);
    expect(loop).toMatch(/UPLOAD_MODE=blob/);
  });

  test('exports UPLOAD_MODE so child processes inherit it', () => {
    expect(loop).toMatch(/export\s+UPLOAD_MODE/);
  });

  test('respects operator override (env-var-set takes precedence over detection)', () => {
    // The detection block must be gated by `-z` / `:-` so a pre-set
    // UPLOAD_MODE is honored without re-derivation.  Catches accidental
    // unconditional reassignment that would clobber operator intent.
    expect(loop).toMatch(/\[\[\s*-z\s*"\$\{UPLOAD_MODE:-\}"/);
  });
});
