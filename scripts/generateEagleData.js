#!/usr/bin/env node
// scripts/generateEagleData.js
// Generates realistic Terapeak-style sold-listing CSVs for
// American Silver Eagles (key/semi-key) and American Gold Eagles (key/semi-key)

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data', 'terapeak');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Helpers ─────────────────────────────────────────────────
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max) { return +(Math.random() * (max - min) + min).toFixed(2); }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }
function randDate(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - randInt(1, daysBack));
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
function fakeItemId() { return String(randInt(100000000000, 399999999999)); }

const GRADERS = ['PCGS', 'NGC'];
const SELLERS = [
  'apmex', 'jmbullion', 'moderncoinmart', 'sdbullion', 'boldpreciousmetals',
  'pinehurst_coins', 'bullionshark', 'liberty_coin', 'mcm_online',
  'govmint_official', 'greatcollections', 'keydate_coins', 'heritage_auctions_outlet',
  'silvertowne', 'goldeneaglecoin'
];
const SHIPPING = [0, 0, 0, 0, 4.99, 5.99, 0, 0, 0, 3.99];

// ══════════════════════════════════════════════════════════════
// AMERICAN SILVER EAGLES
// ══════════════════════════════════════════════════════════════
const ASE_COINS = [
  {
    searchTerm: '1986 American Silver Eagle',
    filename: '1986_American_Silver_Eagle.csv',
    titleTemplates: [
      // Raw / BU
      { title: '1986 American Silver Eagle 1 oz .999 Fine Silver BU', condition: 'Uncirculated', priceRange: [42, 58], weight: 5 },
      { title: '1986 American Silver Eagle First Year Issue BU', condition: 'Uncirculated', priceRange: [44, 60], weight: 3 },
      { title: '1986 Silver Eagle 1oz BU in Capsule', condition: 'Uncirculated', priceRange: [40, 55], weight: 3 },
      // Graded MS69
      { title: '1986 American Silver Eagle {G} MS-69 First Year', condition: 'Certified', priceRange: [55, 78], weight: 4, graded: true },
      { title: '1986 Silver Eagle {G} MS69 First Year of Issue', condition: 'Certified', priceRange: [52, 75], weight: 3, graded: true },
      // Graded MS70
      { title: '1986 American Silver Eagle {G} MS-70 First Year', condition: 'Certified', priceRange: [250, 450], weight: 2, graded: true },
      { title: '1986 Silver Eagle {G} MS70 Perfect Grade', condition: 'Certified', priceRange: [275, 480], weight: 1, graded: true },
      // Graded MS68
      { title: '1986 American Silver Eagle {G} MS-68', condition: 'Certified', priceRange: [38, 52], weight: 2, graded: true },
    ],
    count: 35
  },
  {
    searchTerm: '1994 American Silver Eagle',
    filename: '1994_American_Silver_Eagle.csv',
    titleTemplates: [
      { title: '1994 American Silver Eagle 1 oz .999 Fine Silver BU', condition: 'Uncirculated', priceRange: [48, 68], weight: 4 },
      { title: '1994 Silver Eagle BU Low Mintage Year', condition: 'Uncirculated', priceRange: [50, 72], weight: 3 },
      { title: '1994 American Silver Eagle {G} MS-69', condition: 'Certified', priceRange: [65, 95], weight: 4, graded: true },
      { title: '1994 Silver Eagle {G} MS69 Low Mintage', condition: 'Certified', priceRange: [62, 90], weight: 3, graded: true },
      { title: '1994 American Silver Eagle {G} MS-70', condition: 'Certified', priceRange: [1800, 3200], weight: 1, graded: true },
      { title: '1994 Silver Eagle {G} MS-68', condition: 'Certified', priceRange: [45, 62], weight: 2, graded: true },
    ],
    count: 30
  },
  {
    searchTerm: '1995-W American Silver Eagle Proof',
    filename: '1995-W_American_Silver_Eagle_Proof.csv',
    titleTemplates: [
      // This is the big key — lowest mintage proof ASE (30K), from 10th anniversary set
      { title: '1995-W American Silver Eagle Proof {G} PR-69 DCAM', condition: 'Certified', priceRange: [3800, 5500], weight: 4, graded: true },
      { title: '1995-W Silver Eagle Proof {G} PF69 Ultra Cameo', condition: 'Certified', priceRange: [3700, 5200], weight: 3, graded: true },
      { title: '1995-W American Silver Eagle {G} PR-70 DCAM', condition: 'Certified', priceRange: [8500, 14000], weight: 2, graded: true },
      { title: '1995-W Silver Eagle Proof {G} PF70 Ultra Cameo', condition: 'Certified', priceRange: [9000, 15000], weight: 1, graded: true },
      { title: '1995-W American Silver Eagle Proof {G} PR-68 DCAM', condition: 'Certified', priceRange: [3200, 4500], weight: 2, graded: true },
      // Raw / ungraded proof
      { title: '1995-W American Silver Eagle Proof OGP', condition: 'Uncirculated', priceRange: [3500, 5000], weight: 2 },
      { title: '1995-W Silver Eagle Proof Key Date Lowest Mintage', condition: 'Uncirculated', priceRange: [3400, 4800], weight: 1 },
    ],
    count: 18
  },
  {
    searchTerm: '1996 American Silver Eagle',
    filename: '1996_American_Silver_Eagle.csv',
    titleTemplates: [
      { title: '1996 American Silver Eagle 1 oz BU Lowest Mintage', condition: 'Uncirculated', priceRange: [55, 85], weight: 4 },
      { title: '1996 Silver Eagle BU Key Date 3.6M Minted', condition: 'Uncirculated', priceRange: [58, 88], weight: 3 },
      { title: '1996 American Silver Eagle {G} MS-69', condition: 'Certified', priceRange: [78, 120], weight: 4, graded: true },
      { title: '1996 Silver Eagle {G} MS69 Key Date', condition: 'Certified', priceRange: [75, 115], weight: 3, graded: true },
      { title: '1996 American Silver Eagle {G} MS-70', condition: 'Certified', priceRange: [2500, 4500], weight: 1, graded: true },
      { title: '1996 Silver Eagle {G} MS-68', condition: 'Certified', priceRange: [50, 72], weight: 2, graded: true },
    ],
    count: 30
  },
  {
    searchTerm: '2008-W American Silver Eagle Burnished',
    filename: '2008-W_American_Silver_Eagle_Burnished.csv',
    titleTemplates: [
      { title: '2008-W American Silver Eagle Burnished BU', condition: 'Uncirculated', priceRange: [65, 95], weight: 3 },
      { title: '2008-W Silver Eagle Burnished Satin Finish', condition: 'Uncirculated', priceRange: [68, 100], weight: 3 },
      { title: '2008-W American Silver Eagle Burnished {G} SP-69', condition: 'Certified', priceRange: [80, 120], weight: 4, graded: true },
      { title: '2008-W Silver Eagle Burnished {G} SP69', condition: 'Certified', priceRange: [78, 115], weight: 3, graded: true },
      { title: '2008-W American Silver Eagle Burnished {G} SP-70', condition: 'Certified', priceRange: [350, 600], weight: 1, graded: true },
      { title: '2008-W Silver Eagle Burnished {G} MS-69', condition: 'Certified', priceRange: [78, 110], weight: 2, graded: true },
    ],
    count: 25
  },
  {
    searchTerm: '2011-S American Silver Eagle',
    filename: '2011-S_American_Silver_Eagle.csv',
    titleTemplates: [
      { title: '2011-S American Silver Eagle 25th Anniversary Set', condition: 'Uncirculated', priceRange: [85, 130], weight: 3 },
      { title: '2011-S Silver Eagle from 25th Anniversary Set BU', condition: 'Uncirculated', priceRange: [80, 125], weight: 3 },
      { title: '2011-S American Silver Eagle {G} MS-69 25th Anniversary', condition: 'Certified', priceRange: [100, 155], weight: 4, graded: true },
      { title: '2011-S Silver Eagle {G} MS69 Early Releases', condition: 'Certified', priceRange: [95, 145], weight: 3, graded: true },
      { title: '2011-S American Silver Eagle {G} MS-70 25th Anniversary', condition: 'Certified', priceRange: [220, 380], weight: 2, graded: true },
      { title: '2011-S Silver Eagle {G} MS70 First Strike', condition: 'Certified', priceRange: [230, 400], weight: 1, graded: true },
    ],
    count: 25
  },
  {
    searchTerm: '2019-S American Silver Eagle Enhanced Reverse Proof',
    filename: '2019-S_American_Silver_Eagle_Enhanced_Reverse_Proof.csv',
    titleTemplates: [
      { title: '2019-S American Silver Eagle Enhanced Reverse Proof', condition: 'Uncirculated', priceRange: [380, 550], weight: 3 },
      { title: '2019-S Silver Eagle Enhanced Rev Proof 30K Mintage', condition: 'Uncirculated', priceRange: [400, 580], weight: 2 },
      { title: '2019-S American Silver Eagle Enhanced Reverse Proof {G} PF-69', condition: 'Certified', priceRange: [420, 600], weight: 4, graded: true },
      { title: '2019-S Silver Eagle Enh Rev Proof {G} PF69 First Strike', condition: 'Certified', priceRange: [440, 620], weight: 3, graded: true },
      { title: '2019-S American Silver Eagle Enhanced Reverse Proof {G} PF-70', condition: 'Certified', priceRange: [800, 1400], weight: 2, graded: true },
      { title: '2019-S Silver Eagle Enh Rev Proof {G} PF70 First Day', condition: 'Certified', priceRange: [850, 1500], weight: 1, graded: true },
    ],
    count: 22
  },
  {
    searchTerm: '2021 American Silver Eagle Type 1',
    filename: '2021_American_Silver_Eagle_Type_1.csv',
    titleTemplates: [
      { title: '2021 American Silver Eagle Type 1 Heraldic Eagle BU', condition: 'Uncirculated', priceRange: [34, 45], weight: 5 },
      { title: '2021 Silver Eagle Type 1 Last Year Design 1oz', condition: 'Uncirculated', priceRange: [35, 48], weight: 4 },
      { title: '2021 American Silver Eagle Type 1 {G} MS-69', condition: 'Certified', priceRange: [42, 58], weight: 4, graded: true },
      { title: '2021 Silver Eagle Type 1 {G} MS69 Last Design', condition: 'Certified', priceRange: [40, 55], weight: 3, graded: true },
      { title: '2021 American Silver Eagle Type 1 {G} MS-70', condition: 'Certified', priceRange: [55, 85], weight: 2, graded: true },
      { title: '2021 Silver Eagle Type 1 {G} MS70 First Strike', condition: 'Certified', priceRange: [58, 90], weight: 2, graded: true },
    ],
    count: 35
  },
];

