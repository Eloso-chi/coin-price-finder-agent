#!/usr/bin/env node
// scripts/sync-restored-csvs-to-blob.js
//
// One-time script: uploads restored CSVs to Azure Blob Storage to replace
// truncated copies left by the overwrite bug (fix/csv-merge-on-refresh).
//
// Usage:
//   TERAPEAK_BLOB_ACCOUNT=coinpricecache01 TERAPEAK_BLOB_CONTAINER=terapeak-csvs \
//     node scripts/sync-restored-csvs-to-blob.js [--dry-run]
//
// Requires: az login (or managed identity in Azure)

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'terapeak');
const ACCOUNT = process.env.TERAPEAK_BLOB_ACCOUNT;
const CONTAINER = process.env.TERAPEAK_BLOB_CONTAINER;
const DRY_RUN = process.argv.includes('--dry-run');

// The 165 files restored from git history (pre-loss commit 416829a).
// Only these need re-uploading; all other blobs are fine.
const AFFECTED_FILES = new Set();

async function buildAffectedList() {
  // Use git to find which CSVs changed in the restore commit
  const { execSync } = require('child_process');
  const root = path.join(__dirname, '..');
  const diffOutput = execSync(
    'git log --oneline --diff-filter=M --name-only --format="" -- data/terapeak/',
    { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  // Get files that were modified in the restore commit (the one with "restore 165")
  const restoreCommit = execSync(
    'git log --oneline --all --grep="restore 165" --format="%H"',
    { cwd: root, encoding: 'utf8' }
  ).trim().split('\n')[0];

  if (!restoreCommit) {
    // Fallback: upload all CSVs with >50 rows (deep-paginated)
    console.log('Could not find restore commit, falling back to >50 row heuristic');
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.csv'));
    for (const file of files) {
      const lines = fs.readFileSync(path.join(DATA_DIR, file), 'utf8').split('\n').length - 1;
      if (lines > 50) AFFECTED_FILES.add(file);
    }
    return;
  }

  const changed = execSync(
    `git diff-tree --no-commit-id --name-only -r ${restoreCommit} -- data/terapeak/`,
    { cwd: root, encoding: 'utf8' }
  );
  for (const line of changed.trim().split('\n')) {
    if (line.endsWith('.csv')) {
      AFFECTED_FILES.add(path.basename(line));
    }
  }
}

async function main() {
  if (!ACCOUNT || !CONTAINER) {
    console.error('Error: Set TERAPEAK_BLOB_ACCOUNT and TERAPEAK_BLOB_CONTAINER env vars.');
    console.error('Example: TERAPEAK_BLOB_ACCOUNT=coinpricecache01 TERAPEAK_BLOB_CONTAINER=terapeak-csvs');
    process.exit(1);
  }

  await buildAffectedList();
  console.log(`Found ${AFFECTED_FILES.size} affected file(s) to sync to blob`);

  if (AFFECTED_FILES.size === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (DRY_RUN) {
    console.log('DRY RUN -- would upload:');
    for (const file of AFFECTED_FILES) {
      const size = fs.statSync(path.join(DATA_DIR, file)).size;
      console.log(`  ${file} (${(size / 1024).toFixed(1)} KB)`);
    }
    return;
  }

  const { BlobServiceClient } = require('@azure/storage-blob');
  const { DefaultAzureCredential } = require('@azure/identity');

  const url = `https://${ACCOUNT}.blob.core.windows.net`;
  const blobService = new BlobServiceClient(url, new DefaultAzureCredential());
  const container = blobService.getContainerClient(CONTAINER);

  let uploaded = 0, failed = 0, totalBytes = 0;

  for (const file of AFFECTED_FILES) {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`  SKIP: ${file} (not found on disk)`);
      continue;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const bytes = Buffer.byteLength(content, 'utf8');
      const blockBlob = container.getBlockBlobClient(file);
      await blockBlob.upload(content, bytes, {
        blobHTTPHeaders: { blobContentType: 'text/csv' },
      });
      uploaded++;
      totalBytes += bytes;
      console.log(`  OK: ${file} (${(bytes / 1024).toFixed(1)} KB)`);
    } catch (err) {
      failed++;
      console.error(`  FAIL: ${file} -- ${err.message}`);
    }
  }

  console.log(`\nDone: ${uploaded} uploaded, ${failed} failed, ${(totalBytes / 1024).toFixed(0)} KB total`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
