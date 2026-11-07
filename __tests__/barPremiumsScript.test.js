// __tests__/barPremiumsScript.test.js -- #333H phase 3: scripts/bar-premiums.js and its data file
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const script = require('../scripts/bar-premiums');
const { MIN_SPOT_DAYS } = require('../src/utils/barPremiumStats');

const HEADER = 'Item Title,Item ID,Sold Date,Sold Price,Shipping,Condition,Seller,Format,Item URL,Quantity Sold';
const row = (title, date, price, shipping = '$0.00') => `"${title}",,"${date}",$${price},${shipping},,,Fixed price,,1`;

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bar-premiums-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function writeCsv(name, rows) {
  fs.writeFileSync(path.join(dir, name), [HEADER, ...rows].join('\n') + '\n');
}

describe('dataset selection and de-duplication', () => {
  test.each([
    ['Silver_Bar_1oz_Generic.csv', true], ['PAMP_Suisse_1_oz_Gold_Bar.csv', true], ['100oz_Silver_Bar.csv', true],
    ['Geiger_Square_Gold_Bar.csv', true], ['1892-O_Barber_Dime.csv', false], ['1921_Morgan_Dollar.csv', false],
    ['Silver_Bar_1oz_Generic.meta', false],
  ])('%s is a bar dataset: %s', (file, expected) => {
    expect(script.isBarDataset(file)).toBe(expected);
  });

  test('a sale present in two datasets counts once; repeated rows in one dataset all count', () => {
    writeCsv('A_Silver_Bar.csv', [row('1 oz Silver Bar Generic', 'Jan 10, 2026', '34.00'), row('1 oz Silver Bar Generic', 'Jan 10, 2026', '34.00')]);
    writeCsv('B_Silver_Bar.csv', [row('1 oz Silver Bar Generic', 'Jan 10, 2026', '34.00')]);
    writeCsv('1921_Morgan_Dollar.csv', [row('1 oz Silver Bar Generic', 'Jan 10, 2026', '34.00')]);
    const { comps, datasets } = script.collectComps(dir);
    expect(datasets).toBe(2);
    expect(comps).toHaveLength(2);
  });

  test('--all scans every csv', () => {
    writeCsv('1921_Morgan_Dollar.csv', [row('1 oz Silver Bar Generic', 'Jan 10, 2026', '34.00')]);
    expect(script.collectComps(dir, { all: true }).datasets).toBe(1);
    expect(script.collectComps(dir).datasets).toBe(0);
  });

  test('shipping is part of the price and a blank title carries forward from the listing above', () => {
    writeCsv('A_Silver_Bar.csv', [row('1 oz Silver Bar Generic', 'Jan 10, 2026', '30.00', '$4.00'), ',,"Jan 11, 2026",$31.00,$0.00,,,Fixed price,,1']);
    const { comps } = script.collectComps(dir);
    expect(comps.map(c => c.totalUsd).sort()).toEqual([31, 34]);
    expect(comps.every(c => c.title === '1 oz Silver Bar Generic')).toBe(true);
  });
});

describe('run', () => {
  function seedDataset() {
    const rows = [];
    const days = ['Jan 10, 2026', 'Jan 11, 2026', 'Jan 12, 2026'];
    for (let i = 0; i < 12; i++) rows.push(row(`1 oz Silver Bar Generic ${i}`, days[i % 3], '33.00'));
    for (let i = 0; i < 12; i++) rows.push(row(`1 oz PAMP Suisse Silver Bar ${i}`, days[i % 3], '36.00'));
    writeCsv('Silver_Bar_1oz_Generic.csv', rows);
  }

  test('without spot history it reports prices and leaves premiums null', () => {
    seedDataset();
    const report = script.run({ dir });
    expect(report.version).toBe(1);
    expect(report.spotHistory).toBeNull();
    expect(report.source).toEqual(expect.objectContaining({ datasets: 1, comps: 24, classified: 24 }));
    expect(report.segments.map(s => s.key)).toEqual(['silver|1 oz|brand|PAMP|', 'silver|1 oz|generic||']);
    expect(report.segments.every(s => s.premium === null)).toBe(true);
  });

  test('with a metals_history file it reports premiums and the spot coverage', () => {
    seedDataset();
    const file = path.join(dir, 'metals_history.json');
    const spot = (price) => ({ '2026-01-09': price, '2026-01-10': price, '2026-01-11': price, '2026-01-12': price });
    fs.writeFileSync(file, JSON.stringify({ XAG: spot(30), XAU: spot(2000) }));
    const report = script.run({ dir, metalsHistory: file });
    expect(report.spotHistory).toEqual({ XAG: { days: 4, first: '2026-01-09', last: '2026-01-12' }, XAU: { days: 4, first: '2026-01-09', last: '2026-01-12' } });
    expect(report.spotCoverage).toEqual({ compsWithSpot: 24, compsWithoutSpot: 0 });
    const generic = report.segments.find(s => s.class === 'generic');
    expect(generic.premium.median).toBe(0.1);
    expect(generic.reliable).toBe(true);
    for (const s of report.segments) {
      expect(s.premium).not.toBeNull();
      expect(s.reliable).toBe(s.nWithSpot >= report.minSample && s.spotDays >= MIN_SPOT_DAYS);
    }
  });

  test('spot entries that are not dated positive numbers are dropped, and a non-object file is rejected', () => {
    seedDataset();
    const file = path.join(dir, 'metals_history.json');
    fs.writeFileSync(file, JSON.stringify({ XAG: { '2026-01-10': 30, 'not-a-date': 31, '2026-01-11': '30', '2026-01-12': -5, '2026-01-13': null } }));
    expect(script.run({ dir, metalsHistory: file }).spotHistory).toEqual({ XAG: { days: 1, first: '2026-01-10', last: '2026-01-10' } });
    fs.writeFileSync(file, '[1,2]');
    expect(() => script.run({ dir, metalsHistory: file })).toThrow(/JSON object/);
  });

  test('a sale on one day is not reliable however many comps it has', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`1 oz Silver Bar Generic ${i}`, 'Jan 10, 2026', '33.00'));
    writeCsv('Silver_Bar_1oz_Generic.csv', rows);
    const file = path.join(dir, 'metals_history.json');
    fs.writeFileSync(file, JSON.stringify({ XAG: { '2026-01-10': 30 } }));
    expect(script.run({ dir, metalsHistory: file }).segments[0]).toEqual(expect.objectContaining({ nWithSpot: 30, spotDays: 1, reliable: false }));
  });

  test('a listing with an item id present in two datasets counts once even if the titles differ', () => {
    const withId = (title) => `"${title}",555,"Jan 10, 2026",$33.00,$0.00,,,Fixed price,,1`;
    writeCsv('A_Silver_Bar.csv', [withId('1 oz Silver Bar Generic A')]);
    writeCsv('B_Silver_Bar.csv', [withId('1 oz Silver Bar Generic B')]);
    expect(script.collectComps(dir).comps).toHaveLength(1);
  });

  test('an invalid minSample is rejected', () => {
    seedDataset();
    for (const minSample of [0, -1, 2.5, NaN]) expect(() => script.run({ dir, minSample })).toThrow(/minSample/);
  });

  test('a metals_history file without a known metal is treated as no history', () => {
    seedDataset();
    const file = path.join(dir, 'metals_history.json');
    fs.writeFileSync(file, JSON.stringify({ XYZ: { '2026-01-10': 1 } }));
    expect(script.run({ dir, metalsHistory: file }).spotHistory).toBeNull();
  });

  test('the output is identical on every run', () => {
    seedDataset();
    expect(JSON.stringify(script.run({ dir }))).toBe(JSON.stringify(script.run({ dir })));
  });
});

