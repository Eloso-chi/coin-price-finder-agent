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
const { isDenied, ROLL_PATTERN } = require('../utils/filters');

const CACHE_DIR = require('../utils/cachePath').CACHE_DIR;
const cosmos = require('../utils/cosmosClient');
const STORE_PATH = path.join(CACHE_DIR, 'terapeak_sold.json');

// (CACHE_DIR mkdir handled by cachePath.js)

// ── Persistent store ────────────────────────────────────────
let _store = null;
let _savePending = null;

function loadStore() {
  if (_store) return _store;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    _store = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    _store = {};
  }
  return _store;
}

function saveStore() {
  // Debounced async write -- coalesces rapid successive calls into one I/O.
  if (_savePending) clearTimeout(_savePending);
  _savePending = setTimeout(() => {
    _savePending = null;
    const data = JSON.stringify(_store, null, 2);
    fs.writeFile(STORE_PATH, data, (err) => {
      if (err && process.env.NODE_ENV !== 'test') {
        console.error('[terapeak] Failed to save store:', err.message);
      }
    });
  }, 500);
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
  'listing end date': 'soldDate',

  // Sold price
  'sold price': 'price',
  'price': 'price',
  'sale price': 'price',
  'total sold price': 'price',
  'avg sold price': 'price',
  'average sold price': 'price',
  'sold for': 'price',
  'total price': 'price',
  'accepted price': 'price',

  // Total (price + shipping combined -- used when separate fields absent)
  'total': 'total',
  'subtotal': 'total',

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

  // Location / country (informational -- stored but not critical)
  'country': 'country',
  'buyer country': 'country',
  'location': 'country',
  'buyer location': 'country',
  'item location': 'country',

  // Bids (helps distinguish auction vs BIN)
  'bids': 'bids',
  'number of bids': 'bids',

  // Currency
  'currency': 'currency',
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

// ── isDenied imported from ../utils/filters ──

// ── Parse a single CSV row into a comp ──────────────────────
function rowToComp(mappedRow, searchTerm) {
  const title = mappedRow.title || '';
  if (!title) return null;

  // Skip denied listings -- but keep roll/tube listings (they are valid
  // for roll-specific pricing and would be filtered by applyFilters when
  // the search is not roll-specific)
  if (isDenied(title, { allowRoll: true })) return null;

  const rawPrice = parseFloat(String(mappedRow.price || '0').replace(/[$,£€]/g, ''));
  const rawShipping = parseFloat(String(mappedRow.shipping || '0').replace(/[$,£€]/g, ''));
  const rawTotal = parseFloat(String(mappedRow.total || '0').replace(/[$,£€]/g, ''));
  const price = isNaN(rawPrice) ? 0 : rawPrice;
  const shipping = isNaN(rawShipping) ? 0 : rawShipping;

  // Real Terapeak exports may provide a "Total" column (price + shipping)
  // without separate price/shipping columns.  Use it as the authoritative
  // totalUsd when the individual fields are missing or zero.
  let totalUsd;
  if (price > 0) {
    totalUsd = price + shipping;
  } else if (!isNaN(rawTotal) && rawTotal > 0) {
    totalUsd = rawTotal;
  } else {
    totalUsd = 0;
  }

  if (totalUsd <= 0) return null;

  // Currency -- default USD; real exports may include a Currency column
  const currency = (mappedRow.currency || 'USD').toUpperCase().trim();

  // Parse sold date
  let soldDate = null;
  if (mappedRow.soldDate) {
    const d = new Date(mappedRow.soldDate);
    if (!isNaN(d.getTime())) soldDate = d.toISOString();
  }

  // Build eBay URL: prefer a real eBay item URL from the CSV data.
  // Fall back to a title search URL only when no real URL is available.
  const itemId = mappedRow.itemId || null;
  const csvUrl = mappedRow.url || null;
  let url;
  if (csvUrl && /ebay\.com\/itm\//i.test(csvUrl)) {
    // Real eBay item link from CSV — use directly
    url = csvUrl;
  } else if (itemId) {
    url = `https://www.ebay.com/itm/${itemId}`;
  } else if (title) {
    // Fallback: search-by-title for items without a direct link
    const searchQuery = encodeURIComponent(title.substring(0, 80));
    url = `https://www.ebay.com/sch/i.html?_nkw=${searchQuery}&LH_Complete=1&LH_Sold=1`;
  } else {
    url = null;
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
    price: price > 0 ? price : totalUsd,
    shipping: shipping,
    totalUsd: totalUsd,
    currency: currency,
    location: mappedRow.country || 'US',
    listingType: mappedRow.listingType || (parseInt(mappedRow.bids) > 0 ? 'Auction' : 'Sold'),
    conditionId: conditionId,
    _certificationAspect: null,
    _compositionAspect: null,
    _finenessAspect: null,
    _detectedMetal: detectMetal(title),
    matchScore: null,
    matchNotes: ['terapeak-csv-import'],
    _source: 'terapeak',
    gradeType: null,
    quantitySold: parseInt(mappedRow.quantity) || null,
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

  // Terapeak CSVs use a multi-row format: when a listing sold multiple times
  // (multi-quantity or best-offer), the first row has the title + item ID and
  // subsequent rows for the same listing have blank title/ID but valid
  // price/date/shipping.  Carry forward from the previous row so we don't
  // lose those sales.
  let lastTitle = '';

  for (const record of records) {
    // Map raw columns to canonical names
    const mapped = {};
    for (const [rawCol, canonName] of Object.entries(colMapping)) {
      mapped[canonName] = record[rawCol];
    }

    // Carry forward title from previous row when blank (multi-sale listings)
    // Do NOT carry forward itemId — each blank row is a separate sale event
    // of the same multi-quantity listing and must not be deduped against it.
    if (mapped.title && mapped.title.trim()) {
      lastTitle = mapped.title;
    } else {
      mapped.title = lastTitle;
      mapped.itemId = '';  // force blank so dedup uses title+price key instead
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
    (c.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80) + '|' + Math.round(c.totalUsd || 0) + '|' + (c.soldDate || '')
  ));

  let newCount = 0;
  let dupCount = 0;
  for (const comp of comps) {
    // Check by itemId
    if (comp.itemId && existingIds.has(comp.itemId)) { dupCount++; continue; }
    // Check by title+price+date (date included so same listing sold on different dates isn't deduped)
    const key = (comp.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80) + '|' + Math.round(comp.totalUsd || 0) + '|' + (comp.soldDate || '');
    if (existingTitles.has(key)) { dupCount++; continue; }

    existing.push(comp);
    if (comp.itemId) existingIds.add(comp.itemId);
    existingTitles.add(key);
    newCount++;
  }

  // Merge scrapeMeta intelligently: never overwrite earlier timestamps
  const prevMeta = store[normalizedKey]?.scrapeMeta || {};
  const incomingMeta = meta.scrapeMeta || {};
  const mergedScrapeMeta = {
    page1At: incomingMeta.page1At || prevMeta.page1At || null,
    deepAt: incomingMeta.deepAt || prevMeta.deepAt || null,
    maxPageReached: Math.max(incomingMeta.maxPageReached || 0, prevMeta.maxPageReached || 0) || null,
    lastRefreshAt: incomingMeta.lastRefreshAt || prevMeta.lastRefreshAt || null,
  };
  // Remove scrapeMeta from meta spread to avoid double-write
  const { scrapeMeta: _sm, ...restMeta } = meta;

  store[normalizedKey] = {
    searchTerm: searchTerm,
    comps: existing,
    lastImport: new Date().toISOString(),
    importCount: (store[normalizedKey]?.importCount || 0) + 1,
    scrapeMeta: mergedScrapeMeta,
    ...restMeta
  };

  _store = store;
  saveStore();

  // Write-through to Cosmos DB (#98)
  if (cosmos.isEnabled() && newCount > 0) {
    const doc = {
      id: normalizedKey.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 200),
      searchTerm: normalizedKey,
      comps: existing,
      lastImport: store[normalizedKey].lastImport,
      importCount: store[normalizedKey].importCount,
    };
    cosmos.container('terapeak-sold').items.upsert(doc).catch(err => {
      if (process.env.NODE_ENV !== 'test') console.error('[terapeak] Cosmos write-through failed:', err.message);
    });
  }

  // Invalidate eBay result cache — cached price responses were computed from
  // the old Terapeak dataset and are now stale.  Lazy require to avoid
  // circular dependency (ebayService requires terapeakService).
  if (newCount > 0) {
    try { require('./ebayService').clearCache(); } catch (_) { /* ok */ }
  }

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
 * @param {string} keywords — search query
 * @param {object} [opts] — optional hints
 * @param {string} [opts.metal] — expected metal (e.g. 'silver', 'gold')
 * @param {string} [opts.grade] — expected grade (e.g. 'MS65', 'AU58')
 */
function lookupComps(keywords, opts = {}) {
  const store = loadStore();
  const normalizedSearch = normalizeSearchKey(keywords);

  // Detect grade from query or explicit hint so we can prefer grade-specific datasets.
  const queryGrade = _extractGrade(keywords) || (opts.grade ? opts.grade.toUpperCase().replace(/[\s-]/g, '') : null);

  // Exact match — but only use it when no grade hint is pushing us toward
  // a grade-specific dataset.  When a grade hint exists, fall through to
  // fuzzy matching so the grade bonus can select the right dataset.
  if (store[normalizedSearch] && !queryGrade) {
    return store[normalizedSearch];
  }
  // Also try exact match with grade appended (e.g. "1883 morgan silver dollar ms65")
  if (queryGrade) {
    const gradedKey = normalizedSearch.replace(/\s+(ms|pr|pf|sp|au|xf|ef|vf|vg|ag|fr|po)\s*\d{1,2}\+?\s*$/i, '').trim()
      + ' ' + queryGrade.toLowerCase();
    if (store[gradedKey]) return store[gradedKey];
  }

  // Detect weight from the ORIGINAL (un-normalized) query and dataset searchTerm
  // since normalizeSearchKey strips '/' turning "1/2" into "12"
  const searchWeight = detectWeightFromQuery(keywords);

  // Detect metal from the query so we can prefer matching-metal datasets.
  // Also accept an explicit metal hint from the caller (e.g. expected.metal).
  const queryMetal = _detectMetalFromText(keywords) || (opts.metal ? opts.metal.toLowerCase() : null);

  // Detect US mint mark from original query for mint-mark bonus (#174).
  const queryMintMark = _detectUSMintMark(keywords);

  // Does the search query contain a specific year?  If not we'll merge
  // comps from ALL matching datasets for better coverage.
  const YEAR_RE = /\b(1[7-9]\d{2}|20[0-4]\d)\b/;
  const queryHasYear = YEAR_RE.test(keywords);

  // Fuzzy: bidirectional token matching.
  const searchTokens = normalizedSearch.split(/\s+/).filter(t => t.length > 1);

  // Extract query year (if present) for year-match guard
  const queryYearMatch = normalizedSearch.match(/\b(1[7-9]\d{2}|20[0-4]\d)\b/);
  const queryYear = queryYearMatch ? queryYearMatch[1] : null;

  // Collect all qualifying matches with their scores
  const candidates = [];

  for (const [key, data] of Object.entries(store)) {
    const keyTokens = key.split(/\s+/).filter(t => t.length > 1);
    if (!keyTokens.length || !searchTokens.length) continue;

    // ── Year-mismatch guard: when the query contains a specific year,
    //    reject datasets whose key contains a DIFFERENT year.  This
    //    prevents "1956-D Franklin Half" from matching "1948 Franklin Half"
    //    on shared series tokens alone. ──
    if (queryYear) {
      const keyYearMatch = key.match(/\b(1[7-9]\d{2}|20[0-4]\d)\b/);
      const keyYear = keyYearMatch ? keyYearMatch[1] : null;
      // Skip if dataset has a year and it's different from query year
      // (yearless / "Generic" datasets are still allowed through)
      if (keyYear && keyYear !== queryYear) continue;
    }

    // ── Weight-mismatch guard: reject datasets whose name or comps
    //    clearly indicate a different weight than what was searched. ──
    // Use the original searchTerm for weight detection (not the normalized key)
    const keyWeight = detectWeightFromQuery(data.searchTerm || key);
    if (searchWeight !== null && keyWeight !== null && Math.abs(searchWeight - keyWeight) > 0.01) {
      continue; // e.g. search "1oz" vs dataset "half oz" — skip entirely
    }

    // ── Metal-mismatch guard: reject datasets whose name specifies a
    //    different metal than the query.  This prevents "Perth Lunar
    //    Dragon Silver 1oz" from matching the gold dataset when the eBay
    //    keywords happen to omit the metal token. ──
    const keyMetal = _detectMetalFromText(data.searchTerm || key);
    if (queryMetal && keyMetal && queryMetal !== keyMetal) {
      continue; // e.g. query mentions "silver" but dataset is "gold" — skip
    }

    // ── Mint-origin mismatch guard: reject datasets from a different
    //    world mint when the query specifies one.  Prevents "Perth"
    //    queries from matching "RoyalMint" datasets (and vice versa). ──
    const MINT_ORIGINS = [
      { re: /\bperth\b/i,                 label: 'perth' },
      { re: /\baustralian?\b/i,           label: 'perth' },
      { re: /\broyalmint\b|\broyal\s*mint\b|\bgreat\s*britain\b|\bbrit(?:ish|annia)\b/i, label: 'royalmint' },
      { re: /\brcm\b|\broyal\s*canadian\b|\bcanadian?\b/i, label: 'rcm' },
      { re: /\bchinese?\b|\bpanda\b/i,    label: 'chinese' },
      { re: /\bmexican?\b|\blibertad\b/i, label: 'mexican' },
      { re: /\baustrian?\b|\bphilharmonic\b/i, label: 'austrian' },
    ];
    function detectMintOrigin(text) {
      if (!text) return null;
      for (const { re, label } of MINT_ORIGINS) {
        if (re.test(text)) return label;
      }
      return null;
    }
    const queryMintOrigin = detectMintOrigin(keywords);
    const keyMintOrigin = detectMintOrigin(data.searchTerm || key);
    if (queryMintOrigin && keyMintOrigin && queryMintOrigin !== keyMintOrigin) {
      continue; // e.g. query "Perth Rooster" vs dataset "RoyalMint Rooster" — skip
    }

    // Forward: how many key tokens appear in the search
    const fwdHits = keyTokens.filter(t => searchTokens.includes(t)).length;
    const fwdScore = fwdHits / keyTokens.length;
    // Reverse: how many search tokens appear in the key
    const revHits = searchTokens.filter(t => keyTokens.includes(t)).length;
    const revScore = revHits / searchTokens.length;
    // Combined: both sides must contribute meaningfully.
    // Thresholds are set to prevent cross-series matching (e.g. "Libertad 1oz"
    // should not match "Lunar Dragon 1oz" on shared generic tokens like year/weight).
    const combined = (fwdScore + revScore) / 2;
    const strongSide = Math.max(fwdScore, revScore);

    // ── Specialty guard: datasets with specialty tokens (proof, burnished,
    //    enhanced, type 1/2) should only match queries that also have those
    //    tokens — prevents "Silver Eagle" from pulling in Proof/Burnished data. ──
    const SPECIALTY_TOKENS = ['proof', 'burnished', 'enhanced', 'reverse', 'type'];
    const datasetName = (data.searchTerm || key).toLowerCase();
    const queryLower = keywords.toLowerCase();
    const datasetHasSpecialty = SPECIALTY_TOKENS.some(t => datasetName.includes(t));
    const queryHasSpecialty = SPECIALTY_TOKENS.some(t => queryLower.includes(t));
    if (datasetHasSpecialty && !queryHasSpecialty) {
      continue; // e.g. query "Silver Eagle" vs dataset "Silver Eagle Proof" — skip
    }

    // ── Grade guard: when query has a grade (e.g. "MS65"), reject
    //    datasets with a DIFFERENT grade.  When query has NO grade,
    //    reject grade-specific datasets (they'd bias toward one grade). ──
    const keyGrade = _extractGrade(data.searchTerm || key);
    if (queryGrade && keyGrade && keyGrade !== queryGrade) {
      continue; // e.g. query "Morgan MS65" vs dataset "Morgan MS63" — skip
    }
    if (!queryGrade && keyGrade) {
      continue; // e.g. query "Morgan" vs dataset "Morgan MS65" — skip
    }

    if (strongSide >= 0.65 && combined > 0.55) {
      // Bonus: prefer "Generic" datasets when the query has no year,
      // since they represent the broadest market view.
      const isGeneric = /generic/i.test(data.searchTerm || key);
      const bonus = (!queryHasYear && isGeneric) ? 0.10 : 0;

      // Metal tiebreak: when query has an explicit metal, boost datasets
      // that match and penalize those that don't.  When query has NO metal
      // but the dataset does, apply a small penalty for gold/platinum
      // (silver is the most common unspecified bullion metal).
      let metalBonus = 0;
      if (queryMetal && keyMetal === queryMetal)  metalBonus =  0.10;
      if (queryMetal && keyMetal && keyMetal !== queryMetal) metalBonus = -0.20;
      // When query is ambiguous (no metal): prefer silver datasets slightly
      if (!queryMetal && keyMetal === 'gold')      metalBonus = -0.05;
      if (!queryMetal && keyMetal === 'platinum')   metalBonus = -0.05;
      if (!queryMetal && keyMetal === 'palladium')  metalBonus = -0.05;

      // Metal + weight compound bonus (#175): when query specifies BOTH a
      // metal and a weight, boost datasets that match both.  This prevents
      // gold bullion queries from leaking into generic/silver datasets that
      // happen to share series tokens.
      let weightMatchBonus = 0;
      if (queryMetal && searchWeight !== null && keyMetal === queryMetal && keyWeight !== null && Math.abs(searchWeight - keyWeight) <= 0.01) {
        weightMatchBonus = 0.15;
      }

      // US mint-mark bonus (#174): single-letter mint marks (S, D, O, W)
      // are stripped to 1-char tokens that get filtered out by the len>1
      // token filter, so fuzzy scoring can't distinguish "1896-S" from
      // "1896" datasets.  Detect mint marks from the ORIGINAL text and
      // boost when they match.
      let mintMarkBonus = 0;
      if (queryMintMark) {
        const keyMintMark = _detectUSMintMark(data.searchTerm || key);
        if (keyMintMark === queryMintMark) mintMarkBonus = 0.20;
        // Penalize datasets with a DIFFERENT mint mark
        else if (keyMintMark && keyMintMark !== queryMintMark) mintMarkBonus = -0.15;
      }

      // Grade bonus: when query specifies a grade, boost grade-matching datasets
      // over grade-less (base) datasets.  Grade-specific data is more relevant.
      let gradeBonus = 0;
      if (queryGrade && keyGrade === queryGrade) gradeBonus = 0.15;

      candidates.push({ key, data, score: combined + bonus + metalBonus + weightMatchBonus + mintMarkBonus + gradeBonus, isGeneric, keyMetal, keyGrade });
    }
  }

  if (!candidates.length) return null;

  // Sort by score descending.
  // On ties: when query has a year, prefer year-specific datasets over
  // Generic; when no year, prefer Generic for the broadest market view.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (queryHasYear) {
      // Prefer year-specific (non-Generic) when user specified a year
      if (a.isGeneric !== b.isGeneric) return a.isGeneric ? 1 : -1;
    } else {
      // Prefer Generic when user didn't specify a year
      if (a.isGeneric !== b.isGeneric) return a.isGeneric ? -1 : 1;
    }
    return 0;
  });

  // ── If query has a specific year, return only the single best match ──
  if (queryHasYear) {
    return candidates[0].data;
  }

  // ── No year in query → merge comps from ALL matching datasets ──
  // This provides a comprehensive market view (e.g. "American Silver Eagle"
  // merges Generic, 2024, 2025, 1986, etc.)
  const merged = _mergeDatasets(candidates);
  return merged;
}

