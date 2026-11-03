'use strict';

/**
 * #265W -- tracked source must not carry hardcoded credential fallbacks.
 *
 * A literal default such as `process.env.X_KEY || '<value>'` turns local
 * convenience into a permanent leak (git history keeps the value). These tests
 * pin the removal from scripts/bar-pricing-health.js and fail on any new
 * key/token/secret/password fallback with a literal of 12+ characters.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const JS_FALLBACK_RE = /\b[A-Za-z_.]*(?:KEY|TOKEN|SECRET|PASSWORD)\w*['"\]]*\s*(?:\|\||\?\?)\s*(?:[\w.[\]'"]+\s*(?:\|\||\?\?)\s*)*(['"`])([^'"`$]{12,})\1/i;
const PY_DEFAULT_RE = /environ\.get\(\s*['"][A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z_]*['"]\s*,\s*['"]([^'"]{12,})['"]/i;

function listFiles(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function findFallbacks(file) {
  const hits = [];
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (JS_FALLBACK_RE.test(line) || PY_DEFAULT_RE.test(line)) {
      hits.push(`${path.relative(ROOT, file)}:${i + 1}`);
    }
  });
  return hits;
}

describe('no hardcoded credential fallbacks (#265W)', () => {
  test('detector flags literal fallbacks and ignores benign defaults', () => {
    const flagged = [
      "const API_KEY = process.env.ADMIN_API_KEY || 'abcdefghijklmnop';",
      'const t = process.env.SERVICE_TOKEN ?? "abcdefghijkl";',
      'k = os.environ.get("ADMIN_API_KEY", "abcdefghijkl")',
      "const a = process.env['ADMIN_API_KEY'] || 'abcdefghijklmnop';",
      "const b = process.env.PRIMARY_KEY || process.env.BACKUP_KEY || 'abcdefghijklmnop';",
    ];
    const benign = [
      "const API_KEY = process.env.ADMIN_API_KEY || '';",
      "title=\"Key date: \" + (cell.keyDateTier || 'notable')",
      'const API_KEY = process.env.ADMIN_API_KEY;',
      "const v = process.env.KEYVAULT_NAME || `${base}-vault-name-long`;",
      "const c = process.env.PRIMARY_KEY || process.env.BACKUP_KEY || '';",
    ];
    for (const line of flagged) {
      expect(JS_FALLBACK_RE.test(line) || PY_DEFAULT_RE.test(line)).toBe(true);
    }
    for (const line of benign) {
      expect(JS_FALLBACK_RE.test(line) || PY_DEFAULT_RE.test(line)).toBe(false);
    }
  });

  test('scripts, src, public/js, server.js and greysheet.js contain no such fallback', () => {
    const files = [
      ...listFiles(path.join(ROOT, 'scripts'), ['.js', '.cjs', '.mjs', '.py']),
      ...listFiles(path.join(ROOT, 'src'), ['.js', '.cjs', '.mjs']),
      ...listFiles(path.join(ROOT, 'public', 'js'), ['.js']),
      path.join(ROOT, 'server.js'),
      path.join(ROOT, 'greysheet.js'),
    ];
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap(findFallbacks);
    expect(hits).toEqual([]);
  });

  test('bar-pricing-health.js reads ADMIN_API_KEY from the environment only', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'bar-pricing-health.js'), 'utf8');
    expect(src).toMatch(/const API_KEY = process\.env\.ADMIN_API_KEY;/);
    expect(src).not.toMatch(/ADMIN_API_KEY\s*\|\|/);
  });

  test('bar-pricing-health.js exits 3 with a clear message when ADMIN_API_KEY is unset', () => {
    const env = { ...process.env };
    delete env.ADMIN_API_KEY;
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bar-pricing-health.js')], {
      env,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('ADMIN_API_KEY is required');
    expect(result.stdout).toBe('');
  }, 20000);
});
