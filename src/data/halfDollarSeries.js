// src/data/halfDollarSeries.js — Half Dollar design series + resolver
// Data-driven: add year ranges or overrides without changing resolver logic.
// CommonJS

'use strict';

/**
 * Year-range design series for the US Half Dollar.
 * Ordered newest-first so the resolver finds the most relevant match quickly.
 * Each entry: { yearStart, yearEnd, designName, composition, notes? }
 */
const HALF_DOLLAR_DESIGNS = [
  { yearStart: 1964, yearEnd: 9999, designName: 'Kennedy',         composition: 'Copper-Nickel Clad', notes: '1964 = 90% silver; 1965–1970 = 40% silver; 1971+ = clad' },
  { yearStart: 1948, yearEnd: 1963, designName: 'Franklin',        composition: '90% Silver' },
  { yearStart: 1916, yearEnd: 1947, designName: 'Walking Liberty', composition: '90% Silver' },
  { yearStart: 1892, yearEnd: 1915, designName: 'Barber',          composition: '90% Silver' },
  { yearStart: 1839, yearEnd: 1891, designName: 'Seated Liberty',  composition: '90% Silver' },
  { yearStart: 1807, yearEnd: 1839, designName: 'Capped Bust',     composition: '89.24% Silver' },
  { yearStart: 1796, yearEnd: 1807, designName: 'Draped Bust',     composition: '89.24% Silver' },
  { yearStart: 1794, yearEnd: 1795, designName: 'Flowing Hair',    composition: '89.24% Silver' },
];

/**
 * Per-year overrides that add a variantSuffix (and optionally override composition).
 * Easy to update — just add a new year key.
 *   variantSuffix: appended in parentheses, e.g. "(Semiquincentennial)"
 *   composition:   optional override for that year
 *   notes:         optional override notes
 */
const HALF_DOLLAR_OVERRIDES = {
  1776: { variantSuffix: null, notes: 'No half dollars minted in 1776' },
  1976: { variantSuffix: 'Bicentennial', composition: 'Copper-Nickel Clad', notes: 'Bicentennial reverse design (Independence Hall); dual-dated 1776–1976' },
  2026: { variantSuffix: 'Semiquincentennial', composition: 'Copper-Nickel Clad', notes: '250th Anniversary of American Independence; one-year-only special reverse design' },
};

/**
 * Resolve the composition for a specific Kennedy Half Dollar year.
 * More accurate than the generic design-table composition.
 */
function _resolveKennedyComposition(year) {
  if (year === 1964) return '90% Silver';
  if (year >= 1965 && year <= 1970) return '40% Silver';
  return 'Copper-Nickel Clad';
}

/**
 * Resolve coin variant info for a given denomination and year.
 *
 * @param {string} denomination  — e.g. "Half Dollar", "half dollar"
 * @param {number|string} year   — e.g. 2026 or "2026"
 * @returns {{ denomination: string, year: number|null, designName: string,
 *             variantSuffix: string|null, composition: string, notes: string|null,
 *             label: string }}
 */
function resolveCoinVariant(denomination, year) {
  const denom = (denomination || '').trim();
  const yr = typeof year === 'number' ? year : parseInt(year, 10);

  // Validate
  if (!denom) {
    return { denomination: denom, year: null, designName: 'Unknown', variantSuffix: null,
             composition: 'Unknown', notes: 'No denomination provided', label: 'Unknown' };
  }

  // Currently only "Half Dollar" is data-driven; return a passthrough for others
  if (!/half\s*dollar/i.test(denom)) {
    return { denomination: denom, year: yr || null, designName: null, variantSuffix: null,
             composition: null, notes: 'Denomination not yet supported by series resolver',
             label: denom };
  }

  if (!yr || isNaN(yr) || yr < 1794 || yr > 2100) {
    const reason = !yr || isNaN(yr) ? 'Invalid year' : yr < 1794 ? 'Year predates US coinage' : 'Year too far in the future';
    return { denomination: 'Half Dollar', year: yr || null, designName: 'Unknown',
             variantSuffix: null, composition: 'Unknown', notes: reason,
             label: 'Half Dollar — Unknown' };
  }

  // Find the design by year range
  let design = null;
  for (const d of HALF_DOLLAR_DESIGNS) {
    if (yr >= d.yearStart && yr <= d.yearEnd) { design = d; break; }
  }

  if (!design) {
    return { denomination: 'Half Dollar', year: yr, designName: 'Unknown',
             variantSuffix: null, composition: 'Unknown',
             notes: 'No design series found for year ' + yr,
             label: 'Half Dollar — Unknown' };
  }

  // Check per-year override
  const override = HALF_DOLLAR_OVERRIDES[yr] || {};

  const designName    = design.designName;
  const variantSuffix = override.variantSuffix !== undefined ? override.variantSuffix : null;
  let   composition   = override.composition || design.composition;
  const notes         = override.notes || design.notes || null;

  // Refine composition for Kennedy series
  if (designName === 'Kennedy') {
    composition = override.composition || _resolveKennedyComposition(yr);
  }

  // Build the display label: "Half Dollar — Kennedy (Semiquincentennial)"
  let label = 'Half Dollar — ' + designName;
  if (variantSuffix) label += ' (' + variantSuffix + ')';

  return { denomination: 'Half Dollar', year: yr, designName, variantSuffix, composition, notes, label };
}

module.exports = {
  HALF_DOLLAR_DESIGNS,
  HALF_DOLLAR_OVERRIDES,
  resolveCoinVariant,
};
