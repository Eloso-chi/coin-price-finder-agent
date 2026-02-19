// Numista integration for CoinPriceDiscoveryAgent
// The real implementation is in src/services/numistaService.js
// This file is kept for backward compatibility.
const { lookupCoin, rarityFromMintage } = require('./src/services/numistaService');

async function fetchNumista(query) {
  // Delegate to the full Numista service
  const parsed = typeof query === 'string' ? { series: query } : query;
  return lookupCoin(parsed);
}

module.exports = { fetchNumista, lookupCoin, rarityFromMintage };