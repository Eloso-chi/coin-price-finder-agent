// src/services/auctionPriceService.js — PCGS Auction Prices Realized (APR) data service
// Fetches, deduplicates, and persists auction price history.
// Uses dedicated GetAPRByGrade / GetAPRByCertNo endpoints (up to 100 records/call).
// Rolling 3-year date window. 30-day freshness before re-fetch.
// CommonJS

'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const { CACHE_DIR } = require('../utils/cachePath');
const pcgsQuota = require('./pcgsQuotaService');

const PCGS_API_KEY = process.env.PCGS_API_KEY || '';
const PCGS_BASE = (process.env.PCGS_BASE_URL || 'https://api.pcgs.com/publicapi').replace(/\/+$/, '');
const TIMEOUT = 15000;

// Auction history stored in a subdirectory of cache
const APR_DIR = path.join(CACHE_DIR, 'auction_history');
if (!fs.existsSync(APR_DIR)) fs.mkdirSync(APR_DIR, { recursive: true });

// Manifest tracks freshness per pcgsNo:grade
const MANIFEST_PATH = path.join(CACHE_DIR, 'apr_manifest.json');

// ── Configuration ───────────────────────────────────────────
const DATE_WINDOW_YEARS = parseInt(process.env.APR_DATE_WINDOW_YEARS, 10) || 3;
const FRESHNESS_DAYS = parseInt(process.env.APR_FRESHNESS_DAYS, 10) || 30;
const MAX_RECORDS = 100;

// ── Manifest management ─────────────────────────────────────
let _manifest = null;

function loadManifest() {
  if (_manifest) return _manifest;
  try {
    _manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    _manifest = { entries: {}, lastRun: null, lastRunStatus: null };
  }
  return _manifest;
}

function saveManifest() {
  try {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(_manifest, null, 2));
  } catch (err) {
    console.error('[apr] Failed to save manifest:', err.message);
  }
}

function getManifestEntry(pcgsNo, grade) {
  const manifest = loadManifest();
  return manifest.entries[`${pcgsNo}:${grade}`] || null;
}

function setManifestEntry(pcgsNo, grade, recordCount) {
  const manifest = loadManifest();
  const now = new Date().toISOString();
  manifest.entries[`${pcgsNo}:${grade}`] = {
    lastFetched: now,
    records: recordCount,
    freshUntil: new Date(Date.now() + FRESHNESS_DAYS * 86400000).toISOString().slice(0, 10)
  };
  saveManifest();
}

/**
 * Check if a pcgsNo:grade combo needs refresh.
 */
function needsRefresh(pcgsNo, grade) {
  const entry = getManifestEntry(pcgsNo, grade);
  if (!entry) return true;
  return new Date(entry.freshUntil) <= new Date();
}

