// server.js — CoinPriceDiscoveryAgent entry point
// CommonJS

require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ──────────────────────────────────────────────────
const priceRoute       = require('./src/routes/priceRoute');
const metalsRoute      = require('./src/routes/metalsRoute');
const barPriceRoute    = require('./src/routes/barPriceRoute');
const coinVariantRoute = require('./src/routes/coinVariantRoute');
const marketRoute      = require('./src/routes/marketRoute');
const terapeakRoute    = require('./src/routes/terapeakRoute');
app.use('/api/price', priceRoute);
app.use('/api/metals', metalsRoute);
app.use('/api/bar-price', barPriceRoute);
app.use('/api/coin-variant', coinVariantRoute);
app.use('/api/market/ebay', marketRoute);
app.use('/api/terapeak', terapeakRoute);

// Clear all caches
app.post('/api/clear-cache', (_req, res) => {
  const ebay = require('./src/services/ebayService');
  const pcgs = require('./src/services/pcgsService');
  const market = require('./src/services/marketAggregator');
  ebay.clearCache();
  pcgs.clearCache();
  market.clearCache();
  res.json({ status: 'ok', message: 'All caches cleared' });
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    ebayConfigured: !!(process.env.EBAY_APP_ID && process.env.EBAY_CLIENT_SECRET),
    pcgsConfigured: !!process.env.PCGS_API_KEY,
    metalsConfigured: !!(process.env.GOLDAPI_KEY || process.env.METALS_API_KEY)
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
  const autoResult = terapeakService.autoImportFolder('data/terapeak');
  if (autoResult.imported > 0) {
    console.log(`  Terapeak auto-import: ${autoResult.imported} new file(s) loaded from data/terapeak/`);
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
});
