'use strict';

// #327H: a ".999 oz" purity mark was read as a 999 oz weight, so the import-time reroute built a
// "999oz" target key, the contradictory-weight check rejected it, and the whole upload failed with
// "Contradictory explicit weights in search term:  oz" (empty weights list).

const terapeakService = require('../src/services/terapeakService');
const pcgsService = require('../src/services/pcgsService');
const { analyzeExplicitWeights } = require('../src/utils/explicitWeight');

const { importComps, lookupComps, clearAll, _resetStoreCache } = terapeakService;

const TERM = '2022 Mexican Silver Libertad 1oz';

function comp(title, itemId, totalUsd = 40) {
  return { title, soldDate: '2026-10-01', totalUsd, itemId };
}

beforeEach(() => {
  _resetStoreCache();
  clearAll();
});

afterAll(() => {
  terapeakService._cancelPendingSaves();
  _resetStoreCache();
  clearAll();
});

describe('#327H parseDescription does not read a purity mark or silver-content figure as a weight', () => {
  test.each([
    '2022 Mexico Libertad Onza .999 oz Silver - PCGS MS 70',
    '2022 Libertad .999 oz silver',
    '2022 Libertad Onza .9999 oz fine silver',
    '2022 Libertad .925 oz sterling',
    '1892-O (.3617 OZ SILVER) Barber Silver Half Dollar',
    '1887 $1 Morgan Silver Dollar 90% Silver - .7734 Oz.',
    '1963-D Washington Quarter Net Silver Content .18 oz Troy',
    'US 2004S SILVER MINT PROOF 50 STATE QUARTERS SET (APPROX. .9 OZ ASW)',
    'Silver Eagle ..999 oz BU',
    'Silver Eagle ..9999 oz BU',
    'Bar $.50 oz spot',
  ])('%s has no weight', title => {
    expect(pcgsService.parseDescription(title).weight).toBeUndefined();
  });

  test.each([
    ['1 oz .999 Silver Round', 1],
    ['.999 fine silver 2 oz bar', 2],
    ['2022 Mexico Libertad 1 Onza .999 Fine Silver 1oz', 1],
    ['2024 Gold Libertad 1/2 oz BU', 0.5],
    ['1.5 oz silver round', 1.5],
    ['5 oz silver bar', 5],
    ['12.5 oz silver bar', 12.5],
    ['0.5 oz gold round', 0.5],
  ])('%s still reads a real weight: %s', (title, weight) => {
    expect(pcgsService.parseDescription(title).weight).toBe(weight);
  });

  test.each([
    ['2008-W American Eagle .5 Oz Gold Proof Coin', 0.5],
    ['2018 $10 Yin and Yang Coins Pure Silver .50 oz Box', 0.5],
    ['2017 50th Anniversary Krugerrand .25 Oz Gold Coin', 0.25],
    ['G-70 - .1 oz 1987 Gold China Panda NGC MS69', 0.1],
    ['1989 1/20TH TROY OZ .999 FINE GOLD CHINESE PANDA .050 OZ', 0.05],
  ])('a known fractional ounce written with a leading dot is read: %s -> %s', (title, weight) => {
    expect(pcgsService.parseDescription(title).weight).toBe(weight);
  });

  test.each([
    ['1986 Singapore Lunar Tiger Gold 1 /2 oz Gold', 0.5],
    ['1995 MEXICO PROOF SILVER 1 /20 Oz LIBERTAD', 0.05],
    ['1997 Mo Mexico 1 /4 oz Silver Libertad', 0.25],
    ['NEW 2010 YEAR OF THE TIGER RAINBOW TONED..1/2 OZ PURE SILVER COIN', 0.5],
  ])('a spaced fraction or ellipsis-prefixed fraction is read: %s -> %s', (title, weight) => {
    expect(pcgsService.parseDescription(title).weight).toBe(weight);
  });

  test.each([
    ['30g/1oz Silver Round', 1],
    ['2022 Mexico Libertad/1 OZ.999 Fine Silver', 1],
    ['St. Gaudens/1oz Gold', 1],
    ['Eagle w/1 Oz American Silver', 1],
    ['10.coins.1 oz Silver', 1],
    ['Silver Bar.1 oz BU', 1],
  ])('a number after a slash that does not follow a digit, or after a letter-glued dot, is a real weight: %s -> %s', (title, weight) => {
    expect(pcgsService.parseDescription(title).weight).toBe(weight);
  });

  test.each([
    'Silver.999 oz Round',
    'Fine Silver.9999 oz Bar',
    'Libertad Round.925 oz',
  ])('a purity mark glued to a letter by a dot is not a weight: %s', title => {
    expect(pcgsService.parseDescription(title).weight).toBeUndefined();
  });

  test.each([
    ['Mexico Libertad 2018 / 1 oz SILBER', 1],
    ['NGC Certified MS 65 / 1 Troy Oz .999 Silver', 1],
    ['Silver Eagle 1986 / 1 oz BU', 1],
    ['10 / 1 oz bar', 1],
    ['Roll of 20 /1 oz', 1],
    ['Libertad .9999 /1 oz Fine Silver Coin', 1],
    ['Libertad .5 /1 oz Silver', 1],
    ['2018/1 oz Silver Round', 1],
    ['Roll of 20/1 oz', 1],
    ['MS70/1 oz Silver Eagle', 1],
    ['PF69/1 oz Silver Eagle', 1],
    ['MS 70/1 oz Silver Eagle', 1],
  ])('a year, grade or lot count before a slash is not the weight: %s -> %s', (title, weight) => {
    expect(pcgsService.parseDescription(title).weight).toBe(weight);
  });

  test.each([
    ['Lot of 3 / 10 oz Silver Bars', 10],
    ['5 / 10 oz silver bar', 10],
    ['3 / 5 oz Silver Bars', 5],
    ['0 / 1 oz silver', 1],
    ['1 / 1 oz round', 1],
    ['2 / 2 oz round', 2],
    ['4 / 2 oz round', 2],
    ['3 / 2 oz round', 2],
  ])('a spaced lot count or improper fraction reads the denominator, never a fraction: %s -> %s', (title, weight) => {
    expect(pcgsService.parseDescription(title).weight).toBe(weight);
  });

  test.each([
    ['Libertad 1 / 2 oz', 0.5],
    ['Libertad 1 / 4 oz', 0.25],
    ['Libertad 1 / 10 oz', 0.1],
    ['Libertad 1 /20 Oz', 0.05],
    ['Libertad 1 / 40 oz', 0.025],
    ['Silver 3/16 oz', 0.1875],
    ['Silver 5/10 oz', 0.5],
  ])('a real spaced 1/N fraction or an unspaced proper fraction is read as written: %s -> %s', (title, weight) => {
    expect(pcgsService.parseDescription(title).weight).toBe(weight);
  });

  test.each([
    ['Silver Bar.100 oz', 100],
    ['Silver Bar.1000 oz', 1000],
  ])('a letter-glued round bar weight is kept: %s -> %s', (title, weight) => {
    expect(pcgsService.parseDescription(title).weight).toBe(weight);
  });

  test.each([
    ['Libertad 1 / 50 oz', 0.02],
    ['Libertad 1 / 100 oz', 0.01],
    ['Libertad 1 / 1000 oz', 0.001],
  ])('a spaced 1/N fraction with a listed denominator is read as written: %s -> %s', (title, weight) => {
    expect(pcgsService.parseDescription(title).weight).toBe(weight);
  });

  test.each([
    ['Libertad 1 / 15 oz', 15],
    ['Libertad 1 / 16 oz', 16],
    ['Silver 2 / 5 oz bars', 5],
    ['Silver 3 / 4 oz bars', 4],
  ])('a spaced fraction outside the known set reads the denominator, as before: %s -> %s', (title, weight) => {
    expect(pcgsService.parseDescription(title).weight).toBe(weight);
  });

  test.each([
    ['Silver 3/2 oz bar', 2],
    ['Silver 10/10 oz bar', 10],
  ])('an unspaced improper fraction reads the denominator: %s -> %s', (title, weight) => {
    expect(pcgsService.parseDescription(title).weight).toBe(weight);
  });

  test.each([
    'Mint .1/2 oz Silver',
    'Mint .1 /10 oz Silver',
    'Mint .1 / 2 oz Silver',
    'Libertad Silver1.5 oz',
  ])('a leading-dot proper fraction or a digit-glued decimal tail reads no weight: %s', title => {
    expect(pcgsService.parseDescription(title).weight).toBeUndefined();
  });

  test('known limitation: a denomination glued to a real fraction reads the denominator', () => {
    // "(51/10 oz" is a $5 coin of 1/10 oz; neither the old parser (5.1) nor this one (10) reads it right.
    expect(pcgsService.parseDescription('(51/10 oz - .9999 2015 Gold Canada Coin').weight).toBe(10);
  });

  test('known limitation: a genuine heavy bar written after a letter-glued dot is dropped', () => {
    expect(pcgsService.parseDescription('Silver Bar.200 oz').weight).toBeUndefined();
  });

  test('a zero denominator reads no weight instead of Infinity', () => {
    expect(pcgsService.parseDescription('Silver 1/0 oz round').weight).toBeUndefined();
  });

  test.each([
    ['.5 oz Gold Eagle', '.5 oz'],
    ['G-70 - .050 OZ Panda', '.050 OZ'],
    ['1 /20 Oz Libertad', '1 /20 Oz'],
    ['Mexico 2018 / 1 oz SILBER', '1 oz'],
    ['Mexico 2018/1 oz SILBER', '1 oz'],
    ['Silver Bar.100 oz', '100 oz'],
    ['Silver 1.5 oz round', '1.5 oz'],
  ])('weightRaw shows the text that was read: %s -> %s', (title, raw) => {
    expect(pcgsService.parseDescription(title).weightRaw).toBe(raw);
  });
});

