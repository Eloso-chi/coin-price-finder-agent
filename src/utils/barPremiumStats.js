// src/utils/barPremiumStats.js -- premium over spot by bar segment (#333H phase 3)
// Pure functions: classify sold bar listings, compute per-segment premium
// statistics and the brand-over-generic uplift. No file or network access.
// CommonJS
'use strict';

const { detectBarBrands, detectSeriesFromTitle } = require('../data/barSeries');
const { resolveProductIdentity } = require('./productIdentityResolver');
const { lookupSpotInEntries } = require('./spotLookup');

const GRAMS_PER_OZT = 31.1035;
const OZT_PER_KILO = 32.1507;
const METAL_SYMBOLS = { gold: 'XAU', silver: 'XAG', platinum: 'XPT', palladium: 'XPD' };

const WEIGHT_BUCKETS = [
  ['0.5 g', 0.5 / GRAMS_PER_OZT], ['1 g', 1 / GRAMS_PER_OZT], ['2.5 g', 2.5 / GRAMS_PER_OZT],
  ['5 g', 5 / GRAMS_PER_OZT], ['10 g', 10 / GRAMS_PER_OZT], ['20 g', 20 / GRAMS_PER_OZT],
  ['25 g', 25 / GRAMS_PER_OZT], ['50 g', 50 / GRAMS_PER_OZT], ['100 g', 100 / GRAMS_PER_OZT],
  ['250 g', 250 / GRAMS_PER_OZT], ['500 g', 500 / GRAMS_PER_OZT],
  ['1/10 oz', 0.1], ['1/4 oz', 0.25], ['1/2 oz', 0.5], ['1 oz', 1], ['2 oz', 2], ['5 oz', 5],
  ['10 oz', 10], ['20 oz', 20], ['50 oz', 50], ['100 oz', 100], ['1 kilo', OZT_PER_KILO], ['1000 oz', 1000],
];
const BUCKET_TOLERANCE = 0.02;
// A bar's price stays within this multiple of its metal, weight bucket and month's pooled median;
// outside it the weight in the title is wrong.
const PRICE_BAND = [0.5, 2.0];

const MULTI_ITEM_RE = /\b(?:lot|set|pcs|pieces?|bundle|collection|assortment)\b|\bx\s?\d+\b|\b\d+\s?x\b/i;

function bucketForWeight(ozt) {
  if (!Number.isFinite(ozt) || ozt <= 0) return null;
  const hit = WEIGHT_BUCKETS.find(([, w]) => Math.abs(ozt - w) / w <= BUCKET_TOLERANCE);
  return hit ? { label: hit[0], ozt: hit[1] } : null;
}

/**
 * Classify one sold-listing title as a single bar with a known weight, or say why not.
 * @returns {{ ok: true, metal, bucket, weightOzt, class, brand, series } | { ok: false, reason }}
 */
