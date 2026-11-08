#!/usr/bin/env node
/**
 * import-metals-history.js (#333H)
 *
 * Sends a metals_history.json-shaped file ({ XAU: { 'YYYY-MM-DD': price } }), for example the output of
 * backfill-metals-history.js, to POST /api/admin/metals-history/import. The server keeps days it already
 * has unless they are listed in --replace-days, and validates everything before it writes anything.
 *
 * Needs ADMIN_API_KEY and APP_URL (environment, or a dotenv file given with --env). The key is sent only
 * as a header and is never printed.
 *
 * Usage:
 *   node scripts/import-metals-history.js --file FILE [--replace-days D1,D2] [--app-url URL] [--env FILE] [--dry-run]
 */
'use strict';

const fs = require('fs');
const axios = require('axios');
const { isCalendarDay } = require('../src/utils/spotLookup');

const METALS = ['XAU', 'XAG', 'XPT', 'XPD'];

const fail = (message) => { throw new Error(message); };

/** Keep only known metals and valid past day/price pairs (the server records today itself); report how many rows were left out. */
function cleanHistory(raw, today = new Date().toISOString().substring(0, 10)) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('the file must be a JSON object keyed by metal');
  const history = {};
  let dropped = 0;
  for (const metal of METALS) {
    if (!Object.prototype.hasOwnProperty.call(raw, metal)) continue;
    history[metal] = {};
    for (const [day, price] of Object.entries(raw[metal] || {})) {
      if (isCalendarDay(day) && day < today && typeof price === 'number' && Number.isFinite(price) && price > 0) history[metal][day] = price;
      else dropped++;
    }
  }
  if (!Object.keys(history).length) fail('the file has none of XAU, XAG, XPT, XPD');
  return { history, dropped };
}

/** The key is only ever sent over https, or to a local server. */
function checkAppUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { fail('APP_URL is not a valid URL'); }
  const local = ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) fail('APP_URL must be https (or http on localhost)');
  return parsed.origin;
}

async function importHistory({ origin, key, history, replaceDays }) {
  try {
    const res = await axios.post(`${origin}/api/admin/metals-history/import`, { history, replaceDays }, {
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      timeout: 60000,
      maxBodyLength: 5 * 1024 * 1024,
      maxRedirects: 0, // a redirect would carry the key to wherever it points
    });
    return res.data;
  } catch (err) {
    // Status and the server's message only: the error object carries the request headers, which hold the key.
    const status = err.response ? err.response.status : err.code || 'network error';
    const detail = err.response && err.response.data && typeof err.response.data.error === 'string' ? `: ${err.response.data.error}` : '';
    throw new Error(`import failed (${status})${detail}`);
  }
}

function parseArgs(argv) {
  const opts = { dryRun: false, replaceDays: [] };
  const value = (i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${argv[i]} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--file': opts.file = value(i); i++; break;
      case '--replace-days': opts.replaceDays = value(i).split(',').map((d) => d.trim()); i++; break;
      case '--app-url': opts.appUrl = value(i); i++; break;
      case '--env': opts.env = value(i); i++; break;
      case '--dry-run': opts.dryRun = true; break;
      default: fail(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!opts.file) fail('--file is required');
  if (!opts.replaceDays.every(isCalendarDay)) fail('--replace-days must be real YYYY-MM-DD dates');
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.env) require('dotenv').config({ path: opts.env });
  const { history, dropped } = cleanHistory(JSON.parse(fs.readFileSync(opts.file, 'utf8')));
  const origin = checkAppUrl(opts.appUrl || process.env.APP_URL || '');
  const counts = Object.entries(history).map(([metal, days]) => `${metal}:${Object.keys(days).length}`).join(' ');
  console.log(`Plan: send ${counts} to ${origin}${opts.replaceDays.length ? `, replacing ${opts.replaceDays.join(',')}` : ''}${dropped ? ` (${dropped} invalid row(s) left out)` : ''}`);
  if (opts.dryRun) return;
  const key = process.env.ADMIN_API_KEY || '';
  if (!key) fail('ADMIN_API_KEY is not set (use the environment or --env FILE)');
  const result = await importHistory({ origin, key, history, replaceDays: opts.replaceDays });
  for (const [metal, s] of Object.entries(result.summary || {})) {
    const prev = Object.entries(s.previous || {}).map(([day, p]) => `${day} was ${p}`).join(', ');
    console.log(`  ${metal}: ${s.added} added, ${s.replaced} replaced${prev ? ` (${prev})` : ''}, ${s.kept} kept, ${s.skippedOld} older than retention`);
  }
  if (result.persisted) console.log(`  stored: file ${result.persisted.file}, cosmos ${result.persisted.cosmos}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[import-metals-history] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { cleanHistory, checkAppUrl, importHistory, parseArgs };
