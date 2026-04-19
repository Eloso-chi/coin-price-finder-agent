// server.js — CoinPriceDiscoveryAgent entry point
// CommonJS

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Admin API-key guard for destructive endpoints ───────────
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) {
    // No key configured — reject all admin calls so the endpoints
    // are locked-down by default on a fresh deploy.
    return res.status(403).json({ error: 'Admin API key not configured on server' });
  }
  const provided = req.headers['x-api-key'] || '';
  if (provided.length !== ADMIN_API_KEY.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(ADMIN_API_KEY))) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// ── Middleware ───────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // NOTE: unsafe-inline is required — index.html contains two large inline
      // <script> blocks (~3,400 lines total: main app logic + history chart).
      // Moving them to external files is tracked as a future refactor.
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],   // inline <style> in SPA
      imgSrc:     ["'self'", 'data:', 'https://i.ebayimg.com', 'https://images.pcgs.com', 'https://*.ebayimg.com'],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      frameAncestors: ["'none'"],
    }
  },
  // Enforce HTTPS via Strict-Transport-Security header.
  // Azure App Service terminates TLS; HSTS tells browsers to always use HTTPS.
  strictTransportSecurity: {
    maxAge: 31536000,          // 1 year
    includeSubDomains: true,
  },
}));

// Global rate limiter — 100 requests per minute per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});
app.use(globalLimiter);

// Stricter limiter for expensive API-calling routes
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 20 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many API requests, please try again later' }
});

// Dedicated limiter for file upload (Excel import) — tighter to prevent abuse
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many upload requests, please try again later' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ──────────────────────────────────────────────────
const authRoute        = require('./src/routes/authRoute');
const coinRoute        = require('./src/routes/coinRoute');
const priceRoute       = require('./src/routes/priceRoute');
const metalsRoute      = require('./src/routes/metalsRoute');
const barPriceRoute    = require('./src/routes/barPriceRoute');
const coinVariantRoute = require('./src/routes/coinVariantRoute');
const marketRoute      = require('./src/routes/marketRoute');
const terapeakRoute    = require('./src/routes/terapeakRoute');
const pricingBatchRoute = require('./src/routes/pricingBatchRoute');
const imageProxyRoute   = require('./src/routes/imageProxyRoute');
const coinHistoryRoute  = require('./src/routes/coinHistoryRoute');
const excelImportRoute  = require('./src/routes/excelImportRoute');
app.use('/api/auth', authRoute);
app.use('/api/coins', coinRoute);
app.use('/api/price', apiLimiter, priceRoute);
app.use('/api/metals', metalsRoute);
app.use('/api/bar-price', apiLimiter, barPriceRoute);
app.use('/api/coin-variant', coinVariantRoute);
app.use('/api/market/ebay', apiLimiter, marketRoute);
app.use('/api/terapeak', terapeakRoute);
app.use('/api/pricing-batch', apiLimiter, pricingBatchRoute);
app.use('/api/image-proxy', apiLimiter, imageProxyRoute);
app.use('/api/coin-history', coinHistoryRoute);
app.use('/api/import/excel', uploadLimiter, excelImportRoute);

// Clear all caches (admin-only)
app.post('/api/clear-cache', requireAdmin, (_req, res) => {
  const ebay    = require('./src/services/ebayService');
  const pcgs    = require('./src/services/pcgsService');
  const market  = require('./src/services/marketAggregator');
  const numista = require('./src/services/numistaService');
  const metals  = require('./src/services/metalsSpotPrice');
  const terapeak = require('./src/services/terapeakService');
  ebay.clearCache();
  pcgs.clearCache();
  market.clearCache();
  numista.clearCache();
  metals._reset();
  // Evict Terapeak comps older than 180 days
  const evicted = terapeak.evictStaleComps(180);
  res.json({ status: 'ok', message: 'All caches cleared', terapeakEvicted: evicted });
});

// Health check (minimal info — no config details)
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime()
  });
});

