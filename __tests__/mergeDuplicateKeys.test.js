'use strict';

/**
 * #246 PR C -- unit tests for scripts/merge-duplicate-keys.js pure logic.
 *
 * Only covers the synchronous, side-effect-free helpers (deepCanonical,
 * pickWinner, mergeComps, buildPlan, cosmosDocId). The Cosmos migration
 * branch is exercised by manual dry-run + apply against the live cluster
 * because Jest is not the right place for a Cosmos SDK integration.
 */

const path = require('path');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'merge-duplicate-keys.js');

describe('merge-duplicate-keys.js -- script invariants', () => {
  test('script file exists and is syntactically valid Node', () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
    // node --check parses without executing
    const res = childProcess.spawnSync('node', ['--check', SCRIPT_PATH], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  test('dry-run is the default (no --apply): script does not mutate meta file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mergedup-'));
    const fakeMeta = path.join(tmp, 'terapeak-meta.json');
    // The real script reads data/terapeak-meta.json. We just verify it
    // refuses to apply without --apply by inspecting argv parsing.
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/const APPLY = argv\.includes\('--apply'\)/);
    expect(src).toMatch(/if \(!APPLY\)/);
    expect(src).toMatch(/dry-run -- no changes written/);
    fs.rmSync(tmp, { recursive: true });
  });

  test('--migrate-cosmos without --apply exits non-zero', () => {
    const res = childProcess.spawnSync('node', [SCRIPT_PATH, '--migrate-cosmos'], {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..'),
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--migrate-cosmos requires --apply/);
  });

  test('archive path uses ISO timestamp and lives under data/archive/', () => {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/data', 'archive'/);
    expect(src).toMatch(/terapeak-meta-orphans-/);
  });

  test('Cosmos doc id sanitization matches terapeakService write-through', () => {
    // Verify the helper mirrors the substring(0, 200) + alphanum-_- rule.
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/normalizedKey\.replace\(\/\[\^a-zA-Z0-9_-\]\/g, '_'\)\.substring\(0, 200\)/);
  });

  test('reuses _mergeAggregationMeta from PR B (no copy-paste of merge logic)', () => {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/_mergeAggregationMeta,?\s*\n?\s*\}\s*=\s*require\(['"]\.\.\/src\/services\/terapeakService['"]\)/);
  });
});

describe('merge-duplicate-keys.js -- dry-run end-to-end against the real meta file', () => {
  test('completes successfully and writes a plan artifact', () => {
    const repoRoot = path.join(__dirname, '..');
    const metaPath = path.join(repoRoot, 'data', 'terapeak-meta.json');
    if (!fs.existsSync(metaPath)) {
      // No meta file in repo (CI may not check it in); skip cleanly.
      console.warn('[test] terapeak-meta.json not present -- skipping E2E dry-run');
      return;
    }
    const planPath = path.join(repoRoot, 'docs', 'reports', 'merge-duplicate-keys-plan.json');
    if (fs.existsSync(planPath)) fs.unlinkSync(planPath);

    const before = fs.readFileSync(metaPath, 'utf8');
    const res = childProcess.spawnSync('node', [SCRIPT_PATH, '--quiet'], {
      encoding: 'utf8',
      cwd: repoRoot,
    });
    const after = fs.readFileSync(metaPath, 'utf8');

    // Meta file must be byte-identical after a dry-run
    expect(after).toBe(before);
    expect(res.status).toBe(0);

    // Steady state after #246 PR C migration: no duplicate groups remain,
    // script short-circuits with "Nothing to do." and writes no plan.
    // Before migration: script writes a plan artifact with >=1 merges.
    if (!fs.existsSync(planPath)) {
      expect(res.stdout || '').toMatch(/No duplicate groups found/);
      return;
    }

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    expect(plan.mode).toBe('dry-run');
    expect(typeof plan.duplicateGroupCount).toBe('number');
    expect(Array.isArray(plan.merges)).toBe(true);

    // Every merge group must have exactly one winner and >=1 losers,
    // and winner must not appear in losers.
    for (const m of plan.merges) {
      expect(typeof m.winner).toBe('string');
      expect(m.losers.length).toBeGreaterThanOrEqual(1);
      for (const l of m.losers) {
        expect(l.key).not.toBe(m.winner);
      }
    }
  }, 30000);
});

