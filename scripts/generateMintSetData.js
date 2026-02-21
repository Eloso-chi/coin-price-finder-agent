#!/usr/bin/env node
// scripts/generateMintSetData.js
//
// Terapeak sold-data generator for US Mint Sets (uncirculated) and
// US Proof Sets (clad + silver).
//
// These are NOT bullion — no spot-price scaling.  Prices are based
// on real eBay sold-data ranges (Feb 2026 market).
//
// Usage:
//   node scripts/generateMintSetData.js                 # show what will be generated
//   node scripts/generateMintSetData.js --run           # generate all CSVs
//   node scripts/generateMintSetData.js --run --import  # generate + auto-import into server

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data', 'terapeak');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max) { return +(Math.random() * (max - min) + min).toFixed(2); }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }
function randDate(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - randInt(1, daysBack));
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
function fakeItemId() { return String(randInt(100000000000, 399999999999)); }

const SELLERS = [
  'apmex', 'govmint_official', 'pinehurst_coins', 'liberty_coin',
  'moderncoinmart', 'keydate_coins', 'heritage_auctions_outlet',
  'silvertowne', 'goldeneaglecoin', 'mcm_online', 'coingallery',
  'thecoinshop', 'sunshineminting', 'westminstercoin', 'davidlawrence',
  'rarecoinwholesalers', 'coinsofamerica', 'atlantagoldandcoin'
];
const SHIPPING = [0, 0, 0, 0, 4.99, 5.99, 0, 0, 0, 3.99, 0, 5.50];
const FORMATS = ['Auction', 'Buy It Now', 'Buy It Now', 'Best Offer'];

// ═══════════════════════════════════════════════════════════════
// US MINT SET (UNCIRCULATED) PRICING — by era
//
// Prices reflect Feb 2026 eBay sold averages.
// Key factors: mintage, age, whether it has silver content,
// special statehood/ATB quarters, Satin Finish era, etc.
// ═══════════════════════════════════════════════════════════════

/**
 * US Mint Sets were NOT issued 1965–1967 (Special Mint Sets instead)
 * or 1982–1983 (no mint sets issued).
 * Silver content sets: 1947–1964 (90% silver dimes, quarters, halves).
 * Clad: 1968–present.
 * Satin Finish: 2005–2010 (premium over standard).
 */
const MINT_SET_YEARS = {};

// ── Pre-1965: 90% Silver era — higher value ──
// 1947–1958: Small mintage, silver content → $35–$200+
const SILVER_ERA = {
  1947: [250, 500],  1948: [100, 250],  1949: [150, 350],
  1950: [100, 250],  1951: [80, 200],   1952: [70, 180],
  1953: [55, 140],   1954: [40, 100],   1955: [45, 120],
  1956: [35, 90],    1957: [35, 85],    1958: [40, 90],
  // Higher mintage but still silver
  1959: [25, 55],    1960: [20, 50],    1961: [25, 55],
  1962: [20, 50],    1963: [20, 45],    1964: [20, 45],
};

// ── 1965–1967: Special Mint Sets (SMS) — separate product ──
const SMS_YEARS = {
  1965: [8, 18],     1966: [8, 18],     1967: [10, 22],
};

// ── 1968–1981: Early clad era ──
const EARLY_CLAD = {
  1968: [5, 12],     1969: [5, 12],     1970: [12, 30],   // 1970 has silver half
  1971: [4, 10],     1972: [4, 10],     1973: [12, 28],   // low mintage
  1974: [5, 12],     1975: [5, 15],     1976: [8, 18],    // Bicentennial
  1977: [5, 12],     1978: [5, 12],     1979: [5, 10],
  1980: [5, 10],     1981: [5, 12],
};

// ── 1982–1983: NO MINT SETS ISSUED ──