/**
 * Merge comps from multiple qualifying Terapeak datasets into one result.
 * Deduplicates by (title + soldDate + price) to avoid double-counting
 * items that appear in both a year-specific and a Generic dataset.
 */
function _mergeDatasets(candidates) {
  const seen = new Set();
  const allComps = [];
  const sourceNames = [];

  for (const { data } of candidates) {
    const name = data.searchTerm || '?';
    let added = 0;
    for (const c of (data.comps || [])) {
      // Dedup key: title + date + price (handles same item in multiple datasets)
      const dk = `${(c.title || '').toLowerCase().trim()}|${c.soldDate || ''}|${c.totalUsd || ''}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
      allComps.push(c);
      added++;
    }
    if (added > 0) sourceNames.push(`${name} (${added})`);
  }

  if (!allComps.length) return null;

  return {
    searchTerm: sourceNames.join(' + '),
    comps: allComps,
    lastImport: candidates[0].data.lastImport,
    _merged: true,
    _datasetCount: sourceNames.length
  };
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
    importCount: data.importCount || 1,
    scrapeMeta: data.scrapeMeta || null
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

/**
 * Evict comps whose soldDate is older than `maxDays` from every dataset.
 * Keeps comps with no soldDate (can't determine age).
 * Returns a summary: { datasetsChecked, compsEvicted }.
 */
function evictStaleComps(maxDays = 180) {
  const store = loadStore();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);
  let datasetsChecked = 0;
  let compsEvicted = 0;

  for (const [key, dataset] of Object.entries(store)) {
    if (!dataset.comps || !Array.isArray(dataset.comps)) continue;
    datasetsChecked++;
    const before = dataset.comps.length;
    dataset.comps = dataset.comps.filter(c => {
      if (!c.soldDate) return true;
      return new Date(c.soldDate) >= cutoff;
    });
    compsEvicted += before - dataset.comps.length;
    // Remove empty datasets entirely
    if (dataset.comps.length === 0) {
      delete store[key];
    }
  }

  _store = store;
  if (compsEvicted > 0) {
    saveStore();
    console.log(`[terapeak] Evicted ${compsEvicted} stale comps (older than ${maxDays}d) from ${datasetsChecked} datasets`);
  }
  return { datasetsChecked, compsEvicted };
}

/**
 * Delete CSV files from a folder where EVERY comp's soldDate is older than
 * `maxDays`.  Files whose comps all lack a soldDate are kept (can't determine age).
 *
 * @param {string} folderPath - path to the CSV folder (e.g. 'data/terapeak')
 * @param {number} [maxDays=180] - age threshold in days
 * @returns {{ checked: number, deleted: number, kept: number, deletedFiles: string[] }}
 */
function purgeStaleCSVs(folderPath, maxDays = 180) {
  const absPath = path.isAbsolute(folderPath)
    ? folderPath
    : path.join(__dirname, '..', '..', folderPath);
  if (!fs.existsSync(absPath)) return { checked: 0, deleted: 0, kept: 0, deletedFiles: [] };

  const files = fs.readdirSync(absPath).filter(f => /\.(csv|tsv|txt)$/i.test(f));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);

  let deleted = 0;
  let kept = 0;
  const deletedFiles = [];

  for (const file of files) {
    try {
      const filePath = path.join(absPath, file);
      const csvData = fs.readFileSync(filePath, 'utf8');
      const searchTerm = deriveSearchTerm(absPath, file);
      const { comps } = parseCSV(csvData, searchTerm);

      // Keep files with no comps at all (unparseable / empty)
      if (comps.length === 0) { kept++; continue; }

      // Keep files where at least one comp has no soldDate (can't determine age)
      const hasMissingDate = comps.some(c => !c.soldDate);
      if (hasMissingDate) { kept++; continue; }

      // Check if every comp is older than the cutoff
      const allStale = comps.every(c => new Date(c.soldDate) < cutoff);
      if (allStale) {
        fs.unlinkSync(filePath);
        // Also remove companion .meta file if it exists
        const metaPath = filePath.replace(/\.[^.]+$/, '.meta');
        if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
        deletedFiles.push(file);
        deleted++;
        console.log(`[terapeak] Purged stale CSV: ${file} (all ${comps.length} comps older than ${maxDays}d)`);
      } else {
        kept++;
      }
    } catch (err) {
      console.error(`[terapeak] Error checking CSV ${file}: ${err.message}`);
      kept++;
    }
  }

  if (deleted > 0) {
    console.log(`[terapeak] Purged ${deleted} stale CSV file(s), kept ${kept}`);
  }
  return { checked: files.length, deleted, kept, deletedFiles };
}

// ── Helpers ─────────────────────────────────────────────────

function normalizeSearchKey(term) {
  return (term || '')
    .toLowerCase()
    // Normalize zero→O in year-mint tokens: "1883-0" → "1883-O" (common typo)
    .replace(/\b(\d{4})-0\b/g, '$1-O')
    // Split year-mint tokens: "1956-D" → "1956 d", "1878-CC" → "1878 cc"
    .replace(/\b(\d{4})-(cc|d|s|o|w|p)\b/gi, '$1 $2')
    // Collapse "N oz" → "Noz" so "1 oz" matches dataset keys like "1oz".
    // Must run BEFORE non-alphanumeric stripping so fractions like "1/2 oz" are handled.
    .replace(/\b(\d+(?:[\/\.]\d+)?)\s*oz\b/g, '$1oz')
    // Strip standalone Roman numerals (i, ii, iii, iv, v) -- these are series
    // labels (e.g. "Lunar III") that don't appear in Terapeak dataset keys
    // and poison fuzzy matching by inflating the token count.
    .replace(/\b(i{1,3}|iv|v)\b/g, '')
    .replace(/[^a-z0-9\s\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect weight (in troy oz) from a search query / dataset key string.
 * Handles both numeric ("1oz", "1 oz") and word forms ("half oz", "quarter oz").
 * Returns numeric oz or null if no weight detected.
 */
function detectWeightFromQuery(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  // Word forms used in dataset names (e.g. "half oz", "quarter oz", "tenth oz")
  // Also handle standalone word forms without "oz" (e.g. "Perth Lunar Dragon Gold Quarter")
  if (/\btwentieth\s*oz\b/.test(t))  return 0.05;
  if (/\b1\/20\s*oz\b/.test(t))      return 0.05;
  if (/\btenth\s*oz\b/.test(t))      return 0.1;
  if (/\b1\/10\s*oz\b/.test(t))      return 0.1;
  if (/\bquarter\s*oz\b/.test(t))    return 0.25;
  if (/\b1\/4\s*oz\b/.test(t))       return 0.25;
  if (/\bhalf\s*oz\b/.test(t))       return 0.5;
  if (/\b1\/2\s*oz\b/.test(t))       return 0.5;
  // Generic "N oz" or "Noz"
  const m = t.match(/\b(\d+(?:\.\d+)?)\s*oz\b/);
  if (m) return parseFloat(m[1]);
  // Standalone weight words at end of string or followed by non-alpha
  // (dataset names like "Perth Lunar III 2024 Dragon Gold Quarter")
  if (/\btwentieth\b/.test(t)) return 0.05;
  if (/\btenth\b/.test(t))     return 0.1;
  if (/\bquarter\b/.test(t))   return 0.25;
  if (/\bhalf\b/.test(t))      return 0.5;
  return null;
}

/**
 * Extract a formal grade token (e.g. "MS65", "AU58", "VF35") from text.
 * Returns the normalized grade string (uppercased, no spaces/hyphens) or null.
 */
function _extractGrade(text) {
  if (!text) return null;
  const m = text.match(/\b(MS|PR|PF|SP|AU|XF|EF|VF|VG|AG|FR|PO)\s*[-]?\s*(\d{1,2}\+?)\b/i);
  if (!m) return null;
  return (m[1] + m[2]).toUpperCase(); // e.g. "MS65", "AU58", "VF35+"
}

/**
 * Detect precious metal from a text string (query or dataset name).
 * Returns 'gold', 'silver', 'platinum', 'palladium', or null.
 */
function _detectMetalFromText(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\bgold\b/.test(t))      return 'gold';
  if (/\bsilver\b/.test(t))    return 'silver';
  if (/\bplatinum\b/.test(t))  return 'platinum';
  if (/\bpalladium\b/.test(t)) return 'palladium';
  return null;
}

/**
 * Detect a US mint mark from text (original, un-normalized).
 * Looks for patterns like "1896-S", "1878-CC", "2024-W", "1901 S", "1921 D".
 * Returns the mint mark uppercased ('S', 'D', 'O', 'CC', 'W') or null.
 */
function _detectUSMintMark(text) {
  if (!text) return null;
  // Match year followed by separator and mint mark
  const m = text.match(/\b\d{4}[-\s]?(S|D|O|CC|W)\b/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Auto-import all CSV files from a folder.
 * Each CSV filename (without extension) is used as the search term
 * unless there's a companion .meta file specifying one.
 *
 * Designed to be called at server startup:
 *   terapeakService.autoImportFolder('data/terapeak');
 *
 * Skips re-importing if all data was imported within `maxAgeMs` (default 24h).
 * New or modified CSVs (newer than last import) are always processed.
 * Pass `{ force: true }` to bypass the staleness check.
 *
 * @param {string} folderPath - absolute or relative path to folder with CSVs
 * @param {object} [opts]     - { force: boolean, maxAgeMs: number }
 * @returns {{ imported: number, skipped: number, errors: string[], freshSkipped: number }}
 */
function autoImportFolder(folderPath, opts = {}) {
  const { force = false, maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = opts;  // 7-day freshness window
  const absPath = path.isAbsolute(folderPath) ? folderPath : path.join(__dirname, '..', '..', folderPath);
  if (!fs.existsSync(absPath)) return { imported: 0, skipped: 0, errors: [], freshSkipped: 0 };

  const files = fs.readdirSync(absPath).filter(f => /\.(csv|tsv|txt)$/i.test(f));
  let imported = 0, skipped = 0, freshSkipped = 0;
  const errors = [];

  // Quick staleness check: if every dataset's lastImport is recent AND
  // no CSV file has been modified since then, skip the whole folder.
  if (!force) {
    const store = loadStore();
    const now = Date.now();
    const datasets = Object.values(store);
    if (datasets.length > 0) {
      const oldestImport = Math.min(...datasets.map(d => new Date(d.lastImport).getTime()));
      const allFresh = (now - oldestImport) < maxAgeMs;

      if (allFresh) {
        // Check if any CSV was modified after the oldest import
        const anyModified = files.some(f => {
          const stat = fs.statSync(path.join(absPath, f));
          return stat.mtimeMs > oldestImport;
        });

        if (!anyModified) {
          console.log(`[terapeak] Data is fresh (imported ${Math.round((now - oldestImport) / 60000)}m ago) — skipping auto-import. Use force=true to override.`);
          return { imported: 0, skipped: files.length, errors: [], freshSkipped: files.length };
        }
      }
    }
  }

  for (const file of files) {
    try {
      // Per-file freshness: skip if this file's dataset was imported recently
      // AND the CSV hasn't been modified since
      if (!force) {
        const store = loadStore();
        const searchTerm = deriveSearchTerm(absPath, file);
        const key = normalizeSearchKey(searchTerm);
        const existing = store[key];
        if (existing?.lastImport) {
          const lastImportMs = new Date(existing.lastImport).getTime();
          const csvStat = fs.statSync(path.join(absPath, file));
          if ((Date.now() - lastImportMs) < maxAgeMs && csvStat.mtimeMs <= lastImportMs) {
            freshSkipped++;
            skipped++;
            continue;
          }
        }
      }

      const csvData = fs.readFileSync(path.join(absPath, file), 'utf8');
      const searchTerm = deriveSearchTerm(absPath, file);

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

  return { imported, skipped, errors, freshSkipped };
}

/**
 * Import Terapeak CSVs from Azure Blob Storage instead of the local filesystem.
 * Mirrors autoImportFolder() but reads from the blob container.
 * Only activates when TERAPEAK_BLOB_ACCOUNT + TERAPEAK_BLOB_CONTAINER are set.
 *
 * @param {object} [opts] - { force: boolean, maxAgeMs: number }
 * @returns {Promise<{ imported: number, skipped: number, errors: string[], freshSkipped: number }>}
 */
async function autoImportFromBlob(opts = {}) {
  const blob = require('../utils/blobClient');
  if (!blob.isEnabled()) return { imported: 0, skipped: 0, errors: [], freshSkipped: 0 };

  const { force = false, maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = opts;
  let imported = 0, skipped = 0, freshSkipped = 0;
  const errors = [];

  try {
    const blobs = await blob.listBlobs();
    const csvBlobs = blobs.filter(b => /\.(csv|tsv|txt)$/i.test(b.name));
    if (csvBlobs.length === 0) return { imported: 0, skipped: 0, errors: [], freshSkipped: 0 };

    // Quick staleness check (same logic as autoImportFolder)
    if (!force) {
      const store = loadStore();
      const now = Date.now();
      const datasets = Object.values(store);
      if (datasets.length > 0) {
        const oldestImport = Math.min(...datasets.map(d => new Date(d.lastImport).getTime()));
        const allFresh = (now - oldestImport) < maxAgeMs;
        if (allFresh) {
          const anyModified = csvBlobs.some(b => b.lastModified.getTime() > oldestImport);
          if (!anyModified) {
            console.log(`[terapeak] Blob data is fresh (imported ${Math.round((now - oldestImport) / 60000)}m ago) — skipping. Use force=true to override.`);
            return { imported: 0, skipped: csvBlobs.length, errors: [], freshSkipped: csvBlobs.length };
          }
        }
      }
    }

    for (const blobInfo of csvBlobs) {
      try {
        const fileName = blobInfo.name;
        const searchTerm = fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();

        // Per-file freshness
        if (!force) {
          const store = loadStore();
          const key = normalizeSearchKey(searchTerm);
          const existing = store[key];
          if (existing?.lastImport) {
            const lastImportMs = new Date(existing.lastImport).getTime();
            if ((Date.now() - lastImportMs) < maxAgeMs && blobInfo.lastModified.getTime() <= lastImportMs) {
              freshSkipped++;
              skipped++;
              continue;
            }
          }
        }

        const csvData = await blob.downloadBlob(fileName);
        if (!csvData) { skipped++; continue; }

        const { comps } = parseCSV(csvData, searchTerm);
        if (comps.length === 0) { skipped++; continue; }

        const result = importComps(searchTerm, comps, { fileName, autoImported: true });
        if (result.newComps > 0) {
          console.log(`[terapeak] Blob-imported ${fileName}: ${result.newComps} new comps for "${searchTerm}" (${result.totalStored} total)`);
          imported++;
        } else {
          skipped++;
        }
      } catch (err) {
        errors.push(`${blobInfo.name}: ${err.message}`);
      }
    }
  } catch (err) {
    errors.push(`Blob listing failed: ${err.message}`);
  }

  return { imported, skipped, errors, freshSkipped };
}

/**
 * Derive search term from a CSV filename, checking for .meta companion file.
 */
function deriveSearchTerm(folderPath, file) {
  const metaPath = path.join(folderPath, file.replace(/\.[^.]+$/, '.meta'));
  if (fs.existsSync(metaPath)) {
    return fs.readFileSync(metaPath, 'utf8').trim();
  }
  // "1892-S_Morgan_Silver_Dollar.csv" → "1892-S Morgan Silver Dollar"
  return file.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
}

module.exports = {
  parseCSV,
  importComps,
  lookupComps,
  listDatasets,
  deleteDataset,
  clearAll,
  evictStaleComps,
  purgeStaleCSVs,
  autoImportFolder,
  autoImportFromBlob,
  normalizeSearchKey,
  detectWeightFromQuery,
  detectMetal: _detectMetalFromText,
  detectUSMintMark: _detectUSMintMark,
  extractGrade: _extractGrade,
  // Exposed for testing
  mapColumn,
  rowToComp,
  _resetStoreCache() { _store = null; }
};