function classifyBarTitle(title) {
  const t = String(title || '');
  if (!/\b(?:bars?|combibar|kinebar)\b/i.test(t)) return { ok: false, reason: 'not-a-bar' };
  if (MULTI_ITEM_RE.test(t)) return { ok: false, reason: 'multi-item' };
  const identity = resolveProductIdentity({ text: t });
  const metal = identity.metal && METAL_SYMBOLS[identity.metal] ? identity.metal : null;
  if (!metal) return { ok: false, reason: 'no-metal' };
  const weight = identity.nominalWeightOz ?? identity.weight ?? null;
  const bucket = bucketForWeight(weight);
  if (!bucket) return { ok: false, reason: weight == null ? 'no-weight' : 'odd-weight' };
  const brands = detectBarBrands(t);
  if (brands.length > 1) return { ok: false, reason: 'multiple-makers' };
  const brand = brands[0] || null;
  const series = brand ? (detectSeriesFromTitle(brand, t)?.series || null) : null;
  return {
    ok: true,
    metal,
    bucket: bucket.label,
    weightOzt: bucket.ozt,
    class: brand ? (series ? 'series' : 'brand') : 'generic',
    brand,
    series,
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Drop values outside 1.5 IQR of the quartiles once there are at least 8 values. */
function trimOutliers(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 8) return sorted;
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  return sorted.filter(v => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
}

function summarize(values, digits) {
  const kept = trimOutliers(values);
  if (!kept.length) return null;
  const r = (v) => +v.toFixed(digits);
  return { n: kept.length, p25: r(quantile(kept, 0.25)), median: r(quantile(kept, 0.5)), p75: r(quantile(kept, 0.75)) };
}

function segmentKey(c, level) {
  return [c.metal, c.bucket, level, level === 'generic' ? '' : c.brand, level === 'series' ? c.series : ''].join('|');
}

/**
 * @param {Array<{title:string,totalUsd:number,soldDate:string|null}>} comps - deduplicated sold listings
 * @param {object} [opts]
 * @param {Object<string,Object<string,number>>} [opts.spotHistory] - { XAG: { 'YYYY-MM-DD': price } }
 * @param {number} [opts.minSample=10] - spot-matched comps needed to call a segment reliable
 * @returns {{ segments: object[], uplift: object[], source: object, spotCoverage: object|null }}
 */
function buildBarPremiumReport(comps, { spotHistory = null, minSample = 10 } = {}) {
  const excluded = {};
  const segs = new Map();
  const perMonth = new Map(); // metal|bucket|level|brand -> month -> prices
  let classified = 0;
  let withSpot = 0;
  let lastDay = null;

  const add = (key, meta, premium, price, day) => {
    let s = segs.get(key);
    if (!s) { s = { ...meta, prices: [], premiums: [], first: day, last: day }; segs.set(key, s); }
    s.prices.push(price);
    if (premium != null) s.premiums.push(premium);
    if (day) {
      if (!s.first || day < s.first) s.first = day;
      if (!s.last || day > s.last) s.last = day;
    }
  };

  // Pass 1: classify. Pass 2: drop prices far from the metal and weight bucket's pooled median
  // (a title that names one weight but sells another), then aggregate.
  const items = [];
  for (const comp of comps) {
    const cls = classifyBarTitle(comp.title);
    if (!cls.ok) { excluded[cls.reason] = (excluded[cls.reason] || 0) + 1; continue; }
    if (!(comp.totalUsd > 0)) { excluded['no-price'] = (excluded['no-price'] || 0) + 1; continue; }
    items.push({ comp, cls });
  }
  const pooled = new Map();
  const bandKey = ({ comp, cls }) => (comp.soldDate ? `${cls.metal}|${cls.bucket}|${String(comp.soldDate).slice(0, 7)}` : null);
  for (const item of items) {
    const k = bandKey(item);
    if (k) pooled.set(k, [...(pooled.get(k) || []), item.comp.totalUsd]);
  }
  const bands = new Map();
  for (const [k, prices] of pooled) {
    if (prices.length < 5) continue;
    const m = quantile([...prices].sort((a, b) => a - b), 0.5);
    bands.set(k, [m * PRICE_BAND[0], m * PRICE_BAND[1]]);
  }

  for (const item of items) {
    const { comp, cls } = item;
    const band = bands.get(bandKey(item));
    if (band && (comp.totalUsd < band[0] || comp.totalUsd > band[1])) {
      excluded['price-outlier'] = (excluded['price-outlier'] || 0) + 1;
      continue;
    }
    classified++;
    const day = comp.soldDate ? String(comp.soldDate).slice(0, 10) : null;
    if (day && (!lastDay || day > lastDay)) lastDay = day;
    const spot = spotHistory && day ? lookupSpotInEntries(spotHistory[METAL_SYMBOLS[cls.metal]], day) : null;
    const premium = spot ? comp.totalUsd / (cls.weightOzt * spot) - 1 : null;
    if (premium != null) withSpot++;

    // A series comp also counts for its maker (the brand segment admits every series).
    const levels = cls.brand ? ['brand', ...(cls.series ? ['series'] : [])] : ['generic'];
    for (const level of levels) {
      const key = segmentKey(cls, level);
      add(key, { metal: cls.metal, weightBucket: cls.bucket, class: level, brand: level === 'generic' ? null : cls.brand, series: level === 'series' ? cls.series : null },
        premium, comp.totalUsd, day);
      if (day) {
        const mk = `${cls.metal}|${cls.bucket}|${level === 'generic' ? 'generic' : 'brand'}|${level === 'generic' ? '' : cls.brand}`;
        if (level !== 'series') {
          const months = perMonth.get(mk) || new Map();
          const arr = months.get(day.slice(0, 7)) || [];
          arr.push(comp.totalUsd);
          months.set(day.slice(0, 7), arr);
          perMonth.set(mk, months);
        }
      }
    }
  }

  const segments = [...segs.entries()]
    .map(([key, s]) => ({
      key,
      metal: s.metal,
      weightBucket: s.weightBucket,
      class: s.class,
      brand: s.brand,
      series: s.series,
      n: s.prices.length,
      price: summarize(s.prices, 2),
      premium: s.premiums.length ? summarize(s.premiums, 4) : null,
      nWithSpot: s.premiums.length,
      reliable: s.premiums.length >= minSample,
      firstSold: s.first || null,
      lastSold: s.last || null,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // Brand over generic: same-month price ratio, so no spot history is needed.
  const uplift = [];
  for (const [mk, months] of perMonth) {
    const [metal, bucket, level, brand] = mk.split('|');
    if (level !== 'brand') continue;
    const genericMonths = perMonth.get(`${metal}|${bucket}|generic|`);
    if (!genericMonths) continue;
    const ratios = [];
    for (const [month, prices] of months) {
      const g = genericMonths.get(month);
      if (!g || prices.length < 3 || g.length < 3) continue;
      const med = (arr) => quantile([...arr].sort((a, b) => a - b), 0.5);
      ratios.push(med(prices) / med(g));
    }
    if (!ratios.length) continue;
    ratios.sort((a, b) => a - b);
    uplift.push({ metal, weightBucket: bucket, brand, months: ratios.length, priceRatio: +quantile(ratios, 0.5).toFixed(3) });
  }
  uplift.sort((a, b) => `${a.metal}|${a.weightBucket}|${a.brand}`.localeCompare(`${b.metal}|${b.weightBucket}|${b.brand}`));

  return {
    segments,
    uplift,
    source: { comps: comps.length, classified, excluded: Object.fromEntries(Object.entries(excluded).sort()), lastSold: lastDay },
    spotCoverage: spotHistory ? { compsWithSpot: withSpot, compsWithoutSpot: classified - withSpot } : null,
  };
}

const LINE_STOPWORDS = new Set(('bar bars silver gold platinum palladium oz ozt troy ounce ounces gram grams gm g kilo kg fine pure ' +
  'and the of in with a an new sealed assay card certificate coa in-assay mint minted swiss suisse edelmetalle ' +
  'bullion precious metal metals sale free shipping rare ingot lot').split(/\s+/));

/**
 * Words and word pairs that recur in sold titles of one maker's bars and are not yet a
 * catalogued series. Use it to check a line name against real sold titles before adding it
 * to BAR_SERIES: a real line shows up many times; a seller's decoration does not.
 * @param {Array<{title:string}>} comps
 * @param {{ minCount?: number, top?: number }} [opts]
 * @returns {Array<{ brand:string, candidates: Array<{ phrase:string, count:number }> }>}
 */
function buildLineCandidates(comps, { minCount = 5, top = 12 } = {}) {
  const byBrand = new Map();
  for (const comp of comps) {
    const cls = classifyBarTitle(comp.title);
    if (!cls.ok || !cls.brand || cls.series) continue;
    const brandWords = new Set(cls.brand.toLowerCase().split(/[^a-z]+/).filter(Boolean));
    const words = String(comp.title).toLowerCase().split(/[^a-z]+/)
      .filter(w => w.length > 2 && !LINE_STOPWORDS.has(w) && !brandWords.has(w));
    const counts = byBrand.get(cls.brand) || new Map();
    const seen = new Set();
    for (let i = 0; i < words.length; i++) {
      seen.add(words[i]);
      if (i + 1 < words.length) seen.add(`${words[i]} ${words[i + 1]}`);
    }
    for (const phrase of seen) counts.set(phrase, (counts.get(phrase) || 0) + 1);
    byBrand.set(cls.brand, counts);
  }
  return [...byBrand.entries()]
    .map(([brand, counts]) => ({
      brand,
      candidates: [...counts.entries()]
        .filter(([, count]) => count >= minCount)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, top)
        .map(([phrase, count]) => ({ phrase, count })),
    }))
    .filter(b => b.candidates.length)
    .sort((a, b) => a.brand.localeCompare(b.brand));
}

module.exports = {
  WEIGHT_BUCKETS,
  bucketForWeight,
  classifyBarTitle,
  quantile,
  trimOutliers,
  buildBarPremiumReport,
  buildLineCandidates,
};