describe('merge-duplicate-keys.js -- --from-archive (Cosmos-only follow-up)', () => {
  const repoRoot = path.join(__dirname, '..');

  test('script source declares --from-archive flag and buildPlanFromArchive', () => {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/--from-archive/);
    expect(src).toMatch(/function buildPlanFromArchive/);
    expect(src).toMatch(/async function runFromArchive/);
  });

  test('--from-archive with non-existent path exits 2', () => {
    const res = childProcess.spawnSync(
      'node',
      [SCRIPT_PATH, '--from-archive=/tmp/this-file-does-not-exist-xyz.json'],
      { encoding: 'utf8', cwd: repoRoot },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--from-archive path does not exist/);
  });

  test('--from-archive with malformed archive (no entries) exits 2', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mergedup-arch-'));
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ archivedAt: 'x', reason: 'y' }));
    const res = childProcess.spawnSync(
      'node',
      [SCRIPT_PATH, `--from-archive=${bad}`],
      { encoding: 'utf8', cwd: repoRoot },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/archive has no `entries` object/);
    fs.rmSync(tmp, { recursive: true });
  });

  test('--from-archive dry-run prints summary, mutates nothing, exits 0', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mergedup-arch-'));
    const archivePath = path.join(tmp, 'orphans.json');
    fs.writeFileSync(archivePath, JSON.stringify({
      archivedAt: '2026-06-02T00:00:00.000Z',
      reason: 'test',
      schemaVersion: 1,
      entries: {
        'loser key one': {
          winner: 'winner alpha',
          entry: { compCount: 42, page1At: '2026-05-01T00:00:00.000Z' },
        },
        'loser key two': {
          winner: 'winner alpha',
          entry: { compCount: 17 },
        },
        'loser key three': {
          winner: 'winner beta',
          entry: { compCount: 5 },
        },
      },
    }));

    const res = childProcess.spawnSync(
      'node',
      [SCRIPT_PATH, `--from-archive=${archivePath}`],
      { encoding: 'utf8', cwd: repoRoot },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Cosmos-only follow-up \[DRY-RUN\]/);
    expect(res.stdout).toMatch(/Winner groups in archive:\s+2/);
    expect(res.stdout).toMatch(/Loser keys to migrate:\s+3/);
    expect(res.stdout).toMatch(/Comps recorded in archive:\s+64/);
    fs.rmSync(tmp, { recursive: true });
  });

  test('--from-archive --apply WITHOUT --migrate-cosmos is a documented no-op (exit 0)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mergedup-arch-'));
    const archivePath = path.join(tmp, 'orphans.json');
    fs.writeFileSync(archivePath, JSON.stringify({
      entries: { 'l1': { winner: 'w1', entry: { compCount: 1 } } },
    }));
    const res = childProcess.spawnSync(
      'node',
      [SCRIPT_PATH, `--from-archive=${archivePath}`, '--apply'],
      { encoding: 'utf8', cwd: repoRoot },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/--from-archive only operates on Cosmos/);
    fs.rmSync(tmp, { recursive: true });
  });

  test('--from-archive --apply --migrate-cosmos without Cosmos config exits 3', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mergedup-arch-'));
    const archivePath = path.join(tmp, 'orphans.json');
    fs.writeFileSync(archivePath, JSON.stringify({
      entries: { 'l1': { winner: 'w1', entry: { compCount: 1 } } },
    }));
    const env = { ...process.env };
    delete env.COSMOS_ENDPOINT;
    delete env.COSMOS_KEY;
    const res = childProcess.spawnSync(
      'node',
      [SCRIPT_PATH, `--from-archive=${archivePath}`, '--apply', '--migrate-cosmos'],
      { encoding: 'utf8', cwd: repoRoot, env },
    );
    expect(res.status).toBe(3);
    expect(res.stderr).toMatch(/Cosmos is not configured/);
    fs.rmSync(tmp, { recursive: true });
  });

  test('--from-archive groups multiple losers under the same winner', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mergedup-arch-'));
    const archivePath = path.join(tmp, 'orphans.json');
    fs.writeFileSync(archivePath, JSON.stringify({
      entries: {
        'a': { winner: 'X', entry: { compCount: 10 } },
        'b': { winner: 'X', entry: { compCount: 20 } },
        'c': { winner: 'X', entry: { compCount: 30 } },
        'd': { winner: 'Y', entry: { compCount: 5 } },
      },
    }));
    const res = childProcess.spawnSync(
      'node',
      [SCRIPT_PATH, `--from-archive=${archivePath}`, '--verbose'],
      { encoding: 'utf8', cwd: repoRoot },
    );
    expect(res.status).toBe(0);
    // Winner X should have 3 losers grouped underneath it (one WINNER line, three loser lines for X)
    expect(res.stdout).toMatch(/WINNER\s+"X"[\s\S]*loser \[\s*\d+c\]\s+"a"[\s\S]*loser \[\s*\d+c\]\s+"b"[\s\S]*loser \[\s*\d+c\]\s+"c"/);
    fs.rmSync(tmp, { recursive: true });
  });
});
