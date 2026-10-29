'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAudit, publishJsonPair } = require('../scripts/audit-contradictory-weights');

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

  test('publishes neither output if either destination already exists', () => {
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
});
