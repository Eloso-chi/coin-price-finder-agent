'use strict';

jest.mock('../src/utils/cachePath', () => ({ CACHE_DIR: '/tmp/test-cache' }));

const fs = require('fs');
const path = require('path');
const { planRepair, run } = require('../scripts/repair-apr-generic-quarantines');

describe('repair-apr-generic-quarantines', () => {
  beforeEach(() => {
    jest.spyOn(fs, 'openSync').mockReturnValue(123);
    jest.spyOn(fs, 'writeSync').mockImplementation(() => 1);
    jest.spyOn(fs, 'closeSync').mockImplementation(() => {});
    jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('removes only incident-created generic rejection metadata', () => {
    const manifest = {
      lastRun: 'preserved',
      entries: {
        '100:65': {
          lastFetched: '2026-08-01T00:00:00.000Z',
          records: 4,
          lastRejected: '2026-09-02T00:00:00.000Z',
          rejectionReason: 'IsValidRequest=false',
          consecutiveRejections: 1,
          retryAfter: '2026-10-02T00:00:00.000Z'
        },
        '200:65': {
          lastRejected: '2026-09-02T00:00:00.000Z',
          rejectionReason: 'INVALID_TARGET: grade is not supported',
          consecutiveRejections: 1,
          retryAfter: '2026-10-02T00:00:00.000Z'
        },
        '300:65': {
          lastRejected: '2026-08-31T23:59:59.000Z',
          rejectionReason: 'IsValidRequest=false',
          consecutiveRejections: 1,
          retryAfter: '2026-09-30T00:00:00.000Z'
        }
      }
    };

    const { repaired, repairedKeys } = planRepair(manifest);

    expect(repairedKeys).toEqual(['100:65']);
    expect(repaired.entries['100:65']).toEqual({
      lastFetched: '2026-08-01T00:00:00.000Z',
      records: 4
    });
    expect(repaired.entries['200:65']).toEqual(manifest.entries['200:65']);
    expect(repaired.entries['300:65']).toEqual(manifest.entries['300:65']);
    expect(manifest.entries['100:65']).toHaveProperty('retryAfter');
  });

  test('deletes an entry only when it contains no unrelated fields', () => {
    const { repaired } = planRepair({
      entries: {
        '100:65': {
          lastRejected: '2026-09-02T00:00:00.000Z',
          rejectionReason: 'IsValidRequest=false',
          consecutiveRejections: 1,
          retryAfter: '2026-10-02T00:00:00.000Z'
        }
      }
    });

    expect(repaired.entries).toEqual({});
  });

  test('defaults to dry-run and performs no writes', () => {
    const manifest = JSON.stringify({
      entries: {
        '100:65': {
          lastRejected: '2026-09-02T00:00:00.000Z',
          rejectionReason: 'IsValidRequest=false'
        }
      }
    });
    jest.spyOn(fs, 'readFileSync').mockReturnValue(manifest);
    jest.spyOn(fs, 'lstatSync').mockReturnValue({ isSymbolicLink: () => false });
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    jest.spyOn(fs, 'renameSync').mockImplementation(() => {});

    try {
      expect(run()).toEqual({
        mode: 'dry-run',
        repairedCount: 1,
        repairedKeys: ['100:65']
      });
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(fs.renameSync).not.toHaveBeenCalled();
    } finally { /* restored by afterEach */ }
  });

  test('apply creates an exclusive backup before atomic replacement', () => {
    const manifest = JSON.stringify({
      entries: {
        '100:65': {
          lastRejected: '2026-09-02T00:00:00.000Z',
          rejectionReason: 'IsValidRequest=false'
        }
      }
    });
    jest.spyOn(fs, 'readFileSync').mockReturnValue(manifest);
    jest.spyOn(fs, 'lstatSync').mockReturnValue({ isSymbolicLink: () => false });
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    jest.spyOn(fs, 'renameSync').mockImplementation(() => {});

    try {
      const result = run({ apply: true, appStoppedConfirmed: true });
      expect(result).toEqual(expect.objectContaining({ mode: 'apply', repairedCount: 1 }));
      expect(fs.writeFileSync).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('.pre-314H-repair-'),
        manifest,
        { flag: 'wx' }
      );
      expect(fs.writeFileSync).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('.tmp'),
        expect.any(String),
        { flag: 'wx' }
      );
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        path.normalize('/tmp/test-cache/apr_manifest.json')
      );
    } finally { /* restored by afterEach */ }
  });

  test('refuses apply without explicit stopped-application confirmation', () => {
    jest.spyOn(fs, 'lstatSync').mockReturnValue({ isSymbolicLink: () => false });
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      entries: {
        '100:65': {
          lastRejected: '2026-09-02T00:00:00.000Z',
          rejectionReason: 'IsValidRequest=false'
        }
      }
    }));
    try {
      expect(() => run({ apply: true })).toThrow('every application instance is stopped');
    } finally { /* restored by afterEach */ }
  });
});
