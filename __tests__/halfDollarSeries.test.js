// __tests__/halfDollarSeries.test.js — Unit tests for the Half Dollar design resolver
// Jest

const {
  HALF_DOLLAR_DESIGNS,
  HALF_DOLLAR_OVERRIDES,
  resolveCoinVariant,
} = require('../src/data/halfDollarSeries');

/* ── Data table sanity ─────────────────────────────────────── */
describe('HALF_DOLLAR_DESIGNS', () => {
  test('has at least 8 design eras', () => {
    expect(HALF_DOLLAR_DESIGNS.length).toBeGreaterThanOrEqual(8);
  });

  test('every era has yearStart, yearEnd, designName, composition', () => {
    for (const d of HALF_DOLLAR_DESIGNS) {
      expect(d.yearStart).toBeDefined();
      expect(d.yearEnd).toBeDefined();
      expect(typeof d.designName).toBe('string');
      expect(typeof d.composition).toBe('string');
    }
  });
});

describe('HALF_DOLLAR_OVERRIDES', () => {
  test('2026 has Semiquincentennial suffix', () => {
    expect(HALF_DOLLAR_OVERRIDES[2026]).toBeDefined();
    expect(HALF_DOLLAR_OVERRIDES[2026].variantSuffix).toBe('Semiquincentennial');
  });

  test('1976 has Bicentennial suffix', () => {
    expect(HALF_DOLLAR_OVERRIDES[1976]).toBeDefined();
    expect(HALF_DOLLAR_OVERRIDES[1976].variantSuffix).toBe('Bicentennial');
  });
});

/* ── resolveCoinVariant() ──────────────────────────────────── */
describe('resolveCoinVariant', () => {

  // ── Required test cases from the spec ──

  test('1964 → Kennedy, 90% Silver', () => {
    const r = resolveCoinVariant('Half Dollar', 1964);
    expect(r.designName).toBe('Kennedy');
    expect(r.composition).toBe('90% Silver');
    expect(r.variantSuffix).toBeNull();
    expect(r.label).toBe('Half Dollar — Kennedy');
  });

  test('1967 → Kennedy, 40% Silver', () => {
    const r = resolveCoinVariant('Half Dollar', 1967);
    expect(r.designName).toBe('Kennedy');
    expect(r.composition).toBe('40% Silver');
    expect(r.variantSuffix).toBeNull();
    expect(r.label).toBe('Half Dollar — Kennedy');
  });

  test('1971 → Kennedy, Copper-Nickel Clad', () => {
    const r = resolveCoinVariant('Half Dollar', 1971);
    expect(r.designName).toBe('Kennedy');
    expect(r.composition).toBe('Copper-Nickel Clad');
    expect(r.label).toBe('Half Dollar — Kennedy');
  });

  test('2025 → Kennedy (no override), clad', () => {
    const r = resolveCoinVariant('Half Dollar', 2025);
    expect(r.designName).toBe('Kennedy');
    expect(r.variantSuffix).toBeNull();
    expect(r.composition).toBe('Copper-Nickel Clad');
    expect(r.label).toBe('Half Dollar — Kennedy');
  });

  test('2026 → Kennedy (Semiquincentennial)', () => {
    const r = resolveCoinVariant('Half Dollar', 2026);
    expect(r.designName).toBe('Kennedy');
    expect(r.variantSuffix).toBe('Semiquincentennial');
    expect(r.composition).toBe('Copper-Nickel Clad');
    expect(r.label).toBe('Half Dollar — Kennedy (Semiquincentennial)');
    expect(r.notes).toContain('250th Anniversary');
  });

  test('2027 → Kennedy (no override), defaults', () => {
    const r = resolveCoinVariant('Half Dollar', 2027);
    expect(r.designName).toBe('Kennedy');
    expect(r.variantSuffix).toBeNull();
    expect(r.composition).toBe('Copper-Nickel Clad');
    expect(r.label).toBe('Half Dollar — Kennedy');
  });

  // ── Invalid inputs ──

  test('invalid year "abcd" → Unknown', () => {
    const r = resolveCoinVariant('Half Dollar', 'abcd');
    expect(r.designName).toBe('Unknown');
    expect(r.notes).toContain('Invalid year');
  });

  test('year 1700 → Unknown (predates coinage)', () => {
    const r = resolveCoinVariant('Half Dollar', 1700);
    expect(r.designName).toBe('Unknown');
    expect(r.notes).toContain('predates US coinage');
  });

  test('no denomination → Unknown', () => {
    const r = resolveCoinVariant('', 2026);
    expect(r.designName).toBe('Unknown');
    expect(r.notes).toContain('No denomination');
  });

  // ── Other design eras ──

  test('1948 → Franklin', () => {
    const r = resolveCoinVariant('Half Dollar', 1948);
    expect(r.designName).toBe('Franklin');
    expect(r.composition).toBe('90% Silver');
  });

  test('1920 → Walking Liberty', () => {
    const r = resolveCoinVariant('Half Dollar', 1920);
    expect(r.designName).toBe('Walking Liberty');
    expect(r.composition).toBe('90% Silver');
  });

  test('1900 → Barber', () => {
    const r = resolveCoinVariant('Half Dollar', 1900);
    expect(r.designName).toBe('Barber');
  });

  test('1860 → Seated Liberty', () => {
    const r = resolveCoinVariant('Half Dollar', 1860);
    expect(r.designName).toBe('Seated Liberty');
  });

  test('1820 → Capped Bust', () => {
    const r = resolveCoinVariant('Half Dollar', 1820);
    expect(r.designName).toBe('Capped Bust');
  });

  test('1800 → Draped Bust', () => {
    const r = resolveCoinVariant('Half Dollar', 1800);
    expect(r.designName).toBe('Draped Bust');
  });

  test('1795 → Flowing Hair', () => {
    const r = resolveCoinVariant('Half Dollar', 1795);
    expect(r.designName).toBe('Flowing Hair');
  });

  // ── Bicentennial override ──

  test('1976 → Kennedy (Bicentennial)', () => {
    const r = resolveCoinVariant('Half Dollar', 1976);
    expect(r.designName).toBe('Kennedy');
    expect(r.variantSuffix).toBe('Bicentennial');
    expect(r.label).toBe('Half Dollar — Kennedy (Bicentennial)');
  });

  // ── String year parsing ──

  test('accepts string year "2026"', () => {
    const r = resolveCoinVariant('Half Dollar', '2026');
    expect(r.designName).toBe('Kennedy');
    expect(r.variantSuffix).toBe('Semiquincentennial');
    expect(r.year).toBe(2026);
  });

  // ── Non-supported denomination passthrough ──

  test('non-half-dollar denomination returns passthrough', () => {
    const r = resolveCoinVariant('Quarter', 2026);
    expect(r.denomination).toBe('Quarter');
    expect(r.designName).toBeNull();
    expect(r.notes).toContain('not yet supported');
  });
});
