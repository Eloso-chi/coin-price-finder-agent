// src/data/lunarReference.js — Lunar series comparison reference data
// CommonJS

const { lookupMintage } = require('./mintages');

/**
 * Static reference data for the three Lunar mints.
 * Premium tier: high → strongest secondary market premiums
 */
const LUNAR_MINTS = {
  perth: {
    label: 'Perth Mint',
    country: 'Australia',
    seriesLabel: 'Australian Lunar',
    puritySilver: '.9999 (III) / .999 (I–II)',
    purityGold: '.9999',
    premiumTier: 'high',
    premiumNote: 'Highest collector demand; Series I commands significant premiums',
    sizes: '1/20 oz – 10 kg',
    series: [
      { num: 'I',   years: '1996–2007', note: 'Low mintage; highest premiums' },
      { num: 'II',  years: '2008–2019', note: 'Colorized versions available' },
      { num: 'III', years: '2020–2031', note: '.9999 silver upgrade; current' },
    ],
    mintageKey: { silver: 'australian lunar silver', gold: 'australian lunar gold' },
  },
  royalMint: {
    label: 'Royal Mint',
    country: 'United Kingdom',
    seriesLabel: 'Britannia Lunar / Shēngxiào',
    puritySilver: '.999',
    purityGold: '.9999',
    premiumTier: 'medium',
    premiumNote: 'Growing collector base; gold limited to 8,888/yr',
    sizes: '1 oz (silver); 1 oz, 1/4 oz, 1/10 oz (gold)',
    series: [
      { num: '—', years: '2014–present', note: 'Gold capped at 8,888; silver ramping up' },
    ],
    mintageKey: { silver: 'britannia lunar silver', gold: 'britannia lunar gold' },
  },
  royalAustralianMint: {
    label: 'Royal Australian Mint',
    country: 'Australia',
    seriesLabel: 'RAM Lunar',
    puritySilver: '.999',
    purityGold: '.999',
    premiumTier: 'low',
    premiumNote: 'Lower premiums; limited collector following vs Perth',
    sizes: '1 oz, 1/2 oz',
    series: [
      { num: '—', years: '2017–present', note: 'Smaller program; lower mintages but less demand' },
    ],
    mintageKey: { silver: 'royal australian mint lunar silver', gold: 'royal australian mint lunar gold' },
  },
};

const ZODIAC_ANIMALS = ['Rat','Ox','Tiger','Rabbit','Dragon','Snake','Horse','Goat','Monkey','Rooster','Dog','Pig'];

function zodiacAnimalForYear(year) {
  if (!year || year < 1996) return null;
  return ZODIAC_ANIMALS[((year - 2020) % 12 + 12) % 12];
}

function perthSeriesForYear(year) {
  if (!year) return null;
  if (year >= 1996 && year <= 2007) return 'I';
  if (year >= 2008 && year <= 2019) return 'II';
  if (year >= 2020 && year <= 2031) return 'III';
  return null;
}

/**
 * Build a Lunar mint comparison for a given year and metal.
 * Returns all three mints' data for side-by-side display.
 * @param {number} year
 * @param {string} metal — 'silver' or 'gold'
 * @returns {{ animal, year, metal, perthSeries, mints: Array }}
 */
function buildLunarComparison(year, metal) {
  const numYear = Number(year);
  const animal = zodiacAnimalForYear(numYear);
  if (!animal) return null;

  const met = (metal || 'silver').toLowerCase().includes('gold') ? 'gold' : 'silver';
  const perthSeries = perthSeriesForYear(numYear);

  const mints = Object.entries(LUNAR_MINTS).map(([key, mint]) => {
    const mintageSeriesKey = mint.mintageKey[met];
    const mintageData = lookupMintage(mintageSeriesKey, numYear, 'P');
    const mintage = mintageData?.mintage || null;

    // Determine which series bracket this year falls into for this mint
    const activeSeries = mint.series.find(s => {
      const [startStr, endStr] = s.years.split('–');
      const start = parseInt(startStr);
      const end = endStr === 'present' ? 2031 : parseInt(endStr);
      return numYear >= start && numYear <= end;
    });

    return {
      key,
      label: mint.label,
      country: mint.country,
      purity: met === 'gold' ? mint.purityGold : mint.puritySilver,
      premiumTier: mint.premiumTier,
      premiumNote: mint.premiumNote,
      sizes: mint.sizes,
      mintage,
      activeSeries: activeSeries ? activeSeries.note : null,
      available: !!activeSeries,
    };
  });

  return {
    animal,
    year: numYear,
    metal: met,
    perthSeries,
    mints,
  };
}

module.exports = { buildLunarComparison, LUNAR_MINTS };
