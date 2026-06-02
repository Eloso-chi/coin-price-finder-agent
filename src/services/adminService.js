// src/services/adminService.js — Admin dashboard data aggregation
// CommonJS

'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { shouldSkipRefresh } = require('./freshnessClassifier');

const TERAPEAK_DIR = process.env.TERAPEAK_DATA_DIR || 'data/terapeak';

// ── Staleness Tracker ───────────────────────────────────────

/**
 * Analyze staleness of all Terapeak datasets.
 * Uses newestSaleDate from aggregationMeta (pre-computed, no CSV re-parsing).
 *
 * By default, applies the same refresh-skip exclusions as
 * scripts/generate-freshness-report.js (dormant, confirmed-thin, thin-wait,
 * recently-confirmed-stale, dry-refresh-backoff). Set opts.includeSkipped=true
 * to bypass exclusions (useful for admin dashboards that want the full picture).
 *
 * @param {object} opts
 * @param {number} [opts.days=30]  -- flag datasets with no sale newer than this many days
 * @param {number} [opts.limit=50] -- max results to return (sorted stalest-first)
 * @param {boolean} [opts.includeSkipped=false] -- include datasets the freshness classifier would skip
 * @returns {{ stale: object[], summary: object }}
 */
function getStaleDatasets(opts = {}) {
  const days = opts.days || 30;
  const limit = opts.limit || 50;
  const includeSkipped = !!opts.includeSkipped;
  const cutoffDate = new Date(Date.now() - days * 86_400_000);
  const cutoffStr = cutoffDate.toISOString().split('T')[0]; // YYYY-MM-DD
  const now = new Date();

  // Primary path: read from terapeakService in-memory store (fast, uses sidecar data)
  const terapeakService = require('./terapeakService');
  const datasets = terapeakService.listDatasets();
  const results = [];
  let skippedCount = 0;
  const skippedByReason = {};

  for (const d of datasets) {
    const am = d.aggregationMeta || {};
    const newestSaleDate = am.newestSaleDate || null;
    const oldestSaleDate = am.oldestSaleDate || null;
    const compCount = d.compCount || 0;

    let ageDays = null;
    if (newestSaleDate) {
      ageDays = Math.round((Date.now() - new Date(newestSaleDate).getTime()) / 86_400_000);
    }

    const isStale = !newestSaleDate || newestSaleDate < cutoffStr;

    // Apply the same refresh-skip logic as the freshness report.
    // Build the meta shape shouldSkipRefresh() expects.
    const classifyMeta = {
      newestSaleDate,
      compCount,
      refreshCount: am.refreshCount || 0,
      lastRefreshAt: am.lastRefreshAt || am.page1At || null,
      noDataCount: am.noDataCount || 0,
      noDataAt: am.noDataAt || null,
      consecutiveDryRefreshes: am.consecutiveDryRefreshes || 0,
      csvExists: true, // listDatasets only returns datasets that have a store entry
      identifiers: d.identifiers || null, // Fix A of #245: classifier reads evidence
    };
    const skipDecision = shouldSkipRefresh(classifyMeta, now);

    if (skipDecision.skip) {
      skippedCount += 1;
      skippedByReason[skipDecision.reason] = (skippedByReason[skipDecision.reason] || 0) + 1;
      if (!includeSkipped) continue;
    }

    results.push({
      file: d.key.replace(/ /g, '_'),
      searchTerm: d.searchTerm || d.key,
      compCount,
      newestSoldDate: newestSaleDate,
      oldestSoldDate: oldestSaleDate,
      ageDays,
      isStale,
      ...(skipDecision.skip ? { skipReason: skipDecision.reason } : {}),
    });
  }

  // Sort: stalest first (null dates = infinitely stale, then by age descending)
  results.sort((a, b) => {
    if (a.ageDays === null && b.ageDays === null) return 0;
    if (a.ageDays === null) return -1;
    if (b.ageDays === null) return 1;
    return b.ageDays - a.ageDays;
  });

  const stale = results.filter(r => r.isStale).slice(0, limit);
  const totalCSVs = datasets.length;
  const staleCount = results.filter(r => r.isStale).length;

  // Generate filter regex for the top stale items (excludes skipped unless
  // includeSkipped=true, so refresh-stale.sh only scrapes actionable datasets).
  const filterTerms = stale
    .filter(s => !s.skipReason)
    .slice(0, limit)
    .map(s => _escapeRegex(s.searchTerm));
  const filterRegex = filterTerms.length > 0
    ? filterTerms.map(t => `^${t}$`).join('|')
    : '';

  return {
    stale,
    summary: {
      totalCSVs,
      staleCount,
      freshCount: totalCSVs - staleCount,
      staleDays: days,
      filterRegex,
      skippedCount,
      skippedByReason,
      includeSkipped,
    },
  };
}

