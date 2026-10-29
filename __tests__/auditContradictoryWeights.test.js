'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertPrivateOutputPlatform,
  buildAudit,
  buildRollback,
  publishJsonPair,
} = require('../scripts/audit-contradictory-weights');
const posixTest = process.platform === 'win32' ? test.skip : test;
const windowsTest = process.platform === 'win32' ? test : test.skip;

describe('contradictory-weight audit inventory', () => {
  test('reports affected keys without claiming target or collision analysis', () => {
    const report = buildAudit({
      'libertad 1/2 oz 1 oz': { compCount: 3 },
      'one ounce silver eagle': { compCount: 1 },
    }, {
      'libertad 1/2 oz 1 oz': { comps: [{}, {}] },
    });

    expect(report.mode).toBe('inventory-only');
    expect(report.sourceKeyCount).toBe(2);
    expect(report.affectedKeyCount).toBe(1);
    expect(report.affectedCompCount).toBe(3);
    expect(report.affected[0]).toMatchObject({
      key: 'libertad 1/2 oz 1 oz',
      explicitWeights: [0.5, 1],
      presentInMeta: true,
      presentInStore: true,
    });
    expect(report.affected[0]).not.toHaveProperty('proposedTargetKey');
    expect(report.affected[0]).not.toHaveProperty('proposalBasis');
    expect(report.affected[0]).not.toHaveProperty('collision');
    expect(report.affected[0]).not.toHaveProperty('resolution');
  });

  posixTest('publishes neither output if either destination already exists', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weight-audit-'));
    const first = path.join(tempDir, 'first.json');
    const second = path.join(tempDir, 'second.json');
    fs.writeFileSync(second, '{}');
    try {
      expect(() => publishJsonPair([[first, { ok: true }], [second, { ok: true }]])).toThrow();
      expect(fs.existsSync(first)).toBe(false);
      expect(fs.readFileSync(second, 'utf8')).toBe('{}');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  posixTest('streams valid JSON outputs with owner-only permissions on POSIX', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weight-audit-private-'));
    const reportPath = path.join(tempDir, 'report.json');
    const rollbackPath = path.join(tempDir, 'rollback.json');
    const payload = { entries: [{ key: 'a', comps: [{ title: 'Sale' }] }] };
    try {
      publishJsonPair([[reportPath, payload], [rollbackPath, payload]]);
      expect(JSON.parse(fs.readFileSync(reportPath, 'utf8'))).toEqual(payload);
      expect(JSON.parse(fs.readFileSync(rollbackPath, 'utf8'))).toEqual(payload);
      if (process.platform !== 'win32') {
        expect(fs.statSync(rollbackPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rollback contains only affected keys from both sources', () => {
    const meta = {
      'libertad 1/2 oz 1 oz': { compCount: 2 },
      'silver eagle 1 oz': { compCount: 1 },
    };
    const store = {
      'libertad 1/2 oz 1 oz': { comps: [{ title: 'Affected sale' }] },
      'silver eagle 1 oz': { comps: [{ title: 'Unaffected sale' }] },
    };
    const report = buildAudit(meta, store);
    const rollback = buildRollback(meta, store, report);

    expect(Object.keys(rollback.meta)).toEqual(['libertad 1/2 oz 1 oz']);
    expect(Object.keys(rollback.store)).toEqual(['libertad 1/2 oz 1 oz']);
    expect(rollback.store['libertad 1/2 oz 1 oz'].comps[0].title).toBe('Affected sale');
  });

  test('refuses private audit output on native Windows', () => {
    expect(() => assertPrivateOutputPlatform('win32')).toThrow(/run this audit from WSL/i);
    expect(() => assertPrivateOutputPlatform('linux')).not.toThrow();
  });

  windowsTest('publisher refuses native Windows even with extra caller arguments', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weight-audit-windows-'));
    const reportPath = path.join(tempDir, 'report.json');
    const publisher = publishJsonPair;
    try {
      expect(() => publisher([[reportPath, {}]], 'linux')).toThrow();
      expect(fs.existsSync(reportPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  posixTest('streams through multiple flushes for payloads larger than the buffer threshold', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weight-audit-stream-'));
    const reportPath = path.join(tempDir, 'report.json');
    const largePayload = {
      entries: Array.from({ length: 240 }, (_, index) => ({
        index,
        title: `Sale ${index} ${'x'.repeat(400)}`,
      })),
    };
    try {
      publishJsonPair(
        [[reportPath, largePayload], [path.join(tempDir, 'rollback.json'), {}]],
      );
      expect(JSON.parse(fs.readFileSync(reportPath, 'utf8'))).toEqual(largePayload);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
