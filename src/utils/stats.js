// src/utils/stats.js — Statistical helpers for comp analysis
// CommonJS

/**
 * Sort-safe copy helper.
 */
function sorted(arr) {
  return [...arr].sort((a, b) => a - b);
}

/**
 * Arithmetic mean.
 */
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/**
 * Median of a numeric array.
 */
function median(arr) {
  if (!arr.length) return null;
  const s = sorted(arr);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Percentile (0–100). Uses linear interpolation.
 */
function percentile(arr, p) {
  if (!arr.length) return null;
  const s = sorted(arr);
  if (p <= 0) return s[0];
  if (p >= 100) return s[s.length - 1];
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return s[lo] + frac * (s[hi] - s[lo]);
}

/**
 * Standard deviation (sample).
 */
function stddev(arr) {
  const m = mean(arr);
  if (m === null || arr.length < 2) return 0;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

/**
 * Median Absolute Deviation (MAD).
 */
function mad(arr) {
  const med = median(arr);
  if (med === null) return 0;
  const deviations = arr.map(v => Math.abs(v - med));
  return median(deviations) || 0;
}

/**
 * Remove outliers using median ± k * MAD (default k = 3.5).
 * Returns { kept, removed }.
 */
function removeOutliersMAD(arr, k = 3.5) {
  if (arr.length < 4) return { kept: [...arr], removed: [] };
  const med = median(arr);
  const m = mad(arr);
  // Scale factor 1.4826 converts MAD to an estimator of σ for normal data
  const sigma = m * 1.4826;
  const lo = med - k * sigma;
  const hi = med + k * sigma;
  const kept = [];
  const removed = [];
  for (const v of arr) {
    if (v >= lo && v <= hi) kept.push(v);
    else removed.push(v);
  }
  return { kept, removed };
}

/**
 * Remove outliers using IQR fence (1.5×).
 * Returns { kept, removed }.
 */
function removeOutliersIQR(arr, factor = 1.5) {
  if (arr.length < 4) return { kept: [...arr], removed: [] };
  const s = sorted(arr);
  const q1 = s[Math.floor(s.length * 0.25)];
  const q3 = s[Math.floor(s.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - factor * iqr;
  const hi = q3 + factor * iqr;
  const kept = [];
  const removed = [];
  for (const v of arr) {
    if (v >= lo && v <= hi) kept.push(v);
    else removed.push(v);
  }
  return { kept, removed };
}

/**
 * Weighted median.
 * @param {number[]} values
 * @param {number[]} weights  – same length
 */
function weightedMedian(values, weights) {
  if (!values.length) return null;
  const pairs = values.map((v, i) => ({ v, w: weights[i] || 1 }));
  pairs.sort((a, b) => a.v - b.v);
  const totalW = pairs.reduce((s, p) => s + p.w, 0);
  let cum = 0;
  for (const p of pairs) {
    cum += p.w;
    if (cum >= totalW / 2) return p.v;
  }
  return pairs[pairs.length - 1]?.v ?? null;
}

/**
 * Build summary stats from an array of prices.
 * Sorts once and reuses the sorted array for all calculations.
 */
function summarize(prices) {
  if (!prices.length) {
    return { count: 0, mean: null, median: null, p25: null, p75: null, min: null, max: null, stddev: null, mad: null };
  }
  const s = sorted(prices);
  const m = mean(prices);
  const med = _sortedMedian(s);
  return {
    count: s.length,
    mean: +m.toFixed(2),
    median: +med.toFixed(2),
    p25: +_sortedPercentile(s, 25).toFixed(2),
    p75: +_sortedPercentile(s, 75).toFixed(2),
    min: +s[0].toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    stddev: +stddev(prices).toFixed(2),
    mad: +mad(prices).toFixed(2)
  };
}

/** Median from a pre-sorted array. */
function _sortedMedian(s) {
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Percentile from a pre-sorted array. */
function _sortedPercentile(s, p) {
  if (p <= 0) return s[0];
  if (p >= 100) return s[s.length - 1];
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (idx - lo) * (s[hi] - s[lo]);
}

module.exports = {
  mean,
  median,
  percentile,
  stddev,
  mad,
  removeOutliersMAD,
  removeOutliersIQR,
  weightedMedian,
  summarize,
  sorted
};
