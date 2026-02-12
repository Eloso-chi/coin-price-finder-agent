// Output schema builder for CoinPriceDiscoveryAgent
// Ensures strict JSON structure for audit-friendly results

const { estimateFMV } = require('./evidence');

function buildOutput({ query_id, run_id, mode, run_date, query, cache }) {
  // Headline summary
  const headline = {
    query_id,
    run_id,
    mode,
    run_date,
    summary: `Valuation for ${query.coin_name} (${query.grade}) as of ${run_date}`
  };

  // Sources
  const sources = {
    ebay: cache.ebay_metrics || {},
    greysheet: cache.greysheet || {},
    pcgs: cache.pcgs || {},
    numista: cache.numista || {}
  };

  // All usable comps (manual + eBay)
  const comps = [
    ...(cache.manual_comps || []),
    ...(cache.ebay_comps || [])
  ];

  // ── FMV Estimation ────────────────────────────────────────────
  const anchorPrices = {
    greysheet_bid: cache.greysheet?.bid || null,
    greysheet_ask: cache.greysheet?.ask || null,
    pcgs_price: cache.pcgs?.price || null
  };
  const fmvResult = estimateFMV(comps, anchorPrices);

  const combined_estimate = {
    estimated_fmv: fmvResult.fmv,
    low: fmvResult.low,
    high: fmvResult.high,
    confidence: fmvResult.confidence,
    method: fmvResult.method,
    comp_count: fmvResult.comp_count,
    reasoning: fmvResult.reasoning
  };

  // Limitations
  const limitations = cache.limitations || [];

  // History meta
  const history = {
    query_id,
    run_id,
    mode,
    run_date,
    cache
  };

  return {
    history,
    query,
    headline,
    sources,
    comps,
    combined_estimate,
    limitations
  };
}

module.exports = { buildOutput };
