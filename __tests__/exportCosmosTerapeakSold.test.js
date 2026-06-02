'use strict';

/**
 * #246 -- tests for scripts/export-cosmos-terapeak-sold.js
 *
 * Verifies the pre-migration Cosmos export tool. Avoids real Cosmos --
 * we assert script-invariant properties (CLI parsing, default output path,
 * abort-when-not-configured, JSON shape contract) via source inspection
 * and subprocess invocation.
 */

const path = require('path');
const childProcess = require('child_process');
const fs = require('fs');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'export-cosmos-terapeak-sold.js');
const REPO_ROOT = path.join(__dirname, '..');

describe('export-cosmos-terapeak-sold.js -- script invariants', () => {
  test('script file exists and is syntactically valid Node', () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
    const res = childProcess.spawnSync('node', ['--check', SCRIPT_PATH], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  test('aborts with exit code 1 when Cosmos is not configured', () => {
    const env = { ...process.env };
    delete env.COSMOS_ENDPOINT;
    delete env.COSMOS_KEY;
    const res = childProcess.spawnSync('node', [SCRIPT_PATH], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env,
    });
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/Cosmos is not configured/);
  });

  test('--out without a value exits with code 2', () => {
    const res = childProcess.spawnSync('node', [SCRIPT_PATH, '--out'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--out requires a value/);
  });

  test('default output path is under data/archive/ with ISO timestamp', () => {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/data', 'archive'/);
    expect(src).toMatch(/cosmos-terapeak-sold-/);
    expect(src).toMatch(/new Date\(\)\.toISOString\(\)/);
  });

  test('queries the terapeak-sold container with SELECT *', () => {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/cosmos\.container\(['"]terapeak-sold['"]\)/);
    expect(src).toMatch(/SELECT \* FROM c/);
  });

  test('uses paged fetchNext (not fetchAll) to avoid OOM on large containers', () => {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/while \(iterator\.hasMoreResults\(\)\)/);
    expect(src).toMatch(/fetchNext\(\)/);
    expect(src).not.toMatch(/\.fetchAll\(\)/);
  });

  test('output payload shape includes exportedAt, container, docCount, docs', () => {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/exportedAt:/);
    expect(src).toMatch(/container: 'terapeak-sold'/);
    expect(src).toMatch(/docCount:/);
    expect(src).toMatch(/docs,/);
  });
});
