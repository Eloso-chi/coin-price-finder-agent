#!/usr/bin/env node
// scripts/generateAllCoinData.js
//
// Master Terapeak sold-data generator for ALL coin series in keyDates.js.
// Organized into 7 daily batches for gradual initial population,
// plus a "common dates" batch on a separate 3-day refresh cycle.
//
// Usage:
//   node scripts/generateAllCoinData.js                    # show schedule
//   node scripts/generateAllCoinData.js --day 1            # run day 1 batch
//   node scripts/generateAllCoinData.js --day all          # run everything (keys + common)
//   node scripts/generateAllCoinData.js --day 3 --import   # run day 3 + auto-import
//   node scripts/generateAllCoinData.js --common --import  # run common dates + auto-import
//   node scripts/generateAllCoinData.js --status           # show what's done vs pending

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

const GRADERS = ['PCGS', 'NGC'];
const SELLERS = [
  'apmex', 'jmbullion', 'moderncoinmart', 'sdbullion', 'boldpreciousmetals',
  'pinehurst_coins', 'bullionshark', 'liberty_coin', 'mcm_online',
  'govmint_official', 'greatcollections', 'keydate_coins', 'heritage_auctions_outlet',
  'silvertowne', 'goldeneaglecoin', 'rarecoinwholesalers', 'legend_numismatics',
  'davidlawrence', 'goldhillcoins'
];
const SHIPPING = [0, 0, 0, 0, 4.99, 5.99, 0, 0, 0, 3.99];

// Shorthand template builder: { t: title, c: condition, p: [lo,hi], w: weight, g: graded }
function T(title, condition, priceRange, weight, graded) {
  return { title, condition, priceRange, weight: weight || 1, graded: graded || false };
}
function TG(title, condition, priceRange, weight) {
  return T(title, condition, priceRange, weight, true);
}

// ═══════════════════════════════════════════════════════════════
// DAY 1: Morgan Dollars Priority 2 — Carson City Semi-Keys
// ═══════════════════════════════════════════════════════════════
const DAY1 = {
  label: 'Morgan Dollars — CC Semi-Keys',
  coins: [
    {
      searchTerm: '1878-CC Morgan Silver Dollar', filename: '1878-CC_Morgan_Silver_Dollar.csv', count: 25,
      titleTemplates: [
        T('1878-CC Morgan Silver Dollar BU First CC Morgan', 'Uncirculated', [220, 350], 3),
        T('1878-CC Morgan Dollar VF Details', 'Circulated', [140, 220], 3),
        T('1878-CC Morgan Silver Dollar Fine Details', 'Circulated', [120, 180], 2),
        TG('1878-CC Morgan Dollar {G} VG-08', 'Certified', [130, 200], 2),
        TG('1878-CC Morgan Silver Dollar {G} F-12', 'Certified', [160, 250], 2),
        TG('1878-CC Morgan Dollar {G} VF-20', 'Certified', [200, 320], 2),
        TG('1878-CC Morgan Silver Dollar {G} VF-30', 'Certified', [280, 420], 2),
        TG('1878-CC Morgan Dollar {G} XF-40', 'Certified', [380, 580], 1),
        TG('1878-CC Morgan Silver Dollar {G} XF-45', 'Certified', [450, 700], 1),
        TG('1878-CC Morgan Dollar {G} AU-50', 'Certified', [600, 950], 1),
        TG('1878-CC Morgan Silver Dollar {G} AU-55', 'Certified', [800, 1200], 1),
        TG('1878-CC Morgan Dollar {G} MS-62', 'Certified', [1200, 1900], 1),
        TG('1878-CC Morgan Silver Dollar {G} MS-63', 'Certified', [1800, 2800], 1),
      ]
    },
    {
      searchTerm: '1880-CC Morgan Silver Dollar', filename: '1880-CC_Morgan_Silver_Dollar.csv', count: 25,
      titleTemplates: [
        T('1880-CC Morgan Silver Dollar BU 8/7 Reverse', 'Uncirculated', [280, 450], 2),
        T('1880-CC Morgan Dollar VF Details', 'Circulated', [160, 250], 3),
        TG('1880-CC Morgan Silver Dollar {G} VG-08', 'Certified', [150, 230], 2),
        TG('1880-CC Morgan Dollar {G} F-12', 'Certified', [190, 300], 2),
        TG('1880-CC Morgan Silver Dollar {G} VF-25', 'Certified', [260, 400], 2),
        TG('1880-CC Morgan Dollar {G} XF-40', 'Certified', [380, 580], 2),
        TG('1880-CC Morgan Silver Dollar {G} AU-50', 'Certified', [500, 800], 1),
        TG('1880-CC Morgan Dollar {G} AU-55', 'Certified', [650, 1000], 1),
        TG('1880-CC Morgan Silver Dollar {G} MS-62', 'Certified', [900, 1400], 1),
        TG('1880-CC Morgan Dollar {G} MS-63', 'Certified', [1300, 2000], 1),
        TG('1880-CC Morgan Silver Dollar {G} MS-64', 'Certified', [2000, 3200], 1),
      ]
    },
    {
      searchTerm: '1881-CC Morgan Silver Dollar', filename: '1881-CC_Morgan_Silver_Dollar.csv', count: 25,
      titleTemplates: [
        T('1881-CC Morgan Silver Dollar BU GSA', 'Uncirculated', [380, 550], 2),
        T('1881-CC Morgan Dollar VF Details', 'Circulated', [280, 420], 2),
        TG('1881-CC Morgan Silver Dollar {G} VF-20', 'Certified', [280, 420], 2),
        TG('1881-CC Morgan Dollar {G} VF-30', 'Certified', [340, 500], 2),
        TG('1881-CC Morgan Silver Dollar {G} XF-45', 'Certified', [420, 650], 2),
        TG('1881-CC Morgan Dollar {G} AU-53', 'Certified', [500, 780], 2),
        TG('1881-CC Morgan Silver Dollar {G} AU-58', 'Certified', [600, 900], 1),
        TG('1881-CC Morgan Dollar {G} MS-62', 'Certified', [650, 1000], 2),
        TG('1881-CC Morgan Silver Dollar {G} MS-63', 'Certified', [800, 1250], 1),
        TG('1881-CC Morgan Dollar {G} MS-64', 'Certified', [1100, 1800], 1),
        TG('1881-CC Morgan Silver Dollar {G} MS-65', 'Certified', [2200, 3800], 1),
      ]
    },
    {
      searchTerm: '1882-CC Morgan Silver Dollar', filename: '1882-CC_Morgan_Silver_Dollar.csv', count: 25,
      titleTemplates: [
        T('1882-CC Morgan Silver Dollar BU GSA Holder', 'Uncirculated', [260, 400], 3),
        T('1882-CC Morgan Dollar VF Details', 'Circulated', [180, 280], 2),
        TG('1882-CC Morgan Silver Dollar {G} VF-25', 'Certified', [200, 310], 2),
        TG('1882-CC Morgan Dollar {G} XF-40', 'Certified', [260, 400], 2),
        TG('1882-CC Morgan Silver Dollar {G} AU-55', 'Certified', [320, 480], 2),
        TG('1882-CC Morgan Dollar {G} MS-62', 'Certified', [380, 580], 2),
        TG('1882-CC Morgan Silver Dollar {G} MS-63', 'Certified', [450, 700], 2),
        TG('1882-CC Morgan Dollar {G} MS-64', 'Certified', [650, 1050], 1),
        TG('1882-CC Morgan Silver Dollar {G} MS-65', 'Certified', [1400, 2400], 1),
      ]
    },
    {
      searchTerm: '1883-CC Morgan Silver Dollar', filename: '1883-CC_Morgan_Silver_Dollar.csv', count: 25,
      titleTemplates: [
        T('1883-CC Morgan Silver Dollar BU GSA', 'Uncirculated', [250, 380], 3),
        T('1883-CC Morgan Dollar VF Details', 'Circulated', [170, 260], 2),
        TG('1883-CC Morgan Silver Dollar {G} VF-30', 'Certified', [200, 300], 2),
        TG('1883-CC Morgan Dollar {G} XF-45', 'Certified', [250, 380], 2),
        TG('1883-CC Morgan Silver Dollar {G} AU-55', 'Certified', [300, 460], 2),
        TG('1883-CC Morgan Dollar {G} MS-62', 'Certified', [350, 540], 2),
        TG('1883-CC Morgan Silver Dollar {G} MS-63', 'Certified', [420, 660], 2),
        TG('1883-CC Morgan Dollar {G} MS-64', 'Certified', [600, 980], 1),
        TG('1883-CC Morgan Silver Dollar {G} MS-65', 'Certified', [1300, 2200], 1),
      ]
    },
    {
      searchTerm: '1884-CC Morgan Silver Dollar', filename: '1884-CC_Morgan_Silver_Dollar.csv', count: 25,
      titleTemplates: [
        T('1884-CC Morgan Silver Dollar BU GSA Holder', 'Uncirculated', [260, 400], 3),
        T('1884-CC Morgan Dollar VF Details', 'Circulated', [180, 280], 2),
        TG('1884-CC Morgan Silver Dollar {G} VF-30', 'Certified', [210, 320], 2),
        TG('1884-CC Morgan Dollar {G} XF-45', 'Certified', [260, 400], 2),
        TG('1884-CC Morgan Silver Dollar {G} AU-55', 'Certified', [320, 500], 2),
        TG('1884-CC Morgan Dollar {G} MS-62', 'Certified', [380, 580], 2),
        TG('1884-CC Morgan Silver Dollar {G} MS-63', 'Certified', [450, 700], 2),
        TG('1884-CC Morgan Dollar {G} MS-64', 'Certified', [680, 1100], 1),
        TG('1884-CC Morgan Silver Dollar {G} MS-65', 'Certified', [1500, 2500], 1),
      ]
    },
    {
      searchTerm: '1885-CC Morgan Silver Dollar', filename: '1885-CC_Morgan_Silver_Dollar.csv', count: 25,
      titleTemplates: [
        T('1885-CC Morgan Silver Dollar BU', 'Uncirculated', [550, 850], 2),
        T('1885-CC Morgan Dollar VF Details', 'Circulated', [450, 680], 2),
        TG('1885-CC Morgan Silver Dollar {G} VF-30', 'Certified', [480, 720], 2),
        TG('1885-CC Morgan Dollar {G} XF-45', 'Certified', [550, 850], 2),
        TG('1885-CC Morgan Silver Dollar {G} AU-55', 'Certified', [620, 950], 2),
        TG('1885-CC Morgan Dollar {G} MS-62', 'Certified', [700, 1100], 2),
        TG('1885-CC Morgan Silver Dollar {G} MS-63', 'Certified', [850, 1350], 2),
        TG('1885-CC Morgan Dollar {G} MS-64', 'Certified', [1200, 1900], 1),
        TG('1885-CC Morgan Silver Dollar {G} MS-65', 'Certified', [2400, 4000], 1),
      ]
    },
    {
      searchTerm: '1890-CC Morgan Silver Dollar', filename: '1890-CC_Morgan_Silver_Dollar.csv', count: 22,
      titleTemplates: [
        T('1890-CC Morgan Silver Dollar BU', 'Uncirculated', [200, 320], 3),
        T('1890-CC Morgan Dollar VF Details', 'Circulated', [130, 200], 2),
        TG('1890-CC Morgan Silver Dollar {G} VF-25', 'Certified', [150, 240], 2),
        TG('1890-CC Morgan Dollar {G} XF-40', 'Certified', [200, 320], 2),
        TG('1890-CC Morgan Silver Dollar {G} AU-50', 'Certified', [280, 440], 2),
        TG('1890-CC Morgan Dollar {G} AU-55', 'Certified', [350, 550], 1),
        TG('1890-CC Morgan Silver Dollar {G} MS-62', 'Certified', [500, 800], 1),
        TG('1890-CC Morgan Dollar {G} MS-63', 'Certified', [800, 1300], 1),
        TG('1890-CC Morgan Silver Dollar {G} MS-64', 'Certified', [1800, 3000], 1),
      ]
    },
    {
      searchTerm: '1891-CC Morgan Silver Dollar', filename: '1891-CC_Morgan_Silver_Dollar.csv', count: 22,
      titleTemplates: [
        T('1891-CC Morgan Silver Dollar BU Spitting Eagle', 'Uncirculated', [200, 320], 3),
        T('1891-CC Morgan Dollar VF Details', 'Circulated', [130, 200], 2),
        TG('1891-CC Morgan Silver Dollar {G} VF-25', 'Certified', [150, 240], 2),
        TG('1891-CC Morgan Dollar {G} XF-40', 'Certified', [200, 320], 2),
        TG('1891-CC Morgan Silver Dollar {G} AU-50', 'Certified', [280, 440], 2),
        TG('1891-CC Morgan Dollar {G} AU-55', 'Certified', [350, 550], 1),
        TG('1891-CC Morgan Silver Dollar {G} MS-62', 'Certified', [500, 800], 1),
        TG('1891-CC Morgan Dollar {G} MS-63', 'Certified', [800, 1300], 1),
        TG('1891-CC Morgan Silver Dollar {G} MS-64', 'Certified', [1800, 3000], 1),
      ]
    },
  ]
};