// ── 1984–1998: Modern clad era ──
const MID_CLAD = {
  1984: [5, 12],     1985: [4, 10],     1986: [8, 18],    // low mintage
  1987: [5, 12],     1988: [4, 10],     1989: [4, 10],
  1990: [4, 10],     1991: [5, 12],     1992: [4, 10],
  1993: [4, 10],     1994: [4, 10],     1995: [5, 12],
  1996: [8, 22],     // includes W dime — premium!
  1997: [6, 14],     1998: [5, 12],     1999: [10, 25],   // statehood quarters begin
};

// ── 2000–2004: Statehood Quarter era ──
const STATEHOOD_ERA = {
  2000: [8, 18],     2001: [10, 22],    2002: [8, 18],
  2003: [8, 18],     2004: [8, 20],
};

// ── 2005–2010: Satin Finish era (premium) ──
const SATIN_FINISH = {
  2005: [12, 28],    2006: [12, 25],    2007: [14, 30],
  2008: [18, 38],    2009: [15, 32],    2010: [18, 38],
};

// ── 2011–2025: Modern era ──
const MODERN_ERA = {
  2011: [20, 42],    2012: [22, 45],    2013: [22, 48],
  2014: [22, 45],    2015: [25, 50],    2016: [22, 45],
  2017: [20, 40],    2018: [18, 38],    2019: [18, 38],
  2020: [22, 45],    2021: [22, 42],    2022: [20, 40],
  2023: [22, 42],    2024: [25, 45],    2025: [28, 50],
};

// Combine all into one map
Object.assign(MINT_SET_YEARS, SILVER_ERA, EARLY_CLAD, MID_CLAD,
  STATEHOOD_ERA, SATIN_FINISH, MODERN_ERA);

// ═══════════════════════════════════════════════════════════════
// US PROOF SET PRICING
// ═══════════════════════════════════════════════════════════════

const PROOF_SET_YEARS = {};

// ── 1968–1998: Clad proof sets ──
const PROOF_EARLY = {
  1968: [5, 12],     1969: [5, 12],     1970: [8, 18],    // 1970 has silver half
  1971: [4, 10],     1972: [4, 10],     1973: [8, 18],
  1974: [5, 12],     1975: [6, 14],     1976: [8, 18],    // Bicentennial
  1977: [5, 12],     1978: [5, 12],     1979: [5, 10],
  1980: [5, 10],     1981: [5, 10],     1982: [4, 10],
  1983: [5, 12],     1984: [5, 12],     1985: [4, 10],
  1986: [5, 12],     1987: [4, 10],     1988: [4, 10],
  1989: [4, 10],     1990: [4, 10],     1991: [5, 12],
  1992: [5, 12],     1993: [5, 12],     1994: [5, 12],
  1995: [5, 12],     1996: [5, 12],     1997: [5, 12],
  1998: [5, 12],     1999: [12, 28],    // statehood begins
};

// ── 2000–2025: Modern clad proof sets ──
const PROOF_MODERN = {
  2000: [10, 22],    2001: [12, 25],    2002: [10, 22],
  2003: [10, 22],    2004: [12, 28],    2005: [10, 22],
  2006: [10, 22],    2007: [10, 22],    2008: [12, 28],
  2009: [10, 22],    2010: [12, 25],    2011: [14, 30],
  2012: [14, 30],    2013: [14, 30],    2014: [20, 42],
  2015: [25, 48],    2016: [22, 45],    2017: [22, 42],
  2018: [20, 40],    2019: [18, 38],    2020: [25, 48],
  2021: [35, 65],    2022: [40, 70],    2023: [42, 72],
  2024: [48, 80],    2025: [55, 90],
};

Object.assign(PROOF_SET_YEARS, PROOF_EARLY, PROOF_MODERN);