// ── HTTP helper ─────────────────────────────────────────────
async function aprGet(urlPath) {
  if (pcgsQuota.isBreakerTripped()) {
    throw new Error('PCGS quota breaker tripped — no API calls until midnight PT reset');
  }

  const url = `${PCGS_BASE}${urlPath}`;
  try {
    const resp = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${PCGS_API_KEY}`,
        Accept: 'application/json'
      },
      timeout: TIMEOUT
    });

    // Sync quota from response headers
    const remaining = parseInt(resp.headers['x-ratelimit-remaining'], 10);
    const limit = parseInt(resp.headers['x-ratelimit-limit'], 10);
    if (!isNaN(remaining)) {
      pcgsQuota.syncFromHeaders(remaining, isNaN(limit) ? undefined : limit);
    }
    pcgsQuota.recordCall('apr');

    return resp.data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) {
      pcgsQuota.tripBreaker();
      throw new Error('PCGS API rate limit exceeded (429) — breaker tripped');
    }
    // Still sync headers on error responses if available
    if (err.response?.headers) {
      const remaining = parseInt(err.response.headers['x-ratelimit-remaining'], 10);
      const limit = parseInt(err.response.headers['x-ratelimit-limit'], 10);
      if (!isNaN(remaining)) {
        pcgsQuota.syncFromHeaders(remaining, isNaN(limit) ? undefined : limit);
      }
    }
    throw err;
  }
}

// ── Date helpers ────────────────────────────────────────────
function rollingStartDate() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - DATE_WINDOW_YEARS);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;
}

function todayEndDate() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;
}

// ── Storage helpers ─────────────────────────────────────────
function getStoragePath(pcgsNo) {
  return path.join(APR_DIR, `${pcgsNo}.json`);
}

function loadCoinFile(pcgsNo) {
  const filePath = getStoragePath(pcgsNo);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { pcgsNo, name: null, grades: {} };
  }
}

function saveCoinFile(pcgsNo, data) {
  const filePath = getStoragePath(pcgsNo);
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Deduplicate auction records. Key: LotNo + Auctioneer + Date + Price.
 */
function dedupeRecords(existing, incoming) {
  const keySet = new Set(existing.map(r => `${r.LotNo}|${r.Auctioneer}|${r.Date}|${r.Price}`));
  const newRecords = [];
  for (const record of incoming) {
    const key = `${record.LotNo}|${record.Auctioneer}|${record.Date}|${record.Price}`;
    if (!keySet.has(key)) {
      keySet.add(key);
      newRecords.push(record);
    }
  }
  return { merged: [...existing, ...newRecords], added: newRecords.length };
}

// ── Public API ──────────────────────────────────────────────

/**
 * Fetch APR data by PCGS number + grade from the dedicated endpoint.
 * Merges results into local history store.
 * @param {number|string} pcgsNo
 * @param {number|string} grade
 * @param {object} [opts] - { force: false } to bypass freshness check
 * @returns {{ records: object[], stats: object, fromCache: boolean }}
 */
async function fetchByGrade(pcgsNo, grade, opts = {}) {
  if (!PCGS_API_KEY) throw new Error('PCGS API key not configured');

  const gradeInt = parseInt(String(grade).replace('+', ''), 10);
  const plusGrade = String(grade).includes('+');

  // Check freshness (skip API call if still fresh and not forced)
  if (!opts.force && !needsRefresh(pcgsNo, gradeInt)) {
    const cached = getHistory(pcgsNo, gradeInt);
    return { records: cached.records, stats: cached.stats, fromCache: true };
  }

  const startDate = rollingStartDate();
  const endDate = todayEndDate();

  const data = await aprGet(
    `/coindetail/GetAPRByGrade?PCGSNo=${pcgsNo}&GradeNo=${gradeInt}&PlusGrade=${plusGrade}&StartDate=${startDate}&EndDate=${endDate}&NumberOfRecords=${MAX_RECORDS}`
  );

  if (!data || !data.IsValidRequest) {
    return { records: [], stats: { count: 0 }, fromCache: false };
  }

  const auctions = data.Auctions || [];

  // Merge into persistent store
  const coinData = loadCoinFile(pcgsNo);
  if (!coinData.name && data.Name) coinData.name = data.Name;
  const gradeKey = String(gradeInt);
  const existing = coinData.grades[gradeKey]?.records || [];
  const { merged, added } = dedupeRecords(existing, auctions);

  // Sort by date descending
  merged.sort((a, b) => {
    const [am, ay] = (a.Date || '01-2000').split('-').map(Number);
    const [bm, by] = (b.Date || '01-2000').split('-').map(Number);
    return (by * 12 + bm) - (ay * 12 + am);
  });

  coinData.grades[gradeKey] = { records: merged };
  saveCoinFile(pcgsNo, coinData);
  setManifestEntry(pcgsNo, gradeInt, merged.length);

  const stats = computeStats(merged);
  return { records: merged, stats, fromCache: false, newRecords: added };
}

/**
 * Fetch APR by cert number (returns full history, potentially thousands).
 * @param {string|number} certNo
 */
async function fetchByCertNo(certNo) {
  if (!PCGS_API_KEY) throw new Error('PCGS API key not configured');

  const data = await aprGet(`/coindetail/GetAPRByCertNo/${certNo}`);
  if (!data || !data.IsValidRequest) {
    return { records: [], stats: { count: 0 } };
  }

  const auctions = data.Auctions || [];
  const pcgsNo = data.PCGSNo;
  const grade = data.Grade;

  // Merge into store if we have pcgsNo + grade
  if (pcgsNo && grade) {
    const coinData = loadCoinFile(pcgsNo);
    if (!coinData.name && data.Name) coinData.name = data.Name;
    const gradeKey = String(parseInt(grade, 10));
    const existing = coinData.grades[gradeKey]?.records || [];
    const { merged } = dedupeRecords(existing, auctions);
    coinData.grades[gradeKey] = { records: merged };
    saveCoinFile(pcgsNo, coinData);
    setManifestEntry(pcgsNo, parseInt(grade, 10), merged.length);
  }

  return { records: auctions, stats: computeStats(auctions), pcgsNo, grade: data.Grade };
}

/**
 * Read accumulated history from cache (no API call).
 * @param {number|string} pcgsNo
 * @param {number|string} grade
 */
function getHistory(pcgsNo, grade) {
  const coinData = loadCoinFile(pcgsNo);
  const gradeKey = String(parseInt(String(grade), 10));
  const records = coinData.grades[gradeKey]?.records || [];
  return {
    pcgsNo,
    name: coinData.name,
    grade: parseInt(gradeKey, 10),
    records,
    stats: computeStats(records),
    lastFetched: getManifestEntry(pcgsNo, gradeKey)?.lastFetched || null
  };
}

/**
 * Compute summary statistics from auction records.
 */
function computeStats(records) {
  if (!records || !records.length) return { count: 0, medianUsd: null, highUsd: null, lowUsd: null, avgUsd: null };
  const prices = records.map(r => r.Price).filter(p => p != null && p > 0);
  if (!prices.length) return { count: records.length, medianUsd: null, highUsd: null, lowUsd: null, avgUsd: null };
  prices.sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  return {
    count: prices.length,
    medianUsd: +median.toFixed(2),
    highUsd: prices[prices.length - 1],
    lowUsd: prices[0],
    avgUsd: +(prices.reduce((s, p) => s + p, 0) / prices.length).toFixed(2),
    auctionHouses: [...new Set(records.map(r => r.Auctioneer))],
    dateRange: {
      earliest: records[records.length - 1]?.Date || null,
      latest: records[0]?.Date || null
    }
  };
}

/**
 * Get the manifest for admin/status inspection.
 */
function getManifest() {
  return loadManifest();
}

/**
 * Get all entries that need refresh (for prefetch queue).
 * Returns entries sorted by staleness (oldest first), plus never-fetched combos.
 */
function getStaleEntries() {
  const manifest = loadManifest();
  const stale = [];
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (new Date(entry.freshUntil) <= new Date()) {
      stale.push({ key, ...entry });
    }
  }
  stale.sort((a, b) => new Date(a.lastFetched) - new Date(b.lastFetched));
  return stale;
}

/**
 * Update manifest run status (called by prefetchScheduler).
 */
function updateRunStatus(status, details = {}) {
  const manifest = loadManifest();
  manifest.lastRun = new Date().toISOString();
  manifest.lastRunStatus = status;
  Object.assign(manifest, details);
  _manifest = manifest;
  saveManifest();
}

module.exports = {
  fetchByGrade,
  fetchByCertNo,
  getHistory,
  computeStats,
  getManifest,
  getStaleEntries,
  needsRefresh,
  updateRunStatus,
  FRESHNESS_DAYS,
  DATE_WINDOW_YEARS
};