// ═══════════════════════════════════════════════════════════════
// DAY 2: Morgan Priority 3 (non-CC semi-keys) + Peace Dollars
// ═══════════════════════════════════════════════════════════════
const DAY2 = {
  label: 'Morgan Non-CC Semi-Keys + Peace Dollars',
  coins: [
    {
      searchTerm: '1892-S Morgan Silver Dollar', filename: '1892-S_Morgan_Silver_Dollar.csv', count: 22,
      titleTemplates: [
        T('1892-S Morgan Silver Dollar VF Details', 'Circulated', [120, 200], 3),
        TG('1892-S Morgan Dollar {G} VG-10', 'Certified', [100, 160], 2),
        TG('1892-S Morgan Silver Dollar {G} F-15', 'Certified', [140, 220], 2),
        TG('1892-S Morgan Dollar {G} VF-25', 'Certified', [200, 320], 2),
        TG('1892-S Morgan Silver Dollar {G} XF-40', 'Certified', [350, 550], 2),
        TG('1892-S Morgan Dollar {G} AU-50', 'Certified', [700, 1100], 1),
        TG('1892-S Morgan Silver Dollar {G} AU-55', 'Certified', [1100, 1800], 1),
        TG('1892-S Morgan Dollar {G} MS-62', 'Certified', [3500, 5500], 1),
      ]
    },
    {
      searchTerm: '1895-O Morgan Silver Dollar', filename: '1895-O_Morgan_Silver_Dollar.csv', count: 20,
      titleTemplates: [
        T('1895-O Morgan Silver Dollar VG Details', 'Circulated', [180, 300], 3),
        TG('1895-O Morgan Dollar {G} G-06', 'Certified', [150, 250], 2),
        TG('1895-O Morgan Silver Dollar {G} VG-08', 'Certified', [220, 350], 2),
        TG('1895-O Morgan Dollar {G} F-12', 'Certified', [350, 550], 2),
        TG('1895-O Morgan Silver Dollar {G} VF-20', 'Certified', [600, 950], 2),
        TG('1895-O Morgan Dollar {G} VF-30', 'Certified', [1000, 1600], 1),
        TG('1895-O Morgan Silver Dollar {G} XF-40', 'Certified', [2200, 3500], 1),
        TG('1895-O Morgan Dollar {G} AU-50', 'Certified', [5000, 8000], 1),
      ]
    },
    {
      searchTerm: '1895-S Morgan Silver Dollar', filename: '1895-S_Morgan_Silver_Dollar.csv', count: 20,
      titleTemplates: [
        T('1895-S Morgan Silver Dollar VG Details', 'Circulated', [150, 250], 3),
        TG('1895-S Morgan Dollar {G} VG-08', 'Certified', [200, 320], 2),
        TG('1895-S Morgan Silver Dollar {G} F-12', 'Certified', [300, 480], 2),
        TG('1895-S Morgan Dollar {G} VF-20', 'Certified', [450, 720], 2),
        TG('1895-S Morgan Silver Dollar {G} XF-40', 'Certified', [800, 1300], 1),
        TG('1895-S Morgan Dollar {G} AU-50', 'Certified', [1500, 2500], 1),
        TG('1895-S Morgan Silver Dollar {G} MS-62', 'Certified', [4000, 6500], 1),
      ]
    },
    {
      searchTerm: '1896-S Morgan Silver Dollar', filename: '1896-S_Morgan_Silver_Dollar.csv', count: 20,
      titleTemplates: [
        T('1896-S Morgan Silver Dollar VG Details', 'Circulated', [60, 100], 3),
        TG('1896-S Morgan Dollar {G} VG-10', 'Certified', [70, 120], 2),
        TG('1896-S Morgan Silver Dollar {G} F-12', 'Certified', [100, 170], 2),
        TG('1896-S Morgan Dollar {G} VF-25', 'Certified', [180, 300], 2),
        TG('1896-S Morgan Silver Dollar {G} XF-45', 'Certified', [400, 650], 1),
        TG('1896-S Morgan Dollar {G} AU-55', 'Certified', [900, 1500], 1),
        TG('1896-S Morgan Silver Dollar {G} MS-63', 'Certified', [3500, 5500], 1),
      ]
    },
    {
      searchTerm: '1901 Morgan Silver Dollar', filename: '1901_Morgan_Silver_Dollar.csv', count: 20,
      titleTemplates: [
        T('1901 Morgan Silver Dollar VF Details', 'Circulated', [55, 90], 3),
        TG('1901-P Morgan Dollar {G} VG-10', 'Certified', [50, 85], 2),
        TG('1901 Morgan Silver Dollar {G} F-15', 'Certified', [70, 120], 2),
        TG('1901 Morgan Dollar {G} VF-25', 'Certified', [110, 180], 2),
        TG('1901 Morgan Silver Dollar {G} XF-45', 'Certified', [300, 500], 1),
        TG('1901-P Morgan Dollar {G} AU-55', 'Certified', [1200, 2000], 1),
        TG('1901 Morgan Silver Dollar {G} MS-62', 'Certified', [12000, 20000], 1),
      ]
    },
    {
      searchTerm: '1903-O Morgan Silver Dollar', filename: '1903-O_Morgan_Silver_Dollar.csv', count: 20,
      titleTemplates: [
        T('1903-O Morgan Silver Dollar VF Details', 'Circulated', [280, 420], 2),
        TG('1903-O Morgan Dollar {G} VF-20', 'Certified', [300, 460], 2),
        TG('1903-O Morgan Silver Dollar {G} VF-30', 'Certified', [350, 550], 2),
        TG('1903-O Morgan Dollar {G} XF-40', 'Certified', [400, 620], 2),
        TG('1903-O Morgan Silver Dollar {G} AU-50', 'Certified', [450, 700], 2),
        TG('1903-O Morgan Dollar {G} AU-58', 'Certified', [500, 800], 1),
        TG('1903-O Morgan Silver Dollar {G} MS-62', 'Certified', [550, 880], 1),
        TG('1903-O Morgan Dollar {G} MS-63', 'Certified', [600, 950], 1),
        TG('1903-O Morgan Silver Dollar {G} MS-64', 'Certified', [750, 1200], 1),
        TG('1903-O Morgan Dollar {G} MS-65', 'Certified', [1400, 2400], 1),
      ]
    },
    {
      searchTerm: '1904-S Morgan Silver Dollar', filename: '1904-S_Morgan_Silver_Dollar.csv', count: 18,
      titleTemplates: [
        T('1904-S Morgan Silver Dollar VG Details', 'Circulated', [60, 100], 3),
        TG('1904-S Morgan Dollar {G} VG-10', 'Certified', [70, 120], 2),
        TG('1904-S Morgan Silver Dollar {G} F-15', 'Certified', [100, 170], 2),
        TG('1904-S Morgan Dollar {G} VF-25', 'Certified', [160, 260], 2),
        TG('1904-S Morgan Silver Dollar {G} XF-45', 'Certified', [350, 560], 1),
        TG('1904-S Morgan Dollar {G} AU-55', 'Certified', [700, 1100], 1),
        TG('1904-S Morgan Silver Dollar {G} MS-63', 'Certified', [2800, 4500], 1),
      ]
    },
    // Peace Dollars
    {
      searchTerm: '1921 Peace Silver Dollar', filename: '1921_Peace_Silver_Dollar.csv', count: 25,
      titleTemplates: [
        T('1921 Peace Silver Dollar High Relief First Year', 'Uncirculated', [150, 250], 3),
        T('1921 Peace Dollar VF Details High Relief', 'Circulated', [100, 160], 2),
        TG('1921 Peace Silver Dollar {G} VF-25 High Relief', 'Certified', [120, 200], 2),
        TG('1921 Peace Dollar {G} XF-40', 'Certified', [160, 260], 2),
        TG('1921 Peace Silver Dollar {G} AU-50 High Relief', 'Certified', [200, 320], 2),
        TG('1921 Peace Dollar {G} AU-58', 'Certified', [260, 400], 2),
        TG('1921 Peace Silver Dollar {G} MS-62 High Relief', 'Certified', [350, 550], 1),
        TG('1921 Peace Dollar {G} MS-63', 'Certified', [500, 800], 1),
        TG('1921 Peace Silver Dollar {G} MS-64', 'Certified', [900, 1500], 1),
        TG('1921 Peace Dollar {G} MS-65', 'Certified', [3500, 6000], 1),
      ]
    },
    {
      searchTerm: '1928 Peace Silver Dollar', filename: '1928_Peace_Silver_Dollar.csv', count: 22,
      titleTemplates: [
        T('1928 Peace Silver Dollar VF Details', 'Circulated', [280, 420], 2),
        TG('1928 Peace Dollar {G} VF-20', 'Certified', [300, 460], 2),
        TG('1928 Peace Silver Dollar {G} VF-30', 'Certified', [350, 540], 2),
        TG('1928 Peace Dollar {G} XF-40', 'Certified', [400, 620], 2),
        TG('1928 Peace Silver Dollar {G} AU-50', 'Certified', [480, 750], 2),
        TG('1928 Peace Dollar {G} AU-58', 'Certified', [550, 880], 1),
        TG('1928 Peace Silver Dollar {G} MS-62', 'Certified', [650, 1050], 1),
        TG('1928 Peace Dollar {G} MS-63', 'Certified', [850, 1400], 1),
        TG('1928 Peace Silver Dollar {G} MS-64', 'Certified', [1800, 3000], 1),
      ]
    },
    {
      searchTerm: '1934-S Peace Silver Dollar', filename: '1934-S_Peace_Silver_Dollar.csv', count: 20,
      titleTemplates: [
        T('1934-S Peace Silver Dollar VG Details', 'Circulated', [50, 85], 3),
        TG('1934-S Peace Dollar {G} VG-10', 'Certified', [55, 95], 2),
        TG('1934-S Peace Silver Dollar {G} F-12', 'Certified', [75, 130], 2),
        TG('1934-S Peace Dollar {G} VF-25', 'Certified', [120, 200], 2),
        TG('1934-S Peace Silver Dollar {G} XF-45', 'Certified', [250, 400], 1),
        TG('1934-S Peace Dollar {G} AU-53', 'Certified', [500, 800], 1),
        TG('1934-S Peace Silver Dollar {G} MS-62', 'Certified', [2000, 3500], 1),
      ]
    },
    {
      searchTerm: '1935-S Peace Silver Dollar', filename: '1935-S_Peace_Silver_Dollar.csv', count: 18,
      titleTemplates: [
        T('1935-S Peace Silver Dollar VF Details', 'Circulated', [35, 55], 3),
        TG('1935-S Peace Dollar {G} VF-20', 'Certified', [40, 65], 2),
        TG('1935-S Peace Silver Dollar {G} VF-35', 'Certified', [55, 90], 2),
        TG('1935-S Peace Dollar {G} XF-45', 'Certified', [80, 130], 2),
        TG('1935-S Peace Silver Dollar {G} AU-55', 'Certified', [130, 220], 1),
        TG('1935-S Peace Dollar {G} MS-62', 'Certified', [250, 400], 1),
        TG('1935-S Peace Silver Dollar {G} MS-64', 'Certified', [600, 1000], 1),
      ]
    },
  ]
};

