#!/usr/bin/env node
/**
 * sync-terapeak-meta.js -- pull data/terapeak-meta.json from the live Azure
 * app so the local checkout reflects current scraper state.
 *
 * Why: data/terapeak-meta.json is the freshness classifier's only input but
 * its only writer (`saveMetaSidecar()` in src/services/terapeakService.js)
 * runs server-side. When remote scrapers POST CSVs to Azure with
 * UPLOAD_MODE=api, only Azure's copy gets `page1At` / `lastRefreshAt`
 * stamps. Without this sync, the local sidecar is git-frozen and the
 * Windows-side freshness report keeps classifying already-scraped coins
 * as still-stale.
 *
 * Companion to #259 (run-surface-freshness-loop.sh `sync_meta_from_app`).
 * That fix updated the remote scraper box; this script does the same for
 * any developer workstation.
 *
 * Required env (from .env or shell):
 *   APP_URL           e.g. https://coinpricefinder-<id>.azurewebsites.net
 *   ADMIN_API_KEY     raw admin key matching server's ADMIN_API_KEY
 *
 * Flags:
 *   --check           do not write; just report would-be size + mtime diff
 *   --no-backup       skip writing data/archive/terapeak-meta.before-azure-sync-<ISO>.json
 *   --quiet           only print warnings and the final OK / WROTE line
 *
 * Exit codes:
 *   0  success (synced, or --check completed)
 *   1  config error (missing APP_URL / ADMIN_API_KEY)
 *   2  network / HTTP / validation error (keeps existing file)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const META_PATH = path.join(ROOT, 'data', 'terapeak-meta.json');
const ARCHIVE_DIR = path.join(ROOT, 'data', 'archive');

require('dotenv').config({ path: path.join(ROOT, '.env') });

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const NO_BACKUP = args.includes('--no-backup');
const QUIET = args.includes('--quiet');

function log(...a) { if (!QUIET) console.log(...a); }
function warn(...a) { console.warn('[warn]', ...a); }
function die(code, msg) { console.error('[err]', msg); process.exit(code); }

const APP_URL = (process.env.APP_URL || '').trim();
const ADMIN_API_KEY = (process.env.ADMIN_API_KEY || '').trim();

if (!APP_URL) die(1, 'APP_URL is required (set in .env or env). See docs/runbooks/local-scraper-wsl2.md.');
if (!ADMIN_API_KEY) die(1, 'ADMIN_API_KEY is required (set in .env or env). Must match server\'s key.');

const url = new URL('/api/admin/terapeak-meta', APP_URL);
const client = url.protocol === 'https:' ? https : http;

function fetchMeta() {
  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: 'GET',
      headers: {
        'x-api-key': ADMIN_API_KEY,
        accept: 'application/json',
      },
      timeout: 60_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('request timeout (60s)')); });
    req.on('error', reject);
    req.end();
  });
}

(async function main() {
  log(`Sync data/terapeak-meta.json from ${APP_URL}`);

  let resp;
  try {
    resp = await fetchMeta();
  } catch (err) {
    die(2, `network error: ${err.message}`);
  }

  if (resp.status !== 200) {
    const preview = resp.body.toString('utf8').slice(0, 200);
    die(2, `HTTP ${resp.status} from ${url.href}: ${preview}`);
  }

  // Validate JSON before touching disk
  let parsed;
  try {
    parsed = JSON.parse(resp.body.toString('utf8'));
  } catch (err) {
    die(2, `response is not valid JSON: ${err.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    die(2, 'response JSON is not an object');
  }

  const newBytes = resp.body.length;
  const newEntries = Object.keys(parsed).length;
  const remoteMtime = resp.headers['x-meta-mtime'] || '(unknown)';
  const remoteBytes = resp.headers['x-meta-bytes'] || String(newBytes);

  let existingBytes = 0;
  let existingEntries = 0;
  let existingMtime = null;
  if (fs.existsSync(META_PATH)) {
    const stat = fs.statSync(META_PATH);
    existingBytes = stat.size;
    existingMtime = stat.mtime.toISOString();
    try {
      const cur = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
      existingEntries = Object.keys(cur).length;
    } catch (_err) {
      existingEntries = -1; // corrupt
    }
  }

  log(`  remote: ${newBytes.toLocaleString()} bytes, ${newEntries.toLocaleString()} entries (server mtime ${remoteMtime})`);
  log(`  local:  ${existingBytes.toLocaleString()} bytes, ${existingEntries.toLocaleString()} entries (local mtime ${existingMtime || '(missing)'})`);

  const byteDelta = newBytes - existingBytes;
  const entryDelta = newEntries - existingEntries;
  log(`  delta:  ${byteDelta >= 0 ? '+' : ''}${byteDelta.toLocaleString()} bytes, ${entryDelta >= 0 ? '+' : ''}${entryDelta.toLocaleString()} entries`);

  if (CHECK) {
    console.log(`CHECK: remote=${newBytes}B/${newEntries}e local=${existingBytes}B/${existingEntries}e delta=${byteDelta >= 0 ? '+' : ''}${byteDelta}B/${entryDelta >= 0 ? '+' : ''}${entryDelta}e`);
    process.exit(0);
  }

  // Backup
  if (!NO_BACKUP && fs.existsSync(META_PATH)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15);
    const bak = path.join(ARCHIVE_DIR, `terapeak-meta.before-azure-sync-${stamp}.json`);
    fs.copyFileSync(META_PATH, bak);
    log(`  backup: ${path.relative(ROOT, bak)}`);
  }

  // Atomic write: tmp + rename
  fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
  const tmp = `${META_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, resp.body);
  fs.renameSync(tmp, META_PATH);

  const finalStat = fs.statSync(META_PATH);
  console.log(`WROTE data/terapeak-meta.json (${finalStat.size.toLocaleString()} bytes, ${newEntries.toLocaleString()} entries) from ${APP_URL}`);
})().catch((err) => die(2, `unexpected: ${err.message}`));
