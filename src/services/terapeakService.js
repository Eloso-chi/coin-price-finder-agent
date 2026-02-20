// src/services/terapeakService.js — Import Terapeak CSV exports as sold comps
// CommonJS
//
// Terapeak (eBay Seller Hub → Research) lets you search sold listings and
// export the results as CSV.  This service:
//   1. Parses the CSV into our standard comp format
//   2. Stores the parsed comps in cache/terapeak_sold.json keyed by search term
//   3. Exposes a lookup so ebayService can merge real sold data before API calls

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const CACHE_DIR = path.join(__dirname, '..', '..', 'cache');
const STORE_PATH = path.join(CACHE_DIR, 'terapeak_sold.json');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ── Persistent store ────────────────────────────────────────
let _store = null;

function loadStore() {
  if (_store) return _store;
  try {
    _store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    _store = {};
  }
  return _store;
}

function saveStore() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(_store, null, 2));
}

// ── Column name mapping ─────────────────────────────────────
// Terapeak CSV columns vary slightly between export versions / locales.
// Map all known variants to canonical internal names.
const COLUMN_MAP = {
  // Title
  'title': 'title',
  'item title': 'title',
  'listing title': 'title',
  'product': 'title',
  'product title': 'title',

  // Item ID
  'item id': 'itemId',
  'itemid': 'itemId',
  'item number': 'itemId',
  'ebay item id': 'itemId',
  'ebay item number': 'itemId',
  'listing id': 'itemId',

  // Sold date
  'sold date': 'soldDate',
  'date sold': 'soldDate',
  'sale date': 'soldDate',
  'end date': 'soldDate',
  'date': 'soldDate',
  'last sold date': 'soldDate',
  'transaction date': 'soldDate',

  // Sold price
  'sold price': 'price',
  'price': 'price',
  'sale price': 'price',
  'total sold price': 'price',
  'avg sold price': 'price',
  'average sold price': 'price',
  'sold for': 'price',
  'total price': 'price',

  // Shipping
  'shipping': 'shipping',
  'shipping cost': 'shipping',
  'shipping price': 'shipping',
  'delivery cost': 'shipping',

  // Condition
  'condition': 'condition',
  'item condition': 'condition',
  'condition name': 'condition',

  // Quantity
  'quantity': 'quantity',
  'qty': 'quantity',
  'quantity sold': 'quantity',
  'sold': 'quantity',
  'total sold': 'quantity',

  // Image
  'image': 'imageUrl',
  'image url': 'imageUrl',
  'thumbnail': 'imageUrl',
  'photo': 'imageUrl',

  // URL
  'url': 'url',
  'item url': 'url',
  'listing url': 'url',
  'link': 'url',
  'item link': 'url',

  // Seller
  'seller': 'seller',
  'seller name': 'seller',
  'seller id': 'seller',

  // Category
  'category': 'category',
  'primary category': 'category',

  // Format / type
  'format': 'listingType',
  'listing format': 'listingType',
  'listing type': 'listingType',
  'type': 'listingType',
};

/**
 * Normalize a column header string to its canonical field name.
 */
function mapColumn(header) {
  const h = (header || '').toLowerCase().trim().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
  return COLUMN_MAP[h] || null;
}

// ── Metal detection (duplicated from ebayService to avoid circular dep) ──
const METAL_RE = [
  { metal: 'gold', re: /\bgold\b/i },
  { metal: 'silver', re: /\bsilver\b/i },
  { metal: 'platinum', re: /\bplatinum\b/i },
  { metal: 'palladium', re: /\bpalladium\b/i },
  { metal: 'copper', re: /\bcopper\b/i },
];
function detectMetal(title) {
  if (!title) return null;
  for (const { metal, re } of METAL_RE) {
    if (re.test(title)) return metal;
  }
  return null;
}

// ── Grade type detection (same logic as ebayService) ──
const TPG_RE = /\b(PCGS|NGC|ANACS|ICG|CGC)\b/i;
const GRADE_RE = /\b(MS|PR|PF|SP|AU|XF|EF|VF|VG|AG|FR|PO)\s*[-]?\s*\d{1,2}\+?\b/i;
function classifyGradeType(comp) {
  const cond = (comp.condition || '').toLowerCase();
  if (cond.includes('certified') || cond === '2000') return 'graded';
  if (cond.includes('uncirculated') || cond.includes('circulated')) return 'raw';
  const title = comp.title || '';
  if (TPG_RE.test(title) || GRADE_RE.test(title)) return 'graded';
  return 'raw';
}

// ── Deny-list patterns ──
const DENY_PATTERNS = [
  /\blots?\b/i, /\bcollection\b/i, /\broll\b/i, /\bestate\b/i,
  /\breplica\b/i, /\bcopy\b/i, /\bcleaned\b/i, /\bpolished\b/i,
  /\bfake\b/i, /\btoken\b/i, /\bplated\b/i
];
function isDenied(title) {
  return DENY_PATTERNS.some(p => p.test(title));
}

