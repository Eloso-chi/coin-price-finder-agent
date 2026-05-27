'use strict';

// Mulberry32 PRNG -- public domain, by Tommy Ettinger.
// https://gist.github.com/tommyettinger/46a3c5d3e10cae7be4f7
function mulberry32(seed) {
  let s = seed | 0;
  return function rand() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeSeed(seed) {
  if (seed == null) return Date.now() >>> 0;
  if (Number.isInteger(seed)) return seed >>> 0;
  const asNum = Number(seed);
  if (Number.isFinite(asNum)) return asNum >>> 0;
  let hash = 2166136261;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pick(array, rand) {
  return array[Math.floor(rand() * array.length)];
}

function randomInt(min, max, rand) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(rand() * (hi - lo + 1));
}

function generateRandomLots(options = {}) {
  const {
    pool,
    lotCount = 8,
    minLotSize = 4,
    maxLotSize = 10,
    maxQty = 3,
    allowDuplicates = true,
    seed,
  } = options;

  if (!Array.isArray(pool) || pool.length === 0) {
    throw new Error('pool is required and must contain at least one coin query');
  }

  const normalizedPool = pool
    .map((c) => (typeof c === 'string' ? c : c && c.q))
    .filter(Boolean);

  if (normalizedPool.length === 0) {
    throw new Error('pool did not contain any valid query strings');
  }

  const resolvedSeed = normalizeSeed(seed);
  const rand = mulberry32(resolvedSeed);
  const lots = [];

  for (let i = 0; i < lotCount; i++) {
    const lotSize = randomInt(minLotSize, maxLotSize, rand);
    const lot = [];
    const used = new Set();

    for (let j = 0; j < lotSize; j++) {
      let query = pick(normalizedPool, rand);
      if (!allowDuplicates) {
        let guard = 0;
        while (used.has(query) && guard < normalizedPool.length * 2) {
          query = pick(normalizedPool, rand);
          guard++;
        }
        used.add(query);
      }
      lot.push({ query, qty: randomInt(1, maxQty, rand) });
    }

    lots.push({
      id: `lot-${i + 1}`,
      seed: resolvedSeed,
      items: lot,
    });
  }

  return { seed: resolvedSeed, lots };
}

module.exports = {
  generateRandomLots,
};