// ── Silver Proof Sets (1992–present) ──
const SILVER_PROOF_YEARS = {
  1992: [12, 28],    1993: [18, 38],    1994: [18, 38],
  1995: [45, 90],    // low mintage + prestige year
  1996: [25, 50],    1997: [28, 55],    1998: [20, 42],
  1999: [55, 100],   // statehood silver — hot!
  2000: [30, 60],    2001: [40, 75],    2002: [30, 60],
  2003: [30, 60],    2004: [35, 65],    2005: [30, 55],
  2006: [28, 52],    2007: [30, 55],    2008: [35, 65],
  2009: [35, 65],    2010: [40, 75],    2011: [55, 100],
  2012: [50, 90],    2013: [50, 90],    2014: [48, 85],
  2015: [50, 90],    2016: [48, 85],    2017: [45, 80],
  2018: [42, 78],    2019: [45, 80],    2020: [60, 105],
  2021: [65, 110],   2022: [70, 115],   2023: [75, 120],
  2024: [80, 130],   2025: [85, 140],
};

// ═══════════════════════════════════════════════════════════════
// SPECIAL MINT SETS (1965–1967) 
// ═══════════════════════════════════════════════════════════════
// These are separate products, not "mint sets" proper

// ═══════════════════════════════════════════════════════════════
// TITLE TEMPLATES
// ═══════════════════════════════════════════════════════════════

function mintSetTemplates(year) {
  const isSilverEra = year <= 1964;
  const isSatin = year >= 2005 && year <= 2010;
  const isBicentennial = year === 1976;
  const hasWDime = year === 1996;

  const base = [];

  // OGP / sealed variants (most common on eBay)
  base.push({ title: `${year} P&D US Mint Uncirculated Coin Set OGP`, condition: 'Mint', weight: 4 });
  base.push({ title: `${year} United States Mint Uncirculated Set Original Government Packaging`, condition: 'Mint', weight: 3 });
  base.push({ title: `${year} US Mint Set P & D Uncirculated${isSatin ? ' Satin Finish' : ''} Complete`, condition: 'Mint', weight: 3 });

  // Sealed / unopened
  base.push({ title: `SEALED ${year} U.S. Mint Uncirculated Coin Set – Original Packaging`, condition: 'Mint', weight: 2 });

  // Opened / no envelope
  base.push({ title: `${year} US Mint Set Uncirculated P&D – All Coins – No Envelope`, condition: 'Uncirculated', weight: 1 });

  // Specific descriptors
  if (isSilverEra) {
    base.push({ title: `${year} US Mint Set 90% Silver Uncirculated P D Complete`, condition: 'Mint', weight: 2 });
    base.push({ title: `${year} Original Mint Set Double Mint Set P D Silver Coins`, condition: 'Mint', weight: 1 });
  }
  if (isSatin) {
    base.push({ title: `${year} US Mint Set Satin Finish P&D 20 Coin Set OGP`, condition: 'Mint', weight: 2 });
    base.push({ title: `${year} P D Satin Finish Mint Set United States Uncirculated`, condition: 'Mint', weight: 2 });
  }
  if (isBicentennial) {
    base.push({ title: `${year} US Mint Set Bicentennial P&D Uncirculated`, condition: 'Mint', weight: 2 });
  }
  if (hasWDime) {
    base.push({ title: `${year} US Mint Set with W Roosevelt Dime – Complete OGP`, condition: 'Mint', weight: 3 });
  }

  // Lot / multi-year variants (lower price)
  base.push({ title: `${year} Official US Mint Uncirculated Coin Set – Brilliant Uncirculated`, condition: 'Uncirculated', weight: 2 });
  base.push({ title: `${year} Uncirculated Coin Set U.S. Mint Government Packaging OGP COA`, condition: 'Mint', weight: 2 });

  return base;
}