describe('command line', () => {
  test('parseArgs reads every option and rejects unknown ones', () => {
    expect(script.parseArgs(['--metals-history', 'h.json', '--terapeak-dir', 'd', '--out', 'o.json', '--min-sample', '5', '--all', '--stdout', '--lines']))
      .toEqual({ metalsHistory: 'h.json', dir: 'd', out: 'o.json', minSample: 5, all: true, stdout: true, lines: true });
    expect(() => script.parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });

  test('a missing option value and a bad --min-sample are rejected', () => {
    expect(() => script.parseArgs(['--out'])).toThrow(/needs a value/);
    expect(() => script.parseArgs(['--out', '--stdout'])).toThrow(/needs a value/);
    for (const bad of ['abc', '0', '-3', '2.5']) expect(() => script.parseArgs(['--min-sample', bad])).toThrow(/positive integer/);
  });

  test('--lines prints candidates and writes nothing', () => {
    writeCsv('Scottsdale_Silver_Bar.csv', Array.from({ length: 6 }, (_, i) => row(`1 oz Scottsdale Vortex Silver Bar ${i}`, 'Jan 10, 2026', '33.00')));
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'bar-premiums.js'), '--terapeak-dir', dir, '--lines'], { encoding: 'utf8' });
    expect(out.trim()).toBe('Scottsdale: vortex (6)');
    expect(fs.readdirSync(dir)).toEqual(['Scottsdale_Silver_Bar.csv']);
  });

  test('writes only the file given with --out', () => {
    writeCsv('Silver_Bar_1oz_Generic.csv', Array.from({ length: 6 }, (_, i) => row(`1 oz Silver Bar Generic ${i}`, 'Jan 10, 2026', '33.00')));
    const out = path.join(dir, 'out', 'bar-premiums.json');
    fs.mkdirSync(path.dirname(out));
    const before = fs.readFileSync(path.join(__dirname, '..', 'data', 'bar-premiums.json'), 'utf8');
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'bar-premiums.js'), '--terapeak-dir', dir, '--out', out]);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).segments).toHaveLength(1);
    expect(fs.readFileSync(path.join(__dirname, '..', 'data', 'bar-premiums.json'), 'utf8')).toBe(before);
  });
});

describe('committed data/bar-premiums.json', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'bar-premiums.json'), 'utf8'));

  test('has the report shape and sorted unique segment keys', () => {
    expect(data.version).toBe(1);
    expect(data.backlog).toBe('#333H');
    const keys = data.segments.map(s => s.key);
    expect(keys.length).toBeGreaterThan(50);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort((a, b) => a.localeCompare(b))).toEqual(keys);
  });

  test('every segment is internally consistent', () => {
    for (const s of data.segments) {
      expect(s.key).toBe([s.metal, s.weightBucket, s.class, s.brand || '', s.series || ''].join('|'));
      expect(s.n).toBeGreaterThan(0);
      expect(s.price.p25).toBeLessThanOrEqual(s.price.median);
      expect(s.price.median).toBeLessThanOrEqual(s.price.p75);
      if (s.premium === null) { expect(s.reliable).toBe(false); expect(s.nWithSpot).toBe(0); }
      else expect(s.reliable).toBe(s.nWithSpot >= data.minSample && s.spotDays >= 3);
    }
  });

  test('uplift rows name a metal, bucket and maker with a positive ratio', () => {
    for (const u of data.uplift) {
      expect(['gold', 'silver', 'platinum', 'palladium']).toContain(u.metal);
      expect(u.brand).toBeTruthy();
      expect(u.priceRatio).toBeGreaterThan(0);
      expect(u.months).toBeGreaterThanOrEqual(1);
    }
  });
});
