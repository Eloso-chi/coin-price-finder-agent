'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { CACHE_DIR } = require('../src/utils/cachePath');

const MANIFEST_PATH = path.join(CACHE_DIR, 'apr_manifest.json');
const REPAIR_LOCK_PATH = path.join(CACHE_DIR, 'apr_manifest.repair.lock');
const DEFAULT_CUTOFF = '2026-09-01T00:00:00.000Z';
const GENERIC_REASON = 'IsValidRequest=false';
const REJECTION_FIELDS = [
  'lastRejected',
  'rejectionReason',
  'consecutiveRejections',
  'retryAfter'
];

function isEligible(entry, cutoff) {
  return entry
    && entry.rejectionReason === GENERIC_REASON
    && typeof entry.lastRejected === 'string'
    && Number.isFinite(Date.parse(entry.lastRejected))
    && Date.parse(entry.lastRejected) >= Date.parse(cutoff);
}

function planRepair(manifest, cutoff = DEFAULT_CUTOFF) {
  if (!Number.isFinite(Date.parse(cutoff))) throw new Error('Invalid repair cutoff timestamp');
  const repaired = JSON.parse(JSON.stringify(manifest));
  if (!repaired.entries || typeof repaired.entries !== 'object' || Array.isArray(repaired.entries)) {
    throw new Error('APR manifest entries must be an object');
  }

  const repairedKeys = [];
  for (const [key, entry] of Object.entries(repaired.entries)) {
    if (!isEligible(entry, cutoff)) continue;
    for (const field of REJECTION_FIELDS) delete entry[field];
    if (Object.keys(entry).length === 0) delete repaired.entries[key];
    repairedKeys.push(key);
  }
  return { repaired, repairedKeys };
}

function writeAtomic(filePath, value, expectedSource) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { flag: 'wx' });
    if (fs.readFileSync(filePath, 'utf8') !== expectedSource) {
      throw new Error('APR manifest changed after repair planning; retry with the application stopped');
    }
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* best effort */ }
    throw error;
  }
}

function withRepairLock(callback) {
  let fd;
  try {
    fd = fs.openSync(REPAIR_LOCK_PATH, 'wx');
    fs.writeSync(fd, JSON.stringify({
      owner: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    }));
    return callback();
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
      try { fs.unlinkSync(REPAIR_LOCK_PATH); } catch { /* best effort */ }
    }
  }
}

function run({
  apply = false,
  cutoff = DEFAULT_CUTOFF,
  manifestPath = MANIFEST_PATH,
  appStoppedConfirmed = false
} = {}) {
  return withRepairLock(() => {
    if (fs.lstatSync(manifestPath).isSymbolicLink()) {
      throw new Error('Refusing to repair a symbolic-link APR manifest');
    }
    const originalText = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(originalText);
    const { repaired, repairedKeys } = planRepair(manifest, cutoff);

    if (apply && repairedKeys.length > 0) {
      if (!appStoppedConfirmed) {
        throw new Error('Apply requires explicit confirmation that every application instance is stopped');
      }
      const backupPath = `${manifestPath}.pre-314H-repair-${Date.now()}.bak`;
      fs.writeFileSync(backupPath, originalText, { flag: 'wx' });
      writeAtomic(manifestPath, repaired, originalText);
      return { mode: 'apply', repairedCount: repairedKeys.length, repairedKeys, backupPath };
    }
    return { mode: apply ? 'apply' : 'dry-run', repairedCount: repairedKeys.length, repairedKeys };
  });
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const appStoppedConfirmed = process.argv.includes('--confirm-app-stopped');
  const cutoffArg = process.argv.find(arg => arg.startsWith('--cutoff='));
  const cutoff = cutoffArg ? cutoffArg.slice('--cutoff='.length) : DEFAULT_CUTOFF;
  const result = run({ apply, cutoff, appStoppedConfirmed });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = {
  DEFAULT_CUTOFF,
  GENERIC_REASON,
  planRepair,
  run
};
