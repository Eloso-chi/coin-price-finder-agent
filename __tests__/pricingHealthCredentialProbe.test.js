'use strict';

/**
 * #276H -- tests for the credential pre-flight probe in
 * scripts/pricing-health-full.js
 *
 * Source-invariant tests that verify the structural commitments of the
 * change (probe presence, exit code distinction, escape hatch wiring,
 * regex patterns for eBay + PCGS missing-credential signals).
 *
 * Why source-invariant only:
 * - The probe makes one HTTP call to /api/price; mocking that requires a
 *   stub server, and spawning the script via child_process.spawnSync
 *   against a stub hangs in this environment (open-handle / Windows pipe
 *   issue, surfaced 2026-06-16). Source invariants give us the same
 *   regression surface (a refactor that breaks any of these patterns will
 *   silently break operator-facing behavior) without the harness fragility.
 * - The probe was manually verified against an empty .env on 2026-06-16 --
 *   the verification transcript is in commit 4255e2d body.
 * - If the regex strings, ordering, or exit codes are ever changed, these
 *   tests break loudly and force the author to confirm the probe still
 *   does what its docstring claims.
 */

const path = require('path');
const fs = require('fs');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'pricing-health-full.js');

describe('pricing-health-full.js -- credential pre-flight probe (#276H)', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');

  test('probe block is present and tagged with #276H', () => {
    expect(src).toMatch(/#276H/);
    expect(src).toMatch(/CREDENTIALS MISSING/);
  });

  test('probe exits with code 2 (distinct from code 1 = server-down)', () => {
    // Two `process.exit(2)` paths in the probe block:
    //   1) explicit "creds missing" branch
    //   2) catch-all "probe call itself failed" branch
    // Both must use code 2 so operators can distinguish "server unreachable"
    // (the existing exit 1 above) from "creds missing" (this change).
    const exitTwoCount = (src.match(/process\.exit\(2\)/g) || []).length;
    expect(exitTwoCount).toBeGreaterThanOrEqual(2);

    // The pre-existing server-down path must still use exit(1) -- guard
    // against an accidental rewrite that collapses the two codes.
    expect(src).toMatch(/Server not responding[\s\S]+?process\.exit\(1\)/);
  });

  test('honors --skip-credential-check escape hatch', () => {
    expect(src).toMatch(/--skip-credential-check/);
    // Must be guarded by an args.includes() check so the probe is
    // genuinely bypassed, not just suppressed in the output.
    expect(src).toMatch(/args\.includes\(['"]--skip-credential-check['"]\)/);
  });

  test('matches both eBay and PCGS missing-credential signals (case-insensitive)', () => {
    // eBay path: probe.ebay.{us,global}.error.message regex covers the
    // explicit "credentials not configured" message plus the env-var names
    // so a server that surfaces them in error.message still trips the probe.
    expect(src).toMatch(/credentials not configured\|EBAY_APP_ID\|EBAY_CLIENT_SECRET/);
    // PCGS path: probe.pcgs.limitations[] regex.
    expect(src).toMatch(/api key not configured\|PCGS_API_KEY/);

    // Both checks must be case-insensitive so future server message
    // capitalization changes don't silently break detection.
    const ebayRegex = src.match(/\/credentials not configured\|EBAY_APP_ID\|EBAY_CLIENT_SECRET\/([gimsuy]*)/);
    const pcgsRegex = src.match(/\/api key not configured\|PCGS_API_KEY\/([gimsuy]*)/);
    expect(ebayRegex).not.toBeNull();
    expect(pcgsRegex).not.toBeNull();
    expect(ebayRegex[1]).toMatch(/i/);
    expect(pcgsRegex[1]).toMatch(/i/);
  });

  test('probe runs BEFORE the dataset list is fetched', () => {
    // Critical ordering invariant: if /api/terapeak/datasets were called
    // before the probe, an env with missing creds would still burn the
    // dataset-list call. Verify the probe block sits between the
    // /api/health check and the dataset-list fetch in source order.
    //
    // /api/terapeak/datasets also appears in the ADMIN_PATH_PREFIXES table
    // at the top of the file -- match the actual call site (a GET
    // invocation), not the prefix-list mention.
    const healthIdx = src.indexOf("'GET', '/api/health'");
    const probeIdx = src.indexOf('CREDENTIALS MISSING');
    const datasetsCallIdx = src.indexOf("'GET', '/api/terapeak/datasets'");
    expect(healthIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeGreaterThan(-1);
    expect(datasetsCallIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeGreaterThan(healthIdx);
    expect(datasetsCallIdx).toBeGreaterThan(probeIdx);
  });

  test('script remains syntactically valid Node after the probe addition', () => {
    // Cheap smoke test: `node --check` parses the file without execution.
    // Catches a syntax regression introduced by future edits to the probe.
    const { spawnSync } = require('child_process');
    const res = spawnSync(process.execPath, ['--check', SCRIPT_PATH], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });
});

describe('pricing-health-full.js -- ADMIN_API_KEY hard-fail (#262W)', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');

  test('hard-fail block is present and tagged with #262W', () => {
    expect(src).toMatch(/#262W/);
    expect(src).toMatch(/ADMIN_API_KEY REQUIRED/);
  });

  test('exits with code 3 (distinct from server-down=1 and creds-missing=2)', () => {
    // The new hard-fail must use exit(3) so operators can distinguish
    // "missing admin key" from the pre-existing exit codes 1 and 2.
    expect(src).toMatch(/process\.exit\(3\)/);
  });

  test('fires only for modes that hit /api/terapeak/datasets', () => {
    // Default-sample mode (no flags) must NOT require ADMIN_API_KEY --
    // it works against a fresh dev environment. The guard must check
    // isFullRun / limit / filter, all of which trigger the dataset fetch.
    expect(src).toMatch(/needsAdminKey\s*=\s*isFullRun\s*\|\|\s*limit\s*\|\|\s*filter/);
  });

  test('hard-fail runs BEFORE the /api/health call', () => {
    // Ordering invariant: the ADMIN_API_KEY check is the cheapest
    // pre-flight (no network). It must run first so an operator who
    // forgot the env var sees the actionable error immediately,
    // without waiting for HTTP timeouts when the server is also down.
    const adminGuardIdx = src.indexOf('ADMIN_API_KEY REQUIRED');
    const healthIdx = src.indexOf("'GET', '/api/health'");
    expect(adminGuardIdx).toBeGreaterThan(-1);
    expect(healthIdx).toBeGreaterThan(-1);
    expect(adminGuardIdx).toBeLessThan(healthIdx);
  });
});

describe('pricing-health-full.js -- #262W classifier wiring', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');

  test('imports the three new classifier helpers from scripts/lib/', () => {
    expect(src).toMatch(/require\(['"]\.\/lib\/pricingHealthClassifiers['"]\)/);
    expect(src).toMatch(/classifyRpMeltFloor/);
    expect(src).toMatch(/classifyDealerPremium/);
    expect(src).toMatch(/findFractionalCollisions/);
  });

  test('captures valuation.spotPrice into result.discovery (dealer-premium input)', () => {
    // Without spotPrice in the captured shape, classifyDealerPremium
    // fail-quiets on every coin. This is the actual dependency, not a
    // cosmetic field, so pin its presence.
    expect(src).toMatch(/spotPrice:\s*typeof v\.spotPrice/);
  });

  test('invokes the fractional-collision post-pass over results', () => {
    // Must run AFTER parallelMap (cross-row analysis), not inside testCoin.
    const mapIdx = src.indexOf('parallelMap(coins');
    const collisionIdx = src.indexOf('findFractionalCollisions(results)');
    expect(mapIdx).toBeGreaterThan(-1);
    expect(collisionIdx).toBeGreaterThan(mapIdx);
  });
});
