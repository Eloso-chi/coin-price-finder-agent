'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
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

  test.each(['{', 'not-json'])(
    'does not reclaim a young malformed heartbeat: %s',
    malformedHeartbeat => {
      let clock = Date.now();
      const first = acquireExclusiveLease({
        rootDir,
        staleMs: 1_000,
        heartbeatMs: 0,
        now: () => clock,
      });
      const ownerId = fs.readFileSync(path.join(rootDir, 'active'), 'utf8').trim();
      const heartbeatPath = path.join(rootDir, ownerId, 'heartbeat.json');
      fs.writeFileSync(heartbeatPath, malformedHeartbeat);
      clock = fs.statSync(heartbeatPath).mtimeMs;

      expect(acquireExclusiveLease({ rootDir, staleMs: 1_000, heartbeatMs: 0, now: () => clock })).toBeNull();

      clock += 1_001;
      const replacement = acquireExclusiveLease({ rootDir, staleMs: 1_000, heartbeatMs: 0, now: () => clock });
      expect(replacement).not.toBeNull();
      first.release();
      replacement.release();
    }
  );

  test('does not reclaim a young owner whose heartbeat is missing', () => {
    let clock = Date.now();
    const first = acquireExclusiveLease({
      rootDir,
      staleMs: 1_000,
      heartbeatMs: 0,
      now: () => clock,
    });
    const ownerId = fs.readFileSync(path.join(rootDir, 'active'), 'utf8').trim();
    fs.rmSync(path.join(rootDir, ownerId, 'heartbeat.json'));
    clock = fs.statSync(path.join(rootDir, ownerId)).mtimeMs;

    expect(acquireExclusiveLease({ rootDir, staleMs: 1_000, heartbeatMs: 0, now: () => clock })).toBeNull();

    clock += 1_001;
    const replacement = acquireExclusiveLease({ rootDir, staleMs: 1_000, heartbeatMs: 0, now: () => clock });
    expect(replacement).not.toBeNull();
    first.release();
    replacement.release();
  });

  test('ages the ownership marker when the owner directory is missing', () => {
    let clock = Date.now();
    const first = acquireExclusiveLease({
      rootDir,
      staleMs: 1_000,
      heartbeatMs: 0,
      now: () => clock,
    });
    expect(first).not.toBeNull();
    const leaderPath = path.join(rootDir, 'active');
    const ownerId = fs.readFileSync(leaderPath, 'utf8').trim();
    fs.rmSync(path.join(rootDir, ownerId), { recursive: true, force: true });
    clock = fs.statSync(leaderPath).mtimeMs;

    expect(acquireExclusiveLease({ rootDir, staleMs: 1_000, heartbeatMs: 0, now: () => clock })).toBeNull();

    clock += 1_001;
    const replacement = acquireExclusiveLease({ rootDir, staleMs: 1_000, heartbeatMs: 0, now: () => clock });
    expect(replacement).not.toBeNull();
    replacement.release();
  });

  test('allows only one winner when stale takeover attempts are simultaneous', async () => {
    const first = acquireExclusiveLease({ rootDir, staleMs: 100, heartbeatMs: 0, now: () => 1 });
    const startGate = new Int32Array(new SharedArrayBuffer(4));
    const verifyGate = new Int32Array(new SharedArrayBuffer(4));
    const releaseGate = new Int32Array(new SharedArrayBuffer(4));
    const modulePath = path.resolve(__dirname, '..', 'src', 'utils', 'durableLease.js');
    const workerSource = `
      const { parentPort, workerData } = require('worker_threads');
      const { acquireExclusiveLease } = require(workerData.modulePath);
      const startGate = new Int32Array(workerData.startGate);
      const verifyGate = new Int32Array(workerData.verifyGate);
      const releaseGate = new Int32Array(workerData.releaseGate);
      Atomics.wait(startGate, 0, 0);
      const lease = acquireExclusiveLease({ rootDir: workerData.rootDir, staleMs: 100, heartbeatMs: 0 });
      parentPort.postMessage({ phase: 'acquired', value: Boolean(lease) });
      Atomics.wait(verifyGate, 0, 0);
      let ownsLease = false;
      try {
        lease?.assertOwner();
        ownsLease = Boolean(lease);
      } catch {}
      parentPort.postMessage({ phase: 'verified', value: ownsLease });
      if (ownsLease) {
        Atomics.wait(releaseGate, 0, 0);
        lease.release();
      }
    `;
    const workers = Array.from({ length: 5 }, () => new Worker(workerSource, {
      eval: true,
      workerData: {
        modulePath,
        rootDir,
        startGate: startGate.buffer,
        verifyGate: verifyGate.buffer,
        releaseGate: releaseGate.buffer,
      },
    }));
    const acquiredResults = [];
    const verifiedResults = [];
    const phases = workers.map(worker => {
      let resolveAcquired;
      let rejectAcquired;
      let resolveVerified;
      let rejectVerified;
      const acquired = new Promise((resolve, reject) => {
        resolveAcquired = resolve;
        rejectAcquired = reject;
      });
      const verified = new Promise((resolve, reject) => {
        resolveVerified = resolve;
        rejectVerified = reject;
      });
      worker.on('message', message => {
        if (message.phase === 'acquired') {
          acquiredResults.push(message.value);
          resolveAcquired();
        } else {
          verifiedResults.push(message.value);
          resolveVerified();
        }
      });
      worker.once('error', error => {
        rejectAcquired(error);
        rejectVerified(error);
      });
      return { acquired, verified };
    });
    const exits = workers.map(worker => new Promise((resolve, reject) => {
      worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`)));
    }));

    Atomics.store(startGate, 0, 1);
    Atomics.notify(startGate, 0, workers.length);
    await Promise.all(phases.map(phase => phase.acquired));
    Atomics.store(verifyGate, 0, 1);
    Atomics.notify(verifyGate, 0, workers.length);
    await Promise.all(phases.map(phase => phase.verified));

    expect(acquiredResults.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(verifiedResults.filter(Boolean)).toHaveLength(1);
    expect(() => first.assertOwner()).toThrow(expect.objectContaining({ code: 'LEASE_LOST' }));
    Atomics.store(releaseGate, 0, 1);
    Atomics.notify(releaseGate, 0, workers.length);
    await Promise.all(exits);
    first.release();
  });

  test('ownership checks do not persist a heartbeat for every paid target', () => {
    const lease = acquireExclusiveLease({ rootDir, staleMs: 1_000, heartbeatMs: 60_000 });
    const ownerId = fs.readFileSync(path.join(rootDir, 'active'), 'utf8').trim();
    const heartbeatPath = path.join(rootDir, ownerId, 'heartbeat.json');
    const initialMtime = fs.statSync(heartbeatPath).mtimeMs;

    lease.assertOwner();
    lease.assertOwner();

    expect(fs.statSync(heartbeatPath).mtimeMs).toBe(initialMtime);
    lease.release();
  });
});