// ── Start ───────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`CoinPriceDiscoveryAgent listening on http://localhost:${PORT}`);
  console.log(`  eBay configured: ${!!(process.env.EBAY_APP_ID && process.env.EBAY_CLIENT_SECRET)}`);
  console.log(`  PCGS configured: ${!!process.env.PCGS_API_KEY}`);
  console.log(`  Metals configured: ${!!(process.env.GOLDAPI_KEY || process.env.METALS_API_KEY)}`);
  console.log(`  Cache dir: ${require('./src/utils/cachePath').CACHE_DIR}`);
  if (process.env.CACHE_DIR) {
    console.log(`  Cache dir (custom): ${process.env.CACHE_DIR}`);
  }

  // ── Auto-seed testcollector account (server-side) ──────────
  const authService = require('./src/services/authService');
  const coinStorageService = require('./src/services/coinStorageService');

  if (!authService.userExists('testcollector')) {
    const SEED_COINS = [
      { series: 'Morgan Dollar',              year: '1921', mint: 'D', grade: 'MS-65', weight: null, count: 3,  query: '1921-D Morgan Dollar MS-65' },
      { series: 'Morgan Dollar',              year: '1878', mint: 'S', grade: 'VF-30', weight: null, count: 1,  query: '1878-S Morgan Dollar VF-30' },
      { series: 'Peace Dollar',               year: '1923', mint: 'P', grade: 'MS-63', weight: null, count: 2,  query: '1923 Peace Dollar MS-63' },
      { series: 'Kennedy Half Dollar',        year: '1964', mint: 'P', grade: 'PR-69', weight: null, count: 1,  query: '1964 Kennedy Half Dollar PR-69' },
      { series: 'Walking Liberty Half Dollar', year:'1941', mint: 'S', grade: 'VF-25', weight: null, count: 1,  query: '1941-S Walking Liberty Half Dollar VF-25' },
      { series: 'American Silver Eagle',      year: '2024', mint: 'P', grade: 'MS-70', weight: 1,    count: 20, query: '2024 American Silver Eagle MS-70' },
      { series: 'Washington Quarter',         year: '1932', mint: 'D', grade: 'VG-10', weight: null, count: 1,  query: '1932-D Washington Quarter VG-10' },
      { series: 'Roosevelt Dime',             year: '1946', mint: 'P', grade: 'MS-66', weight: null, count: 5,  query: '1946 Roosevelt Dime MS-66' },
      { series: 'Buffalo Nickel',             year: '1937', mint: 'D', grade: 'MS-64', weight: null, count: 1,  query: '1937-D Buffalo Nickel MS-64' },
      { series: 'Lincoln Cent',               year: '1909', mint: 'S', grade: 'VF-20', weight: null, count: 1,  query: '1909-S Lincoln Cent VF-20' },
    ];
    authService.signup('testcollector', 'Coins2026!').then(result => {
      for (const coin of SEED_COINS) {
        coinStorageService.addCoin(result.userId, coin);
      }
      console.log(`  [seed] testcollector account created with ${SEED_COINS.length} coins`);
    }).catch(err => {
      console.warn(`  [seed] could not create test account: ${err.message}`);
    });
  } else {
    console.log(`  [seed] testcollector account already exists`);
  }
  // ── Startup: auto-import Terapeak CSVs from data/terapeak/ folder ──
  const terapeakService = require('./src/services/terapeakService');
  const TERAPEAK_DATA_DIR = process.env.TERAPEAK_DATA_DIR || 'data/terapeak';

  // Evict stale Terapeak comps (>180 days old) before importing new data
  const evictResult = terapeakService.evictStaleComps(180);
  if (evictResult.compsEvicted > 0) {
    console.log(`  Terapeak stale eviction: removed ${evictResult.compsEvicted} comps older than 180d`);
  }

  // Purge CSV files where every comp is older than 180 days
  const purgeResult = terapeakService.purgeStaleCSVs(TERAPEAK_DATA_DIR, 180);
  if (purgeResult.deleted > 0) {
    console.log(`  Terapeak CSV purge: deleted ${purgeResult.deleted} stale file(s): ${purgeResult.deletedFiles.join(', ')}`);
  }

  // Try blob storage first (#99), then fall back to local folder
  const blobClient = require('./src/utils/blobClient');
  let autoResult = { imported: 0, errors: [] };
  if (blobClient.isEnabled()) {
    try {
      autoResult = await terapeakService.autoImportFromBlob();
      if (autoResult.imported > 0) {
        console.log(`  Terapeak blob-import: ${autoResult.imported} new file(s) from Azure Blob Storage`);
      }
      if (autoResult.errors.length > 0) {
        console.warn(`  Terapeak blob-import errors: ${autoResult.errors.join('; ')}`);
      }
    } catch (err) {
      console.warn(`  Terapeak blob-import failed, falling back to local: ${err.message}`);
    }
  }
  // Always run local folder import too (may have CSVs not yet uploaded to blob)
  const localResult = terapeakService.autoImportFolder(TERAPEAK_DATA_DIR);
  if (localResult.imported > 0) {
    console.log(`  Terapeak auto-import: ${localResult.imported} new file(s) loaded from ${TERAPEAK_DATA_DIR}/`);
    autoResult.imported += localResult.imported;
  }
  if (localResult.errors.length > 0) {
    console.warn(`  Terapeak auto-import errors: ${localResult.errors.join('; ')}`);
  }
  if (autoResult.imported > 0) {
    const ebayService = require('./src/services/ebayService');
    ebayService.clearCache();
    console.log(`  eBay cache cleared (Terapeak data updated)`);
  }

  const datasets = terapeakService.listDatasets();
  if (datasets.length > 0) {
    const totalComps = datasets.reduce((s, d) => s + d.compCount, 0);
    console.log(`  Terapeak sold data: ${datasets.length} dataset(s), ${totalComps} total comps`);
  } else {
    console.log(`  Terapeak sold data: none — drop CSVs in data/terapeak/ or upload at /api/terapeak/import`);
  }

  // ── Background metals spot-price refresh (every 30 min) ──────────
  const metals = require('./src/services/metalsSpotPrice');
  const metalsHistory = require('./src/services/metalsHistoryService');
  const METALS_POLL_MS = parseInt(process.env.METALS_POLL_MS, 10) || 30 * 60 * 1000; // 30 min

  // Evict metals history entries older than 400 days on startup
  metalsHistory.evictOld(400);

  async function refreshMetalsPrices() {
    try {
      const result = await metals.getMetalsSpotPrices(['XAU', 'XAG', 'XPT', 'XPD']);
      const sources = [...new Set(Object.values(result).map(r => r.source))];
      console.log(`  [metals] Background refresh ok — sources: ${sources.join(', ')}`);
      // Record daily history snapshot for charting
      for (const [sym, data] of Object.entries(result)) {
        if (data.price) metalsHistory.recordDaily(sym, data.price, data.timestamp);
      }
    } catch (err) {
      console.warn(`  [metals] Background refresh failed: ${err.message}`);
    }
  }

  // Initial fetch on startup
  refreshMetalsPrices();

  // Repeat every 30 minutes
  setInterval(refreshMetalsPrices, METALS_POLL_MS);
  console.log(`  Metals spot price: polling every ${METALS_POLL_MS / 60000} min (round-robin across ${metals._providers.length} providers)`);

  // ── Background Greysheet history refresh (weekly) ──────────
  const greysheetHistory = require('./src/services/greysheetHistoryService');
  const { runRefresh: runGreysheetRefresh } = require('./scripts/greysheet-refresh');
  const GS_REFRESH_INTERVAL_DAYS = parseInt(process.env.GS_REFRESH_DAYS, 10) || 7;
  const GS_REFRESH_MS = GS_REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

  // Evict Greysheet history entries older than 200 days on startup
  greysheetHistory.evictOld(200);

  function needsGreysheetRefresh() {
    const lastRun = greysheetHistory.getLastRefreshDate();
    if (!lastRun) return true;
    const daysSince = (Date.now() - new Date(lastRun + 'T00:00:00Z').getTime()) / 86_400_000;
    return daysSince >= GS_REFRESH_INTERVAL_DAYS;
  }

  async function doGreysheetRefresh() {
    try {
      console.log('  [greysheet] Starting weekly price refresh...');
      const result = await runGreysheetRefresh({ delayMs: 500 });
      console.log(`  [greysheet] Refresh complete: ${result.totalSnapshots} snapshots, ${result.coinsTracked} coins tracked`);
    } catch (err) {
      console.warn(`  [greysheet] Refresh failed: ${err.message}`);
    }
  }

  // Check on startup if a refresh is due (delayed 10s to not block startup)
  setTimeout(() => {
    if (needsGreysheetRefresh()) {
      console.log(`  [greysheet] Last refresh: ${greysheetHistory.getLastRefreshDate() || 'never'} — starting refresh...`);
      doGreysheetRefresh();
    } else {
      console.log(`  [greysheet] Last refresh: ${greysheetHistory.getLastRefreshDate()} — next in ${GS_REFRESH_INTERVAL_DAYS}d (${greysheetHistory.coinCount()} coins tracked)`);
    }
  }, 10_000);

  // Safety-net interval: re-check every 24h in case the app stays up for weeks
  setInterval(() => {
    if (needsGreysheetRefresh()) doGreysheetRefresh();
  }, 24 * 60 * 60 * 1000);

  // ── Periodic blob re-import (every 30 min) ──────────────────
  // Picks up new CSVs uploaded directly to blob by scraping scripts (#107)
  const BLOB_REIMPORT_MS = parseInt(process.env.BLOB_REIMPORT_MS, 10) || 30 * 60 * 1000;
  if (blobClient.isEnabled()) {
    setInterval(async () => {
      try {
        const result = await terapeakService.autoImportFromBlob();
        if (result.imported > 0) {
          console.log(`  [terapeak] Blob re-import: ${result.imported} new file(s)`);
          const ebayService = require('./src/services/ebayService');
          ebayService.clearCache();
        }
      } catch (err) {
        console.warn(`  [terapeak] Blob re-import failed: ${err.message}`);
      }
    }, BLOB_REIMPORT_MS);
    console.log(`  Terapeak blob re-import: polling every ${BLOB_REIMPORT_MS / 60000} min`);
  }
});
