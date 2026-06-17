# Synthetic Data Audit -- PURGED (2026-05-07)

## Status: COMPLETE
All synthetic data has been identified and removed. Commit `be1e31a`.

## What Was Done
1. Deleted 88 pure synthetic CSV files (gold coins, Perth Lunars, RCM Lunars, etc.)
2. Cleaned 1 mixed file (`1991_American_Gold_Eagle_1oz.csv` -- removed 28 synthetic rows)
3. Wiped `cache/terapeak_sold.json` and rebuilt from clean CSVs only
4. Server restarted to auto-import only real data

## Post-Purge State
- 2,307 datasets, 130,215 comps, 0 synthetic contamination
- All data is real Terapeak exports from eBay

## Detection Method
- Item ID range is NOT a valid discriminator (real eBay IDs overlap 100B-400B)
- Reliable discriminator: **synthetic seller names** (apmex, jmbullion, sdbullion, etc. from generator scripts)
- Generation scripts used 22 hardcoded seller names; real Terapeak exports leave seller blank

## Generation Scripts (kept for reference, not used)
| Script | What it generated |
|--------|-------------------|
| `scripts/generateAllCoinData.js` | Morgans, Barbers, Walking Liberty, etc. |
| `scripts/generateEagleData.js` | Silver/Gold Eagles |
| `scripts/generateMintSetData.js` | Mint/Proof Sets |
| `scripts/generatePriority1Morgans.js` | Key date Morgans |
| `scripts/spotScaler.js` | Price range adjuster |