// ═══════════════════════════════════════════════════════════════
// DAY 3: Walking Liberty + Franklin Halves + Kennedy Halves
// ═══════════════════════════════════════════════════════════════
const DAY3 = {
  label: 'Walking Liberty Halves + Franklin Halves + Kennedy Halves',
  coins: [
    // Walking Liberty key dates
    {
      searchTerm: '1916 Walking Liberty Half Dollar', filename: '1916_Walking_Liberty_Half.csv', count: 22,
      titleTemplates: [
        T('1916 Walking Liberty Half Dollar AG-G Details', 'Circulated', [35, 55], 3),
        TG('1916 Walking Liberty Half {G} G-06', 'Certified', [40, 65], 2),
        TG('1916 Walking Liberty Half Dollar {G} VG-10', 'Certified', [65, 105], 2),
        TG('1916 Walking Liberty Half {G} F-12', 'Certified', [100, 165], 2),
        TG('1916 Walking Liberty Half Dollar {G} VF-25', 'Certified', [180, 300], 2),
        TG('1916 Walking Liberty Half {G} XF-40', 'Certified', [280, 450], 1),
        TG('1916 Walking Liberty Half Dollar {G} AU-50', 'Certified', [450, 720], 1),
        TG('1916 Walking Liberty Half {G} MS-62', 'Certified', [750, 1200], 1),
      ]
    },
    {
      searchTerm: '1916-S Walking Liberty Half Dollar', filename: '1916-S_Walking_Liberty_Half.csv', count: 20,
      titleTemplates: [
        T('1916-S Walking Liberty Half Dollar AG Details', 'Circulated', [50, 85], 3),
        TG('1916-S Walking Liberty Half {G} G-04', 'Certified', [55, 90], 2),
        TG('1916-S Walking Liberty Half Dollar {G} VG-08', 'Certified', [85, 140], 2),
        TG('1916-S Walking Liberty Half {G} F-12', 'Certified', [150, 250], 2),
        TG('1916-S Walking Liberty Half Dollar {G} VF-25', 'Certified', [300, 480], 1),
        TG('1916-S Walking Liberty Half {G} XF-40', 'Certified', [500, 800], 1),
        TG('1916-S Walking Liberty Half Dollar {G} AU-50', 'Certified', [900, 1500], 1),
      ]
    },
    {
      searchTerm: '1917-S Walking Liberty Half Dollar Obverse', filename: '1917-S_Walking_Liberty_Half_Obv.csv', count: 18,
      titleTemplates: [
        T('1917-S Walking Liberty Half Dollar Obverse Mintmark', 'Circulated', [30, 55], 3),
        TG('1917-S Walking Liberty Half {G} VG-08 Obverse', 'Certified', [35, 60], 2),
        TG('1917-S Walking Liberty Half Dollar {G} F-12 Obv MM', 'Certified', [50, 90], 2),
        TG('1917-S Walking Liberty Half {G} VF-25 Obverse', 'Certified', [85, 150], 2),
        TG('1917-S Walking Liberty Half Dollar {G} XF-40', 'Certified', [200, 340], 1),
        TG('1917-S Walking Liberty Half {G} AU-50', 'Certified', [400, 650], 1),
      ]
    },
    {
      searchTerm: '1919-D Walking Liberty Half Dollar', filename: '1919-D_Walking_Liberty_Half.csv', count: 18,
      titleTemplates: [
        T('1919-D Walking Liberty Half Dollar AG Details', 'Circulated', [25, 45], 3),
        TG('1919-D Walking Liberty Half {G} G-06', 'Certified', [30, 50], 2),
        TG('1919-D Walking Liberty Half Dollar {G} VG-10', 'Certified', [55, 95], 2),
        TG('1919-D Walking Liberty Half {G} F-15', 'Certified', [110, 180], 2),
        TG('1919-D Walking Liberty Half Dollar {G} VF-25', 'Certified', [220, 360], 1),
        TG('1919-D Walking Liberty Half {G} XF-40', 'Certified', [450, 750], 1),
        TG('1919-D Walking Liberty Half Dollar {G} AU-50', 'Certified', [800, 1300], 1),
      ]
    },
    {
      searchTerm: '1921 Walking Liberty Half Dollar', filename: '1921_Walking_Liberty_Half.csv', count: 18,
      titleTemplates: [
        T('1921 Walking Liberty Half Dollar AG Details', 'Circulated', [80, 140], 3),
        TG('1921 Walking Liberty Half {G} AG-03', 'Certified', [70, 120], 2),
        TG('1921 Walking Liberty Half Dollar {G} G-06', 'Certified', [100, 170], 2),
        TG('1921 Walking Liberty Half {G} VG-08', 'Certified', [150, 250], 2),
        TG('1921 Walking Liberty Half Dollar {G} F-12', 'Certified', [250, 400], 1),
        TG('1921 Walking Liberty Half {G} VF-25', 'Certified', [500, 800], 1),
        TG('1921 Walking Liberty Half Dollar {G} XF-40', 'Certified', [1200, 2000], 1),
      ]
    },
    {
      searchTerm: '1921-D Walking Liberty Half Dollar', filename: '1921-D_Walking_Liberty_Half.csv', count: 18,
      titleTemplates: [
        T('1921-D Walking Liberty Half Dollar AG Details', 'Circulated', [60, 100], 3),
        TG('1921-D Walking Liberty Half {G} AG-03', 'Certified', [55, 95], 2),
        TG('1921-D Walking Liberty Half Dollar {G} G-06', 'Certified', [80, 140], 2),
        TG('1921-D Walking Liberty Half {G} VG-08', 'Certified', [120, 200], 2),
        TG('1921-D Walking Liberty Half Dollar {G} F-12', 'Certified', [200, 340], 1),
        TG('1921-D Walking Liberty Half {G} VF-25', 'Certified', [400, 650], 1),
        TG('1921-D Walking Liberty Half Dollar {G} XF-40', 'Certified', [900, 1500], 1),
      ]
    },
    {
      searchTerm: '1921-S Walking Liberty Half Dollar', filename: '1921-S_Walking_Liberty_Half.csv', count: 16,
      titleTemplates: [
        T('1921-S Walking Liberty Half Dollar AG Details', 'Circulated', [20, 40], 3),
        TG('1921-S Walking Liberty Half {G} G-04', 'Certified', [25, 45], 2),
        TG('1921-S Walking Liberty Half Dollar {G} VG-08', 'Certified', [40, 70], 2),
        TG('1921-S Walking Liberty Half {G} F-12', 'Certified', [80, 140], 2),
        TG('1921-S Walking Liberty Half Dollar {G} VF-25', 'Certified', [200, 340], 1),
        TG('1921-S Walking Liberty Half {G} XF-40', 'Certified', [500, 850], 1),
      ]
    },
    {
      searchTerm: '1938-D Walking Liberty Half Dollar', filename: '1938-D_Walking_Liberty_Half.csv', count: 20,
      titleTemplates: [
        T('1938-D Walking Liberty Half Dollar VF Details', 'Circulated', [55, 90], 3),
        TG('1938-D Walking Liberty Half {G} VF-20', 'Certified', [60, 100], 2),
        TG('1938-D Walking Liberty Half Dollar {G} VF-35', 'Certified', [80, 130], 2),
        TG('1938-D Walking Liberty Half {G} XF-45', 'Certified', [100, 165], 2),
        TG('1938-D Walking Liberty Half Dollar {G} AU-55', 'Certified', [140, 220], 2),
        TG('1938-D Walking Liberty Half {G} MS-63', 'Certified', [220, 360], 1),
        TG('1938-D Walking Liberty Half Dollar {G} MS-64', 'Certified', [320, 520], 1),
        TG('1938-D Walking Liberty Half {G} MS-65', 'Certified', [550, 900], 1),
      ]
    },
    // Franklin Halves
    {
      searchTerm: '1948 Franklin Half Dollar', filename: '1948_Franklin_Half.csv', count: 18,
      titleTemplates: [
        T('1948 Franklin Half Dollar BU First Year', 'Uncirculated', [22, 38], 3),
        TG('1948 Franklin Half {G} MS-63 FBL', 'Certified', [35, 60], 3),
        TG('1948 Franklin Half Dollar {G} MS-64 FBL', 'Certified', [65, 110], 2),
        TG('1948 Franklin Half {G} MS-65 FBL', 'Certified', [150, 260], 1),
        TG('1948 Franklin Half Dollar {G} MS-66 FBL', 'Certified', [500, 850], 1),
      ]
    },
    {
      searchTerm: '1949-S Franklin Half Dollar', filename: '1949-S_Franklin_Half.csv', count: 18,
      titleTemplates: [
        T('1949-S Franklin Half Dollar BU', 'Uncirculated', [20, 35], 3),
        TG('1949-S Franklin Half {G} MS-63 FBL', 'Certified', [50, 85], 2),
        TG('1949-S Franklin Half Dollar {G} MS-64 FBL', 'Certified', [100, 170], 2),
        TG('1949-S Franklin Half {G} MS-65 FBL', 'Certified', [280, 460], 1),
        TG('1949-S Franklin Half Dollar {G} MS-66 FBL', 'Certified', [1200, 2000], 1),
      ]
    },
    {
      searchTerm: '1953 Franklin Half Dollar', filename: '1953_Franklin_Half.csv', count: 16,
      titleTemplates: [
        T('1953 Franklin Half Dollar BU', 'Uncirculated', [18, 30], 3),
        TG('1953 Franklin Half {G} MS-63 FBL', 'Certified', [55, 95], 2),
        TG('1953 Franklin Half Dollar {G} MS-64 FBL', 'Certified', [130, 220], 2),
        TG('1953 Franklin Half {G} MS-65 FBL', 'Certified', [400, 680], 1),
        TG('1953 Franklin Half Dollar {G} MS-66 FBL', 'Certified', [2500, 4200], 1),
      ]
    },
    {
      searchTerm: '1955 Franklin Half Dollar', filename: '1955_Franklin_Half.csv', count: 18,
      titleTemplates: [
        T('1955 Franklin Half Dollar BU Bugs Bunny', 'Uncirculated', [20, 35], 3),
        TG('1955 Franklin Half {G} MS-63 FBL', 'Certified', [28, 48], 2),
        TG('1955 Franklin Half Dollar {G} MS-64 FBL', 'Certified', [45, 75], 2),
        TG('1955 Franklin Half {G} MS-65 FBL', 'Certified', [90, 155], 2),
        TG('1955 Franklin Half Dollar {G} MS-66 FBL', 'Certified', [350, 580], 1),
      ]
    },
    {
      searchTerm: '1956 Franklin Half Dollar', filename: '1956_Franklin_Half.csv', count: 16,
      titleTemplates: [
        T('1956 Franklin Half Dollar BU Type 2', 'Uncirculated', [18, 30], 3),
        TG('1956 Franklin Half {G} MS-64 FBL', 'Certified', [32, 55], 2),
        TG('1956 Franklin Half Dollar {G} MS-65 FBL', 'Certified', [55, 95], 2),
        TG('1956 Franklin Half {G} MS-66 FBL', 'Certified', [200, 340], 1),
      ]
    },
    // Kennedy Halves
    {
      searchTerm: '1964 Kennedy Half Dollar', filename: '1964_Kennedy_Half.csv', count: 25,
      titleTemplates: [
        T('1964 Kennedy Half Dollar 90% Silver BU', 'Uncirculated', [12, 18], 5),
        T('1964 Kennedy Half Dollar Proof', 'Uncirculated', [18, 30], 3),
        TG('1964 Kennedy Half {G} MS-65', 'Certified', [28, 48], 3),
        TG('1964 Kennedy Half Dollar {G} MS-66', 'Certified', [55, 95], 2),
        TG('1964 Kennedy Half {G} MS-67', 'Certified', [350, 600], 1),
        TG('1964 Kennedy Half Dollar {G} PR-69 DCAM', 'Certified', [65, 110], 1),
      ]
    },
    {
      searchTerm: '1970-D Kennedy Half Dollar', filename: '1970-D_Kennedy_Half.csv', count: 20,
      titleTemplates: [
        T('1970-D Kennedy Half Dollar 40% Silver Mint Set Only', 'Uncirculated', [35, 58], 4),
        TG('1970-D Kennedy Half {G} MS-65', 'Certified', [55, 90], 3),
        TG('1970-D Kennedy Half Dollar {G} MS-66', 'Certified', [100, 170], 2),
        TG('1970-D Kennedy Half {G} MS-67', 'Certified', [700, 1200], 1),
      ]
    },
  ]
};

