#!/usr/bin/env node
/**
 * backfill-metals-history.js (#333H)
 *
 * Builds a metals_history.json-shaped file ({ XAG: { 'YYYY-MM-DD': price } }) from
 * GoldAPI.io daily history, so bar-premiums.js has spot prices for old sales.
 * It never writes the server's store: the output goes to --out, and values already
 * in --existing (for example the production history) always win over fetched ones.
 *
 * Needs GOLDAPI_KEY (environment, or a dotenv file given with --env). The key is
 * sent only as a header and is never printed. The free plan allows 150 requests a
 * month; one request covers up to 90 days of one metal.
 *
 * Usage:
 *   node scripts/backfill-metals-history.js --from 2024-11-01 [--to YYYY-MM-DD]
 *        [--metals XAU,XAG,XPT] [--existing FILE] [--replace-days D1,D2] [--out FILE] [--env FILE]
 *        [--max-requests N] [--delay-ms N] [--dry-run]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'cache', 'metals_history_backfill.json');
const METALS = ['XAU', 'XAG', 'XPT', 'XPD'];
const MAX_WINDOW_DAYS = 90;
const DAY_MS = 86400000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const fail = (message) => { throw new Error(message); };

function isCalendarDay(value) {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Inclusive from/to day strings split into windows of at most MAX_WINDOW_DAYS days. */
function buildWindows(from, to) {
  if (!isCalendarDay(from) || !isCalendarDay(to)) fail('from and to must be real YYYY-MM-DD dates');
  if (from > to) fail('from must not be after to');
  const windows = [];
  let start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (start <= end) {
    const stop = Math.min(end, start + (MAX_WINDOW_DAYS - 1) * DAY_MS);
    windows.push({ from: toDay(start), to: toDay(stop) });
    start = stop + DAY_MS;
  }
  return windows;
}

/** Rows of a GoldAPI /history body that are real days with a positive finite price. */
function parseHistoryBody(body, metal) {
  if (!body || typeof body !== 'object' || body.metal !== metal || !Array.isArray(body.prices)) {
    fail(`unexpected history response for ${metal}`);
  }
  const rows = {};
  let dropped = 0;
  for (const row of body.prices) {
    const ok = row && isCalendarDay(row.date) && typeof row.price === 'number' && Number.isFinite(row.price) && row.price > 0;
    if (ok) rows[row.date] = Math.round(row.price * 100) / 100;
    else dropped++;
  }
  return { rows, dropped };
}

