'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

class LeaseLostError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LeaseLostError';
    this.code = 'LEASE_LOST';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function acquireExclusiveLease({ rootDir, staleMs, heartbeatMs = 60_000, now = Date.now }) {
  fs.mkdirSync(rootDir, { recursive: true });
  const leaderPath = path.join(rootDir, 'active');
  const ownerId = `${process.pid}-${randomUUID()}`;
  const ownerDir = path.join(rootDir, ownerId);
  const heartbeatPath = path.join(ownerDir, 'heartbeat.json');
  const releasedPath = path.join(ownerDir, 'released');
  fs.mkdirSync(ownerDir);

  function writeHeartbeat() {
    fs.writeFileSync(heartbeatPath, JSON.stringify({ ownerId, pid: process.pid, host: os.hostname(), at: now() }));
  }

  function leaderOwner() {
    try {
      return fs.readFileSync(leaderPath, 'utf8').trim();
    } catch {
      return null;
    }
  }

  function tryBecomeLeader() {
    try {
      fs.writeFileSync(leaderPath, ownerId, { flag: 'wx' });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return false;
    }
  }

  function reclaimableOwner() {
    const incumbentId = leaderOwner();
    if (!incumbentId) {
      try {
        return now() - fs.statSync(leaderPath).mtimeMs > staleMs ? '' : false;
      } catch {
        return '';
      }
    }

    const incumbentDir = path.join(rootDir, incumbentId);
    if (fs.existsSync(path.join(incumbentDir, 'released'))) return incumbentId;
    const heartbeat = readJson(path.join(incumbentDir, 'heartbeat.json'));
    return !heartbeat || now() - heartbeat.at > staleMs ? incumbentId : false;
  }

  writeHeartbeat();
  let acquired = tryBecomeLeader();
  if (!acquired) {
    const expectedOwner = reclaimableOwner();
    if (expectedOwner !== false) {
      const retiredPath = path.join(rootDir, `retired-${randomUUID()}`);
      try {
        fs.renameSync(leaderPath, retiredPath);
        const retiredOwner = fs.readFileSync(retiredPath, 'utf8').trim();
        if (retiredOwner === expectedOwner) {
          acquired = tryBecomeLeader();
        } else {
          try {
            fs.renameSync(retiredPath, leaderPath);
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      fs.rmSync(retiredPath, { force: true });
    }
  }

  if (!acquired) {
    fs.rmSync(ownerDir, { recursive: true, force: true });
    return null;
  }

  const heartbeatTimer = heartbeatMs > 0
    ? setInterval(() => {
      try {
        if (leaderOwner() === ownerId) writeHeartbeat();
      } catch {
        // The next ownership check fails closed before another paid request.
      }
    }, heartbeatMs)
    : null;
  heartbeatTimer?.unref();

  function assertOwner() {
    if (leaderOwner() !== ownerId) {
      throw new LeaseLostError('Durable refresh lease ownership was lost');
    }
    try {
      writeHeartbeat();
    } catch {
      throw new LeaseLostError('Durable refresh lease heartbeat could not be persisted');
    }
  }

  function release() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    fs.writeFileSync(releasedPath, new Date(now()).toISOString());
  }

  return { ownerId, assertOwner, release };
}

module.exports = { acquireExclusiveLease, LeaseLostError };