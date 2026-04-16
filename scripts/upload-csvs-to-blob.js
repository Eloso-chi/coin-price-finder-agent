#!/usr/bin/env node
// scripts/upload-csvs-to-blob.js — One-time upload of local Terapeak CSVs to Azure Blob
// Usage: node scripts/upload-csvs-to-blob.js [folderPath]
// Requires: TERAPEAK_BLOB_ACCOUNT + TERAPEAK_BLOB_CONTAINER env vars (or az login)
'use strict';

const fs = require('fs');
const path = require('path');

const folder = process.argv[2] || path.join(__dirname, '..', 'data', 'terapeak');

async function main() {
  const blob = require('../src/utils/blobClient');
  if (!blob.isEnabled()) {
    console.error('Set TERAPEAK_BLOB_ACCOUNT and TERAPEAK_BLOB_CONTAINER env vars.');
    process.exit(1);
  }

  const absPath = path.resolve(folder);
  if (!fs.existsSync(absPath)) {
    console.error(`Folder not found: ${absPath}`);
    process.exit(1);
  }

  const files = fs.readdirSync(absPath).filter(f => /\.(csv|tsv|txt|meta)$/i.test(f));
  console.log(`Uploading ${files.length} file(s) from ${absPath} to blob...`);

  let uploaded = 0, errors = 0;
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(absPath, file), 'utf8');
      await blob.uploadBlob(file, content);
      console.log(`  ✓ ${file} (${(Buffer.byteLength(content) / 1024).toFixed(1)} KB)`);
      uploaded++;
    } catch (err) {
      console.error(`  ✗ ${file}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\nDone: ${uploaded} uploaded, ${errors} error(s).`);
}

main().catch(err => { console.error(err); process.exit(1); });
