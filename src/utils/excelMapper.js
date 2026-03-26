'use strict';

const XLSX = require('xlsx');

// ── Header normalization map ────────────────────────────────
const HEADER_ALIASES = {
  coin:       'coin',
  coin_name:  'coin',
  year:       'year',
  'mint mark': 'mint_mark',
  mint_mark:  'mint_mark',
  mintmark:   'mint_mark',
  mint:       'mint_mark',
  'base metal': 'base_metal',
  basemetal:  'base_metal',
  base_metal: 'base_metal',
  finess:     'fineness',
  fineness:   'fineness',
  'troy oz':  'troy_oz',
  'tory oz':  'troy_oz',
  troy_oz:    'troy_oz',
  troyoz:     'troy_oz',
  toryoz:     'troy_oz',
  count:      'count',
  'total toz': 'total_toz',
  total_toz:  'total_toz',
  totaltoz:   'total_toz',
  cost:       'cost',
  'melt value': 'melt_value',
  meltvalue:  'melt_value',
  melt_value: 'melt_value',
  'market value': 'market_value',
  marketvalue: 'market_value',
  market_value: 'market_value',
  slab:       'slab',
  grade:      'grade',
  notes:      'notes',
  coa:        'coa',
};

/**
 * Normalize a raw header string to a canonical key.
 * Case-insensitive, strips extra whitespace and underscores.
 */
function normalizeHeader(raw) {
  if (raw == null) return null;
  const clean = String(raw).trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
  return HEADER_ALIASES[clean] || HEADER_ALIASES[clean.replace(/ /g, '_')] || null;
}

// ── Value parsers ───────────────────────────────────────────

