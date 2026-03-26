// server.js — CoinPriceDiscoveryAgent entry point
// CommonJS

require('dotenv').config();

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
  const provided = req.headers['x-api-key'] || req.query.apiKey;
  if (provided !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// ── Middleware ───────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],   // inline <script> in SPA
      styleSrc:   ["'self'", "'unsafe-inline'"],   // inline <style> in SPA
      imgSrc:     ["'self'", 'data:', 'https://i.ebayimg.com', 'https://images.pcgs.com', 'https://*.ebayimg.com'],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      frameAncestors: ["'none'"],
    }
  }
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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ──────────────────────────────────────────────────
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
app.use('/api/price', apiLimiter, priceRoute);
app.use('/api/metals', metalsRoute);
app.use('/api/bar-price', apiLimiter, barPriceRoute);
app.use('/api/coin-variant', coinVariantRoute);
app.use('/api/market/ebay', apiLimiter, marketRoute);
app.use('/api/terapeak', terapeakRoute);
app.use('/api/pricing-batch', apiLimiter, pricingBatchRoute);
app.use('/api/image-proxy', imageProxyRoute);
app.use('/api/coin-history', coinHistoryRoute);
app.use('/api/import/excel', apiLimiter, excelImportRoute);

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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`CoinPriceDiscoveryAgent listening on http://localhost:${PORT}`);
  console.log(`  eBay configured: ${!!(process.env.EBAY_APP_ID && process.env.EBAY_CLIENT_SECRET)}`);
  console.log(`  PCGS configured: ${!!process.env.PCGS_API_KEY}`);
  console.log(`  Metals configured: ${!!(process.env.GOLDAPI_KEY || process.env.METALS_API_KEY)}`);

  // ── Startup: auto-import Terapeak CSVs from data/terapeak/ folder ──
  const terapeakService = require('./src/services/terapeakService');

  // Evict stale Terapeak comps (>180 days old) before importing new data
  const evictResult = terapeakService.evictStaleComps(180);
  if (evictResult.compsEvicted > 0) {
    console.log(`  Terapeak stale eviction: removed ${evictResult.compsEvicted} comps older than 180d`);
  }

  // Purge CSV files where every comp is older than 180 days
  const purgeResult = terapeakService.purgeStaleCSVs('data/terapeak', 180);
  if (purgeResult.deleted > 0) {
    console.log(`  Terapeak CSV purge: deleted ${purgeResult.deleted} stale file(s): ${purgeResult.deletedFiles.join(', ')}`);
  }

  const autoResult = terapeakService.autoImportFolder('data/terapeak');
  if (autoResult.imported > 0) {
    console.log(`  Terapeak auto-import: ${autoResult.imported} new file(s) loaded from data/terapeak/`);
    // Clear eBay cache when Terapeak data changes — prevents stale
    // cached results from hiding freshly imported comp data
    const ebayService = require('./src/services/ebayService');
    ebayService.clearCache();
    console.log(`  eBay cache cleared (Terapeak data updated)`);
  }
  if (autoResult.errors.length > 0) {
    console.warn(`  Terapeak auto-import errors: ${autoResult.errors.join('; ')}`);
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
});