// ── Parse a single CSV row into a comp ──────────────────────
function rowToComp(mappedRow, searchTerm) {
  const title = mappedRow.title || '';
  if (!title) return null;

  // Skip denied listings
  if (isDenied(title)) return null;

  const rawPrice = parseFloat(String(mappedRow.price || '0').replace(/[$,£€]/g, ''));
  const rawShipping = parseFloat(String(mappedRow.shipping || '0').replace(/[$,£€]/g, ''));
  const price = isNaN(rawPrice) ? 0 : rawPrice;
  const shipping = isNaN(rawShipping) ? 0 : rawShipping;
  const totalUsd = price + shipping;

  if (totalUsd <= 0) return null;

  // Parse sold date
  let soldDate = null;
  if (mappedRow.soldDate) {
    const d = new Date(mappedRow.soldDate);
    if (!isNaN(d.getTime())) soldDate = d.toISOString();
  }

  // Build eBay URL from item ID if URL not provided
  let url = mappedRow.url || null;
  const itemId = mappedRow.itemId || null;
  if (!url && itemId) {
    url = `https://www.ebay.com/itm/${itemId}`;
  }

  // Condition ID mapping
  let conditionId = null;
  const cond = (mappedRow.condition || '').toLowerCase();
  if (cond.includes('certified') || cond === '2000') conditionId = '2000';
  else if (cond.includes('uncirculated') || cond === '3000') conditionId = '3000';
  else if (cond.includes('circulated') || cond === '4000') conditionId = '4000';

  const comp = {
    itemId: itemId,
    title: title,
    url: url,
    imageUrl: mappedRow.imageUrl || null,
    additionalImages: [],
    soldDate: soldDate,
    price: price,
    shipping: shipping,
    totalUsd: totalUsd,
    currency: 'USD',
    location: 'US',
    listingType: mappedRow.listingType || 'Sold',
    conditionId: conditionId,
    _certificationAspect: null,
    _compositionAspect: null,
    _finenessAspect: null,
    _detectedMetal: detectMetal(title),
    matchScore: null,
    matchNotes: ['terapeak-csv-import'],
    _source: 'terapeak',
    gradeType: null
  };
  comp.gradeType = classifyGradeType(comp);
  return comp;
}

/**
 * Parse a Terapeak CSV buffer/string into an array of comps.
 *
 * @param {string|Buffer} csvData  - raw CSV content
 * @param {string} searchTerm      - the keyword the user searched in Terapeak
 * @returns {{ comps: object[], skipped: number, columns: string[] }}
 */
function parseCSV(csvData, searchTerm) {
  const csvStr = typeof csvData === 'string' ? csvData : csvData.toString('utf8');

  // csv-parse/sync handles BOM, quoted fields, etc.
  const records = parse(csvStr, {
    columns: true,          // first row = headers
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  });

  if (!records.length) {
    return { comps: [], skipped: 0, columns: [] };
  }

  // Map column headers
  const rawColumns = Object.keys(records[0]);
  const colMapping = {};
  for (const col of rawColumns) {
    const mapped = mapColumn(col);
    if (mapped) colMapping[col] = mapped;
  }

  const knownColumns = rawColumns.filter(c => colMapping[c]);
  const unmappedColumns = rawColumns.filter(c => !colMapping[c]);

  const comps = [];
  let skipped = 0;

  for (const record of records) {
    // Map raw columns to canonical names
    const mapped = {};
    for (const [rawCol, canonName] of Object.entries(colMapping)) {
      mapped[canonName] = record[rawCol];
    }

    const comp = rowToComp(mapped, searchTerm);
    if (comp) {
      comps.push(comp);
    } else {
      skipped++;
    }
  }

  return {
    comps,
    skipped,
    columns: knownColumns,
    unmappedColumns,
    totalRows: records.length
  };
}

/**
 * Import parsed comps into the persistent terapeak store.
 *
 * @param {string} searchTerm  - e.g. "1892-S Morgan Silver Dollar"
 * @param {object[]} comps     - array of parsed comps
 * @param {object} [meta]      - optional metadata
 * @returns {object} import summary
 */
function importComps(searchTerm, comps, meta = {}) {
  const store = loadStore();
  const normalizedKey = normalizeSearchKey(searchTerm);

  // Dedup against existing comps for this key
  const existing = store[normalizedKey]?.comps || [];
  const existingIds = new Set(existing.map(c => c.itemId).filter(Boolean));
  const existingTitles = new Set(existing.map(c =>
    (c.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80) + '|' + Math.round(c.totalUsd || 0)
  ));

  let newCount = 0;
  let dupCount = 0;
  for (const comp of comps) {
    // Check by itemId
    if (comp.itemId && existingIds.has(comp.itemId)) { dupCount++; continue; }
    // Check by title+price
    const key = (comp.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80) + '|' + Math.round(comp.totalUsd || 0);
    if (existingTitles.has(key)) { dupCount++; continue; }

    existing.push(comp);
    if (comp.itemId) existingIds.add(comp.itemId);
    existingTitles.add(key);
    newCount++;
  }

  store[normalizedKey] = {
    searchTerm: searchTerm,
    comps: existing,
    lastImport: new Date().toISOString(),
    importCount: (store[normalizedKey]?.importCount || 0) + 1,
    ...meta
  };

  _store = store;
  saveStore();

  return {
    key: normalizedKey,
    newComps: newCount,
    duplicatesSkipped: dupCount,
    totalStored: existing.length,
    lastImport: store[normalizedKey].lastImport
  };
}

