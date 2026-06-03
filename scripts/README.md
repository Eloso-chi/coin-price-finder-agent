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
| `bootstrap-surface-wsl.sh` | One-command Surface/WSL bootstrap for PR250 flow (deps, venv, Playwright, env templates) | `bash scripts/bootstrap-surface-wsl.sh` |
| `surface` | One-word launcher for the Surface freshness loop (loads validated env + runs loop) | `surface` |
| `run-surface-freshness-loop.sh` | Surface/WSL wrapper: report -> page 1 backlog -> report -> deep backlog -> report | `bash scripts/run-surface-freshness-loop.sh --env-file ~/.env.surface` |
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
| `lot-estimator-health.js` | Randomized lot parity + consistency health audit (bulk vs individual) | `node scripts/lot-estimator-health.js --lots 8 --seed 18652` |
| `generate-freshness-report.js` | Dataset freshness triage (5-state + recently-confirmed-stale split) | `node scripts/generate-freshness-report.js [--summary] [--batch N]` |
| `greysheet-refresh.js` | Bulk Greysheet price snapshot collector | `node scripts/greysheet-refresh.js` |
| `upload-csvs-to-blob.js` | Upload local Terapeak CSVs to Azure Blob | `node scripts/upload-csvs-to-blob.js [folderPath]` |
| `migrate-to-cosmos.js` | One-time migration of history data to Cosmos DB | `node scripts/migrate-to-cosmos.js` |
| `clean-csvs.js` | One-time CSV cleaner (applies DENY_PATTERNS) | `node scripts/clean-csvs.js` |
| `backfill-sale-dates.js` | Backfill newestSaleDate/oldestSaleDate/compCount into meta sidecar | `node scripts/backfill-sale-dates.js [--dry-run]` |
| `reclassify-comps.js` | Batch comp reclassification (weight mismatch rerouting) | `node scripts/reclassify-comps.js [--apply]` |

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

### Lot estimator health

```bash
# Randomized bulk-vs-individual lot parity checks
node scripts/lot-estimator-health.js --lots 8 --min-size 5 --max-size 10 --seed 18652

# Write report to a custom file and run extra repeat checks
node scripts/lot-estimator-health.js --lots 12 --repeat 3 --out cache/lot-health.json
```

### Freshness triage report

```bash
node scripts/generate-freshness-report.js              # Full report to cache/freshness-report.json
node scripts/generate-freshness-report.js --summary    # Print summary only (no file write)
node scripts/generate-freshness-report.js --batch 100  # Write top-100 priority batch file
node scripts/generate-freshness-report.js --metal gold # Filter to gold-metal datasets only
node scripts/generate-freshness-report.js --stale 15   # Override stale threshold (default 15 days)
```

### Surface freshness loop

```bash
# Residential-machine loop: pre-flight cookies, generate report, run page-1
# backlog, regenerate report, run deep-pagination backlog, regenerate report.
bash scripts/run-surface-freshness-loop.sh --env-file ~/.env.surface

# Skip the live eBay probe if you already did one moments ago.
bash scripts/run-surface-freshness-loop.sh --env-file ~/.env.surface --skip-probe

# Run page-1 only and defer deep pagination.
bash scripts/run-surface-freshness-loop.sh --env-file ~/.env.surface --skip-deep --page1-batch 20
```

### Surface bootstrap (fast setup)

```bash
# Run once per new Surface/WSL environment.
bash scripts/bootstrap-surface-wsl.sh

# Save admin key once (hidden prompt, chmod 600 file):
~/set-cpf-admin-key.sh

# Activate the one-word command in your shell:
source ~/.bashrc

# Run the full freshness loop:
surface
```

Notes:
- Key persists in `~/.config/cpf/admin_api_key` and is never written to shell history.
- Use raw `ADMIN_API_KEY` value, not `@Microsoft.KeyVault(SecretUri=...)`.
- If Playwright install fails on Ubuntu 26.04, use Ubuntu 24.04/22.04 for scraper runs.
