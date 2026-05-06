#!/usr/bin/env node
// Audit: Analyze 1987 Silver Libertad sold comps for data quality issues
const { lookupComps } = require('../src/services/terapeakService');
const { classifyGradeType } = require('../src/services/ebayService');
const { isDenied } = require('../src/utils/filters');
const stats = require('../src/utils/stats');

const dataset = lookupComps('1987 Mexico Silver Libertad 1 oz -gold', { metal: 'silver' });
console.log('Dataset:', dataset.searchTerm);
console.log('Total comps:', dataset.comps.length);

// Apply the same filtering as the valuation pipeline
let comps = dataset.comps.filter(c => !isDenied(c.title || ''));
console.log('After denied filter:', comps.length);

// Classify grade types
const graded = comps.filter(c => classifyGradeType(c) === 'graded');
const raw = comps.filter(c => classifyGradeType(c) === 'raw');
console.log('Graded:', graded.length, '| Raw:', raw.length);

// Show what was classified as graded
if (graded.length > 0) {
  console.log('\n=== GRADED COMPS (excluded from valuation) ===');
  graded.slice(0, 20).forEach((c, i) => {
    console.log(`  ${i + 1}. $${c.totalUsd.toFixed(2)} — ${(c.title || '').substring(0, 90)}`);
  });
}

// Analyze the raw comps (what valuation uses)
const prices = raw.map(c => c.totalUsd).sort((a, b) => a - b);
console.log('\n=== RAW COMPS PRICE DISTRIBUTION ===');
console.log('Count:', prices.length);
console.log('Min: $' + prices[0] + ' | Max: $' + prices[prices.length - 1]);
console.log('Median: $' + stats.median(prices));
console.log('Mean: $' + stats.mean(prices).toFixed(2));
console.log('P25: $' + stats.percentile(prices, 25));
console.log('P75: $' + stats.percentile(prices, 75));

// MAD outlier detection (same 3.5x threshold as valuation)
const med = stats.median(prices);
const deviations = prices.map(p => Math.abs(p - med));
const mad = stats.median(deviations) || 1;
const outlierThreshold = 3.5 * mad;
const outliers = raw.filter(c => Math.abs(c.totalUsd - med) > outlierThreshold);
console.log(`\nMAD: $${mad.toFixed(2)} | Outlier threshold: ±$${outlierThreshold.toFixed(2)} from median`);
console.log(`Outliers (would be removed): ${outliers.length}`);

// Top 15 highest priced - check for graded coins that slipped through
console.log('\n=== TOP 15 HIGHEST PRICED RAW COMPS ===');
const byPrice = [...raw].sort((a, b) => b.totalUsd - a.totalUsd);
byPrice.slice(0, 15).forEach((c, i) => {
  const title = (c.title || '').substring(0, 85);
  const flag = title.match(/NGC|PCGS|MS[\s-]?\d|PR[\s-]?\d|PF[\s-]?\d/i) ? ' *** GRADED?' : '';
  console.log(`  ${i + 1}. $${c.totalUsd.toFixed(2)} — ${title}${flag}`);
});

// Bottom 10 - check for suspicious lows
console.log('\n=== BOTTOM 10 CHEAPEST RAW COMPS ===');
const bottom = [...raw].sort((a, b) => a.totalUsd - b.totalUsd);
bottom.slice(0, 10).forEach((c, i) => {
  const title = (c.title || '').substring(0, 85);
  const flag = title.match(/lot|set|damaged|cull|cleaned/i) ? ' *** SUSPECT' : '';
  console.log(`  ${i + 1}. $${c.totalUsd.toFixed(2)} — ${title}${flag}`);
});

// Check for multi-coin listings (lots that got through)
console.log('\n=== POTENTIAL LOTS/MULTI-COIN (checking titles) ===');
const lotPatterns = /\b(lot|set|\d+\s*x\s*|\d+\s*pcs?|group|collection|roll|tube|sheet)\b/i;
const multiCoin = raw.filter(c => lotPatterns.test(c.title || ''));
console.log(`Found ${multiCoin.length} potential lot/multi-coin listings:`);
multiCoin.forEach((c, i) => {
  console.log(`  ${i + 1}. $${c.totalUsd.toFixed(2)} — ${(c.title || '').substring(0, 85)}`);
});

