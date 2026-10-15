'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireExclusiveLease } = require('../src/utils/durableLease');

describe('durable exclusive lease', () => {
  let rootDir;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-lease-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('allows only one active owner', () => {
    const first = acquireExclusiveLease({ rootDir, staleMs: 1_000, heartbeatMs: 0 });
    const second = acquireExclusiveLease({ rootDir, staleMs: 1_000, heartbeatMs: 0 });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(() => first.assertOwner()).not.toThrow();
    first.release();
  });

  test('allows immediate takeover after the owner releases', () => {
    const first = acquireExclusiveLease({ rootDir, staleMs: 1_000, heartbeatMs: 0 });
    first.release();
    const second = acquireExclusiveLease({ rootDir, staleMs: 1_000, heartbeatMs: 0 });

    expect(second).not.toBeNull();
    expect(() => second.assertOwner()).not.toThrow();
    second.release();
  });

  test('fences a stale owner without allowing its cleanup to displace the replacement', () => {
    let clock = 1_000;
    const first = acquireExclusiveLease({
      rootDir,
      staleMs: 1_000,
      heartbeatMs: 0,
      now: () => clock,
    });
    clock = 2_001;
    const second = acquireExclusiveLease({
      rootDir,
      staleMs: 1_000,
      heartbeatMs: 0,
      now: () => clock,
    });

    expect(second).not.toBeNull();
    expect(() => first.assertOwner()).toThrow(expect.objectContaining({ code: 'LEASE_LOST' }));
    first.release();
    expect(() => second.assertOwner()).not.toThrow();
    second.release();
  });
});