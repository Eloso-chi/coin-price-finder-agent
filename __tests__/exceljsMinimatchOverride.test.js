'use strict';

/**
 * #326H -- the exceljs dependency chain pulls in minimatch < 11.0.1
 * (GHSA-g3hv-75wg-m249). Overrides pin minimatch 11 under the runtime
 * parents; the workbook paths the app uses must still work.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const PATCHED = [11, 0, 1];

function atLeastPatched(version) {
  const parts = version.split('.').map(Number);
  for (let i = 0; i < PATCHED.length; i += 1) {
    if (parts[i] > PATCHED[i]) return true;
    if (parts[i] < PATCHED[i]) return false;
  }
  return true;
}

describe('#326H exceljs minimatch override', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

  test('package.json pins patched minimatch under each runtime parent', () => {
    for (const parent of ['exceljs', 'archiver-utils', 'rimraf']) {
      expect(pkg.overrides[parent]).toEqual({ minimatch: '^11.0.1' });
    }
  });

  test('every minimatch copy under the exceljs chain in the lockfile is patched', () => {
    const chain = Object.keys(lock.packages).filter((key) => (
      /node_modules\/(archiver-utils|rimraf|readdir-glob|zip-stream)\//.test(key)
      && /node_modules\/minimatch$/.test(key)
    ));
    expect(chain.length).toBeGreaterThanOrEqual(3);
    for (const key of chain) {
      expect({ key, patched: atLeastPatched(lock.packages[key].version) }).toEqual({ key, patched: true });
    }
  });

  test('workbook write then load round-trips through the zip stack', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['Coin', 'Price']);
    sheet.addRow(['1oz Silver Eagle', 42.5]);
    const buffer = await workbook.xlsx.writeBuffer();

    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(buffer);
    expect(loaded.getWorksheet('Sheet1').getRow(2).getCell(1).value).toBe('1oz Silver Eagle');
    expect(loaded.getWorksheet('Sheet1').getRow(2).getCell(2).value).toBe(42.5);
  });

  test('workbook file write then read round-trips', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-326h-'));
    const file = path.join(dir, 'roundtrip.xlsx');
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('Sheet1').addRow(['a', 1]);
      await workbook.xlsx.writeFile(file);

      const loaded = new ExcelJS.Workbook();
      await loaded.xlsx.readFile(file);
      expect(loaded.getWorksheet('Sheet1').rowCount).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
