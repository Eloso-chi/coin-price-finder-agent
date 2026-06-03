/**
 * #251 -- Local vs Codespaces parity guard.
 *
 * Source-level contract test for scripts/terapeak-export.py. The exporter
 * must expose an explicit UPLOAD_MODE selector (api|blob|auto) defaulting to
 * `api`, must have a blob branch that does NOT fall back to the API, and the
 * surface loop wrapper must default UPLOAD_MODE to `api`.
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

describe('#251 surface loop defaults UPLOAD_MODE to api', () => {
  test('run-surface-freshness-loop.sh sets UPLOAD_MODE default to api', () => {
    const loop = fs.readFileSync(LOOP_SCRIPT, 'utf8');
    // Parameter-expansion default assignment: ${UPLOAD_MODE:=api}
    expect(loop).toMatch(/\$\{\s*UPLOAD_MODE\s*:?=\s*api\s*\}/);
    expect(loop).toMatch(/export\s+UPLOAD_MODE/);
  });
});
