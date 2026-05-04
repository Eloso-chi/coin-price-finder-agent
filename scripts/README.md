# scripts/

Operational scripts for data collection, migration, and maintenance. Most scripts are run manually from the repo root.

## Prerequisites

| Requirement | Scripts that need it |
|---|---|
| Node server running (`node server.js`) | `sales-aggregator.py`, `terapeak-export.py`, `pricing-health-full.js` |
| VNC desktop + browser session | `terapeak-export.py`, `sales-aggregator.py`, `vnc-login.py` |
| Azure credentials (Key Vault) | `upload-csvs-to-blob.js`, `migrate-to-cosmos.js`, `greysheet-refresh.js` |
| Python 3 + playwright | `terapeak-export.py`, `sales-aggregator.py`, `vnc-login.py`, `create_placeholders.py` |

## Script Reference

### Terapeak Collection

| Script | Purpose | Usage |
|---|---|---|
| `terapeak-export.py` | Semi-automated Terapeak CSV exporter (page 1) | `python3 scripts/terapeak-export.py --run --limit 20` |
| `sales-aggregator.py` | Deep pagination aggregator (pages 2-6) with dashboard mode | `python3 scripts/sales-aggregator.py` (dashboard) or `--run --limit 10` |
| `vnc-login.py` | Opens browser, waits for eBay login, saves cookies | `python3 scripts/vnc-login.py` |
| `create_placeholders.py` | Create placeholder CSVs + meta files for export backlog | `python3 scripts/create_placeholders.py` |

### Data Generation

| Script | Purpose | Usage |
|---|---|---|
| `generateAllCoinData.js` | Generate all coin dataset CSVs | `node scripts/generateAllCoinData.js` |
| `generateEagleData.js` | Generate American Eagle series data | `node scripts/generateEagleData.js` |
| `generateMintSetData.js` | Generate mint set data | `node scripts/generateMintSetData.js` |
| `generatePriority1Morgans.js` | Generate Priority-1 Morgan dollar data | `node scripts/generatePriority1Morgans.js` |
| `create-grade-datasets.js` | Generate grade-suffixed Terapeak CSV stubs | `node scripts/create-grade-datasets.js` |
| `seedFromEbay.js` | Seed coin data from eBay listings | `node scripts/seedFromEbay.js` |

### Maintenance & Migration

| Script | Purpose | Usage |
|---|---|---|
| `pricing-health-full.js` | Full-dataset pricing health audit | `node scripts/pricing-health-full.js --full` |
| `greysheet-refresh.js` | Bulk Greysheet price snapshot collector | `node scripts/greysheet-refresh.js` |
| `upload-csvs-to-blob.js` | Upload local Terapeak CSVs to Azure Blob | `node scripts/upload-csvs-to-blob.js [folderPath]` |
| `migrate-to-cosmos.js` | One-time migration of history data to Cosmos DB | `node scripts/migrate-to-cosmos.js` |
| `clean-csvs.js` | One-time CSV cleaner (applies DENY_PATTERNS) | `node scripts/clean-csvs.js` |

### Utilities

| Script | Purpose |
|---|---|
| `spotScaler.js` | Spot-price-aware range scaling for CSV generators (library, not standalone) |
| `_validateLookups.js` | Temporary validation script -- test all US coin Terapeak lookups |
| `test-metrics/` | Jest metrics capture + summary reporter (`run-with-metrics.cjs`, `summarize.cjs`) |

## Common Workflows

### Initial Terapeak export run

```bash
# 1. Start server
node server.js &

# 2. Login to eBay via VNC
python3 scripts/vnc-login.py

# 3. Run exports (limit to 20 coins)
python3 scripts/terapeak-export.py --run --limit 20

# 4. Deep-collect pages 2+ for thin datasets
python3 scripts/sales-aggregator.py --run --limit 10
```

### Dashboard-driven aggregation

```bash
# Launch interactive dashboard (no flags)
python3 scripts/sales-aggregator.py
# Select a priority category from the menu, then confirm to start
```

### Pricing health check

```bash
node scripts/pricing-health-full.js --full --out health-report.json
# Or filter to specific series:
node scripts/pricing-health-full.js --filter "morgan" --concurrency 4
```