function parseMoney(val) {
  if (val == null) return null;
  const s = String(val).replace(/[$,\s]/g, '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseNumber(val) {
  if (val == null) return null;
  const s = String(val).replace(/,/g, '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// ── Coin string parser ──────────────────────────────────────

const YEAR_RE = /\b(1[6-9]\d{2}|20[0-9]{2})\b/;
const MINT_RE = /\b(CC|S|D|O|P|W)\b/i;

// Map common workbook names to canonical series names used by the pricing engine
const SERIES_ALIASES = {
  'american silver eagles':            'American Silver Eagle',
  'american gold eagle - 1/4':         'American Gold Eagle 1/4 oz',
  'american gold eagle 1/10th':        'American Gold Eagle 1/10 oz',
  'silver libertad':                   'Mexican Silver Libertad',
  'silver libertad - 1/4 oz':          'Mexican Silver Libertad 1/4 oz',
  'silver britania\'s 1/10th':         'British Silver Britannia 1/10 oz',
  'franklin half dollars':             'Franklin Half Dollar',
  'roosevelt silver dimes - modern':   'Roosevelt Silver Dime',
  'morgan dollar (vintage)':           'Morgan Dollar',
  'morgan dollar (modern)':            'Morgan Dollar',
  'morgan dollar (slab)':              'Morgan Dollar',
  'perth lunar':                       'Australian Lunar Silver',
  'perth lunar 1/2 oz (slab)':         'Australian Lunar Silver 1/2 oz',
  'perth mint lunar 1/2 oz':           'Australian Lunar Silver 1/2 oz',
  'perth mint (wedge tail eagle)':     'Perth Mint Wedge-Tailed Eagle',
  'rcm .75 oz wild canada series':     'RCM Wild Canada Series 3/4 oz',
  'rcm 1.5 oz canada polar bear':      'Canadian Silver Polar Bear 1.5 oz',
  'rcm 1/2 oz canada polar bear':      'Canadian Silver Polar Bear 1/2 oz',
  'washington silver proof quarter (post 2019)': 'Washington Silver Proof Quarter',
  'washington silver proof quarter (pre 2019)':  'Washington Silver Proof Quarter',
  'gieger gold .5 gram':               'Geiger Gold 0.5g',
  'gieger silver 1 gram':              'Geiger Silver 1g',
  'golden state mint liberty indian head': 'Golden State Mint Liberty Indian Head',
  'aztec round - 1/4oz':               'Aztec Silver Round 1/4 oz',
  'royal mint\'s shengxiào collection.': 'Royal Mint Shengxiao Collection',
  'royal mint\'s shengxiao collection.': 'Royal Mint Shengxiao Collection',
  'royal mint\'s shengxiào collection':  'Royal Mint Shengxiao Collection',
  'royal mint\'s shengxiao collection':  'Royal Mint Shengxiao Collection',
  'canadian maple leaf':                'Canadian Silver Maple Leaf',
};

function normalizeSeries(raw) {
  if (!raw) return raw;
  return SERIES_ALIASES[raw.toLowerCase().trim()] || raw;
}

function parseCoinString(coinStr) {
  let year = null;
  let mint = null;
  let series = null;

  if (!coinStr) return { year, mint, series };

  const str = String(coinStr).trim();

  // Extract year
  const ym = str.match(YEAR_RE);
  if (ym) year = ym[1];

  // Extract mint mark -- look for standalone common US mint marks
  // Avoid matching single letters that are part of words
  const withoutYear = year ? str.replace(year, ' ') : str;
  const mm = withoutYear.match(MINT_RE);
  if (mm) {
    // Make sure it's standalone (not part of a larger word)
    const idx = withoutYear.indexOf(mm[0]);
    const before = idx > 0 ? withoutYear[idx - 1] : ' ';
    const after = idx + mm[0].length < withoutYear.length ? withoutYear[idx + mm[0].length] : ' ';
    if (/[\s,\-()]/.test(before) || idx === 0) {
      if (/[\s,\-()]/.test(after) || idx + mm[0].length === withoutYear.length) {
        mint = mm[0].toUpperCase();
      }
    }
  }

  // Series = everything left after removing year and mint
  let remainder = str;
  if (year) remainder = remainder.replace(year, '').trim();
  if (mint) {
    // Remove only standalone mint token
    remainder = remainder.replace(new RegExp('\\b' + mint + '\\b', 'i'), '').trim();
  }
  remainder = remainder.replace(/\s+/g, ' ').replace(/^[\s,\-]+|[\s,\-]+$/g, '').trim();
  if (remainder) series = remainder.slice(0, 200);

  return {
    year: year ? String(year).slice(0, 10) : null,
    mint: mint ? mint.slice(0, 10) : null,
    series: series || null,
  };
}

// ── Grade normalization ─────────────────────────────────────

function normalizeGrade(gradeVal) {
  if (gradeVal == null) return null;
  const s = String(gradeVal).trim();
  if (!s) return null;
  // Numeric grade -> "MS-##"
  const n = parseInt(s, 10);
  if (String(n) === s && n >= 1 && n <= 70) {
    return ('MS-' + n).slice(0, 30);
  }
  return s.slice(0, 30);
}

// ── Build query string ──────────────────────────────────────

function buildQuery(row) {
  const coin = String(row.coin || '').trim();
  if (!coin) return '';

  const parts = [coin];
  if (row.base_metal) parts.push('metal=' + String(row.base_metal).trim());
  if (row.fineness) parts.push('fineness=' + String(row.fineness).trim());
  if (row.slab && String(row.slab).trim().toUpperCase() === 'Y') parts.push('slab=Y');
  if (row.grade) parts.push('grade=' + String(row.grade).trim());
  if (row.coa && String(row.coa).trim().toUpperCase() === 'Y') parts.push('COA=Y');

  // Join with " | " separator, truncate to 300
  return parts.join(' | ').slice(0, 300);
}

// ── Main mapper ─────────────────────────────────────────────

const MAX_ROWS = 5000;
const REQUIRED_SHEET = 'Collectors';

/**
 * Parse an .xlsx buffer and map rows from the "Collectors" sheet
 * to the coin-price-agent backup JSON format.
 *
 * @param {Buffer} buffer - Raw .xlsx file bytes
 * @returns {{ payload: object, summary: object }}
 */
function mapExcelToBackup(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false });

  // Require "Collectors" sheet (case-insensitive)
  const sheetName = workbook.SheetNames.find(
    n => n.toLowerCase() === REQUIRED_SHEET.toLowerCase()
  );
  if (!sheetName) {
    return { error: 'Missing required worksheet: Collectors' };
  }

  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  // Map headers for first row to detect column names
  if (rawRows.length === 0) {
    return {
      payload: {
        format: 'coin-price-agent-backup-v1',
        exportedAt: new Date().toISOString(),
        count: 0,
        coins: [],
      },
      summary: { receivedRows: 0, mappedRows: 0, failedRows: 0, failures: [] },
    };
  }

  // Normalize headers from the first row's keys
  const rawHeaders = Object.keys(rawRows[0]);
  const headerMap = {};  // rawKey -> canonical key
  for (const raw of rawHeaders) {
    const norm = normalizeHeader(raw);
    if (norm) headerMap[raw] = norm;
  }

  const coins = [];
  const failures = [];
  const now = new Date().toISOString();
  const rowLimit = Math.min(rawRows.length, MAX_ROWS);

  for (let i = 0; i < rowLimit; i++) {
    const rawRow = rawRows[i];
    const rowNum = i + 2; // 1-based, +1 for header row

    // Remap to canonical keys
    const row = {};
    for (const [rawKey, val] of Object.entries(rawRow)) {
      const canonKey = headerMap[rawKey];
      if (canonKey) row[canonKey] = val;
    }

    // Coin is REQUIRED
    const coinStr = row.coin != null ? String(row.coin).trim() : '';
    if (!coinStr) {
      failures.push({ row: rowNum, field: 'Coin', message: 'Coin name is required' });
      continue;
    }

    // Count
    const countVal = parseNumber(row.count);
    const count = (countVal != null && countVal >= 1) ? Math.floor(countVal) : 1;

    // Cost per coin
    const totalCost = parseMoney(row.cost);
    const costPer = (totalCost != null && Number.isFinite(totalCost) && totalCost >= 0)
      ? totalCost / count
      : null;

    // Weight
    let perCoinToz = null;
    const troyOz = parseNumber(row.troy_oz);
    if (troyOz != null && Number.isFinite(troyOz) && troyOz > 0) {
      perCoinToz = troyOz;
    } else {
      const totalToz = parseNumber(row.total_toz);
      if (totalToz != null && Number.isFinite(totalToz) && totalToz > 0) {
        perCoinToz = totalToz / count;
      }
    }
    const weight = perCoinToz != null ? String(perCoinToz).slice(0, 20) : null;

    // Grade
    const grade = normalizeGrade(row.grade);

    // Parse coin string for series/year/mint
    // Apply series alias on raw coin name before parsing
    const normalizedCoinStr = normalizeSeries(coinStr) || coinStr;
    const parsed = parseCoinString(normalizedCoinStr);

    // Prefer dedicated Year/Mint Mark columns over values parsed from coin name
    let year = parsed.year;
    if (row.year != null) {
      const y = String(row.year).trim();
      // Only accept 4-digit years
      if (/^\d{4}$/.test(y)) year = y;
    }
    // Validate parsed year is also 4 digits
    if (year && !/^\d{4}$/.test(year)) year = null;

    let mint = parsed.mint;
    if (row.mint_mark != null) {
      const mm = String(row.mint_mark).trim().toUpperCase();
      if (mm) mint = mm;
    }

    // Query
    const query = buildQuery(row);

    coins.push({
      series: parsed.series,
      year: year,
      mint: mint,
      grade: grade,
      weight: weight,
      baseMetal: row.base_metal ? String(row.base_metal).trim().toLowerCase().slice(0, 30) : null,
      fineness: row.fineness != null ? parseNumber(row.fineness) : null,
      query: query,
      count: count,
      costPer: costPer != null ? Math.round(costPer * 100) / 100 : null,
      notes: row.notes ? String(row.notes).trim().slice(0, 500) : null,
      dateAdded: now,
    });
  }

  const payload = {
    format: 'coin-price-agent-backup-v1',
    exportedAt: now,
    count: coins.length,
    coins: coins,
  };

  return {
    payload,
    summary: {
      receivedRows: rowLimit,
      mappedRows: coins.length,
      failedRows: failures.length,
      failures: failures,
    },
  };
}

module.exports = {
  mapExcelToBackup,
  // Exposed for testing:
  normalizeHeader,
  parseMoney,
  parseNumber,
  parseCoinString,
  normalizeGrade,
  buildQuery,
  MAX_ROWS,
  REQUIRED_SHEET,
};
