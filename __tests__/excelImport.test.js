'use strict';

const fs   = require('fs');
const path = require('path');
const {
  mapExcelToBackup,
  normalizeHeader,
  parseMoney,
  parseNumber,
  parseCoinString,
  normalizeGrade,
  buildQuery,
  REQUIRED_SHEET,
} = require('../src/utils/excelMapper');

const XLSX = require('xlsx');

// ── Helper: build an in-memory .xlsx buffer from an array of arrays ──
function makeXlsx(sheetName, aoa) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function makeMultiSheetXlsx(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ═══════════════════════════════════════════════════════════════
//  normalizeHeader
// ═══════════════════════════════════════════════════════════════

describe('normalizeHeader', () => {
  test('maps exact headers', () => {
    expect(normalizeHeader('Coin')).toBe('coin');
    expect(normalizeHeader('count')).toBe('count');
    expect(normalizeHeader('grade')).toBe('grade');
    expect(normalizeHeader('COA')).toBe('coa');
  });

  test('handles "finess" typo', () => {
    expect(normalizeHeader('finess')).toBe('fineness');
    expect(normalizeHeader('Finess')).toBe('fineness');
    expect(normalizeHeader('FINESS')).toBe('fineness');
  });

  test('handles "fineness" correct spelling', () => {
    expect(normalizeHeader('fineness')).toBe('fineness');
  });

  test('handles spacing and case variations', () => {
    expect(normalizeHeader('Base Metal')).toBe('base_metal');
    expect(normalizeHeader('BASE METAL')).toBe('base_metal');
    expect(normalizeHeader('base_metal')).toBe('base_metal');
    expect(normalizeHeader('  base  metal  ')).toBe('base_metal');
  });

  test('handles "total toz" variants', () => {
    expect(normalizeHeader('total toz')).toBe('total_toz');
    expect(normalizeHeader('Total Toz')).toBe('total_toz');
    expect(normalizeHeader('total_toz')).toBe('total_toz');
  });

  test('handles "troy oz" variants', () => {
    expect(normalizeHeader('troy oz')).toBe('troy_oz');
    expect(normalizeHeader('Troy Oz')).toBe('troy_oz');
    expect(normalizeHeader('troy_oz')).toBe('troy_oz');
  });

  test('returns null for unknown headers', () => {
    expect(normalizeHeader('random')).toBeNull();
    expect(normalizeHeader('')).toBeNull();
    expect(normalizeHeader(null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  parseMoney
// ═══════════════════════════════════════════════════════════════

describe('parseMoney', () => {
  test('parses dollar amounts', () => {
    expect(parseMoney('$85.00')).toBe(85);
    expect(parseMoney('$2,150.00')).toBe(2150);
    expect(parseMoney('85')).toBe(85);
  });

  test('returns null for invalid', () => {
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  parseCoinString
// ═══════════════════════════════════════════════════════════════

describe('parseCoinString', () => {
  test('extracts year and mint from "1921 Morgan Dollar S"', () => {
    const r = parseCoinString('1921 Morgan Dollar S');
    expect(r.year).toBe('1921');
    expect(r.mint).toBe('S');
    expect(r.series).toBe('Morgan Dollar');
  });

  test('handles "1923 Peace Dollar" (no mint)', () => {
    const r = parseCoinString('1923 Peace Dollar');
    expect(r.year).toBe('1923');
    expect(r.mint).toBeNull();
    expect(r.series).toBe('Peace Dollar');
  });

  test('handles "American Silver Eagle 2024 W"', () => {
    const r = parseCoinString('American Silver Eagle 2024 W');
    expect(r.year).toBe('2024');
    expect(r.mint).toBe('W');
    expect(r.series).toBe('American Silver Eagle');
  });

  test('handles no year or mint', () => {
    const r = parseCoinString('Gold Buffalo');
    expect(r.year).toBeNull();
    expect(r.mint).toBeNull();
    expect(r.series).toBe('Gold Buffalo');
  });

  test('returns all null for empty string', () => {
    const r = parseCoinString('');
    expect(r.year).toBeNull();
    expect(r.mint).toBeNull();
    expect(r.series).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  normalizeGrade
// ═══════════════════════════════════════════════════════════════

describe('normalizeGrade', () => {
  test('numeric grade -> "MS-##"', () => {
    expect(normalizeGrade('65')).toBe('MS-65');
    expect(normalizeGrade('70')).toBe('MS-70');
    expect(normalizeGrade('1')).toBe('MS-1');
  });

  test('text grade preserved as-is', () => {
    expect(normalizeGrade('VF-30')).toBe('VF-30');
    expect(normalizeGrade('PR-69')).toBe('PR-69');
  });

  test('null/empty returns null', () => {
    expect(normalizeGrade(null)).toBeNull();
    expect(normalizeGrade('')).toBeNull();
  });

  test('numeric 0 or > 70 treated as text', () => {
    expect(normalizeGrade('0')).toBe('0');
    expect(normalizeGrade('71')).toBe('71');
  });
});

// ═══════════════════════════════════════════════════════════════
//  costPer math
// ═══════════════════════════════════════════════════════════════

describe('costPer calculation', () => {
  test('total cost / count', () => {
    const buf = makeXlsx('Collectors', [
      ['Coin', 'count', 'cost'],
      ['Test Coin', 4, '$100.00'],
    ]);
    const { payload } = mapExcelToBackup(buf);
    expect(payload.coins[0].costPer).toBe(25);
  });

  test('defaults count to 1 when missing', () => {
    const buf = makeXlsx('Collectors', [
      ['Coin', 'cost'],
      ['Test Coin', '$50.00'],
    ]);
    const { payload } = mapExcelToBackup(buf);
    expect(payload.coins[0].costPer).toBe(50);
    expect(payload.coins[0].count).toBe(1);
  });

  test('null costPer when cost is missing', () => {
    const buf = makeXlsx('Collectors', [
      ['Coin', 'count'],
      ['Test Coin', 3],
    ]);
    const { payload } = mapExcelToBackup(buf);
    expect(payload.coins[0].costPer).toBeNull();
  });

  test('rounds costPer to 2 decimals', () => {
    const buf = makeXlsx('Collectors', [
      ['Coin', 'count', 'cost'],
      ['Test Coin', 3, '$100'],
    ]);
    const { payload } = mapExcelToBackup(buf);
    expect(payload.coins[0].costPer).toBe(33.33);
  });
});

// ═══════════════════════════════════════════════════════════════
//  weight calculation
// ═══════════════════════════════════════════════════════════════

describe('weight calculation', () => {
  test('uses troy oz directly when present', () => {
    const buf = makeXlsx('Collectors', [
      ['Coin', 'troy oz', 'count', 'total toz'],
      ['Test Coin', '0.7734', 2, '1.5468'],
    ]);
    const { payload } = mapExcelToBackup(buf);
    expect(payload.coins[0].weight).toBe('0.7734');
  });

  test('computes from total_toz / count when troy oz missing', () => {
    const buf = makeXlsx('Collectors', [
      ['Coin', 'count', 'total toz'],
      ['Test Coin', 10, '10'],
    ]);
    const { payload } = mapExcelToBackup(buf);
    expect(payload.coins[0].weight).toBe('1');
  });

  test('null weight when both missing', () => {
    const buf = makeXlsx('Collectors', [
      ['Coin'],
      ['Test Coin'],
    ]);
    const { payload } = mapExcelToBackup(buf);
    expect(payload.coins[0].weight).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  Sheet selection
// ═══════════════════════════════════════════════════════════════

describe('sheet selection', () => {
  test('reads only "Collectors" sheet', () => {
    const buf = makeMultiSheetXlsx({
      Other: [['foo'], ['bar']],
      Collectors: [['Coin'], ['Test Coin']],
      More: [['a'], [1]],
    });
    const { payload, summary } = mapExcelToBackup(buf);
    expect(payload.coins).toHaveLength(1);
    expect(payload.coins[0].query).toContain('Test Coin');
    expect(summary.receivedRows).toBe(1);
  });

  test('returns error when "Collectors" sheet is missing', () => {
    const buf = makeXlsx('Sheet1', [['Coin'], ['Test']]);
    const result = mapExcelToBackup(buf);
    expect(result.error).toBe('Missing required worksheet: Collectors');
  });

  test('sheet name is case-insensitive', () => {
    const buf = makeXlsx('collectors', [['Coin'], ['Test']]);
    const result = mapExcelToBackup(buf);
    expect(result.error).toBeUndefined();
    expect(result.payload).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
//  Row validation
// ═══════════════════════════════════════════════════════════════

describe('row validation', () => {
  test('empty Coin column fails the row', () => {
    const buf = makeXlsx('Collectors', [
      ['Coin', 'count'],
      ['', 1],
      ['Good Coin', 1],
    ]);
    const { payload, summary } = mapExcelToBackup(buf);
    expect(payload.coins).toHaveLength(1);
    expect(summary.failedRows).toBe(1);
    expect(summary.failures[0].row).toBe(2);
    expect(summary.failures[0].field).toBe('Coin');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Backup format compliance
// ═══════════════════════════════════════════════════════════════

describe('backup format compliance', () => {
  test('output has correct format field', () => {
    const buf = makeXlsx('Collectors', [['Coin'], ['Test']]);
    const { payload } = mapExcelToBackup(buf);
    expect(payload.format).toBe('coin-price-agent-backup-v1');
    expect(payload.exportedAt).toBeDefined();
    expect(typeof payload.count).toBe('number');
    expect(Array.isArray(payload.coins)).toBe(true);
  });

  test('coin objects have all required fields', () => {
    const buf = makeXlsx('Collectors', [
      ['Coin', 'grade', 'count', 'cost', 'troy oz'],
      ['1921 Morgan Dollar S', '65', 2, '$85', '0.7734'],
    ]);
    const { payload } = mapExcelToBackup(buf);
    const coin = payload.coins[0];
    expect(coin).toHaveProperty('series');
    expect(coin).toHaveProperty('year');
    expect(coin).toHaveProperty('mint');
    expect(coin).toHaveProperty('grade');
    expect(coin).toHaveProperty('weight');
    expect(coin).toHaveProperty('query');
    expect(coin).toHaveProperty('count');
    expect(coin).toHaveProperty('costPer');
    expect(coin).toHaveProperty('dateAdded');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Integration: sample workbook
// ═══════════════════════════════════════════════════════════════

describe('integration: sample workbook', () => {
  const samplePath = path.join(__dirname, '..', 'samples', 'test-collection.xlsx');

  test('sample workbook parses correctly', () => {
    const buf = fs.readFileSync(samplePath);
    const result = mapExcelToBackup(buf);
    expect(result.error).toBeUndefined();

    const { payload, summary } = result;
    expect(payload.format).toBe('coin-price-agent-backup-v1');
    // 7 data rows, 1 has empty Coin -> 6 mapped, 1 failed
    expect(summary.receivedRows).toBe(6);
    expect(summary.mappedRows).toBe(5);
    expect(summary.failedRows).toBe(1);
  });

  test('Morgan Dollar row has correct mapping', () => {
    const buf = fs.readFileSync(samplePath);
    const { payload } = mapExcelToBackup(buf);
    // First row: "1921 Morgan Dollar S"
    const morgan = payload.coins[0];
    expect(morgan.year).toBe('1921');
    expect(morgan.mint).toBe('S');
    expect(morgan.series).toBe('Morgan Dollar');
    expect(morgan.grade).toBe('MS-65');
    expect(morgan.count).toBe(2);
    expect(morgan.costPer).toBe(42.5); // $85 / 2
    expect(morgan.weight).toBe('0.7734');
    expect(morgan.query).toContain('1921 Morgan Dollar S');
  });

  test('Peace Dollar row', () => {
    const buf = fs.readFileSync(samplePath);
    const { payload } = mapExcelToBackup(buf);
    const peace = payload.coins[1];
    expect(peace.year).toBe('1923');
    expect(peace.grade).toBe('VF-30');
    expect(peace.costPer).toBe(35);
    expect(peace.count).toBe(1);
  });

  test('no-collectors workbook returns error', () => {
    const noCollPath = path.join(__dirname, '..', 'samples', 'no-collectors-sheet.xlsx');
    const buf = fs.readFileSync(noCollPath);
    const result = mapExcelToBackup(buf);
    expect(result.error).toBe('Missing required worksheet: Collectors');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Route integration
// ═══════════════════════════════════════════════════════════════

describe('POST /api/import/excel', () => {
  const express = require('express');
  const request = require('supertest');
  let app;

  beforeAll(() => {
    // Minimal Express app with the route
    app = express();
    const excelImportRoute = require('../src/routes/excelImportRoute');
    app.use('/api/import/excel', excelImportRoute);
  });

  test('returns 400 for no file', async () => {
    const res = await request(app).post('/api/import/excel');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });

  test('returns 400 for missing Collectors sheet', async () => {
    const noCollPath = path.join(__dirname, '..', 'samples', 'no-collectors-sheet.xlsx');
    const buf = fs.readFileSync(noCollPath);
    const res = await request(app)
      .post('/api/import/excel')
      .attach('file', buf, 'test.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required worksheet/);
  });

  test('returns payload and summary for valid workbook', async () => {
    const samplePath = path.join(__dirname, '..', 'samples', 'test-collection.xlsx');
    const buf = fs.readFileSync(samplePath);
    const res = await request(app)
      .post('/api/import/excel')
      .attach('file', buf, 'collection.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.payload).toBeDefined();
    expect(res.body.payload.format).toBe('coin-price-agent-backup-v1');
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.mappedRows).toBeGreaterThan(0);
  });

  test('rejects non-xlsx file', async () => {
    const res = await request(app)
      .post('/api/import/excel')
      .attach('file', Buffer.from('hello'), 'test.csv');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/\.xlsx/);
  });
});