/** Existing values win, except days in `replaceDays`; other dates missing from `existing` come from `fetched`. */
function mergeHistory(existing, fetched, replaceDays = []) {
  const replace = new Set(replaceDays);
  const merged = {};
  for (const metal of METALS.filter((m) => (existing && m in existing) || m in fetched)) {
    const days = Object.create(null);
    const old = (existing && existing[metal]) || {};
    for (const [day, price] of Object.entries(old)) if (isCalendarDay(day) && price > 0) days[day] = price;
    for (const [day, price] of Object.entries(fetched[metal] || {})) if (!(day in days) || replace.has(day)) days[day] = price;
    merged[metal] = Object.fromEntries(Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  return merged;
}

function loadExisting(file) {
  if (!file) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('--existing must be a JSON object');
  return parsed;
}

/**
 * @param {object} opts
 * @param {string} opts.from
 * @param {string} opts.to
 * @param {string[]} opts.metals
 * @param {(metal:string, window:{from:string,to:string}) => Promise<object>} opts.fetchWindow
 * @param {object} [opts.existing]
 * @param {number} [opts.delayMs]
 * @param {number} [opts.maxRequests]
 * @param {string[]} [opts.replaceDays] - days where the fetched value replaces an existing one
 */
async function backfill({ from, to, metals, fetchWindow, existing = {}, delayMs = 0, maxRequests = 40, replaceDays = [] }) {
  const windows = buildWindows(from, to);
  const requests = windows.length * metals.length;
  if (requests > maxRequests) fail(`plan needs ${requests} requests, above --max-requests ${maxRequests}`);
  const fetched = {};
  let dropped = 0;
  let done = 0;
  for (const metal of metals) {
    fetched[metal] = {};
    for (const window of windows) {
      if (done > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const { rows, dropped: bad } = parseHistoryBody(await fetchWindow(metal, window), metal);
      Object.assign(fetched[metal], rows);
      dropped += bad;
      done++;
    }
  }
  const history = mergeHistory(existing, fetched, replaceDays);
  const added = {};
  for (const metal of metals) {
    added[metal] = Object.keys(fetched[metal]).filter((day) => !(existing[metal] && day in existing[metal]) || replaceDays.includes(day)).length;
  }
  return { history, summary: { requests, windows: windows.length, added, dropped } };
}

function makeFetchWindow(key, baseUrl = 'https://www.goldapi.io/api') {
  return async (metal, window) => {
    try {
      const res = await axios.get(`${baseUrl}/history/${metal}/USD`, {
        params: { from: window.from, to: window.to },
        headers: { 'x-access-token': key, Accept: 'application/json' },
        timeout: 30000,
      });
      return res.data;
    } catch (err) {
      // Status only: the error object carries the request headers, which hold the key.
      const status = err.response ? err.response.status : err.code || 'network error';
      throw new Error(`GoldAPI ${metal} ${window.from}..${window.to} failed (${status})`);
    }
  };
}

function parseArgs(argv) {
  const opts = { metals: ['XAU', 'XAG', 'XPT'], out: DEFAULT_OUT, delayMs: 400, maxRequests: 40, dryRun: false };
  const value = (i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${argv[i]} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--from': opts.from = value(i); i++; break;
      case '--to': opts.to = value(i); i++; break;
      case '--metals': opts.metals = value(i).split(',').map((m) => m.trim().toUpperCase()); i++; break;
      case '--existing': opts.existing = value(i); i++; break;
      case '--replace-days': opts.replaceDays = value(i).split(',').map((d) => d.trim()); i++; break;
      case '--out': opts.out = path.resolve(value(i)); i++; break;
      case '--env': opts.env = value(i); i++; break;
      case '--max-requests': opts.maxRequests = Number(value(i)); i++; break;
      case '--delay-ms': opts.delayMs = Number(value(i)); i++; break;
      case '--dry-run': opts.dryRun = true; break;
      default: fail(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!opts.from) fail('--from is required');
  if (opts.replaceDays && !opts.replaceDays.every(isCalendarDay)) fail('--replace-days must be real YYYY-MM-DD dates');
  if (!opts.metals.length || opts.metals.some((m) => !METALS.includes(m))) fail(`--metals must be from ${METALS.join(',')}`);
  for (const [name, n] of [['--max-requests', opts.maxRequests], ['--delay-ms', opts.delayMs]]) {
    if (!Number.isInteger(n) || n < 0) fail(`${name} must be a non-negative integer`);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.env) require('dotenv').config({ path: opts.env });
  const yesterday = toDay(Date.now() - DAY_MS);
  const to = opts.to || yesterday;
  if (to > yesterday) fail(`--to must not be after ${yesterday} (the API has no future dates)`);
  const windows = buildWindows(opts.from, to);
  console.log(`Plan: ${opts.metals.join(',')} ${opts.from}..${to}, ${windows.length} window(s) per metal, ${windows.length * opts.metals.length} request(s)`);
  if (opts.dryRun) return;
  const key = process.env.GOLDAPI_KEY || '';
  if (!key) fail('GOLDAPI_KEY is not set (use the environment or --env FILE)');
  const { history, summary } = await backfill({
    from: opts.from,
    to,
    metals: opts.metals,
    fetchWindow: makeFetchWindow(key),
    existing: loadExisting(opts.existing),
    replaceDays: opts.replaceDays || [],
    delayMs: opts.delayMs,
    maxRequests: opts.maxRequests,
  });
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(history, null, 2) + '\n');
  console.log(`Wrote ${opts.out}`);
  for (const metal of opts.metals) {
    const days = Object.keys(history[metal] || {});
    console.log(`  ${metal}: ${days.length} days (${days[0]} .. ${days[days.length - 1]}), ${summary.added[metal]} added`);
  }
  if (summary.dropped) console.log(`  ${summary.dropped} row(s) dropped (bad date or price)`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[backfill-metals-history] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { buildWindows, parseHistoryBody, mergeHistory, backfill, makeFetchWindow, parseArgs, isCalendarDay, MAX_WINDOW_DAYS };