describe('#327H import of a 1 oz dataset whose comps carry a .999 purity mark', () => {
  const comps = [
    comp('2022 Mexico Libertad Onza .999 oz Silver - PCGS MS 70', 'P1', 70),
    comp('2022 Mexico Libertad 1 Onza Plata Pura Ley .999 Fine Silver 1oz', 'P2'),
    comp('2022 1oz BANCO de MEXICO Silver Libertad .999 Fine Silver in Cap', 'P3'),
  ];

  test('imports without throwing and stores every comp in the 1 oz dataset', () => {
    const result = importComps(TERM, comps, { fileName: 'x.csv', fileSize: 1 }, { source: 'direct-page1' });
    expect(result.newComps).toBe(3);
    expect(result.reclassified).toBe(0);
    expect(result.totalStored).toBe(3);
    const stored = lookupComps(TERM).comps.map(c => c.itemId).sort();
    expect(stored).toEqual(['P1', 'P2', 'P3']);
  });

  test('no 999 oz dataset is created', () => {
    importComps(TERM, comps, {}, { source: 'direct-page1' });
    const datasets = terapeakService.listDatasets();
    expect(datasets).toHaveLength(1);
    expect(datasets[0].searchTerm).toBe(TERM);
    expect(analyzeExplicitWeights(datasets[0].searchTerm).weights).toEqual([1]);
  });
});