// ══════════════════════════════════════════════════════════════
// AMERICAN GOLD EAGLES
// ══════════════════════════════════════════════════════════════
const AGE_COINS = [
  {
    searchTerm: '1986 American Gold Eagle 1 oz',
    filename: '1986_American_Gold_Eagle_1oz.csv',
    titleTemplates: [
      { title: '1986 American Gold Eagle 1 oz First Year Issue BU', condition: 'Uncirculated', priceRange: [2750, 3100], weight: 4 },
      { title: '1986 Gold Eagle 1oz .9167 Fine Gold MCMLXXXVI', condition: 'Uncirculated', priceRange: [2700, 3050], weight: 3 },
      { title: '1986 American Gold Eagle 1 oz {G} MS-69', condition: 'Certified', priceRange: [2850, 3250], weight: 4, graded: true },
      { title: '1986 Gold Eagle 1oz {G} MS69 First Year', condition: 'Certified', priceRange: [2800, 3200], weight: 3, graded: true },
      { title: '1986 American Gold Eagle 1 oz {G} MS-70', condition: 'Certified', priceRange: [4500, 7000], weight: 1, graded: true },
      { title: '1986 Gold Eagle {G} MS-68 1 oz First Year Issue', condition: 'Certified', priceRange: [2700, 2950], weight: 2, graded: true },
      // 1/2 oz and fractional mixed in (common in searches)
      { title: '1986 American Gold Eagle 1/2 oz First Year BU', condition: 'Uncirculated', priceRange: [1350, 1550], weight: 2 },
      { title: '1986 American Gold Eagle 1/4 oz BU', condition: 'Uncirculated', priceRange: [680, 780], weight: 2 },
      { title: '1986 American Gold Eagle 1/10 oz BU First Year', condition: 'Uncirculated', priceRange: [280, 330], weight: 2 },
    ],
    count: 30
  },
  {
    searchTerm: '1991 American Gold Eagle 1 oz',
    filename: '1991_American_Gold_Eagle_1oz.csv',
    titleTemplates: [
      { title: '1991 American Gold Eagle 1 oz BU Low Mintage', condition: 'Uncirculated', priceRange: [2750, 3100], weight: 4 },
      { title: '1991 Gold Eagle 1oz .9167 Fine Gold', condition: 'Uncirculated', priceRange: [2700, 3050], weight: 3 },
      { title: '1991 American Gold Eagle 1 oz {G} MS-69', condition: 'Certified', priceRange: [2850, 3300], weight: 4, graded: true },
      { title: '1991 Gold Eagle 1oz {G} MS69 Low Mintage 243K', condition: 'Certified', priceRange: [2900, 3350], weight: 3, graded: true },
      { title: '1991 American Gold Eagle 1 oz {G} MS-70', condition: 'Certified', priceRange: [5500, 9000], weight: 1, graded: true },
      { title: '1991 Gold Eagle {G} MS-68 1 oz', condition: 'Certified', priceRange: [2700, 2950], weight: 2, graded: true },
      { title: '1991 American Gold Eagle 1/2 oz BU', condition: 'Uncirculated', priceRange: [1350, 1550], weight: 2 },
      { title: '1991 American Gold Eagle 1/10 oz BU', condition: 'Uncirculated', priceRange: [280, 330], weight: 2 },
    ],
    count: 28
  },
  {
    searchTerm: '1999-W American Gold Eagle Proof Unfinished Dies',
    filename: '1999-W_American_Gold_Eagle_Proof.csv',
    titleTemplates: [
      { title: '1999-W American Gold Eagle 1 oz Proof Unfinished Proof Dies', condition: 'Certified', priceRange: [4500, 7500], weight: 3 },
      { title: '1999-W Gold Eagle Proof {G} PF-69 DCAM Unfinished Dies Error', condition: 'Certified', priceRange: [5000, 8000], weight: 3, graded: true },
      { title: '1999-W American Gold Eagle Proof {G} PF69 Ultra Cameo UFD', condition: 'Certified', priceRange: [4800, 7800], weight: 3, graded: true },
      { title: '1999-W Gold Eagle {G} PF-70 DCAM Unfinished Proof Dies', condition: 'Certified', priceRange: [12000, 20000], weight: 1, graded: true },
      // Regular 1999-W proof (not error)
      { title: '1999-W American Gold Eagle 1 oz Proof {G} PF-69 DCAM', condition: 'Certified', priceRange: [2900, 3400], weight: 3, graded: true },
      { title: '1999-W Gold Eagle 1oz Proof OGP COA', condition: 'Uncirculated', priceRange: [2800, 3300], weight: 2 },
      { title: '1999-W American Gold Eagle 1/2 oz Proof', condition: 'Uncirculated', priceRange: [1400, 1650], weight: 1 },
      { title: '1999-W Gold Eagle 1/4 oz Proof {G} PF-69', condition: 'Certified', priceRange: [720, 850], weight: 1, graded: true },
    ],
    count: 22
  },
  {
    searchTerm: '2021 American Gold Eagle Type 1',
    filename: '2021_American_Gold_Eagle_Type_1.csv',
    titleTemplates: [
      { title: '2021 American Gold Eagle Type 1 1 oz BU Last Design', condition: 'Uncirculated', priceRange: [2700, 3000], weight: 5 },
      { title: '2021 Gold Eagle Type 1 Heraldic Eagle 1oz', condition: 'Uncirculated', priceRange: [2680, 2980], weight: 4 },
      { title: '2021 American Gold Eagle Type 1 1 oz {G} MS-69', condition: 'Certified', priceRange: [2780, 3100], weight: 4, graded: true },
      { title: '2021 Gold Eagle Type 1 {G} MS69 Last Year Design', condition: 'Certified', priceRange: [2750, 3080], weight: 3, graded: true },
      { title: '2021 American Gold Eagle Type 1 1 oz {G} MS-70', condition: 'Certified', priceRange: [2950, 3400], weight: 2, graded: true },
      { title: '2021 Gold Eagle Type 1 {G} MS70 First Strike', condition: 'Certified', priceRange: [3000, 3500], weight: 2, graded: true },
      { title: '2021 American Gold Eagle Type 1 1/2 oz BU', condition: 'Uncirculated', priceRange: [1350, 1520], weight: 2 },
      { title: '2021 American Gold Eagle Type 1 1/4 oz BU', condition: 'Uncirculated', priceRange: [680, 760], weight: 2 },
      { title: '2021 American Gold Eagle Type 1 1/10 oz BU', condition: 'Uncirculated', priceRange: [275, 320], weight: 2 },
    ],
    count: 35
  },
];

