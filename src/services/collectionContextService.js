'use strict';

function summarizeCollection(coins) {
  const safeCoins = Array.isArray(coins) ? coins : [];
  const totalCount = safeCoins.reduce((sum, coin) => sum + (Number(coin.count) || 1), 0);
  const costedCoins = safeCoins.filter(coin => Number.isFinite(Number(coin.costPer)));
  const costBasis = costedCoins.reduce((sum, coin) => {
    return sum + (Number(coin.costPer) * (Number(coin.count) || 1));
  }, 0);
  const gaps = safeCoins.flatMap(coin => {
    const missing = [];
    if (!coin.query && !coin.series) missing.push('identification');
    if (!coin.year) missing.push('year');
    if (!coin.grade) missing.push('grade');
    if (!Number.isFinite(Number(coin.costPer))) missing.push('cost basis');
    return missing.length ? [{ coinHash: coin.coinHash || null, missing }] : [];
  });

  return {
    coinTypes: safeCoins.length,
    totalCount,
    costedTypes: costedCoins.length,
    costBasis: +costBasis.toFixed(2),
    gaps,
    uncertainty: gaps.length ? 'incomplete collection metadata' : 'collection metadata complete',
  };
}

function buildAnswer(intent, summary) {
  if (intent === 'gaps') {
    return summary.gaps.length
      ? `I found ${summary.gaps.length} collection item${summary.gaps.length === 1 ? '' : 's'} with missing information.`
      : 'Your collection has no detected metadata gaps.';
  }
  return `Your collection contains ${summary.totalCount} coin${summary.totalCount === 1 ? '' : 's'} across ${summary.coinTypes} type${summary.coinTypes === 1 ? '' : 's'}.`;
}

function getCollectionContext(coins, intent = 'summary') {
  const normalizedIntent = intent === 'gaps' ? 'gaps' : 'summary';
  const summary = summarizeCollection(coins);
  return {
    intent: normalizedIntent,
    answer: buildAnswer(normalizedIntent, summary),
    summary,
    provenance: {
      provider: 'deterministic-collection-context',
      source: 'authenticated-user-collection',
      observed: true,
      userDataOnly: true,
    },
  };
}

module.exports = { getCollectionContext, summarizeCollection };