/**
 * Look up terapeak sold comps for a search term.
 * Returns null if no data, or { comps, searchTerm, lastImport }.
 * Tries exact match first, then fuzzy substring matching.
 */
function lookupComps(keywords) {
  const store = loadStore();
  const normalizedSearch = normalizeSearchKey(keywords);

  // Exact match
  if (store[normalizedSearch]) {
    return store[normalizedSearch];
  }

  // Fuzzy: bidirectional token matching.
  // Score = average of (what % of key tokens are in search) and (what % of search tokens are in key).
  // This handles both "1892-S Morgan" matching "1892-s morgan silver dollar"
  // and "1892-S Morgan Silver Dollar MS-65" matching "1892-s morgan silver dollar".
  const searchTokens = normalizedSearch.split(/\s+/).filter(t => t.length > 1);
  let bestMatch = null;
  let bestScore = 0;

  for (const [key, data] of Object.entries(store)) {
    const keyTokens = key.split(/\s+/).filter(t => t.length > 1);
    if (!keyTokens.length || !searchTokens.length) continue;
    // Forward: how many key tokens appear in the search
    const fwdHits = keyTokens.filter(t => searchTokens.includes(t)).length;
    const fwdScore = fwdHits / keyTokens.length;
    // Reverse: how many search tokens appear in the key
    const revHits = searchTokens.filter(t => keyTokens.includes(t)).length;
    const revScore = revHits / searchTokens.length;
    // Combined: both sides must contribute; use the lower of the two but
    // require the stronger side to be >= 0.6
    const combined = (fwdScore + revScore) / 2;
    const strongSide = Math.max(fwdScore, revScore);
    if (strongSide >= 0.6 && combined > 0.4 && combined > bestScore) {
      bestScore = combined;
      bestMatch = data;
    }
  }

  return bestMatch;
}

/**
 * List all stored terapeak datasets.
 */
function listDatasets() {
  const store = loadStore();
  return Object.entries(store).map(([key, data]) => ({
    key,
    searchTerm: data.searchTerm,
    compCount: data.comps?.length || 0,
    lastImport: data.lastImport,
    importCount: data.importCount || 1
  }));
}

/**
 * Delete a terapeak dataset by key.
 */
function deleteDataset(key) {
  const store = loadStore();
  const normalized = normalizeSearchKey(key);
  if (store[normalized]) {
    delete store[normalized];
    _store = store;
    saveStore();
    return true;
  }
  return false;
}

/**
 * Clear all terapeak data.
 */
function clearAll() {
  _store = {};
  saveStore();
}

// ── Helpers ─────────────────────────────────────────────────

function normalizeSearchKey(term) {
  return (term || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Auto-import all CSV files from a folder.
 * Each CSV filename (without extension) is used as the search term
 * unless there's a companion .meta file specifying one.
 *
 * Designed to be called at server startup:
 *   terapeakService.autoImportFolder('data/terapeak');
 *
 * @param {string} folderPath - absolute or relative path to folder with CSVs
 * @returns {{ imported: number, skipped: number, errors: string[] }}
 */
function autoImportFolder(folderPath) {
  const absPath = path.isAbsolute(folderPath) ? folderPath : path.join(__dirname, '..', '..', folderPath);
  if (!fs.existsSync(absPath)) return { imported: 0, skipped: 0, errors: [] };

  const files = fs.readdirSync(absPath).filter(f => /\.(csv|tsv|txt)$/i.test(f));
  let imported = 0, skipped = 0;
  const errors = [];

  for (const file of files) {
    try {
      const csvData = fs.readFileSync(path.join(absPath, file), 'utf8');
      // Search term: check for .meta file first, else derive from filename
      const metaPath = path.join(absPath, file.replace(/\.[^.]+$/, '.meta'));
      let searchTerm;
      if (fs.existsSync(metaPath)) {
        searchTerm = fs.readFileSync(metaPath, 'utf8').trim();
      } else {
        // Derive from filename: "1892-S_Morgan_Silver_Dollar.csv" → "1892-S Morgan Silver Dollar"
        searchTerm = file.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
      }

      const { comps } = parseCSV(csvData, searchTerm);
      if (comps.length === 0) { skipped++; continue; }

      const result = importComps(searchTerm, comps, { fileName: file, autoImported: true });
      if (result.newComps > 0) {
        console.log(`[terapeak] Auto-imported ${file}: ${result.newComps} new comps for "${searchTerm}" (${result.totalStored} total)`);
        imported++;
      } else {
        skipped++;
      }
    } catch (err) {
      errors.push(`${file}: ${err.message}`);
    }
  }

  return { imported, skipped, errors };
}

module.exports = {
  parseCSV,
  importComps,
  lookupComps,
  listDatasets,
  deleteDataset,
  clearAll,
  autoImportFolder,
  normalizeSearchKey,
  // Exposed for testing
  mapColumn,
  rowToComp
};
