/**
 * holdoutValidation.test.js — #177
 *
 * Validates that the pricing pipeline doesn't distort FMV away from
 * actual sale prices.  Uses 80/20 holdout splits on real Terapeak CSV
 * data: trains on 80%, asserts FMV falls within IQR of the held-out 20%.
 *
 * This is a statistical test — some variance is expected.  We require
 * >= 70% of test coins to pass the IQR check (with 20% tolerance band).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const stats = require('../src/utils/stats');
const { computeValuation } = require('../src/services/valuationService');

// ── Seeded PRNG for reproducible splits ──
// Multi-seed majority-pass (BACKLOG #239 / batch 3):
// If HOLDOUT_SEED env is set, we honor it (single-seed mode, legacy behavior).
// Otherwise we run the full holdout across 5 fixed seeds and require >= 3 of 5
// seeds to clear the per-seed >= 70% pass rate threshold. This guards against
// single-seed luck/unluck distorting a real regression signal.
const FIXED_SEEDS = [42, 7, 1337, 2025, 99];
const SEEDS = process.env.HOLDOUT_SEED
  ? [parseInt(process.env.HOLDOUT_SEED, 10)]
  : FIXED_SEEDS;
const PER_SEED_PASS_THRESHOLD = 0.70;
const MAJORITY = Math.ceil(SEEDS.length / 2); // 3 of 5

function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ── Parse a Terapeak CSV into comp objects ──
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]);
  const titleIdx = header.indexOf('Item Title');
  const priceIdx = header.indexOf('Sold Price');
  const dateIdx  = header.indexOf('Sold Date');
  const idIdx    = header.indexOf('Item ID');
  if (priceIdx < 0) return [];

  const comps = [];
  let lastTitle = '';

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const title = (cols[titleIdx] || '').trim() || lastTitle;
    if (title) lastTitle = title;

    const priceStr = (cols[priceIdx] || '').replace(/[^0-9.]/g, '');
    const totalUsd = parseFloat(priceStr);
    if (!totalUsd || totalUsd <= 0) continue;

    const soldDate = (cols[dateIdx] || '').trim();
    const itemId   = (cols[idIdx] || '').trim();

    comps.push({
      itemId: itemId || `holdout-${i}`,
      title,
      totalUsd,
      soldDate: soldDate || new Date().toISOString(),
      matchScore: 75,
      gradeType: 'raw',
      _source: 'terapeak',
    });
  }
  return comps;
}

// ── Split array into train/test with seeded random ──
function holdoutSplit(arr, trainRatio, rng) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const splitIdx = Math.floor(shuffled.length * trainRatio);
  return { train: shuffled.slice(0, splitIdx), test: shuffled.slice(splitIdx) };
}

// ── Build mock eBay result shape for computeValuation ──
function mockEbay(comps) {
  const prices = comps.map(c => c.totalUsd);
  return {
    us: {
      comps,
      stats: {
        count: prices.length,
        mean: stats.mean(prices),
        median: stats.median(prices),
        min: Math.min(...prices),
        max: Math.max(...prices),
      },
      removed: {},
      gathered: comps.length,
    },
    global: { comps: [], stats: {} },
    lookback: { requested: 180, used: 180, extended: false },
  };
}

// ── Test fixtures: diverse coin types with 50+ comps ──
const TERAPEAK_DIR = path.join(__dirname, '..', 'data', 'terapeak');

const TEST_COINS = [
  // Bullion — silver
  { file: '2024_American_Silver_Eagle.csv',        label: '2024 ASE',            isBullion: true  },
  { file: '1982_Mexican_Silver_Libertad_1oz.csv',  label: '1982 Libertad 1oz',   isBullion: true  },
  { file: 'Australian_Lunar_Silver_1oz_Generic.csv',label: 'Lunar Silver Generic',isBullion: true  },
  { file: 'Silver_Round_1oz_Generic.csv',           label: 'Silver Round Generic',isBullion: true  },
  // Bullion — gold
  { file: 'Canadian_Gold_Maple_Leaf_Tenth_oz_Generic.csv', label: 'Gold Maple 1/10', isBullion: true },
  // Numismatic
  { file: '1882-S_Morgan_Silver_Dollar.csv',        label: '1882-S Morgan',       isBullion: false },
  { file: '1887_Morgan_Silver_Dollar.csv',          label: '1887 Morgan',         isBullion: false },
  { file: '1903-O_Morgan_Silver_Dollar.csv',        label: '1903-O Morgan',       isBullion: false },
  { file: '1897_Morgan_Silver_Dollar.csv',          label: '1897 Morgan',         isBullion: false },
  { file: '1878-CC_Morgan_Silver_Dollar.csv',       label: '1878-CC Morgan',      isBullion: false },
].filter(c => fs.existsSync(path.join(TERAPEAK_DIR, c.file)));

// ════════════════════════════════════════════════════════════
//  Holdout Validation — multi-seed majority-pass (BACKLOG #239)
// ════════════════════════════════════════════════════════════
if (TEST_COINS.length === 0) {
  describe('holdout validation — FMV vs actual sales (#177)', () => {
    test.skip('no Terapeak CSV fixtures found', () => {});
  });
} else {
  // Collect per-seed pass rates so the final summary test can apply the
  // majority-pass rule across seeds.
  const perSeedRates = [];

  describe.each(SEEDS)('holdout validation — seed=%i (#177, #239)', (seed) => {
    const rng = seededRandom(seed);
    const results = [];

    test.each(TEST_COINS.map(c => [c.label, c]))(
      '%s: FMV within holdout IQR (±20%)',
      (label, coin) => {
        const comps = parseCsv(path.join(TERAPEAK_DIR, coin.file));
        // Need enough comps for a meaningful split
        if (comps.length < 20) {
          results.push({ label, skip: true, reason: 'too few comps' });
          return; // skip, don't fail
        }

        const { train, test: holdout } = holdoutSplit(comps, 0.80, rng);

        // Compute FMV from training set
        const ebay = mockEbay(train);
        const pcgs = { verified: false };
        const { valuation } = computeValuation(pcgs, ebay, null, null, {
          isBullion: coin.isBullion,
        });
        const fmv = valuation?.fmvCore;

        // Compute IQR of holdout set
        const holdoutPrices = holdout.map(c => c.totalUsd).sort((a, b) => a - b);
        const q1 = stats.percentile(holdoutPrices, 25);
        const q3 = stats.percentile(holdoutPrices, 75);

        // Allow 20% tolerance band around IQR
        const lowerBound = q1 * 0.80;
        const upperBound = q3 * 1.20;
        const inRange = fmv >= lowerBound && fmv <= upperBound;

        results.push({
          label,
          fmv: fmv ? +fmv.toFixed(2) : null,
          q1: +q1.toFixed(2),
          q3: +q3.toFixed(2),
          lowerBound: +lowerBound.toFixed(2),
          upperBound: +upperBound.toFixed(2),
          trainCount: train.length,
          holdoutCount: holdout.length,
          pass: inRange,
        });

        // Per-coin failures are non-fatal; aggregate is what matters.
        if (!inRange) {
          console.warn(
            `[holdout seed=${seed}] ${label}: FMV $${fmv?.toFixed(2)} outside ` +
            `[$${lowerBound.toFixed(2)}, $${upperBound.toFixed(2)}] ` +
            `(Q1=$${q1.toFixed(2)}, Q3=$${q3.toFixed(2)}, train=${train.length}, holdout=${holdout.length})`
          );
        }
      }
    );

    test(`seed=${seed} aggregate pass rate captured`, () => {
      const scored = results.filter(r => !r.skip);
      if (scored.length === 0) {
        console.warn(`[holdout seed=${seed}] No coins scored — all skipped`);
        perSeedRates.push({ seed, rate: null, scored: 0, passed: 0 });
        return;
      }
      const passed = scored.filter(r => r.pass).length;
      const rate = passed / scored.length;
      perSeedRates.push({ seed, rate, scored: scored.length, passed });
      console.log(
        `[holdout seed=${seed}] Pass rate: ${passed}/${scored.length} ` +
        `(${(rate * 100).toFixed(0)}%)`
      );
      scored.forEach(r => {
        const tag = r.pass ? 'PASS' : 'FAIL';
        console.log(
          `  [${tag}] ${r.label}: FMV=$${r.fmv} range=[$${r.lowerBound},$${r.upperBound}] ` +
          `(Q1=$${r.q1}, Q3=$${r.q3}, train=${r.trainCount}, holdout=${r.holdoutCount})`
        );
      });
      // Soft-fail individual seeds (do not abort the suite). Final majority
      // gate runs after every seed has finished.
    });
  });

  // Final gate: across all seeds, at least MAJORITY of them must have hit
  // the per-seed >= 70% pass rate. Single-seed mode (HOLDOUT_SEED set) keeps
  // the legacy behavior: 1 seed, requires that single seed to pass.
  describe('holdout validation — cross-seed majority gate (#239)', () => {
    test(`>= ${MAJORITY} of ${SEEDS.length} seeds clear ${(PER_SEED_PASS_THRESHOLD * 100).toFixed(0)}% per-seed pass rate`, () => {
      // Completion guard: this test runs in a sibling describe() after the
      // describe.each(SEEDS) blocks above. Jest executes sibling describes
      // sequentially within a single suite, so by the time this assertion
      // runs, every seed should have populated perSeedRates exactly once.
      // Fail loudly if that contract is ever broken (e.g. by a Jest upgrade
      // that parallelizes sibling describes).
      expect(perSeedRates.length).toBe(SEEDS.length);

      const ratedSeeds = perSeedRates.filter(r => r.rate !== null);
      // Fixture-presence guard: a silent all-skipped pass is worse than a
      // hard fail — it would let someone delete the Terapeak CSVs without
      // anyone noticing the holdout suite stopped validating anything.
      expect(ratedSeeds.length).toBeGreaterThan(0);

      const seedPasses = ratedSeeds.filter(r => r.rate >= PER_SEED_PASS_THRESHOLD).length;
      console.log(
        `[holdout] Cross-seed gate: ${seedPasses}/${ratedSeeds.length} seeds ` +
        `passed (>=${(PER_SEED_PASS_THRESHOLD * 100).toFixed(0)}%); need >= ${MAJORITY}.`
      );
      perSeedRates.forEach(r => {
        console.log(
          `  seed=${r.seed}: ${r.passed}/${r.scored} = ` +
          `${r.rate === null ? 'n/a' : (r.rate * 100).toFixed(0) + '%'}`
        );
      });
      expect(seedPasses).toBeGreaterThanOrEqual(MAJORITY);
    });
  });
}
