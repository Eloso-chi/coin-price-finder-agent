// server.js — CoinPriceDiscoveryAgent entry point
// CommonJS

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ──────────────────────────────────────────────────
const priceRoute  = require('./src/routes/priceRoute');
const metalsRoute = require('./src/routes/metalsRoute');
app.use('/api/price', priceRoute);
app.use('/api/metals', metalsRoute);

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
app.listen(PORT, () => {
  console.log(`CoinPriceDiscoveryAgent listening on http://localhost:${PORT}`);
  console.log(`  eBay configured: ${!!(process.env.EBAY_APP_ID && process.env.EBAY_CLIENT_SECRET)}`);
  console.log(`  PCGS configured: ${!!process.env.PCGS_API_KEY}`);
  console.log(`  Metals configured: ${!!(process.env.GOLDAPI_KEY || process.env.METALS_API_KEY)}`);
});
