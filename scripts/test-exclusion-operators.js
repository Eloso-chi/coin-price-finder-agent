#!/usr/bin/env node
/**
 * Broad regression test: verify that eBay exclusion operators (-gold, -silver)
 * in keywords do NOT poison Terapeak fuzzy matching for a variety of coins.
 */
const { lookupComps } = require('../src/services/terapeakService');

// Silver coins that get "-gold" appended by buildKeywords
const silverCoins = [
  { query: '2024 American Silver Eagle 1 oz -gold', metal: 'silver', expect: 'Silver' },
  { query: '2023 Canada 1 oz Silver Maple Leaf -gold', metal: 'silver', expect: 'Silver' },
  { query: '2025 Mexico 1 oz Silver Libertad -gold', metal: 'silver', expect: 'Silver' },
  { query: '2022 Australia 1 oz Silver Kookaburra -gold', metal: 'silver', expect: 'Silver' },
  { query: '2024 Great Britain 1 oz Silver Britannia -gold', metal: 'silver', expect: 'Silver' },
  { query: '2024 Austria 1 oz Silver Philharmonic -gold', metal: 'silver', expect: 'Silver' },
  { query: '2024 China 30g Silver Panda -gold', metal: 'silver', expect: 'Silver' },
  { query: '2025 Perth Lunar Snake 1 oz silver -gold', metal: 'silver', expect: 'silver' },
  { query: '1987 Mexico Silver Libertad 1 oz -gold', metal: 'silver', expect: 'Silver' },
  { query: '2017 Silver Krugerrand 1 oz -gold', metal: 'silver', expect: 'Silver' },
  { query: '2019 American Silver Eagle BU -proof -enhanced -S -gold', metal: 'silver', expect: 'Silver' },
  { query: '2021 American Silver Eagle Type 1 -gold', metal: 'silver', expect: 'Silver' },
  { query: 'silver libertad 1 oz -proof -gold', metal: 'silver', expect: 'silver' },
];

// Gold coins that get "-silver" appended by buildKeywords
const goldCoins = [
  { query: '2024 American Gold Eagle 1 oz -silver', metal: 'gold', expect: 'Gold' },
  { query: '2025 Canada 1 oz Gold Maple Leaf -silver', metal: 'gold', expect: 'Gold' },
  { query: '2024 Mexico 1 oz Gold Libertad -silver', metal: 'gold', expect: 'Gold' },
  { query: '2024 Australia 1 oz Gold Kangaroo -silver', metal: 'gold', expect: 'Gold' },
  { query: '2024 Great Britain 1 oz Gold Britannia -silver', metal: 'gold', expect: 'Gold' },
  { query: '2024 Austria 1 oz Gold Philharmonic -silver', metal: 'gold', expect: 'Gold' },
  { query: '2025 American Gold Buffalo 1 oz -silver', metal: 'gold', expect: 'Gold' },
  { query: '2024 South Africa 1 oz Gold Krugerrand -silver', metal: 'gold', expect: 'Gold' },
  { query: '2025 Lunar Snake 1 oz Gold -silver', metal: 'gold', expect: 'Gold' },
  { query: '2021 American Gold Eagle Type 1 -silver', metal: 'gold', expect: 'Gold' },
];

let failures = 0;
let passes = 0;

console.log('=== SILVER COINS (with -gold exclusion) ===');
for (const c of silverCoins) {
  const r = lookupComps(c.query, { metal: c.metal });
  const searchTerm = r ? r.searchTerm : '';
  const hasExpected = searchTerm.toLowerCase().includes(c.expect.toLowerCase());
  const hasWrongMetal = searchTerm.toLowerCase().includes('gold');
  const pass = hasExpected && !hasWrongMetal;
  if (pass) {
    passes++;
    console.log(`  [PASS] ${c.query}`);
    console.log(`         -> ${searchTerm} (${r.comps.length} comps)`);
  } else {
    failures++;
    console.log(`  [FAIL] ${c.query}`);
    console.log(`         -> ${searchTerm || 'null'} (${r ? r.comps.length : 0} comps)`);
    console.log(`         Expected "${c.expect}" in searchTerm, got wrong metal`);
  }
}

console.log('');
console.log('=== GOLD COINS (with -silver exclusion) ===');
for (const c of goldCoins) {
  const r = lookupComps(c.query, { metal: c.metal });
  const searchTerm = r ? r.searchTerm : '';
  const hasExpected = searchTerm.toLowerCase().includes(c.expect.toLowerCase());
  const hasWrongMetal = searchTerm.toLowerCase().includes('silver');
  const pass = hasExpected && !hasWrongMetal;
  if (pass) {
    passes++;
    console.log(`  [PASS] ${c.query}`);
    console.log(`         -> ${searchTerm} (${r.comps.length} comps)`);
  } else {
    failures++;
    console.log(`  [FAIL] ${c.query}`);
    console.log(`         -> ${searchTerm || 'null'} (${r ? r.comps.length : 0} comps)`);
    console.log(`         Expected "${c.expect}" in searchTerm, got wrong metal`);
  }
}

console.log('');
console.log(`=== RESULT: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'} (${passes + failures} coins tested) ===`);
process.exit(failures > 0 ? 1 : 0);