describe('#327H a rejected reroute target must not discard the whole upload', () => {
  // 1001 oz is above the 1000 oz cap (MAX_WEIGHT_OUNCES), so the derived "1001oz" reroute key is
  // rejected by the analyzer.
  const comps = [
    comp('2022 Mexico Libertad 1 oz Silver BU', 'G1'),
    comp('2022 Mexico Libertad 1001 oz Silver Bar', 'BAD1'),
    comp('2022 Mexico Libertad 1001 oz Silver Round', 'BAD2'),
    comp('2022 Mexico Libertad 1 oz Silver Proof', 'G2'),
  ];

  test('the valid comps are stored and the unplaceable comps are counted separately, not thrown', () => {
    const result = importComps(TERM, comps, {}, { source: 'direct-page1' });
    const stored = lookupComps(TERM).comps.map(c => c.itemId).sort();
    expect(stored).toEqual(['G1', 'G2']);
    expect(result.newComps).toBe(2);
    expect(result.weightUnplaceable).toBe(2);
    expect(result.identityExcluded).toBe(0);
    expect(result.reclassified).toBe(0);
  });

  test('no dataset is created for the rejected key', () => {
    importComps(TERM, comps, {}, { source: 'direct-page1' });
    const datasets = terapeakService.listDatasets();
    expect(datasets).toHaveLength(1);
    expect(datasets[0].searchTerm).toBe(TERM);
  });

  test('a genuinely contradictory dataset term is still rejected', () => {
    expect(() => importComps('1 oz and 5 oz Libertad Silver', [comp('x 1 oz', 'Z1')]))
      .toThrow(expect.objectContaining({ code: 'CONTRADICTORY_WEIGHT', explicitWeights: [1, 5] }));
  });
});

