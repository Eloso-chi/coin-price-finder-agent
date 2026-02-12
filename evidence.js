// Evidence normalization and metrics logic for CoinPriceDiscoveryAgent
// Handles manual and source comps, computes metrics

function normalizeComp(comp, query) {
  // Only SOLD comps allowed
  if (!comp.sold_price) return null;
  // Compute all_in_price
  const shipping = comp.shipping || 0;
  const all_in_price = comp.sold_price + shipping;
  // Deduplication and filtering handled elsewhere
  // Match quality
  let match_quality = 'Weak';
  if (comp.grade === query.grade && comp.coin_name === query.coin_name) {
    match_quality = 'Exact';
  } else if (comp.grade === query.grade) {
    match_quality = 'Close';
  }
  // Traceability
  return {
    ...comp,
    all_in_price,
    source: comp.source || 'manual',
    match_quality,
    original: comp.original || comp,
    url: comp.url || null
  };
}

function computeMetrics(comps) {
  // Filter valid comps
  const used = comps.filter(c => !!c && !c.excluded);
  const prices = used.map(c => c.all_in_price);
  prices.sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  const date_range = used.length ? {
    start: used[0].sold_date,
    end: used[used.length - 1].sold_date
  } : { start: null, end: null };
  return {
    total_sold_found: comps.length,
    total_used_after_filter: used.length,
    median_sold_price: median,
    date_range
  };
}

module.exports = {
  normalizeComp,
  computeMetrics
};
