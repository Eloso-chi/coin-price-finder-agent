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

function atomicWriteFile(filePath, contents) {
  const tempPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, contents);
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
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
    atomicWriteFile(heartbeatPath, JSON.stringify({ ownerId, pid: process.pid, host: os.hostname(), at: now() }));
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

  function filesystemEntryIsStale(...filePaths) {
    for (const filePath of filePaths) {
      try {
        const ageMs = now() - fs.statSync(filePath).mtimeMs;
        return Number.isFinite(ageMs) && ageMs > staleMs;
      } catch {
        continue;
      }
    }
    return false;
  }

  function ownerIsReclaimable(incumbentId, ownershipPath = leaderPath) {
    const incumbentDir = path.join(rootDir, incumbentId);
    if (fs.existsSync(path.join(incumbentDir, 'released'))) return incumbentId;
    const incumbentHeartbeatPath = path.join(incumbentDir, 'heartbeat.json');
    const heartbeat = readJson(incumbentHeartbeatPath);
    if (heartbeat
      && heartbeat.ownerId === incumbentId
      && Number.isFinite(heartbeat.at)) {
      return now() - heartbeat.at > staleMs ? incumbentId : false;
    }
    return filesystemEntryIsStale(incumbentHeartbeatPath, incumbentDir, ownershipPath)
      ? incumbentId
      : false;
  }

  function reclaimableOwner() {
    const incumbentId = leaderOwner();
    if (!incumbentId) {
      return filesystemEntryIsStale(leaderPath) ? '' : false;
    }
    return ownerIsReclaimable(incumbentId);
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
        if (retiredOwner === expectedOwner
          && (!retiredOwner || ownerIsReclaimable(retiredOwner, retiredPath) !== false)) {
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

  let heartbeatError = null;
  const heartbeatTimer = heartbeatMs > 0
    ? setInterval(() => {
      try {
        if (leaderOwner() === ownerId) writeHeartbeat();
      } catch (error) {
        heartbeatError = error;
      }
    }, heartbeatMs)
    : null;
  heartbeatTimer?.unref();

  function assertOwner() {
    if (leaderOwner() !== ownerId || heartbeatError) {
      throw new LeaseLostError('Durable refresh lease ownership was lost');
    }
  }

  function release() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    atomicWriteFile(releasedPath, new Date(now()).toISOString());
  }

  return { ownerId, assertOwner, release };
}

module.exports = { acquireExclusiveLease, LeaseLostError };