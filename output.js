// Output schema builder for CoinPriceDiscoveryAgent
// Ensures strict JSON structure for audit-friendly results

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
    ebay_sold: cache.ebay_metrics || {},
    greysheet_cdn: cache.greysheet || {},
    pcgs_coinfacts: cache.pcgs || {},
    numista: cache.numista || {}
  };

  // Comps (manual + ebay)
  const comps = [
    ...(cache.manual_comps || []),
    ...(cache.ebay_comps || [])
  ];

  // Time series (last 6 months, weekly buckets)
  const time_series = {
    points: [],
    // TODO: implement time bucketing and median calculation
    summary: 'Time series not implemented yet.'
  };

  // Combined estimate
  const combined_estimate = {
    estimated_fmv: sources.greysheet_cdn.bid && sources.greysheet_cdn.ask
      ? (sources.greysheet_cdn.bid + sources.greysheet_cdn.ask) / 2
      : sources.ebay_sold.median_sold_price || null,
    low: Math.min(...comps.map(c => c.all_in_price)),
    high: Math.max(...comps.map(c => c.all_in_price)),
    confidence: comps.length > 5 ? 0.8 : 0.5,
    reasoning: 'Estimate based on available comps and source diversity.'
  };

  // Limitations
  const limitations = cache.limitations || [];

  // History
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
    time_series,
    combined_estimate,
    limitations
  };
}

module.exports = { buildOutput };
