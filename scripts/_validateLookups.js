#!/usr/bin/env node
// Temporary validation script — test all US coin Terapeak lookups
const tp = require('../src/services/terapeakService');

const ds = tp.listDatasets();
console.log('Total datasets:', ds.length, '\n');

// Realistic user search patterns for each US coin type
const US_SEARCH_PATTERNS = [];

// Collect all US-type datasets
for (const d of ds) {
  const st = d.searchTerm;
  const stL = st.toLowerCase();
  
  // Skip non-US coins (world bullion, lunar, etc.)
  if (stL.includes('canadian') || stL.includes('australian') || stL.includes('british') ||
      stL.includes('mexican') || stL.includes('austrian') || stL.includes('chinese') ||
      stL.includes('krugerrand') || stL.includes('perth') || stL.includes('rcm') ||
      stL.includes('royalmint') || stL.includes('kookaburra') || stL.includes('polar bear') ||
      stL.includes('lunar')) continue;

  // Extract year and mint from dataset name
  const ym = st.match(/^(\d{4})(?:-(CC|D|S|O|W))?\s+(.+)$/i);
  const year = ym ? ym[1] : null;
  const mint = ym ? (ym[2] || '') : '';
  const series = ym ? ym[3] : st;
  
  // Generate realistic user queries
  const queries = [st]; // exact
  
  if (year) {
    // "1956 Franklin Half Dollar" (user adds "Dollar")
    if (stL.includes('half') && !stL.includes('dollar')) {
      queries.push(st + ' Dollar');
    }
    if (stL.includes('morgan') && !stL.includes('dollar')) {
      queries.push(st.replace(/Morgan/i, 'Morgan Dollar').replace('Dollar Silver Dollar', 'Silver Dollar'));
    }
    if (stL.includes('peace') && !stL.includes('dollar')) {
      queries.push(st.replace(/Peace/i, 'Peace Dollar').replace('Dollar Silver Dollar', 'Silver Dollar'));
    }
    
    // User might search "1956 D Franklin Half Dollar" when only P exists
    // or "1956-D Franklin Half Dollar"
    if (!mint) {
      queries.push(year + '-D ' + series);
      queries.push(year + '-S ' + series);
    }
    // With "Half Dollar" instead of "Half"
    if (stL.includes(' half') && !stL.includes('half dollar') && !stL.includes('half eagle')) {
      queries.push(st.replace(/ half$/i, ' Half Dollar'));
    }
    // With "Dollar" appended for Morgans/Peace
    if ((stL.includes('morgan') || stL.includes('peace')) && !stL.includes('dollar')) {
      queries.push(st + ' Dollar');
    }
  }
  
  US_SEARCH_PATTERNS.push({ dataset: st, compCount: d.compCount, queries, year, mint, series });
}

console.log('US datasets to validate:', US_SEARCH_PATTERNS.length, '\n');

// Test each query
let totalTests = 0;
let totalPass = 0;
let totalFail = 0;
const failures = [];

for (const entry of US_SEARCH_PATTERNS) {
  for (const q of entry.queries) {
    totalTests++;
    const r = tp.lookupComps(q);
    if (r && r.comps.length > 0) {
      // Check if we got the RIGHT data (not a cross-match to a different coin)
      const matched = r.searchTerm.toLowerCase();
      const expected = entry.dataset.toLowerCase();
      // For yearless queries, the merge is fine
      // For year-specific, the match should contain the same year
      const expectYear = entry.year;
      const gotYear = matched.match(/\d{4}/)?.[0];
      
      if (expectYear && gotYear && expectYear !== gotYear && !matched.includes(expectYear)) {
        // Wrong year matched
        failures.push({
          query: q,
          expected: entry.dataset,
          got: r.searchTerm,
          comps: r.comps.length,
          issue: 'WRONG YEAR - got ' + gotYear + ' expected ' + expectYear
        });
        totalFail++;
      } else {
        totalPass++;
      }
    } else {
      failures.push({
        query: q,
        expected: entry.dataset,
        got: 'null',
        comps: 0,
        issue: 'NO MATCH'
      });
      totalFail++;
    }
  }
}

console.log('═══ RESULTS ═══');
console.log('Total tests:', totalTests);
console.log('Pass:', totalPass);
console.log('Fail:', totalFail);
console.log('');

if (failures.length > 0) {
  console.log('═══ FAILURES ═══');
  for (const f of failures) {
    console.log(`  FAIL: "${f.query}"`);
    console.log(`    Expected: ${f.expected}`);
    console.log(`    Got: ${f.got} (${f.comps} comps)`);
    console.log(`    Issue: ${f.issue}`);
    console.log('');
  }
}