// Check for wrong year/wrong coin
console.log('\n=== POTENTIAL WRONG YEAR/COIN (no "1987" or "Libertad" in title) ===');
const wrongCoin = raw.filter(c => {
  const t = (c.title || '').toLowerCase();
  return !t.includes('1987') && !t.includes('libertad');
});
console.log(`Found ${wrongCoin.length} comps missing both "1987" and "Libertad":`);
wrongCoin.slice(0, 10).forEach((c, i) => {
  console.log(`  ${i + 1}. $${c.totalUsd.toFixed(2)} — ${(c.title || '').substring(0, 85)}`);
});

// Check for gold coins that leaked in
console.log('\n=== POTENTIAL GOLD COINS IN DATASET ===');
const goldLeaks = raw.filter(c => {
  const t = (c.title || '').toLowerCase();
  return t.includes('gold') && !t.includes('-gold');
});
console.log(`Found ${goldLeaks.length} comps with "gold" in title:`);
goldLeaks.forEach((c, i) => {
  console.log(`  ${i + 1}. $${c.totalUsd.toFixed(2)} — ${(c.title || '').substring(0, 85)}`);
});

// Check for fractional (non-1oz) coins
console.log('\n=== POTENTIAL FRACTIONAL (not 1 oz) ===');
const fractional = raw.filter(c => {
  const t = (c.title || '').toLowerCase();
  return /\b(1\/2|1\/4|1\/10|1\/20|half|quarter|2\s*oz|5\s*oz|10\s*oz)\b/.test(t);
});
console.log(`Found ${fractional.length} potential fractional/multi-oz:`);
fractional.forEach((c, i) => {
  console.log(`  ${i + 1}. $${c.totalUsd.toFixed(2)} — ${(c.title || '').substring(0, 85)}`);
});

// Check for PROOF coins in the raw pool (should be excluded)
console.log('\n=== PROOF COINS IN RAW POOL (should be filtered) ===');
const proofs = raw.filter(c => /\bproof\b/i.test(c.title || ''));
console.log(`Found ${proofs.length} proof comps:`);
proofs.forEach((c, i) => {
  console.log(`  ${i + 1}. $${c.totalUsd.toFixed(2)} — ${(c.title || '').substring(0, 85)}`);
});

// Check for DDO/DDR variety coins (premium varieties inflate price)
console.log('\n=== DDO/DDR/VARIETY COINS IN RAW POOL ===');
const varieties = raw.filter(c => /DDO|DDR|double die|lettered edge/i.test(c.title || ''));
console.log(`Found ${varieties.length} variety comps:`);
varieties.forEach((c, i) => {
  console.log(`  ${i + 1}. $${c.totalUsd.toFixed(2)} — ${(c.title || '').substring(0, 85)}`);
});

// Wrong year comps
console.log('\n=== WRONG YEAR (no "1987" in title) ===');
const wrongYear = raw.filter(c => {
  const t = (c.title || '');
  return !t.includes('1987');
});
console.log(`Found ${wrongYear.length} comps without "1987" in title:`);
wrongYear.forEach((c, i) => {
  console.log(`  ${i + 1}. $${c.totalUsd.toFixed(2)} — ${(c.title || '').substring(0, 85)}`);
});

// Multi-coin listings
console.log('\n=== MULTI-COIN LISTINGS ===');
const multi = raw.filter(c => /\b(2x|3x|pair|both|two|three|\d\s*coin)/i.test(c.title || ''));
console.log(`Found ${multi.length} multi-coin:`);
multi.forEach((c, i) => {
  console.log(`  ${i + 1}. $${c.totalUsd.toFixed(2)} — ${(c.title || '').substring(0, 85)}`);
});

// Summary impact
console.log('\n=== IMPACT SUMMARY ===');
const cleanRaw = raw.filter(c => {
  const t = (c.title || '');
  const isProof = /\bproof\b/i.test(t);
  const isVariety = /DDO|DDR|double die|lettered edge/i.test(t);
  const isMulti = /\b(2x|3x|pair|both|two|three|\d\s*coin)/i.test(t);
  const isWrongYear = !t.includes('1987');
  return !isProof && !isVariety && !isMulti && !isWrongYear;
});
const cleanPrices = cleanRaw.map(c => c.totalUsd).sort((a, b) => a - b);
console.log(`Original raw: ${raw.length} comps, median $${stats.median(prices)}`);
console.log(`After cleanup: ${cleanRaw.length} comps, median $${stats.median(cleanPrices)}`);
console.log(`Removed: ${raw.length - cleanRaw.length} problematic comps`);
console.log(`Median shift: $${stats.median(prices)} -> $${stats.median(cleanPrices)} (${((stats.median(cleanPrices) - stats.median(prices)) / stats.median(prices) * 100).toFixed(1)}%)`);
