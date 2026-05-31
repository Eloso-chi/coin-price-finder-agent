// __tests__/dealerPremiums.test.js
'use strict';

const {
  lookupPremiumRange,
  classifyPremium,
  computePremium,
  PREMIUM_RANGES,
} = require('../src/data/dealerPremiums');

describe('dealerPremiums — lookupPremiumRange', () => {
  test('matches Silver Eagle 1oz', () => {
    const r = lookupPremiumRange({ metal: 'silver', weightOz: 1, series: 'American Silver Eagle', form: 'coin' });
    expect(r).not.toBeNull();
    expect(r.key).toBe('silver-eagle-1oz');
    expect(r.min).toBeGreaterThan(0);
    expect(r.max).toBeGreaterThan(r.min);
  });

  test('matches Gold Eagle fractional', () => {
    const r = lookupPremiumRange({ metal: 'gold', weightOz: 0.1, series: 'American Gold Eagle', form: 'coin' });
    expect(r.key).toBe('gold-eagle-frac');
  });

  test('matches generic 1oz silver bar', () => {
    const r = lookupPremiumRange({ metal: 'silver', weightOz: 1, form: 'bar' });
    expect(r.key).toBe('silver-bar-1oz');
  });

  test('matches 10oz silver bar', () => {
    const r = lookupPremiumRange({ metal: 'silver', weightOz: 10, form: 'bar' });
    expect(r.key).toBe('silver-bar-10oz');
  });

  test('matches 1g gold bar', () => {
    const r = lookupPremiumRange({ metal: 'gold', weightOz: 1 / 31.1035, form: 'bar' });
    expect(r.key).toBe('gold-bar-1g');
  });

  test('matches Mexican Silver Libertad with wider band', () => {
    const r = lookupPremiumRange({ metal: 'silver', weightOz: 1, series: 'Mexican Silver Libertad', form: 'coin' });
    expect(r.key).toBe('silver-libertad-1oz');
    expect(r.max).toBeGreaterThanOrEqual(1.0); // ≥ 100% upper band
  });

  test('returns null when metal missing', () => {
    expect(lookupPremiumRange({})).toBeNull();
    expect(lookupPremiumRange(null)).toBeNull();
  });

  test('falls through to generic when series unknown', () => {
    const r = lookupPremiumRange({ metal: 'silver', weightOz: 1, series: 'Unknown Series', form: 'coin' });
    expect(r).not.toBeNull();
    expect(r.key).toBe('silver-coin-1oz-other');
  });

  test('all ranges have min < max', () => {
    for (const row of PREMIUM_RANGES) {
      expect(row.min).toBeLessThan(row.max);
      expect(row.min).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('dealerPremiums — classifyPremium', () => {
  const range = { min: 0.05, max: 0.20 };
  test('low when below band', () => expect(classifyPremium(0.02, range)).toBe('low'));
  test('high when above band', () => expect(classifyPremium(0.50, range)).toBe('high'));
  test('normal when inside band', () => expect(classifyPremium(0.10, range)).toBe('normal'));
  test('normal at band edges', () => {
    expect(classifyPremium(0.05, range)).toBe('normal');
    expect(classifyPremium(0.20, range)).toBe('normal');
  });
  test('unknown when range or premium invalid', () => {
    expect(classifyPremium(NaN, range)).toBe('unknown');
    expect(classifyPremium(0.10, null)).toBe('unknown');
  });
});

describe('dealerPremiums — computePremium', () => {
  test('positive when FMV > melt', () => {
    expect(computePremium(35, 25)).toBeCloseTo(0.4, 5);
  });
  test('negative when FMV < melt', () => {
    expect(computePremium(20, 25)).toBeCloseTo(-0.2, 5);
  });
  test('null on invalid inputs', () => {
    expect(computePremium(null, 25)).toBeNull();
    expect(computePremium(30, 0)).toBeNull();
    expect(computePremium(30, -1)).toBeNull();
    expect(computePremium(NaN, 25)).toBeNull();
  });
});
