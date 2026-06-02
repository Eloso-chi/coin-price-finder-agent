// __tests__/auditDuplicateKeys.test.js
// Smoke tests for scripts/audit-duplicate-keys.js (#246 phase 1).
// Verifies the script is read-only (does not mutate data/terapeak-meta.json)
// and produces a well-formed report.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const META_PATH = path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const REPORT_PATH = path.join(__dirname, '..', 'docs', 'reports', 'duplicate-keys-report.json');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'audit-duplicate-keys.js');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('audit-duplicate-keys.js (#246 phase 1)', () => {
  let metaHashBefore;
  let reportBackup;

  beforeAll(() => {
    if (fs.existsSync(META_PATH)) {
      metaHashBefore = sha256(fs.readFileSync(META_PATH));
    }
    // Save existing report (a real one was generated during dev) so we don't
    // disturb a tracked artifact if there is one.
    if (fs.existsSync(REPORT_PATH)) {
      reportBackup = fs.readFileSync(REPORT_PATH);
    }
  });

  afterAll(() => {
    if (reportBackup != null) {
      fs.writeFileSync(REPORT_PATH, reportBackup);
    }
  });

  test('script runs without error and produces a report', () => {
    if (!fs.existsSync(META_PATH)) {
      // Cannot run audit without meta -- skip rather than fail.
      return;
    }
    execFileSync('node', [SCRIPT, '--top', '1'], { encoding: 'utf8' });
    expect(fs.existsSync(REPORT_PATH)).toBe(true);
  });

  test('does NOT mutate data/terapeak-meta.json (read-only safety)', () => {
    if (!fs.existsSync(META_PATH)) return;
    const metaHashAfter = sha256(fs.readFileSync(META_PATH));
    expect(metaHashAfter).toBe(metaHashBefore);
  });

  test('report has expected top-level shape', () => {
    if (!fs.existsSync(REPORT_PATH)) return;
    const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
    expect(report).toMatchObject({
      generatedAt: expect.any(String),
      metaKeyCount: expect.any(Number),
      canonicalGroupCount: expect.any(Number),
      duplicateGroupCount: expect.any(Number),
      duplicateKeyCount: expect.any(Number),
      classification: {
        'mixed-populated-and-empty': expect.any(Number),
        'all-populated': expect.any(Number),
        'all-empty': expect.any(Number),
      },
      aliasMapVersion: 1,
      duplicateGroups: expect.any(Array),
    });
  });

  test('every duplicate group has >=2 members and a suggested canonical', () => {
    if (!fs.existsSync(REPORT_PATH)) return;
    const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
    for (const group of report.duplicateGroups) {
      expect(group.members.length).toBeGreaterThanOrEqual(2);
      expect(typeof group.suggestedCanonicalKey).toBe('string');
      expect(group.suggestedCanonicalKey.length).toBeGreaterThan(0);
      // The suggested canonical must be one of the group's actual member keys.
      const memberKeys = group.members.map(m => m.key);
      expect(memberKeys).toContain(group.suggestedCanonicalKey);
      // Classification must be one of the three known buckets.
      expect(['mixed-populated-and-empty', 'all-populated', 'all-empty'])
        .toContain(group.classification);
    }
  });

  test('mixed groups are listed before all-populated and all-empty', () => {
    if (!fs.existsSync(REPORT_PATH)) return;
    const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
    const classWeight = { 'mixed-populated-and-empty': 0, 'all-populated': 1, 'all-empty': 2 };
    let prevWeight = -1;
    for (const group of report.duplicateGroups) {
      const w = classWeight[group.classification];
      expect(w).toBeGreaterThanOrEqual(prevWeight);
      prevWeight = w;
    }
  });
});