// ═══════════════════════════════════════════════════════════════
// DAY 4: Mercury Dimes + Standing Liberty Quarters + Washington Quarters
// ═══════════════════════════════════════════════════════════════
const DAY4 = {
  label: 'Mercury Dimes + Standing Liberty Quarters + Washington Quarters',
  coins: [
    // Mercury Dimes
    {
      searchTerm: '1916-D Mercury Dime', filename: '1916-D_Mercury_Dime.csv', count: 22,
      titleTemplates: [
        T('1916-D Mercury Dime AG-G Details', 'Circulated', [700, 1100], 3),
        TG('1916-D Mercury Dime {G} AG-03', 'Certified', [650, 1000], 2),
        TG('1916-D Mercury Dime {G} G-04', 'Certified', [850, 1350], 2),
        TG('1916-D Mercury Dime {G} G-06', 'Certified', [1000, 1600], 2),
        TG('1916-D Mercury Dime {G} VG-08', 'Certified', [1400, 2200], 2),
        TG('1916-D Mercury Dime {G} F-12', 'Certified', [2200, 3500], 1),
        TG('1916-D Mercury Dime {G} VF-25', 'Certified', [3500, 5500], 1),
        TG('1916-D Mercury Dime {G} XF-40', 'Certified', [6000, 9500], 1),
        TG('1916-D Mercury Dime {G} AU-50', 'Certified', [9000, 14000], 1),
      ]
    },
    {
      searchTerm: '1921 Mercury Dime', filename: '1921_Mercury_Dime.csv', count: 18,
      titleTemplates: [
        T('1921 Mercury Dime AG Details', 'Circulated', [40, 70], 3),
        TG('1921 Mercury Dime {G} G-04', 'Certified', [45, 75], 2),
        TG('1921 Mercury Dime {G} VG-08', 'Certified', [65, 110], 2),
        TG('1921 Mercury Dime {G} F-12', 'Certified', [100, 170], 2),
        TG('1921 Mercury Dime {G} VF-25', 'Certified', [180, 300], 1),
        TG('1921 Mercury Dime {G} XF-40', 'Certified', [350, 580], 1),
      ]
    },
    {
      searchTerm: '1921-D Mercury Dime', filename: '1921-D_Mercury_Dime.csv', count: 18,
      titleTemplates: [
        T('1921-D Mercury Dime AG Details', 'Circulated', [40, 70], 3),
        TG('1921-D Mercury Dime {G} G-06', 'Certified', [50, 85], 2),
        TG('1921-D Mercury Dime {G} VG-08', 'Certified', [70, 120], 2),
        TG('1921-D Mercury Dime {G} F-12', 'Certified', [110, 190], 2),
        TG('1921-D Mercury Dime {G} VF-25', 'Certified', [200, 340], 1),
        TG('1921-D Mercury Dime {G} XF-40', 'Certified', [400, 650], 1),
      ]
    },
    {
      searchTerm: '1926-S Mercury Dime', filename: '1926-S_Mercury_Dime.csv', count: 16,
      titleTemplates: [
        T('1926-S Mercury Dime VG Details', 'Circulated', [15, 28], 3),
        TG('1926-S Mercury Dime {G} VG-08', 'Certified', [18, 32], 2),
        TG('1926-S Mercury Dime {G} F-12', 'Certified', [30, 55], 2),
        TG('1926-S Mercury Dime {G} VF-25', 'Certified', [80, 140], 2),
        TG('1926-S Mercury Dime {G} XF-40', 'Certified', [200, 340], 1),
        TG('1926-S Mercury Dime {G} AU-55', 'Certified', [500, 850], 1),
      ]
    },
    {
      searchTerm: '1942/1 Mercury Dime', filename: '1942-1_Mercury_Dime.csv', count: 18,
      titleTemplates: [
        T('1942/1 Mercury Dime Overdate VG Details', 'Circulated', [350, 550], 3),
        TG('1942/1 Mercury Dime {G} VG-08 Overdate', 'Certified', [400, 620], 2),
        TG('1942/1 Mercury Dime {G} F-12', 'Certified', [550, 880], 2),
        TG('1942/1 Mercury Dime {G} VF-25', 'Certified', [800, 1300], 1),
        TG('1942/1 Mercury Dime {G} XF-40', 'Certified', [1200, 2000], 1),
        TG('1942/1 Mercury Dime {G} AU-50', 'Certified', [2000, 3200], 1),
      ]
    },
    {
      searchTerm: '1942/1-D Mercury Dime', filename: '1942-1-D_Mercury_Dime.csv', count: 16,
      titleTemplates: [
        T('1942/1-D Mercury Dime Overdate VG Details', 'Circulated', [400, 650], 3),
        TG('1942/1-D Mercury Dime {G} VG-08', 'Certified', [450, 720], 2),
        TG('1942/1-D Mercury Dime {G} F-12', 'Certified', [650, 1050], 2),
        TG('1942/1-D Mercury Dime {G} VF-25', 'Certified', [1000, 1600], 1),
        TG('1942/1-D Mercury Dime {G} XF-40', 'Certified', [1500, 2500], 1),
        TG('1942/1-D Mercury Dime {G} AU-50', 'Certified', [2500, 4000], 1),
      ]
    },
    // Standing Liberty Quarters
    {
      searchTerm: '1916 Standing Liberty Quarter', filename: '1916_Standing_Liberty_Quarter.csv', count: 18,
      titleTemplates: [
        T('1916 Standing Liberty Quarter AG Details', 'Circulated', [3500, 5500], 3),
        TG('1916 Standing Liberty Quarter {G} AG-03', 'Certified', [3200, 5000], 2),
        TG('1916 Standing Liberty Quarter {G} G-04', 'Certified', [4500, 7200], 2),
        TG('1916 Standing Liberty Quarter {G} G-06', 'Certified', [5500, 8800], 1),
        TG('1916 Standing Liberty Quarter {G} VG-08', 'Certified', [7500, 12000], 1),
        TG('1916 Standing Liberty Quarter {G} F-12', 'Certified', [10000, 16000], 1),
      ]
    },
    {
      searchTerm: '1918/7-S Standing Liberty Quarter', filename: '1918-7-S_Standing_Liberty_Quarter.csv', count: 16,
      titleTemplates: [
        T('1918/7-S Standing Liberty Quarter VG Details Overdate', 'Circulated', [1200, 2000], 3),
        TG('1918/7-S Standing Liberty Quarter {G} VG-08', 'Certified', [1500, 2400], 2),
        TG('1918/7-S Standing Liberty Quarter {G} F-12', 'Certified', [2200, 3500], 2),
        TG('1918/7-S Standing Liberty Quarter {G} VF-20', 'Certified', [3500, 5500], 1),
        TG('1918/7-S Standing Liberty Quarter {G} VF-30', 'Certified', [5000, 8000], 1),
        TG('1918/7-S Standing Liberty Quarter {G} XF-40', 'Certified', [8000, 13000], 1),
      ]
    },
    {
      searchTerm: '1919-D Standing Liberty Quarter', filename: '1919-D_Standing_Liberty_Quarter.csv', count: 16,
      titleTemplates: [
        T('1919-D Standing Liberty Quarter VG Details', 'Circulated', [100, 170], 3),
        TG('1919-D Standing Liberty Quarter {G} VG-08', 'Certified', [120, 200], 2),
        TG('1919-D Standing Liberty Quarter {G} F-12', 'Certified', [200, 340], 2),
        TG('1919-D Standing Liberty Quarter {G} VF-25', 'Certified', [400, 650], 1),
        TG('1919-D Standing Liberty Quarter {G} XF-40', 'Certified', [800, 1300], 1),
        TG('1919-D Standing Liberty Quarter {G} AU-50', 'Certified', [1500, 2500], 1),
      ]
    },
    {
      searchTerm: '1919-S Standing Liberty Quarter', filename: '1919-S_Standing_Liberty_Quarter.csv', count: 16,
      titleTemplates: [
        T('1919-S Standing Liberty Quarter VG Details', 'Circulated', [100, 170], 3),
        TG('1919-S Standing Liberty Quarter {G} VG-08', 'Certified', [120, 200], 2),
        TG('1919-S Standing Liberty Quarter {G} F-12', 'Certified', [200, 340], 2),
        TG('1919-S Standing Liberty Quarter {G} VF-25', 'Certified', [400, 650], 1),
        TG('1919-S Standing Liberty Quarter {G} XF-40', 'Certified', [850, 1400], 1),
        TG('1919-S Standing Liberty Quarter {G} AU-50', 'Certified', [1600, 2600], 1),
      ]
    },
    {
      searchTerm: '1921 Standing Liberty Quarter', filename: '1921_Standing_Liberty_Quarter.csv', count: 16,
      titleTemplates: [
        T('1921 Standing Liberty Quarter VG Details', 'Circulated', [80, 140], 3),
        TG('1921 Standing Liberty Quarter {G} VG-08', 'Certified', [100, 170], 2),
        TG('1921 Standing Liberty Quarter {G} F-12', 'Certified', [160, 270], 2),
        TG('1921 Standing Liberty Quarter {G} VF-25', 'Certified', [300, 500], 1),
        TG('1921 Standing Liberty Quarter {G} XF-40', 'Certified', [600, 1000], 1),
        TG('1921 Standing Liberty Quarter {G} AU-50', 'Certified', [1200, 2000], 1),
      ]
    },
    {
      searchTerm: '1923-S Standing Liberty Quarter', filename: '1923-S_Standing_Liberty_Quarter.csv', count: 14,
      titleTemplates: [
        T('1923-S Standing Liberty Quarter VG Details', 'Circulated', [150, 250], 3),
        TG('1923-S Standing Liberty Quarter {G} VG-08', 'Certified', [180, 300], 2),
        TG('1923-S Standing Liberty Quarter {G} F-12', 'Certified', [300, 500], 2),
        TG('1923-S Standing Liberty Quarter {G} VF-25', 'Certified', [550, 900], 1),
        TG('1923-S Standing Liberty Quarter {G} XF-40', 'Certified', [1000, 1700], 1),
      ]
    },
    {
      searchTerm: '1927-S Standing Liberty Quarter', filename: '1927-S_Standing_Liberty_Quarter.csv', count: 14,
      titleTemplates: [
        T('1927-S Standing Liberty Quarter VG Details', 'Circulated', [20, 35], 3),
        TG('1927-S Standing Liberty Quarter {G} F-12', 'Certified', [30, 55], 2),
        TG('1927-S Standing Liberty Quarter {G} VF-25', 'Certified', [80, 140], 2),
        TG('1927-S Standing Liberty Quarter {G} XF-40', 'Certified', [250, 420], 1),
        TG('1927-S Standing Liberty Quarter {G} MS-63 FH', 'Certified', [2000, 3500], 1),
      ]
    },
    // Washington Quarters
    {
      searchTerm: '1932-D Washington Quarter', filename: '1932-D_Washington_Quarter.csv', count: 20,
      titleTemplates: [
        T('1932-D Washington Quarter VG Details Key Date', 'Circulated', [80, 130], 3),
        TG('1932-D Washington Quarter {G} G-06', 'Certified', [75, 120], 2),
        TG('1932-D Washington Quarter {G} VG-08', 'Certified', [100, 165], 2),
        TG('1932-D Washington Quarter {G} F-12', 'Certified', [140, 230], 2),
        TG('1932-D Washington Quarter {G} VF-25', 'Certified', [200, 340], 1),
        TG('1932-D Washington Quarter {G} XF-40', 'Certified', [300, 500], 1),
        TG('1932-D Washington Quarter {G} AU-55', 'Certified', [500, 850], 1),
        TG('1932-D Washington Quarter {G} MS-62', 'Certified', [900, 1500], 1),
      ]
    },
    {
      searchTerm: '1932-S Washington Quarter', filename: '1932-S_Washington_Quarter.csv', count: 20,
      titleTemplates: [
        T('1932-S Washington Quarter VG Details Key Date', 'Circulated', [80, 130], 3),
        TG('1932-S Washington Quarter {G} G-06', 'Certified', [75, 120], 2),
        TG('1932-S Washington Quarter {G} VG-08', 'Certified', [100, 165], 2),
        TG('1932-S Washington Quarter {G} F-12', 'Certified', [135, 220], 2),
        TG('1932-S Washington Quarter {G} VF-25', 'Certified', [190, 320], 1),
        TG('1932-S Washington Quarter {G} XF-40', 'Certified', [280, 460], 1),
        TG('1932-S Washington Quarter {G} AU-55', 'Certified', [420, 700], 1),
        TG('1932-S Washington Quarter {G} MS-63', 'Certified', [750, 1250], 1),
      ]
    },
  ]
};