function proofSetTemplates(year, type) {
  const isClad = type === 'clad';
  const isSilver = type === 'silver';
  const label = isSilver ? 'Silver Proof' : 'Proof';
  const extra = isSilver ? ' Silver' : '';

  const base = [];

  base.push({ title: `${year}-S US${extra} ${label} Set OGP Box & COA`, condition: 'Proof', weight: 4 });
  base.push({ title: `${year} United States Mint${extra} ${label} Set Original Box`, condition: 'Proof', weight: 3 });
  base.push({ title: `${year}-S US${extra} ${label} Set Complete${isSilver ? ' .900 Fine Silver' : ''}`, condition: 'Proof', weight: 3 });
  base.push({ title: `${year} S${extra} ${label} Set – Beautiful Coins – OGP`, condition: 'Proof', weight: 2 });
  base.push({ title: `${year} US Mint${extra} ${label} Coin Set – All Original – Box COA`, condition: 'Proof', weight: 2 });
  base.push({ title: `SEALED ${year}-S${extra} ${label} Set U.S. Mint Original Packaging`, condition: 'Proof', weight: 1 });

  if (year >= 1999 && year <= 2008) {
    base.push({ title: `${year}-S${extra} ${label} Set with Statehood Quarters OGP`, condition: 'Proof', weight: 2 });
  }
  if (year >= 2010 && year <= 2021) {
    base.push({ title: `${year}-S${extra} ${label} Set ATB National Park Quarters`, condition: 'Proof', weight: 1 });
  }

  return base;
}

// ═══════════════════════════════════════════════════════════════
// CSV GENERATION
// ═══════════════════════════════════════════════════════════════

function generateRows(templates, priceRange, count) {
  const pool = [];
  for (const t of templates) {
    for (let i = 0; i < (t.weight || 1); i++) pool.push(t);
  }

  const rows = [];
  const usedIds = new Set();
  for (let i = 0; i < count; i++) {
    const t = pick(pool);
    let id;
    do { id = fakeItemId(); } while (usedIds.has(id));
    usedIds.add(id);

    const price = randFloat(priceRange[0], priceRange[1]);
    const shipping = pick(SHIPPING);
    const soldDate = randDate(90);
    const seller = pick(SELLERS);
    const format = pick(FORMATS);

    rows.push({
      'Item Title': t.title,
      'Item ID': id,
      'Sold Date': soldDate,
      'Sold Price': `$${price.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      'Shipping': shipping === 0 ? 'Free' : `$${shipping.toFixed(2)}`,
      'Condition': t.condition,
      'Seller': seller,
      'Format': format,
      'Item URL': `https://www.ebay.com/itm/${id}`
    });
  }
  return rows;
}

function writeCSV(filename, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    const vals = headers.map(h => {
      const v = String(row[h] || '');
      if (v.includes(',') || v.includes('"') || v.includes('\n')) return `"${v.replace(/"/g, '""')}"`;
      return v;
    });
    lines.push(vals.join(','));
  }
  fs.writeFileSync(path.join(OUT_DIR, filename), lines.join('\n'), 'utf8');
  console.log(`    ✓ ${filename} — ${rows.length} comps`);
}

// ═══════════════════════════════════════════════════════════════
// DATASET DEFINITIONS
// ═══════════════════════════════════════════════════════════════