describe('#327H fractional-ounce comps with a leading-dot weight reroute to the right dataset', () => {
  const comps = [
    comp('2022 Mexico Libertad 1 oz Silver BU', 'W1'),
    comp('2022 Mexico Libertad .5 oz Silver BU', 'HALF1'),
    comp('2022 Mexico Libertad .25 Oz Silver Proof', 'QTR1'),
    comp('2022 Mexico Libertad 1 /10 oz Silver', 'TEN1'),
  ];

  test('they are not left in the 1 oz dataset', () => {
    const result = importComps(TERM, comps, {}, { source: 'direct-page1' });
    const stored = lookupComps(TERM).comps.map(c => c.itemId);
    expect(stored).toEqual(['W1']);
    expect(result.reclassified).toBe(3);
    expect(result.weightUnplaceable).toBe(0);
    const keys = terapeakService.listDatasets().map(d => d.searchTerm);
    expect(keys).toHaveLength(4);
    for (const [itemId, weight] of [['HALF1', 0.5], ['QTR1', 0.25], ['TEN1', 0.1]]) {
      const home = terapeakService.listDatasets().find(d => {
        const found = lookupComps(d.searchTerm);
        return found && found.comps.some(c => c.itemId === itemId);
      });
      expect(home).toBeDefined();
      expect(analyzeExplicitWeights(home.searchTerm).weights).toEqual([weight]);
    }
  });
});

describe('#327H genuine 1 oz comps with a year, grade or lot count before a slash stay in the 1 oz dataset', () => {
  const comps = [
    comp('2022 Mexico Libertad 2022 / 1 oz Silver BU', 'Y1'),
    comp('2022 Mexico Libertad NGC MS 65 / 1 Troy Oz .999', 'G65'),
    comp('2022 Mexico Libertad Roll of 20 /1 oz Silver', 'R20'),
  ];

  test('they are neither rerouted to a bogus weight dataset nor dropped as ambiguous', () => {
    const result = importComps(TERM, comps, {}, { source: 'direct-page1' });
    expect(lookupComps(TERM).comps.map(c => c.itemId).sort()).toEqual(['G65', 'R20', 'Y1']);
    expect(result.reclassified).toBe(0);
    expect(result.ambiguousExcluded).toBe(0);
    expect(result.weightUnplaceable).toBe(0);
    expect(terapeakService.listDatasets()).toHaveLength(1);
  });
});

describe('#327H the rejection message says why', () => {
  const longTerm = `${'a'.repeat(501)} 1oz`;

  test('an invalid term with no detected weights is not described as contradictory', () => {
    let error;
    try { importComps(longTerm, [comp('x', 'L1')]); } catch (e) { error = e; }
    expect(error).toBeDefined();
    expect(error.code).toBe('CONTRADICTORY_WEIGHT');
    expect(error.explicitWeights).toEqual([]);
    expect(error.message).toMatch(/^Invalid explicit weight in search term/);
    expect(error.message).not.toMatch(/Contradictory/);
    expect(error.message.length).toBeLessThan(200);
  });

  test('the error carries the received length and says whether the key was derived', () => {
    let error;
    try { importComps(longTerm, [comp('x', 'L3')]); } catch (e) { error = e; }
    expect(error.searchTermLength).toBe(longTerm.length);
    expect(error.derivedKey).toBe(false);
    let derived;
    try { importComps(longTerm, [comp('x', 'L4')], {}, { source: 'reroute' }); } catch (e) { derived = e; }
    expect(derived.derivedKey).toBe(true);
  });

  test('the same wording applies when updating dataset metadata', () => {
    let error;
    try { terapeakService.updateDatasetMeta(longTerm, { noDataCount: 1 }); } catch (e) { error = e; }
    expect(error).toBeDefined();
    expect(error.code).toBe('CONTRADICTORY_WEIGHT');
    expect(error.message).toMatch(/^Invalid explicit weight in search term/);
  });

  test('two different weights keep the contradictory wording and list the weights', () => {
    let error;
    try { importComps('1 oz and 5 oz Libertad Silver', [comp('x', 'L2')]); } catch (e) { error = e; }
    expect(error.message).toBe('Contradictory explicit weights in search term: 1, 5 oz');
  });
});