// ═══════════════════════════════════════════════════════════════
// DAY 5: Barber Coins (Dimes, Quarters, Halves)
// ═══════════════════════════════════════════════════════════════
const DAY5 = {
  label: 'Barber Dimes + Barber Quarters + Barber Halves',
  coins: [
    // Barber Dimes
    {
      searchTerm: '1894-S Barber Dime', filename: '1894-S_Barber_Dime.csv', count: 8,
      titleTemplates: [
        // Extremely rare — only 24 minted, very few sales
        TG('1894-S Barber Dime {G} AG-03', 'Certified', [500000, 800000], 2),
        TG('1894-S Barber Dime {G} G-04', 'Certified', [800000, 1300000], 1),
        TG('1894-S Barber Dime {G} G-06', 'Certified', [1200000, 2000000], 1),
        T('1894-S Barber Dime Replica Copy NOT REAL', 'Circulated', [5, 15], 1),
      ]
    },
    {
      searchTerm: '1895-O Barber Dime', filename: '1895-O_Barber_Dime.csv', count: 16,
      titleTemplates: [
        T('1895-O Barber Dime AG Details', 'Circulated', [25, 45], 3),
        TG('1895-O Barber Dime {G} G-04', 'Certified', [30, 55], 2),
        TG('1895-O Barber Dime {G} VG-08', 'Certified', [55, 95], 2),
        TG('1895-O Barber Dime {G} F-12', 'Certified', [120, 200], 1),
        TG('1895-O Barber Dime {G} VF-20', 'Certified', [250, 420], 1),
      ]
    },
    {
      searchTerm: '1901-S Barber Dime', filename: '1901-S_Barber_Dime.csv', count: 16,
      titleTemplates: [
        T('1901-S Barber Dime AG Details', 'Circulated', [30, 55], 3),
        TG('1901-S Barber Dime {G} G-06', 'Certified', [35, 60], 2),
        TG('1901-S Barber Dime {G} VG-08', 'Certified', [65, 110], 2),
        TG('1901-S Barber Dime {G} F-12', 'Certified', [140, 240], 1),
        TG('1901-S Barber Dime {G} VF-25', 'Certified', [300, 500], 1),
      ]
    },
    // Barber Quarters
    {
      searchTerm: '1896-S Barber Quarter', filename: '1896-S_Barber_Quarter.csv', count: 16,
      titleTemplates: [
        T('1896-S Barber Quarter AG Details', 'Circulated', [40, 70], 3),
        TG('1896-S Barber Quarter {G} G-04', 'Certified', [50, 85], 2),
        TG('1896-S Barber Quarter {G} VG-08', 'Certified', [100, 170], 2),
        TG('1896-S Barber Quarter {G} F-12', 'Certified', [250, 420], 1),
        TG('1896-S Barber Quarter {G} VF-20', 'Certified', [550, 900], 1),
      ]
    },
    {
      searchTerm: '1901-S Barber Quarter', filename: '1901-S_Barber_Quarter.csv', count: 16,
      titleTemplates: [
        T('1901-S Barber Quarter AG Details Major Key', 'Circulated', [2000, 3500], 3),
        TG('1901-S Barber Quarter {G} AG-03', 'Certified', [2500, 4000], 2),
        TG('1901-S Barber Quarter {G} G-04', 'Certified', [4000, 6500], 2),
        TG('1901-S Barber Quarter {G} G-06', 'Certified', [5500, 9000], 1),
        TG('1901-S Barber Quarter {G} VG-08', 'Certified', [8000, 13000], 1),
        TG('1901-S Barber Quarter {G} F-12', 'Certified', [15000, 25000], 1),
      ]
    },
    {
      searchTerm: '1913-S Barber Quarter', filename: '1913-S_Barber_Quarter.csv', count: 16,
      titleTemplates: [
        T('1913-S Barber Quarter AG Details', 'Circulated', [150, 250], 3),
        TG('1913-S Barber Quarter {G} G-04', 'Certified', [180, 300], 2),
        TG('1913-S Barber Quarter {G} VG-08', 'Certified', [350, 580], 2),
        TG('1913-S Barber Quarter {G} F-12', 'Certified', [700, 1200], 1),
        TG('1913-S Barber Quarter {G} VF-20', 'Certified', [1500, 2500], 1),
      ]
    },
    // Barber Halves
    {
      searchTerm: '1892-O Barber Half Dollar Micro O', filename: '1892-O_Barber_Half_Micro_O.csv', count: 16,
      titleTemplates: [
        T('1892-O Barber Half Dollar Micro O AG Details', 'Circulated', [55, 95], 3),
        TG('1892-O Barber Half Dollar Micro O {G} G-04', 'Certified', [70, 120], 2),
        TG('1892-O Barber Half Dollar Micro O {G} VG-08', 'Certified', [120, 200], 2),
        TG('1892-O Barber Half Dollar Micro O {G} F-12', 'Certified', [250, 420], 1),
        TG('1892-O Barber Half Dollar {G} VF-25 Micro O', 'Certified', [500, 850], 1),
      ]
    },
    {
      searchTerm: '1897-S Barber Half Dollar', filename: '1897-S_Barber_Half.csv', count: 14,
      titleTemplates: [
        T('1897-S Barber Half Dollar AG Details', 'Circulated', [30, 55], 3),
        TG('1897-S Barber Half {G} G-04', 'Certified', [35, 60], 2),
        TG('1897-S Barber Half Dollar {G} VG-08', 'Certified', [60, 100], 2),
        TG('1897-S Barber Half {G} F-12', 'Certified', [130, 220], 1),
        TG('1897-S Barber Half Dollar {G} VF-25', 'Certified', [300, 500], 1),
      ]
    },
    {
      searchTerm: '1904-S Barber Half Dollar', filename: '1904-S_Barber_Half.csv', count: 14,
      titleTemplates: [
        T('1904-S Barber Half Dollar AG Details', 'Circulated', [15, 28], 3),
        TG('1904-S Barber Half {G} G-06', 'Certified', [18, 32], 2),
        TG('1904-S Barber Half Dollar {G} VG-10', 'Certified', [35, 60], 2),
        TG('1904-S Barber Half {G} F-12', 'Certified', [80, 140], 1),
        TG('1904-S Barber Half Dollar {G} VF-25', 'Certified', [200, 340], 1),
      ]
    },
    {
      searchTerm: '1913 Barber Half Dollar', filename: '1913_Barber_Half.csv', count: 14,
      titleTemplates: [
        T('1913 Barber Half Dollar VG Details', 'Circulated', [30, 50], 3),
        TG('1913 Barber Half {G} G-06', 'Certified', [25, 45], 2),
        TG('1913 Barber Half Dollar {G} VG-08', 'Certified', [40, 70], 2),
        TG('1913 Barber Half {G} F-12', 'Certified', [80, 140], 1),
        TG('1913 Barber Half Dollar {G} VF-25', 'Certified', [180, 300], 1),
        TG('1913 Barber Half {G} XF-40', 'Certified', [400, 680], 1),
      ]
    },
    {
      searchTerm: '1914 Barber Half Dollar', filename: '1914_Barber_Half.csv', count: 14,
      titleTemplates: [
        T('1914 Barber Half Dollar VG Details', 'Circulated', [35, 60], 3),
        TG('1914 Barber Half {G} G-06', 'Certified', [30, 52], 2),
        TG('1914 Barber Half Dollar {G} VG-08', 'Certified', [48, 82], 2),
        TG('1914 Barber Half {G} F-12', 'Certified', [95, 160], 1),
        TG('1914 Barber Half Dollar {G} VF-25', 'Certified', [220, 370], 1),
      ]
    },
    {
      searchTerm: '1915 Barber Half Dollar', filename: '1915_Barber_Half.csv', count: 14,
      titleTemplates: [
        T('1915 Barber Half Dollar VG Details Last Year', 'Circulated', [30, 50], 3),
        TG('1915 Barber Half {G} G-06', 'Certified', [28, 48], 2),
        TG('1915 Barber Half Dollar {G} VG-08', 'Certified', [45, 78], 2),
        TG('1915 Barber Half {G} F-12', 'Certified', [90, 155], 1),
        TG('1915 Barber Half Dollar {G} VF-25', 'Certified', [200, 340], 1),
      ]
    },
  ]
};

// ═══════════════════════════════════════════════════════════════
// DAY 6: World Bullion (Maples, Pandas, Libertads, Britannias, etc.)
// ═══════════════════════════════════════════════════════════════
const DAY6 = {
  label: 'World Bullion — Maples, Pandas, Libertads, Britannias, Kookaburras, Krugerrands, Philharmonics',
  coins: [
    // Canadian Silver Maple Leafs
    {
      searchTerm: '1988 Canadian Silver Maple Leaf', filename: '1988_Canadian_Silver_Maple_Leaf.csv', count: 20,
      titleTemplates: [
        T('1988 Canada 1 oz Silver Maple Leaf BU First Year', 'Uncirculated', [38, 55], 4),
        TG('1988 Canadian Silver Maple Leaf {G} MS-69', 'Certified', [55, 85], 3),
        TG('1988 Silver Maple Leaf {G} MS-68', 'Certified', [42, 62], 2),
      ]
    },
    {
      searchTerm: '2003 Canadian Silver Maple Leaf', filename: '2003_Canadian_Silver_Maple_Leaf.csv', count: 16,
      titleTemplates: [
        T('2003 Canada 1 oz Silver Maple Leaf BU Low Mintage', 'Uncirculated', [40, 60], 4),
        TG('2003 Canadian Silver Maple Leaf {G} MS-69', 'Certified', [58, 90], 3),
      ]
    },
    // Chinese Silver Pandas
    {
      searchTerm: '1983 Chinese Silver Panda', filename: '1983_Chinese_Silver_Panda.csv', count: 14,
      titleTemplates: [
        T('1983 China Silver Panda 1 oz First Year Issue', 'Uncirculated', [400, 650], 3),
        TG('1983 Chinese Silver Panda {G} MS-67', 'Certified', [500, 800], 2),
        TG('1983 Chinese Silver Panda {G} MS-68', 'Certified', [700, 1100], 2),
        TG('1983 Chinese Silver Panda {G} MS-69', 'Certified', [1200, 2000], 1),
      ]
    },
    {
      searchTerm: '1984 Chinese Silver Panda', filename: '1984_Chinese_Silver_Panda.csv', count: 12,
      titleTemplates: [
        T('1984 China Silver Panda 1 oz', 'Uncirculated', [350, 580], 3),
        TG('1984 Chinese Silver Panda {G} MS-68', 'Certified', [600, 1000], 2),
        TG('1984 Chinese Silver Panda {G} MS-69', 'Certified', [1000, 1700], 1),
      ]
    },
    {
      searchTerm: '1995 Chinese Silver Panda', filename: '1995_Chinese_Silver_Panda.csv', count: 14,
      titleTemplates: [
        T('1995 China Silver Panda 1 oz Small Date', 'Uncirculated', [65, 110], 3),
        T('1995 China Silver Panda 1 oz Large Date', 'Uncirculated', [45, 72], 2),
        TG('1995 Chinese Silver Panda {G} MS-69 Small Date', 'Certified', [150, 260], 2),
        TG('1995 Chinese Silver Panda {G} MS-69 Large Date', 'Certified', [60, 100], 1),
      ]
    },
    // Mexican Silver Libertads
    {
      searchTerm: '2020 Mexican Silver Libertad', filename: '2020_Mexican_Silver_Libertad.csv', count: 18,
      titleTemplates: [
        T('2020 Mexico 1 oz Silver Libertad BU Low Mintage', 'Uncirculated', [60, 95], 4),
        TG('2020 Mexican Silver Libertad {G} MS-69', 'Certified', [85, 140], 3),
        TG('2020 Mexican Silver Libertad {G} MS-70', 'Certified', [180, 320], 1),
      ]
    },
    {
      searchTerm: '2023 Mexican Silver Libertad', filename: '2023_Mexican_Silver_Libertad.csv', count: 18,
      titleTemplates: [
        T('2023 Mexico 1 oz Silver Libertad BU Lowest Mintage', 'Uncirculated', [75, 120], 4),
        TG('2023 Mexican Silver Libertad {G} MS-69', 'Certified', [100, 165], 3),
        TG('2023 Mexican Silver Libertad {G} MS-70', 'Certified', [220, 380], 1),
      ]
    },
    // British Silver Britannias
    {
      searchTerm: '1997 British Silver Britannia', filename: '1997_British_Silver_Britannia.csv', count: 14,
      titleTemplates: [
        T('1997 Great Britain 1 oz Silver Britannia First Year', 'Uncirculated', [80, 130], 3),
        TG('1997 British Silver Britannia {G} MS-69', 'Certified', [120, 200], 2),
        TG('1997 British Silver Britannia {G} MS-68', 'Certified', [90, 150], 2),
      ]
    },
    {
      searchTerm: '2001 British Silver Britannia', filename: '2001_British_Silver_Britannia.csv', count: 12,
      titleTemplates: [
        T('2001 Great Britain 1 oz Silver Britannia Lowest Mintage', 'Uncirculated', [120, 200], 3),
        TG('2001 British Silver Britannia {G} MS-69', 'Certified', [180, 300], 2),
      ]
    },
    // Silver Krugerrands
    {
      searchTerm: '2017 Silver Krugerrand', filename: '2017_Silver_Krugerrand.csv', count: 18,
      titleTemplates: [
        T('2017 South Africa 1 oz Silver Krugerrand First Year BU', 'Uncirculated', [42, 65], 4),
        TG('2017 Silver Krugerrand {G} MS-69 50th Anniversary', 'Certified', [60, 100], 3),
        TG('2017 Silver Krugerrand {G} MS-70 First Year', 'Certified', [100, 175], 1),
        T('2017 South Africa 1 oz Silver Krugerrand Proof', 'Uncirculated', [80, 130], 2),
      ]
    },
    // Australian Silver Kookaburras
    {
      searchTerm: '1990 Australian Silver Kookaburra', filename: '1990_Australian_Silver_Kookaburra.csv', count: 14,
      titleTemplates: [
        T('1990 Australia 1 oz Silver Kookaburra First Year BU', 'Uncirculated', [55, 90], 3),
        TG('1990 Australian Silver Kookaburra {G} MS-69', 'Certified', [80, 135], 2),
        TG('1990 Australian Silver Kookaburra {G} MS-70', 'Certified', [200, 350], 1),
      ]
    },
    // Austrian Silver Philharmonics
    {
      searchTerm: '2008 Austrian Silver Philharmonic', filename: '2008_Austrian_Silver_Philharmonic.csv', count: 14,
      titleTemplates: [
        T('2008 Austria 1 oz Silver Philharmonic First Year BU', 'Uncirculated', [35, 52], 4),
        TG('2008 Austrian Silver Philharmonic {G} MS-69', 'Certified', [48, 78], 2),
        TG('2008 Austrian Silver Philharmonic {G} MS-70', 'Certified', [80, 140], 1),
      ]
    },
  ]
};

