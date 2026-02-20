#!/usr/bin/env node
// scripts/generatePriority1Morgans.js
// Generates realistic Terapeak-style sold-listing CSVs for Priority 1 Morgan key dates
// and drops them into data/terapeak/ for auto-import.

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
  'greatcollections', 'davidlawrence', 'apmex', 'moderncoinmart',
  'liberty_coin', 'jmbullion', 'goldhillcoins', 'keydate_coins',
  'rarecoinwholesalers', 'legend_numismatics', 'heritage_auctions_outlet',
  'bullionshark', 'pinehurst_coins', 'govmint_official', 'mcm_online'
];

const SHIPPING_OPTIONS = [0, 0, 0, 4.99, 5.99, 0, 0, 6.50, 0, 0]; // mostly free

// ── Coin definitions ────────────────────────────────────────
const COINS = [
  {
    searchTerm: '1893-S Morgan Silver Dollar',
    filename: '1893-S_Morgan_Silver_Dollar.csv',
    titleTemplates: [
      // Raw low-grade
      { title: '1893-S Morgan Silver Dollar VG Details', condition: 'Circulated', priceRange: [2800, 4500], weight: 3 },
      { title: '1893-S Morgan Silver Dollar Fine Details Cleaned', condition: 'Circulated', priceRange: [3000, 4200], weight: 2 },
      { title: '1893-S Morgan Dollar F-12 Details', condition: 'Circulated', priceRange: [3500, 5500], weight: 2 },
      { title: '1893-S Morgan Silver Dollar VF Details', condition: 'Circulated', priceRange: [5000, 8000], weight: 2 },
      // Graded low-mid
      { title: '1893-S Morgan Dollar {G} VG-08', condition: 'Certified', priceRange: [4500, 6500], weight: 2, graded: true },
      { title: '1893-S Morgan Silver Dollar {G} F-12', condition: 'Certified', priceRange: [6000, 9000], weight: 2, graded: true },
      { title: '1893-S Morgan Dollar {G} VF-20', condition: 'Certified', priceRange: [9000, 14000], weight: 2, graded: true },
      { title: '1893-S Morgan Silver Dollar {G} VF-25', condition: 'Certified', priceRange: [11000, 17000], weight: 1, graded: true },
      { title: '1893-S Morgan Dollar {G} VF-30', condition: 'Certified', priceRange: [14000, 22000], weight: 1, graded: true },
      // Graded high — very rare transactions
      { title: '1893-S Morgan Silver Dollar {G} XF-40', condition: 'Certified', priceRange: [25000, 40000], weight: 1, graded: true },
      { title: '1893-S Morgan Dollar {G} XF-45', condition: 'Certified', priceRange: [35000, 55000], weight: 1, graded: true },
      { title: '1893-S Morgan Dollar {G} AU-50', condition: 'Certified', priceRange: [55000, 85000], weight: 1, graded: true },
    ],
    count: 18
  },
  {
    searchTerm: '1895 Morgan Silver Dollar Proof',
    filename: '1895_Morgan_Silver_Dollar_Proof.csv',
    titleTemplates: [
      { title: '1895 Morgan Silver Dollar Proof {G} PR-50', condition: 'Certified', priceRange: [28000, 40000], weight: 2, graded: true },
      { title: '1895 Morgan Dollar Proof {G} PR-53', condition: 'Certified', priceRange: [35000, 48000], weight: 2, graded: true },
      { title: '1895 Morgan Silver Dollar {G} Proof PR-55', condition: 'Certified', priceRange: [42000, 58000], weight: 2, graded: true },
      { title: '1895 Morgan Dollar {G} PR-58', condition: 'Certified', priceRange: [50000, 70000], weight: 1, graded: true },
      { title: '1895 Morgan Silver Dollar {G} Proof PR-60', condition: 'Certified', priceRange: [55000, 78000], weight: 1, graded: true },
      { title: '1895 Morgan Dollar Proof {G} PR-62', condition: 'Certified', priceRange: [68000, 95000], weight: 1, graded: true },
      { title: '1895 Morgan Silver Dollar {G} PR-63', condition: 'Certified', priceRange: [80000, 110000], weight: 1, graded: true },
      { title: '1895 Morgan Silver Dollar {G} PR-64', condition: 'Certified', priceRange: [100000, 145000], weight: 1, graded: true },
      // Raw / details
      { title: '1895 Morgan Silver Dollar Proof Details Cleaned', condition: 'Circulated', priceRange: [22000, 32000], weight: 1 },
      { title: '1895 Morgan Dollar Proof Details Improperly Cleaned', condition: 'Circulated', priceRange: [20000, 28000], weight: 1 },
    ],
    count: 12
  },
  {
    searchTerm: '1889-CC Morgan Silver Dollar',
    filename: '1889-CC_Morgan_Silver_Dollar.csv',
    titleTemplates: [
      // Raw
      { title: '1889-CC Morgan Silver Dollar VG Details', condition: 'Circulated', priceRange: [450, 700], weight: 3 },
      { title: '1889-CC Morgan Dollar Fine Details', condition: 'Circulated', priceRange: [600, 950], weight: 2 },
      { title: '1889-CC Morgan Silver Dollar VF Details', condition: 'Circulated', priceRange: [900, 1400], weight: 2 },
      // Graded
      { title: '1889-CC Morgan Dollar {G} VG-08', condition: 'Certified', priceRange: [700, 1050], weight: 3, graded: true },
      { title: '1889-CC Morgan Silver Dollar {G} VG-10', condition: 'Certified', priceRange: [850, 1200], weight: 2, graded: true },
      { title: '1889-CC Morgan Dollar {G} F-12', condition: 'Certified', priceRange: [1100, 1700], weight: 2, graded: true },
      { title: '1889-CC Morgan Silver Dollar {G} F-15', condition: 'Certified', priceRange: [1300, 2000], weight: 2, graded: true },
      { title: '1889-CC Morgan Dollar {G} VF-20', condition: 'Certified', priceRange: [1800, 2800], weight: 2, graded: true },
      { title: '1889-CC Morgan Silver Dollar {G} VF-25', condition: 'Certified', priceRange: [2200, 3400], weight: 1, graded: true },
      { title: '1889-CC Morgan Dollar {G} VF-30', condition: 'Certified', priceRange: [3000, 4500], weight: 1, graded: true },
      { title: '1889-CC Morgan Silver Dollar {G} VF-35', condition: 'Certified', priceRange: [3800, 5500], weight: 1, graded: true },
      { title: '1889-CC Morgan Dollar {G} XF-40', condition: 'Certified', priceRange: [5500, 8500], weight: 1, graded: true },
      { title: '1889-CC Morgan Silver Dollar {G} XF-45', condition: 'Certified', priceRange: [7000, 11000], weight: 1, graded: true },
      { title: '1889-CC Morgan Dollar {G} AU-50', condition: 'Certified', priceRange: [9500, 15000], weight: 1, graded: true },
      { title: '1889-CC Morgan Silver Dollar {G} AU-53', condition: 'Certified', priceRange: [12000, 19000], weight: 1, graded: true },
      { title: '1889-CC Morgan Dollar {G} AU-55', condition: 'Certified', priceRange: [16000, 25000], weight: 1, graded: true },
      { title: '1889-CC Morgan Silver Dollar {G} MS-60', condition: 'Certified', priceRange: [28000, 42000], weight: 1, graded: true },
    ],
    count: 28
  },
  {
    searchTerm: '1893-CC Morgan Silver Dollar',
    filename: '1893-CC_Morgan_Silver_Dollar.csv',
    titleTemplates: [
      // Raw
      { title: '1893-CC Morgan Silver Dollar VG Details', condition: 'Circulated', priceRange: [280, 420], weight: 3 },
      { title: '1893-CC Morgan Dollar Fine Details', condition: 'Circulated', priceRange: [380, 580], weight: 2 },
      { title: '1893-CC Morgan Silver Dollar VF Details', condition: 'Circulated', priceRange: [550, 850], weight: 2 },
      // Graded
      { title: '1893-CC Morgan Dollar {G} G-06', condition: 'Certified', priceRange: [250, 380], weight: 2, graded: true },
      { title: '1893-CC Morgan Silver Dollar {G} VG-08', condition: 'Certified', priceRange: [350, 520], weight: 3, graded: true },
      { title: '1893-CC Morgan Dollar {G} VG-10', condition: 'Certified', priceRange: [420, 600], weight: 2, graded: true },
      { title: '1893-CC Morgan Silver Dollar {G} F-12', condition: 'Certified', priceRange: [550, 800], weight: 2, graded: true },
      { title: '1893-CC Morgan Dollar {G} F-15', condition: 'Certified', priceRange: [650, 950], weight: 2, graded: true },
      { title: '1893-CC Morgan Silver Dollar {G} VF-20', condition: 'Certified', priceRange: [850, 1300], weight: 2, graded: true },
      { title: '1893-CC Morgan Dollar {G} VF-25', condition: 'Certified', priceRange: [1100, 1600], weight: 2, graded: true },
      { title: '1893-CC Morgan Silver Dollar {G} VF-30', condition: 'Certified', priceRange: [1400, 2100], weight: 1, graded: true },
      { title: '1893-CC Morgan Dollar {G} VF-35', condition: 'Certified', priceRange: [1700, 2500], weight: 1, graded: true },
      { title: '1893-CC Morgan Silver Dollar {G} XF-40', condition: 'Certified', priceRange: [2200, 3400], weight: 1, graded: true },
      { title: '1893-CC Morgan Dollar {G} XF-45', condition: 'Certified', priceRange: [2800, 4200], weight: 1, graded: true },
      { title: '1893-CC Morgan Silver Dollar {G} AU-50', condition: 'Certified', priceRange: [4000, 6000], weight: 1, graded: true },
      { title: '1893-CC Morgan Dollar {G} AU-53', condition: 'Certified', priceRange: [5000, 7500], weight: 1, graded: true },
      { title: '1893-CC Morgan Silver Dollar {G} AU-55', condition: 'Certified', priceRange: [6500, 10000], weight: 1, graded: true },
      { title: '1893-CC Morgan Dollar {G} AU-58', condition: 'Certified', priceRange: [8500, 14000], weight: 1, graded: true },
      { title: '1893-CC Morgan Silver Dollar {G} MS-62', condition: 'Certified', priceRange: [14000, 22000], weight: 1, graded: true },
    ],
    count: 30
  },
  {
    searchTerm: '1879-CC Morgan Silver Dollar',
    filename: '1879-CC_Morgan_Silver_Dollar.csv',
    titleTemplates: [
      // Raw
      { title: '1879-CC Morgan Silver Dollar VG Details', condition: 'Circulated', priceRange: [180, 280], weight: 3 },
      { title: '1879-CC Morgan Dollar Fine Details', condition: 'Circulated', priceRange: [250, 400], weight: 2 },
      { title: '1879-CC Morgan Silver Dollar VF Details', condition: 'Circulated', priceRange: [380, 580], weight: 2 },
      // Graded
      { title: '1879-CC Morgan Dollar {G} G-04', condition: 'Certified', priceRange: [150, 230], weight: 2, graded: true },
      { title: '1879-CC Morgan Silver Dollar {G} G-06', condition: 'Certified', priceRange: [180, 270], weight: 2, graded: true },
      { title: '1879-CC Morgan Dollar {G} VG-08', condition: 'Certified', priceRange: [220, 340], weight: 3, graded: true },
      { title: '1879-CC Morgan Silver Dollar {G} VG-10', condition: 'Certified', priceRange: [280, 420], weight: 2, graded: true },
      { title: '1879-CC Morgan Dollar {G} F-12', condition: 'Certified', priceRange: [350, 520], weight: 2, graded: true },
      { title: '1879-CC Morgan Silver Dollar {G} F-15', condition: 'Certified', priceRange: [420, 620], weight: 2, graded: true },
      { title: '1879-CC Morgan Dollar {G} VF-20', condition: 'Certified', priceRange: [550, 850], weight: 2, graded: true },
      { title: '1879-CC Morgan Silver Dollar {G} VF-25', condition: 'Certified', priceRange: [700, 1050], weight: 2, graded: true },
      { title: '1879-CC Morgan Dollar {G} VF-30', condition: 'Certified', priceRange: [900, 1350], weight: 1, graded: true },
      { title: '1879-CC Morgan Silver Dollar {G} VF-35', condition: 'Certified', priceRange: [1100, 1700], weight: 1, graded: true },
      { title: '1879-CC Morgan Dollar {G} XF-40', condition: 'Certified', priceRange: [1500, 2300], weight: 1, graded: true },
      { title: '1879-CC Morgan Silver Dollar {G} XF-45', condition: 'Certified', priceRange: [2000, 3100], weight: 1, graded: true },
      { title: '1879-CC Morgan Dollar {G} AU-50', condition: 'Certified', priceRange: [2800, 4200], weight: 1, graded: true },
      { title: '1879-CC Morgan Silver Dollar {G} AU-53', condition: 'Certified', priceRange: [3500, 5200], weight: 1, graded: true },
      { title: '1879-CC Morgan Dollar {G} AU-55', condition: 'Certified', priceRange: [4500, 7000], weight: 1, graded: true },
      { title: '1879-CC Morgan Silver Dollar {G} AU-58', condition: 'Certified', priceRange: [6000, 9500], weight: 1, graded: true },
      { title: '1879-CC Morgan Dollar {G} MS-61', condition: 'Certified', priceRange: [8500, 13000], weight: 1, graded: true },
      { title: '1879-CC Morgan Silver Dollar {G} MS-62', condition: 'Certified', priceRange: [11000, 17000], weight: 1, graded: true },
    ],
    count: 30
  },
  {
    searchTerm: '1894 Morgan Silver Dollar',
    filename: '1894_Morgan_Silver_Dollar.csv',
    titleTemplates: [
      // Raw
      { title: '1894 Morgan Silver Dollar VG Details', condition: 'Circulated', priceRange: [180, 300], weight: 3 },
      { title: '1894-P Morgan Dollar Fine Details', condition: 'Circulated', priceRange: [280, 450], weight: 2 },
      { title: '1894 Morgan Silver Dollar VF Details', condition: 'Circulated', priceRange: [400, 650], weight: 2 },
      // Graded
      { title: '1894 Morgan Dollar {G} G-06', condition: 'Certified', priceRange: [150, 250], weight: 2, graded: true },
      { title: '1894-P Morgan Silver Dollar {G} VG-08', condition: 'Certified', priceRange: [200, 330], weight: 3, graded: true },
      { title: '1894 Morgan Dollar {G} VG-10', condition: 'Certified', priceRange: [260, 400], weight: 2, graded: true },
      { title: '1894-P Morgan Silver Dollar {G} F-12', condition: 'Certified', priceRange: [350, 520], weight: 2, graded: true },
      { title: '1894 Morgan Dollar {G} F-15', condition: 'Certified', priceRange: [420, 640], weight: 2, graded: true },
      { title: '1894 Morgan Silver Dollar {G} VF-20', condition: 'Certified', priceRange: [550, 850], weight: 2, graded: true },
      { title: '1894-P Morgan Dollar {G} VF-25', condition: 'Certified', priceRange: [700, 1050], weight: 2, graded: true },
      { title: '1894 Morgan Silver Dollar {G} VF-30', condition: 'Certified', priceRange: [900, 1400], weight: 1, graded: true },
      { title: '1894 Morgan Dollar {G} XF-40', condition: 'Certified', priceRange: [1400, 2200], weight: 1, graded: true },
      { title: '1894-P Morgan Silver Dollar {G} XF-45', condition: 'Certified', priceRange: [1800, 2800], weight: 1, graded: true },
      { title: '1894 Morgan Dollar {G} AU-50', condition: 'Certified', priceRange: [2500, 3800], weight: 1, graded: true },
      { title: '1894 Morgan Silver Dollar {G} AU-53', condition: 'Certified', priceRange: [3200, 5000], weight: 1, graded: true },
      { title: '1894-P Morgan Dollar {G} AU-55', condition: 'Certified', priceRange: [4000, 6500], weight: 1, graded: true },
      { title: '1894 Morgan Silver Dollar {G} AU-58', condition: 'Certified', priceRange: [5500, 8500], weight: 1, graded: true },
      { title: '1894-P Morgan Dollar {G} MS-62', condition: 'Certified', priceRange: [9000, 14000], weight: 1, graded: true },
    ],
    count: 28
  }
];

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

    // Replace {G} with random grader
    if (t.graded) {
      title = title.replace('{G}', pick(GRADERS));
    }

    let id;
    do { id = fakeItemId(); } while (usedIds.has(id));
    usedIds.add(id);

    const price = randFloat(t.priceRange[0], t.priceRange[1]);
    const shipping = pick(SHIPPING_OPTIONS);
    const soldDate = randDate(90);
    const seller = pick(SELLERS);
    const format = pick(['Auction', 'Auction', 'Buy It Now', 'Best Offer']);

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
      // Quote if contains comma or quote
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
console.log('\n═══ Generating Priority 1 Morgan Dollar Terapeak CSVs ═══\n');
let totalRows = 0;

for (const coin of COINS) {
  const rows = generateRows(coin);
  writeCSV(coin.filename, rows);
  totalRows += rows.length;
}

console.log(`\n  Total: ${totalRows} sold comps across ${COINS.length} CSVs`);
console.log(`  Output: ${OUT_DIR}/\n`);
console.log('Run the server or call autoImportFolder to load them.\n');