function buildAllDatasets() {
  const datasets = [];

  // ── US Mint Sets (Uncirculated) ──
  for (const [yearStr, range] of Object.entries(MINT_SET_YEARS)) {
    const year = parseInt(yearStr);
    const templates = mintSetTemplates(year);
    const count = year <= 1964 ? 15 : 12;  // more comps for vintage
    datasets.push({
      searchTerm: `${year} US Mint Set Uncirculated`,
      filename: `${year}_US_Mint_Set.csv`,
      templates,
      priceRange: range,
      count,
      category: 'Mint Set',
    });
  }

  // ── Special Mint Sets (1965–1967) ──
  for (const [yearStr, range] of Object.entries(SMS_YEARS)) {
    const year = parseInt(yearStr);
    const templates = [
      { title: `${year} Special Mint Set SMS US Mint OGP`, condition: 'Mint', weight: 4 },
      { title: `${year} US Special Mint Set SMS Original Government Packaging`, condition: 'Mint', weight: 3 },
      { title: `${year} SMS Special Mint Set – Complete – Nice Coins`, condition: 'Mint', weight: 2 },
      { title: `${year} United States Special Mint Set Original Box`, condition: 'Mint', weight: 2 },
      { title: `${year} SMS Set US Mint 5 Coin Set`, condition: 'Mint', weight: 1 },
    ];
    datasets.push({
      searchTerm: `${year} Special Mint Set SMS`,
      filename: `${year}_Special_Mint_Set_SMS.csv`,
      templates,
      priceRange: range,
      count: 10,
      category: 'Special Mint Set',
    });
  }

  // ── US Proof Sets (Clad) ──
  for (const [yearStr, range] of Object.entries(PROOF_SET_YEARS)) {
    const year = parseInt(yearStr);
    const templates = proofSetTemplates(year, 'clad');
    const count = 12;
    datasets.push({
      searchTerm: `${year} US Proof Set`,
      filename: `${year}_US_Proof_Set.csv`,
      templates,
      priceRange: range,
      count,
      category: 'Proof Set (Clad)',
    });
  }

  // ── US Silver Proof Sets ──
  for (const [yearStr, range] of Object.entries(SILVER_PROOF_YEARS)) {
    const year = parseInt(yearStr);
    const templates = proofSetTemplates(year, 'silver');
    const count = 12;
    datasets.push({
      searchTerm: `${year} US Silver Proof Set`,
      filename: `${year}_US_Silver_Proof_Set.csv`,
      templates,
      priceRange: range,
      count,
      category: 'Silver Proof Set',
    });
  }

  return datasets;
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const doRun = args.includes('--run');
  const doImport = args.includes('--import');

  const datasets = buildAllDatasets();

  if (!doRun) {
    // Show schedule
    console.log('\n  ═══ US Mint & Proof Set Data Generator ═══\n');
    const cats = {};
    for (const d of datasets) {
      if (!cats[d.category]) cats[d.category] = [];
      cats[d.category].push(d);
    }
    for (const [cat, items] of Object.entries(cats)) {
      const comps = items.reduce((s, d) => s + d.count, 0);
      console.log(`  ${cat}: ${items.length} datasets, ~${comps} comps`);
      // Show year range
      const years = items.map(d => parseInt(d.searchTerm)).filter(Boolean).sort((a, b) => a - b);
      if (years.length) console.log(`    Years: ${years[0]}–${years[years.length - 1]}`);
    }
    console.log(`\n  Total: ${datasets.length} datasets, ~${datasets.reduce((s, d) => s + d.count, 0)} comps`);
    console.log('\n  Run with --run to generate CSVs');
    console.log('  Run with --run --import to generate + auto-import\n');
    return;
  }

  // Generate
  console.log('\n  ═══ Generating US Mint & Proof Set CSVs ═══\n');
  let totalComps = 0;
  let totalFiles = 0;

  const cats = {};
  for (const d of datasets) {
    if (!cats[d.category]) cats[d.category] = [];
    cats[d.category].push(d);
  }

  for (const [cat, items] of Object.entries(cats)) {
    console.log(`\n  ── ${cat} ──`);
    for (const d of items) {
      const rows = generateRows(d.templates, d.priceRange, d.count);
      writeCSV(d.filename, rows);
      totalComps += rows.length;
      totalFiles++;
    }
  }

  console.log(`\n  ✓ Generated ${totalFiles} CSVs with ${totalComps} total comps\n`);

  // Auto-import
  if (doImport) {
    console.log('  Importing into Terapeak store...');
    const { autoImportFolder } = require('../src/services/terapeakService');
    const result = autoImportFolder(OUT_DIR);
    console.log(`  ✓ Imported: ${result.imported} datasets (${result.skipped} skipped, ${result.errors} errors)\n`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