// ═══════════════════════════════════════════════════════════════
// DAY 7: US Gold Type Coins + Gold Buffalo + Seated Liberty + Trade Dollars
// ═══════════════════════════════════════════════════════════════
const DAY7 = {
  label: 'US Gold Type Coins + Gold Buffalo + Seated Liberty + Trade Dollars',
  coins: [
    // Gold Buffalo
    {
      searchTerm: '2006 American Gold Buffalo', filename: '2006_American_Gold_Buffalo.csv', count: 25,
      titleTemplates: [
        T('2006 American Gold Buffalo 1 oz .9999 First Year BU', 'Uncirculated', [2750, 3100], 4),
        TG('2006 Gold Buffalo {G} MS-69 First Strike', 'Certified', [2850, 3250], 3),
        TG('2006 American Gold Buffalo {G} MS-70', 'Certified', [3500, 5000], 2),
        TG('2006 Gold Buffalo {G} MS-69', 'Certified', [2800, 3200], 2),
        T('2006-W American Gold Buffalo 1 oz Proof', 'Uncirculated', [3000, 3500], 2),
        TG('2006-W Gold Buffalo Proof {G} PF-69 DCAM', 'Certified', [3100, 3600], 2),
        TG('2006-W Gold Buffalo Proof {G} PF-70 DCAM', 'Certified', [4000, 6000], 1),
      ]
    },
    // St. Gaudens
    {
      searchTerm: '1907 Saint Gaudens Double Eagle High Relief', filename: '1907_Saint_Gaudens_High_Relief.csv', count: 16,
      titleTemplates: [
        TG('1907 Saint Gaudens High Relief Double Eagle {G} AU-55', 'Certified', [12000, 18000], 2),
        TG('1907 St Gaudens $20 High Relief {G} AU-58', 'Certified', [15000, 23000], 2),
        TG('1907 Saint Gaudens High Relief {G} MS-61', 'Certified', [18000, 28000], 2),
        TG('1907 Saint Gaudens High Relief {G} MS-62', 'Certified', [22000, 35000], 1),
        TG('1907 St Gaudens High Relief {G} MS-63', 'Certified', [30000, 48000], 1),
        T('1907 Saint Gaudens High Relief Wire Rim $20 Gold', 'Circulated', [45000, 75000], 1),
      ]
    },
    {
      searchTerm: '1908 Saint Gaudens Double Eagle No Motto', filename: '1908_Saint_Gaudens_No_Motto.csv', count: 20,
      titleTemplates: [
        T('1908 Saint Gaudens $20 No Motto BU', 'Uncirculated', [2600, 3000], 3),
        TG('1908 Saint Gaudens No Motto {G} MS-63', 'Certified', [2800, 3300], 3),
        TG('1908 St Gaudens $20 No Motto {G} MS-64', 'Certified', [3200, 4200], 2),
        TG('1908 Saint Gaudens No Motto {G} MS-65', 'Certified', [5500, 8500], 1),
        TG('1908 Saint Gaudens No Motto {G} MS-66', 'Certified', [12000, 20000], 1),
      ]
    },
    // Indian Head Eagles ($10)
    {
      searchTerm: '1907 Indian Head Eagle', filename: '1907_Indian_Head_Eagle.csv', count: 18,
      titleTemplates: [
        T('1907 Indian Head $10 Eagle First Year BU', 'Uncirculated', [1000, 1500], 3),
        TG('1907 Indian Eagle {G} MS-62', 'Certified', [1100, 1700], 2),
        TG('1907 Indian Head $10 Eagle {G} MS-63', 'Certified', [1500, 2300], 2),
        TG('1907 Indian Eagle {G} MS-64', 'Certified', [3000, 5000], 1),
        T('1907 Indian Head $10 Wire Rim Variety', 'Circulated', [15000, 25000], 1),
      ]
    },
    {
      searchTerm: '1911-D Indian Head Eagle', filename: '1911-D_Indian_Head_Eagle.csv', count: 16,
      titleTemplates: [
        T('1911-D Indian Head $10 Eagle VF Details', 'Circulated', [800, 1300], 3),
        TG('1911-D Indian Eagle {G} VF-30', 'Certified', [900, 1400], 2),
        TG('1911-D Indian Head $10 Eagle {G} XF-40', 'Certified', [1200, 1900], 2),
        TG('1911-D Indian Eagle {G} AU-50', 'Certified', [1500, 2400], 1),
        TG('1911-D Indian Head $10 Eagle {G} AU-55', 'Certified', [1800, 2900], 1),
        TG('1911-D Indian Eagle {G} MS-62', 'Certified', [3500, 5500], 1),
      ]
    },
    // Indian Quarter Eagles ($2.50)
    {
      searchTerm: '1911-D Indian Quarter Eagle', filename: '1911-D_Indian_Quarter_Eagle.csv', count: 18,
      titleTemplates: [
        T('1911-D $2.50 Indian Quarter Eagle VF Details Key', 'Circulated', [2500, 4000], 3),
        TG('1911-D Indian Quarter Eagle {G} VF-20', 'Certified', [3000, 4800], 2),
        TG('1911-D Indian $2.50 {G} VF-30', 'Certified', [3800, 6000], 2),
        TG('1911-D Indian Quarter Eagle {G} XF-40', 'Certified', [5000, 8000], 1),
        TG('1911-D Indian $2.50 {G} XF-45', 'Certified', [6000, 9500], 1),
        TG('1911-D Indian Quarter Eagle {G} AU-50', 'Certified', [8000, 13000], 1),
        TG('1911-D Indian $2.50 {G} AU-55', 'Certified', [10000, 16000], 1),
      ]
    },
    // Liberty Half Eagles ($5)
    {
      searchTerm: '1875 Liberty Half Eagle', filename: '1875_Liberty_Half_Eagle.csv', count: 10,
      titleTemplates: [
        TG('1875 Liberty $5 Half Eagle {G} VF-25', 'Certified', [20000, 35000], 2),
        TG('1875 Liberty Half Eagle {G} XF-40', 'Certified', [35000, 55000], 1),
        TG('1875 Liberty $5 Half Eagle {G} AU-50', 'Certified', [50000, 80000], 1),
        T('1875 Liberty Half Eagle $5 Gold Proof', 'Certified', [80000, 130000], 1),
      ]
    },
    // Seated Liberty Dollars
    {
      searchTerm: '1871-CC Seated Liberty Dollar', filename: '1871-CC_Seated_Liberty_Dollar.csv', count: 10,
      titleTemplates: [
        T('1871-CC Seated Liberty Dollar VG Details', 'Circulated', [8000, 14000], 3),
        TG('1871-CC Seated Liberty Dollar {G} G-06', 'Certified', [10000, 17000], 2),
        TG('1871-CC Seated Liberty Dollar {G} VG-08', 'Certified', [15000, 25000], 1),
        TG('1871-CC Seated Liberty Dollar {G} F-12', 'Certified', [25000, 42000], 1),
      ]
    },
    {
      searchTerm: '1873-CC Seated Liberty Dollar', filename: '1873-CC_Seated_Liberty_Dollar.csv', count: 10,
      titleTemplates: [
        T('1873-CC Seated Liberty Dollar VG Details', 'Circulated', [6000, 10000], 3),
        TG('1873-CC Seated Liberty Dollar {G} G-06', 'Certified', [7500, 12500], 2),
        TG('1873-CC Seated Liberty Dollar {G} VG-10', 'Certified', [12000, 20000], 1),
        TG('1873-CC Seated Liberty Dollar {G} F-12', 'Certified', [20000, 35000], 1),
      ]
    },
    // Trade Dollars
    {
      searchTerm: '1878-CC Trade Dollar', filename: '1878-CC_Trade_Dollar.csv', count: 16,
      titleTemplates: [
        T('1878-CC Trade Dollar VF Details', 'Circulated', [280, 450], 3),
        TG('1878-CC Trade Dollar {G} VF-20', 'Certified', [320, 500], 2),
        TG('1878-CC Trade Dollar {G} VF-30', 'Certified', [420, 680], 2),
        TG('1878-CC Trade Dollar {G} XF-40', 'Certified', [550, 900], 1),
        TG('1878-CC Trade Dollar {G} XF-45', 'Certified', [700, 1150], 1),
        TG('1878-CC Trade Dollar {G} AU-50', 'Certified', [1000, 1600], 1),
        TG('1878-CC Trade Dollar {G} AU-55', 'Certified', [1400, 2200], 1),
      ]
    },
  ]
};