const ALL_COINS = [...ASE_COINS, ...AGE_COINS];

// ── Build weighted template pool ────────────────────────────
function buildPool(templates) {
  const pool = [];
  for (const t of templates) {
    for (let i = 0; i < (t.weight || 1); i++) pool.push(t);
  }
  return pool;
}

// ── Generate rows for one coin ──────────────────────────────
function generateRows(coin) {
  const pool = buildPool(coin.titleTemplates);
  const rows = [];
  const usedIds = new Set();

  for (let i = 0; i < coin.count; i++) {
    const t = pick(pool);
    let title = t.title;
    if (t.graded) title = title.replace('{G}', pick(GRADERS));

    let id;
    do { id = fakeItemId(); } while (usedIds.has(id));
    usedIds.add(id);

    const price = randFloat(t.priceRange[0], t.priceRange[1]);
    const shipping = pick(SHIPPING);
    const soldDate = randDate(90);
    const seller = pick(SELLERS);
    const format = pick(['Auction', 'Buy It Now', 'Buy It Now', 'Best Offer']);

    rows.push({
      'Item Title': title,
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

// ── Write CSV ───────────────────────────────────────────────
function writeCSV(filename, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    const vals = headers.map(h => {
      const v = String(row[h] || '');
      if (v.includes(',') || v.includes('"') || v.includes('\n')) {
        return `"${v.replace(/"/g, '""')}"`;
      }
      return v;
    });
    lines.push(vals.join(','));
  }
  const outPath = path.join(OUT_DIR, filename);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`  ✓ ${filename} — ${rows.length} sold listings`);
}

// ── Main ────────────────────────────────────────────────────
console.log('\n═══ Generating American Silver Eagle Terapeak CSVs ═══\n');
let aseTotal = 0;
for (const coin of ASE_COINS) {
  const rows = generateRows(coin);
  writeCSV(coin.filename, rows);
  aseTotal += rows.length;
}
console.log(`\n  ASE subtotal: ${aseTotal} sold comps across ${ASE_COINS.length} CSVs\n`);

console.log('═══ Generating American Gold Eagle Terapeak CSVs ═══\n');
let ageTotal = 0;
for (const coin of AGE_COINS) {
  const rows = generateRows(coin);
  writeCSV(coin.filename, rows);
  ageTotal += rows.length;
}
console.log(`\n  AGE subtotal: ${ageTotal} sold comps across ${AGE_COINS.length} CSVs`);
console.log(`\n  GRAND TOTAL: ${aseTotal + ageTotal} sold comps, ${ALL_COINS.length} CSVs`);
console.log(`  Output: ${OUT_DIR}/\n`);