/**
 * Get aggregate dataset health stats.
 * @returns {{ totalCSVs, totalComps, emptyCSVs, avgCompsPerCSV, oldestData, newestData }}
 */
function getDatasetHealth() {
  const csvFiles = _listCSVFiles();
  let totalComps = 0;
  let emptyCSVs = 0;
  let oldest = null;
  let newest = null;

  for (const csvPath of csvFiles) {
    const stats = _analyzeCSV(csvPath);
    if (!stats || stats.compCount === 0) {
      emptyCSVs++;
      continue;
    }
    totalComps += stats.compCount;
    if (stats.oldestSoldDate && (!oldest || stats.oldestSoldDate < oldest)) {
      oldest = stats.oldestSoldDate;
    }
    if (stats.newestSoldDate && (!newest || stats.newestSoldDate > newest)) {
      newest = stats.newestSoldDate;
    }
  }

  return {
    totalCSVs: csvFiles.length,
    totalComps,
    emptyCSVs,
    avgCompsPerCSV: csvFiles.length > 0 ? Math.round(totalComps / csvFiles.length) : 0,
    oldestData: oldest ? oldest.toISOString() : null,
    newestData: newest ? newest.toISOString() : null,
  };
}

// ── User & System Stats ─────────────────────────────────────

/**
 * Gather admin dashboard overview stats.
 * Lazy-requires services to avoid circular deps and keep this lightweight.
 */
function getDashboardStats() {
  const authService = require('./authService');
  const coinStorage = require('./coinStorageService');
  const terapeakService = require('./terapeakService');
  const quotaService = require('./terapeakQuotaService');

  // Users
  const users = authService.listUsers();
  const userStats = {
    totalUsers: users.length,
    users: users.map(u => ({
      username: u.username,
      userId: u.userId,
      createdAt: u.createdAt,
      coinCount: coinStorage.count(u.userId),
    })),
  };

  // Terapeak datasets (from in-memory store, fast)
  const datasets = terapeakService.listDatasets();
  const totalComps = datasets.reduce((s, d) => s + d.compCount, 0);
  const dataStats = {
    totalDatasets: datasets.length,
    totalComps,
  };

  // Quota
  const quota = quotaService.getStatus();

  return {
    users: userStats,
    data: dataStats,
    quota: {
      date: quota.date,
      used: quota.used,
      remaining: quota.remaining,
      limit: quota.limit,
    },
    uptime: Math.round(process.uptime()),
  };
}

// ── Internal helpers ────────────────────────────────────────

function _listCSVFiles() {
  const dir = path.resolve(TERAPEAK_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.csv'))
    .map(f => path.join(dir, f));
}

/**
 * Parse a CSV to extract comp count and date range.
 * Uses lightweight parsing — only reads Sold Date column.
 */
function _analyzeCSV(csvPath) {
  try {
    const raw = fs.readFileSync(csvPath, 'utf8').trim();
    if (!raw || raw === '') return null;

    const records = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });

    if (records.length === 0) return { compCount: 0, newestSoldDate: null, oldestSoldDate: null };

    let newest = null;
    let oldest = null;

    for (const row of records) {
      const dateStr = row['Sold Date'] || row['soldDate'] || row['sold_date'] || '';
      if (!dateStr) continue;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) continue;
      if (!newest || d > newest) newest = d;
      if (!oldest || d < oldest) oldest = d;
    }

    return { compCount: records.length, newestSoldDate: newest, oldestSoldDate: oldest };
  } catch {
    return null;
  }
}

function _escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  getStaleDatasets,
  getDatasetHealth,
  getDashboardStats,
  _analyzeCSV,       // exposed for testing
  _listCSVFiles,
};