// ═══════════════════════════════════════════════════════════════
// COMMON DATES — High-volume, stable prices. Run every 3 days max.
// node scripts/generateAllCoinData.js --common --import
// ═══════════════════════════════════════════════════════════════
const COMMON = {
  label: 'Common Dates — High Volume (refresh every 3 days)',
  coins: [
    // ── Morgan Dollar common dates ──
    {
      searchTerm: '1921 Morgan Silver Dollar', filename: '1921_Morgan_Silver_Dollar.csv', count: 35,
      titleTemplates: [
        T('1921 Morgan Silver Dollar BU', 'Uncirculated', [32, 48], 5),
        T('1921 Morgan Dollar AU Details', 'Circulated', [28, 40], 4),
        T('1921-P Morgan Silver Dollar VF-XF', 'Circulated', [26, 36], 3),
        TG('1921 Morgan Dollar {G} MS-62', 'Certified', [38, 55], 3),
        TG('1921 Morgan Silver Dollar {G} MS-63', 'Certified', [45, 68], 2),
        TG('1921 Morgan Dollar {G} MS-64', 'Certified', [55, 85], 2),
        TG('1921 Morgan Silver Dollar {G} MS-65', 'Certified', [100, 170], 1),
      ]
    },
    {
      searchTerm: '1880-S Morgan Silver Dollar', filename: '1880-S_Morgan_Silver_Dollar.csv', count: 30,
      titleTemplates: [
        T('1880-S Morgan Silver Dollar BU Blast White', 'Uncirculated', [38, 55], 4),
        T('1880-S Morgan Dollar AU-BU', 'Circulated', [32, 46], 3),
        TG('1880-S Morgan Dollar {G} MS-63', 'Certified', [48, 72], 3),
        TG('1880-S Morgan Silver Dollar {G} MS-64', 'Certified', [60, 95], 2),
        TG('1880-S Morgan Dollar {G} MS-65', 'Certified', [100, 165], 1),
        TG('1880-S Morgan Silver Dollar {G} MS-66', 'Certified', [220, 380], 1),
      ]
    },
    {
      searchTerm: '1881-S Morgan Silver Dollar', filename: '1881-S_Morgan_Silver_Dollar.csv', count: 30,
      titleTemplates: [
        T('1881-S Morgan Silver Dollar BU', 'Uncirculated', [38, 55], 4),
        T('1881-S Morgan Dollar AU-BU Toned', 'Circulated', [33, 48], 3),
        TG('1881-S Morgan Dollar {G} MS-63', 'Certified', [48, 72], 3),
        TG('1881-S Morgan Silver Dollar {G} MS-64', 'Certified', [58, 90], 2),
        TG('1881-S Morgan Dollar {G} MS-65', 'Certified', [95, 160], 1),
        TG('1881-S Morgan Silver Dollar {G} MS-66', 'Certified', [200, 350], 1),
      ]
    },
    {
      searchTerm: '1882-S Morgan Silver Dollar', filename: '1882-S_Morgan_Silver_Dollar.csv', count: 28,
      titleTemplates: [
        T('1882-S Morgan Silver Dollar BU', 'Uncirculated', [36, 52], 4),
        T('1882-S Morgan Dollar XF-AU', 'Circulated', [30, 42], 3),
        TG('1882-S Morgan Dollar {G} MS-63', 'Certified', [45, 68], 3),
        TG('1882-S Morgan Silver Dollar {G} MS-64', 'Certified', [55, 85], 2),
        TG('1882-S Morgan Dollar {G} MS-65', 'Certified', [90, 155], 1),
      ]
    },
    {
      searchTerm: '1884-O Morgan Silver Dollar', filename: '1884-O_Morgan_Silver_Dollar.csv', count: 28,
      titleTemplates: [
        T('1884-O Morgan Silver Dollar BU', 'Uncirculated', [36, 52], 4),
        T('1884-O Morgan Dollar AU-BU', 'Circulated', [30, 44], 3),
        TG('1884-O Morgan Dollar {G} MS-63', 'Certified', [48, 70], 3),
        TG('1884-O Morgan Silver Dollar {G} MS-64', 'Certified', [58, 88], 2),
        TG('1884-O Morgan Dollar {G} MS-65', 'Certified', [100, 170], 1),
      ]
    },
    {
      searchTerm: '1885-O Morgan Silver Dollar', filename: '1885-O_Morgan_Silver_Dollar.csv', count: 28,
      titleTemplates: [
        T('1885-O Morgan Silver Dollar BU', 'Uncirculated', [36, 52], 4),
        T('1885-O Morgan Dollar AU Nice', 'Circulated', [30, 43], 3),
        TG('1885-O Morgan Dollar {G} MS-63', 'Certified', [46, 68], 3),
        TG('1885-O Morgan Silver Dollar {G} MS-64', 'Certified', [55, 85], 2),
        TG('1885-O Morgan Dollar {G} MS-65', 'Certified', [95, 160], 1),
      ]
    },
    {
      searchTerm: '1887 Morgan Silver Dollar', filename: '1887_Morgan_Silver_Dollar.csv', count: 28,
      titleTemplates: [
        T('1887 Morgan Silver Dollar BU', 'Uncirculated', [36, 52], 4),
        T('1887 Morgan Dollar AU-BU', 'Circulated', [30, 44], 3),
        TG('1887 Morgan Dollar {G} MS-63', 'Certified', [46, 68], 3),
        TG('1887 Morgan Silver Dollar {G} MS-64', 'Certified', [55, 85], 2),
        TG('1887 Morgan Dollar {G} MS-65', 'Certified', [95, 160], 1),
        TG('1887 Morgan Silver Dollar {G} MS-66', 'Certified', [200, 340], 1),
      ]
    },
    {
      searchTerm: '1889 Morgan Silver Dollar', filename: '1889_Morgan_Silver_Dollar.csv', count: 25,
      titleTemplates: [
        T('1889 Morgan Silver Dollar BU', 'Uncirculated', [36, 52], 4),
        T('1889 Morgan Dollar AU', 'Circulated', [30, 44], 3),
        TG('1889 Morgan Dollar {G} MS-63', 'Certified', [48, 72], 3),
        TG('1889 Morgan Silver Dollar {G} MS-64', 'Certified', [62, 98], 2),
        TG('1889 Morgan Dollar {G} MS-65', 'Certified', [120, 200], 1),
      ]
    },
    {
      searchTerm: '1896 Morgan Silver Dollar', filename: '1896_Morgan_Silver_Dollar.csv', count: 25,
      titleTemplates: [
        T('1896 Morgan Silver Dollar BU', 'Uncirculated', [36, 52], 4),
        T('1896 Morgan Dollar AU', 'Circulated', [30, 44], 3),
        TG('1896 Morgan Dollar {G} MS-63', 'Certified', [48, 72], 3),
        TG('1896 Morgan Silver Dollar {G} MS-64', 'Certified', [60, 95], 2),
        TG('1896 Morgan Dollar {G} MS-65', 'Certified', [100, 170], 1),
      ]
    },
    {
      searchTerm: '1900-O Morgan Silver Dollar', filename: '1900-O_Morgan_Silver_Dollar.csv', count: 25,
      titleTemplates: [
        T('1900-O Morgan Silver Dollar BU', 'Uncirculated', [36, 52], 4),
        T('1900-O Morgan Dollar AU', 'Circulated', [28, 42], 3),
        TG('1900-O Morgan Dollar {G} MS-63', 'Certified', [46, 68], 3),
        TG('1900-O Morgan Silver Dollar {G} MS-64', 'Certified', [55, 85], 2),
        TG('1900-O Morgan Dollar {G} MS-65', 'Certified', [120, 200], 1),
      ]
    },
    // ── Peace Dollar common dates ──
    {
      searchTerm: '1922 Peace Silver Dollar', filename: '1922_Peace_Silver_Dollar.csv', count: 30,
      titleTemplates: [
        T('1922 Peace Silver Dollar BU', 'Uncirculated', [28, 40], 5),
        T('1922 Peace Dollar AU-BU', 'Circulated', [25, 36], 4),
        TG('1922 Peace Dollar {G} MS-63', 'Certified', [35, 52], 3),
        TG('1922 Peace Silver Dollar {G} MS-64', 'Certified', [42, 65], 2),
        TG('1922 Peace Dollar {G} MS-65', 'Certified', [70, 120], 1),
      ]
    },
    {
      searchTerm: '1923 Peace Silver Dollar', filename: '1923_Peace_Silver_Dollar.csv', count: 28,
      titleTemplates: [
        T('1923 Peace Silver Dollar BU', 'Uncirculated', [28, 40], 5),
        T('1923 Peace Dollar AU-BU', 'Circulated', [25, 36], 4),
        TG('1923 Peace Dollar {G} MS-63', 'Certified', [35, 52], 3),
        TG('1923 Peace Silver Dollar {G} MS-64', 'Certified', [42, 65], 2),
        TG('1923 Peace Dollar {G} MS-65', 'Certified', [70, 120], 1),
      ]
    },
    {
      searchTerm: '1924 Peace Silver Dollar', filename: '1924_Peace_Silver_Dollar.csv', count: 25,
      titleTemplates: [
        T('1924 Peace Silver Dollar BU', 'Uncirculated', [28, 40], 5),
        T('1924 Peace Dollar AU', 'Circulated', [25, 36], 4),
        TG('1924 Peace Dollar {G} MS-63', 'Certified', [35, 52], 3),
        TG('1924 Peace Silver Dollar {G} MS-64', 'Certified', [42, 65], 2),
        TG('1924 Peace Dollar {G} MS-65', 'Certified', [72, 125], 1),
      ]
    },
    {
      searchTerm: '1925 Peace Silver Dollar', filename: '1925_Peace_Silver_Dollar.csv', count: 25,
      titleTemplates: [
        T('1925 Peace Silver Dollar BU', 'Uncirculated', [28, 40], 5),
        T('1925 Peace Dollar AU', 'Circulated', [25, 36], 4),
        TG('1925 Peace Dollar {G} MS-63', 'Certified', [35, 52], 3),
        TG('1925 Peace Silver Dollar {G} MS-64', 'Certified', [42, 65], 2),
        TG('1925 Peace Dollar {G} MS-65', 'Certified', [70, 120], 1),
      ]
    },
    // ── ASE common / generic ──
    {
      searchTerm: 'American Silver Eagle', filename: 'American_Silver_Eagle_Generic.csv', count: 40,
      titleTemplates: [
        T('American Silver Eagle 1 oz .999 Silver BU', 'Uncirculated', [32, 42], 6),
        T('American Silver Eagle 1 oz BU Random Year', 'Uncirculated', [31, 40], 5),
        T('American Silver Eagle BU in Capsule', 'Uncirculated', [33, 44], 3),
        TG('American Silver Eagle {G} MS-69', 'Certified', [38, 52], 3),
        TG('American Silver Eagle {G} MS-70', 'Certified', [48, 72], 2),
        T('Lot of 5 American Silver Eagle 1 oz BU', 'Uncirculated', [160, 210], 1),
      ]
    },
    {
      searchTerm: '2024 American Silver Eagle', filename: '2024_American_Silver_Eagle.csv', count: 35,
      titleTemplates: [
        T('2024 American Silver Eagle 1 oz .999 Silver BU', 'Uncirculated', [33, 44], 5),
        T('2024 Silver Eagle Type 2 BU', 'Uncirculated', [32, 42], 4),
        TG('2024 American Silver Eagle {G} MS-69', 'Certified', [40, 55], 3),
        TG('2024 Silver Eagle {G} MS-70 First Strike', 'Certified', [50, 75], 2),
        TG('2024-W American Silver Eagle Proof {G} PF-69 DCAM', 'Certified', [65, 95], 1),
      ]
    },
    {
      searchTerm: '2025 American Silver Eagle', filename: '2025_American_Silver_Eagle.csv', count: 30,
      titleTemplates: [
        T('2025 American Silver Eagle 1 oz .999 Silver BU', 'Uncirculated', [34, 46], 5),
        T('2025 Silver Eagle BU Newest Release', 'Uncirculated', [35, 48], 4),
        TG('2025 American Silver Eagle {G} MS-69', 'Certified', [42, 58], 3),
        TG('2025 Silver Eagle {G} MS-70 First Day', 'Certified', [55, 82], 2),
      ]
    },
    // ── AGE common / generic ──
    {
      searchTerm: 'American Gold Eagle 1 oz', filename: 'American_Gold_Eagle_1oz_Generic.csv', count: 30,
      titleTemplates: [
        T('American Gold Eagle 1 oz .9167 Gold BU Random Year', 'Uncirculated', [2650, 2950], 5),
        T('American Gold Eagle 1 oz BU', 'Uncirculated', [2680, 2980], 4),
        TG('American Gold Eagle 1 oz {G} MS-69', 'Certified', [2750, 3050], 3),
        TG('American Gold Eagle 1 oz {G} MS-70', 'Certified', [2900, 3300], 1),
      ]
    },
    {
      searchTerm: '2024 American Gold Eagle 1 oz', filename: '2024_American_Gold_Eagle_1oz.csv', count: 28,
      titleTemplates: [
        T('2024 American Gold Eagle 1 oz BU', 'Uncirculated', [2700, 3000], 5),
        T('2024 Gold Eagle 1oz Type 2', 'Uncirculated', [2680, 2980], 4),
        TG('2024 American Gold Eagle 1 oz {G} MS-69', 'Certified', [2780, 3080], 3),
        TG('2024 Gold Eagle 1oz {G} MS-70 First Strike', 'Certified', [2900, 3350], 1),
      ]
    },
    {
      searchTerm: '2025 American Gold Eagle 1 oz', filename: '2025_American_Gold_Eagle_1oz.csv', count: 25,
      titleTemplates: [
        T('2025 American Gold Eagle 1 oz BU', 'Uncirculated', [2720, 3020], 5),
        T('2025 Gold Eagle 1oz Newest Release', 'Uncirculated', [2700, 3000], 4),
        TG('2025 American Gold Eagle 1 oz {G} MS-69', 'Certified', [2800, 3100], 3),
        TG('2025 Gold Eagle 1oz {G} MS-70 First Day', 'Certified', [2950, 3400], 1),
      ]
    },
    // ── Fractional Gold Eagles (common) ──
    {
      searchTerm: 'American Gold Eagle 1/10 oz', filename: 'American_Gold_Eagle_Tenth_oz_Generic.csv', count: 25,
      titleTemplates: [
        T('American Gold Eagle 1/10 oz BU Random Year', 'Uncirculated', [265, 310], 5),
        T('American Gold Eagle 1/10 oz .9167 Gold BU', 'Uncirculated', [268, 315], 4),
        TG('American Gold Eagle 1/10 oz {G} MS-69', 'Certified', [280, 325], 3),
        TG('American Gold Eagle 1/10 oz {G} MS-70', 'Certified', [310, 380], 1),
      ]
    },
    {
      searchTerm: 'American Gold Eagle 1/4 oz', filename: 'American_Gold_Eagle_Quarter_oz_Generic.csv', count: 22,
      titleTemplates: [
        T('American Gold Eagle 1/4 oz BU Random Year', 'Uncirculated', [660, 750], 5),
        T('American Gold Eagle 1/4 oz .9167 Gold BU', 'Uncirculated', [665, 755], 4),
        TG('American Gold Eagle 1/4 oz {G} MS-69', 'Certified', [700, 790], 3),
        TG('American Gold Eagle 1/4 oz {G} MS-70', 'Certified', [780, 920], 1),
      ]
    },
    // ── Gold Buffalo common ──
    {
      searchTerm: 'American Gold Buffalo 1 oz', filename: 'American_Gold_Buffalo_1oz_Generic.csv', count: 25,
      titleTemplates: [
        T('American Gold Buffalo 1 oz .9999 Gold BU Random Year', 'Uncirculated', [2750, 3100], 5),
        T('Gold Buffalo 1oz .9999 Fine Gold BU', 'Uncirculated', [2760, 3080], 4),
        TG('American Gold Buffalo 1 oz {G} MS-69', 'Certified', [2820, 3150], 3),
        TG('Gold Buffalo 1oz {G} MS-70', 'Certified', [2950, 3400], 1),
      ]
    },
    // ── Generic Morgan sweep (catches misc common dates) ──
    {
      searchTerm: 'Morgan Silver Dollar', filename: 'Morgan_Silver_Dollar_Generic.csv', count: 40,
      titleTemplates: [
        T('Morgan Silver Dollar BU Uncirculated Random Year', 'Uncirculated', [35, 52], 5),
        T('Morgan Dollar AU-BU Pre-1921', 'Circulated', [32, 48], 4),
        T('Morgan Silver Dollar VF-XF Circulated', 'Circulated', [28, 38], 3),
        TG('Morgan Silver Dollar {G} MS-63 Random', 'Certified', [48, 75], 2),
        TG('Morgan Silver Dollar {G} MS-64', 'Certified', [60, 100], 1),
        TG('Morgan Silver Dollar {G} MS-65', 'Certified', [100, 180], 1),
      ]
    },
    // ── Generic Peace sweep ──
    {
      searchTerm: 'Peace Silver Dollar', filename: 'Peace_Silver_Dollar_Generic.csv', count: 35,
      titleTemplates: [
        T('Peace Silver Dollar BU Uncirculated Random Year', 'Uncirculated', [28, 40], 5),
        T('Peace Dollar AU-BU', 'Circulated', [25, 36], 4),
        T('Peace Silver Dollar VF-XF', 'Circulated', [24, 34], 3),
        TG('Peace Silver Dollar {G} MS-63 Random', 'Certified', [35, 55], 2),
        TG('Peace Silver Dollar {G} MS-64', 'Certified', [42, 68], 1),
        TG('Peace Silver Dollar {G} MS-65', 'Certified', [70, 125], 1),
      ]
    },
  ]
};

// ═══════════════════════════════════════════════════════════════
// SCHEDULE
// ═══════════════════════════════════════════════════════════════
const SCHEDULE = [
  DAY1, // Day 1: Morgan CC Semi-Keys
  DAY2, // Day 2: Morgan non-CC Semi-Keys + Peace Dollars
  DAY3, // Day 3: Walking Liberty + Franklin + Kennedy Halves
  DAY4, // Day 4: Mercury Dimes + Standing Liberty + Washington Quarters
  DAY5, // Day 5: Barber Coins
  DAY6, // Day 6: World Bullion
  DAY7, // Day 7: US Gold + Buffalo + Seated Liberty + Trade Dollars
];

// ═══════════════════════════════════════════════════════════════
// EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════════
function buildPool(templates) {
  const pool = [];
  for (const t of templates) {
    for (let i = 0; i < (t.weight || 1); i++) pool.push(t);
  }
  return pool;
}

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
  console.log(`    ✓ ${filename} — ${rows.length} sold listings`);
}

function runDay(dayNum) {
  const day = SCHEDULE[dayNum - 1];
  if (!day) { console.error(`  ✗ No schedule for day ${dayNum}`); return 0; }
  console.log(`\n  ═══ Day ${dayNum}: ${day.label} ═══\n`);
  let total = 0;
  for (const coin of day.coins) {
    const rows = generateRows(coin);
    writeCSV(coin.filename, rows);
    total += rows.length;
  }
  console.log(`\n    Subtotal: ${total} comps across ${day.coins.length} CSVs\n`);
  return total;
}

function showSchedule() {
  console.log('\n  ═══ Terapeak Data Generation Schedule ═══\n');
  console.log('  Already completed:');
  console.log('    • Priority 1 Morgans (6 coins, ~142 comps)');
  console.log('    • American Silver Eagles (8 coins, ~220 comps)');
  console.log('    • American Gold Eagles (4 coins, ~115 comps)');
  console.log('');
  let totalCoins = 0, totalComps = 0;
  for (let i = 0; i < SCHEDULE.length; i++) {
    const day = SCHEDULE[i];
    const coins = day.coins.length;
    const comps = day.coins.reduce((s, c) => s + c.count, 0);
    totalCoins += coins;
    totalComps += comps;
    console.log(`  Day ${i + 1}: ${day.label}`);
    console.log(`         ${coins} datasets, ~${comps} comps`);
    console.log(`         Run: node scripts/generateAllCoinData.js --day ${i + 1} --import`);
    console.log('');
  }
  // Common dates
  const cCoins = COMMON.coins.length;
  const cComps = COMMON.coins.reduce((s, c) => s + c.count, 0);
  console.log(`  Common: ${COMMON.label}`);
  console.log(`          ${cCoins} datasets, ~${cComps} comps (3-day refresh cycle)`);
  console.log(`          Run: node scripts/generateAllCoinData.js --common --import`);
  console.log('');
  console.log(`  Key dates total: ${totalCoins} datasets, ~${totalComps} new comps across 7 days`);
  console.log(`  Common total: ${cCoins} datasets, ~${cComps} comps`);
  console.log(`  Grand total (with previous): ~${totalComps + cComps + 142 + 220 + 115} comps\n`);
}

function showStatus() {
  console.log('\n  ═══ Data Generation Status ═══\n');
  for (let i = 0; i < SCHEDULE.length; i++) {
    const day = SCHEDULE[i];
    const allExist = day.coins.every(c => fs.existsSync(path.join(OUT_DIR, c.filename)));
    const someExist = day.coins.some(c => fs.existsSync(path.join(OUT_DIR, c.filename)));
    const status = allExist ? '✅ DONE' : someExist ? '⚠️  PARTIAL' : '⬚  PENDING';
    const existing = day.coins.filter(c => fs.existsSync(path.join(OUT_DIR, c.filename))).length;
    console.log(`  Day ${i + 1}: ${status}  ${day.label} (${existing}/${day.coins.length} CSVs)`);
  }
  // Common dates status
  const cAll = COMMON.coins.every(c => fs.existsSync(path.join(OUT_DIR, c.filename)));
  const cSome = COMMON.coins.some(c => fs.existsSync(path.join(OUT_DIR, c.filename)));
  const cStatus = cAll ? '✅ DONE' : cSome ? '⚠️  PARTIAL' : '⬚  PENDING';
  const cExist = COMMON.coins.filter(c => fs.existsSync(path.join(OUT_DIR, c.filename))).length;
  // Check freshness — common dates use a 3-day window
  let freshness = '';
  if (cSome) {
    const ages = COMMON.coins
      .filter(c => fs.existsSync(path.join(OUT_DIR, c.filename)))
      .map(c => fs.statSync(path.join(OUT_DIR, c.filename)).mtimeMs);
    const oldest = Math.min(...ages);
    const ageDays = ((Date.now() - oldest) / (24 * 60 * 60 * 1000)).toFixed(1);
    freshness = ageDays > 3 ? ` ⏰ oldest ${ageDays}d — due for refresh` : ` (${ageDays}d old)`;
  }
  console.log(`  Common: ${cStatus}  ${COMMON.label} (${cExist}/${COMMON.coins.length} CSVs)${freshness}`);
  console.log('');
}

// ── CLI ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dayArg = args.find(a => a.startsWith('--day'));
const dayVal = dayArg ? args[args.indexOf(dayArg) + 1] || args[args.indexOf('--day') + 1] : null;
const doImport = args.includes('--import');
const showStat = args.includes('--status');
const doCommon = args.includes('--common');

// Handle --day=N format too
let dayNum = null;
if (dayArg && dayArg.includes('=')) {
  const v = dayArg.split('=')[1];
  dayNum = v === 'all' ? 'all' : parseInt(v);
} else if (dayVal) {
  dayNum = dayVal === 'all' ? 'all' : parseInt(dayVal);
}

function runCommonDates() {
  console.log(`\n  ═══ COMMON DATES: ${COMMON.label} ═══`);
  console.log(`  ${COMMON.coins.length} datasets (3-day refresh cycle)\n`);
  let total = 0;
  for (const coin of COMMON.coins) {
    const rows = generateRows(coin);
    writeCSV(coin.filename, rows);
    total += rows.length;
  }
  console.log(`\n  Common dates total: ${total} comps across ${COMMON.coins.length} CSVs\n`);
  return total;
}

function doAutoImport() {
  const tp = require('../src/services/terapeakService');
  const r = tp.autoImportFolder('data/terapeak', { force: true });
  console.log(`  Import: ${r.imported} imported, ${r.skipped} skipped, ${r.errors.length} errors`);
  const datasets = tp.listDatasets();
  console.log(`  Total datasets: ${datasets.length}, Total comps: ${datasets.reduce((s,d) => s + d.compCount, 0)}\n`);
}

if (showStat) {
  showStatus();
} else if (doCommon) {
  runCommonDates();
  if (doImport) doAutoImport();
} else if (dayNum === 'all') {
  console.log('\n  ═══ Running ALL days + common dates ═══');
  let grand = 0;
  for (let i = 1; i <= SCHEDULE.length; i++) grand += runDay(i);
  grand += runCommonDates();
  console.log(`\n  Grand total: ${grand} comps generated\n`);
  if (doImport) doAutoImport();
} else if (dayNum >= 1 && dayNum <= SCHEDULE.length) {
  runDay(dayNum);
  if (doImport) doAutoImport();
} else {
  showSchedule();
}
