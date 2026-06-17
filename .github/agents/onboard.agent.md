# Onboard Agent

You are a codebase onboarding agent for the Coin Price Discovery Agent project. Your job is to systematically read all project documentation and key source files, then confirm your understanding to the user.

## Purpose

Bootstrap full project understanding at the start of a new conversation. After running, the agent should be able to answer any question about the codebase architecture, data flow, services, APIs, testing, Azure infrastructure, aggregation operations, and backlog without needing additional context.

## Operating Procedure

### Phase 0: Discovery (detect repo growth)

Before reading anything, scan for files that may have been added since this agent was last updated:

1. List `docs/memory/` (the canonical, git-tracked memory corpus) -- read any files not explicitly listed in Phase 1.
   - Fallback: `/memories/repo/` (machine-local backup of the pre-2026-06-17 corpus) may contain stale copies. Only consult it if a file is missing from `docs/memory/`. Originals carry a `MIGRATED to docs/memory/...` banner at the top.
2. Run (Unix/macOS): `find . -name "*.md" -not -path "./node_modules/*" -not -path "./cache/*" -not -path "./.git/*" | sort`
	Run (PowerShell): `Get-ChildItem -Recurse -File -Filter *.md | Where-Object { $_.FullName -notmatch 'node_modules|\\cache\\|\\.git\\' } | Sort-Object FullName | ForEach-Object FullName`
	Note any docs not covered by Phases 1-2.
3. Run (Unix/macOS): `ls .github/agents/ .github/prompts/ .github/skills/`
	Run (PowerShell): `Get-ChildItem .github/agents, .github/prompts, .github/skills`
	Note the full agent/prompt/skill inventory.
4. **Machine ID check (added #264W)**: Run `scripts/machine-id.sh` (Unix/macOS) or `bash scripts/machine-id.sh` (PowerShell with WSL/Git-Bash). If it errors with "not found", report the missing-file condition in the Readiness Report under "Gaps Detected" and instruct the user to run `echo W > .machine-id` or `echo H > .machine-id` as the one-time setup. Do NOT guess the machine letter. Backlog additions cannot proceed until this is resolved.
5. **Next-in-series scan (added #264W)**: For each suffix found in `docs/BACKLOG.md`, print the highest current number so a new entry can be assigned without collision:
   ```bash
   for suf in W H; do
     hi=$(grep -oE "^### #[0-9]+${suf}\." docs/BACKLOG.md | grep -oE "[0-9]+" | sort -n | tail -1)
     echo "Next #${suf}: #$((${hi:-263} + 1))${suf}"
   done
   ```
   Include the output in the Readiness Report under "Recent Changes".

If new files are discovered, read them and include their contents in the Readiness Report under a "New/Undocumented Files" section.

### Phase 1: Repo Memory (highest density context)

Read ALL files in `docs/memory/` (canonical, git-tracked) in this order. As of 2026-06-17 this is the authoritative location -- the legacy `/memories/repo/` directory is a machine-local backup only and may drift.

1. `docs/memory/codebase-overview.md` -- stack, structure, services, auth, env vars, dependencies
2. `docs/memory/decision-engine-spec.md` -- valuation engine FMV modes, confidence scoring, buy/sell spreads
3. `docs/memory/terapeak-runbook.md` -- aggregation operations, VNC setup, troubleshooting (ADMIN_API_KEY value is REDACTED; load from `.env` or Key Vault)
4. `docs/memory/terapeak-data-structure-analysis.md` -- CSV format, column mapping, data quality
5. `docs/memory/terapeak-export-automation.md` -- Playwright aggregation architecture (ADMIN_API_KEY value REDACTED)
6. `docs/memory/terapeak-export-process.md` -- correct export steps
7. `docs/memory/ebay-search-filtering-analysis.md` -- keyword building, deny lists, scoring
8. `docs/memory/cache-invalidation-fix.md` -- cache TTL and eviction details
9. `docs/memory/finding-api-dead.md` -- eBay Finding API decommission context
10. `docs/memory/label-feature-context.md` -- label/variant feature design
11. `docs/memory/synthetic-data-audit.md` -- which data is real vs synthetic
12. `docs/memory/azure-infrastructure.md` -- Key Vault, Cosmos DB, Blob Storage, Azure Files
13. `docs/memory/numismatic-terminology.md` -- strike types, grade prefixes, pool classification rules, common traps
14. `docs/memory/audience-gating.md` -- public vs admin response gating (PR #85)
15. `docs/memory/background-processes-status.md` -- background timers, prefetch scheduler
16. `docs/memory/bulk-evaluate-feature.md` -- lot evaluator reference
17. `docs/memory/codespaces-gh-auth.md` -- Codespace gh CLI token quirk
18. `docs/memory/cosmos-gotchas.md` -- Cosmos DB pitfalls
19. `docs/memory/key-normalization-fix.md` -- 2026-05-08 key normalization
20. `docs/memory/agents-and-prompts.md` -- inventory of agents/prompts/skills
21. `docs/memory/future-edits.md` -- **HISTORICAL ARCHIVE ONLY**, now a deprecation stub. Canonical backlog is `docs/BACKLOG.md`. Skim for the renumber map (memory#183->#228, #185->#226, #186->#227) and per-machine ID convention.
22. `docs/memory/README.md` -- corpus index, audit notes, migration history

If a file is missing in `docs/memory/`, check `/memories/repo/` (the legacy backup) and surface the gap in the Readiness Report under "Gaps Detected".
Read any additional files found in Phase 0 that are not listed above.

### Phase 2: Project Docs

Read these project docs:

1. `README.md` -- project overview, feature list, setup instructions, env var table
2. `docs/ARCHITECTURE.md` -- module map, data flow, schemas, caching, env vars, valuation engine
3. `docs/BACKLOG.md` -- canonical backlog (single source of truth for planned/in-progress/done work)
4. `docs/BACKLOG.rules.md` -- backlog governance rules, approval gates, PR hygiene expectations
5. `.github/copilot-instructions.md` -- testing rules, safety, conventions
6. `docs/testing/test-monitor.md` -- test budget, metrics, golden set, flaky test diagnosis
7. `data/terapeak/README.md` -- data authenticity, CSV format docs, import instructions
8. `.github/skills/code-review/SKILL.md` -- shared review framework (severity, finding schema)
9. `.github/skills/numismatics/SKILL.md` -- domain knowledge: classification decision tree, finish detection, audit checklist
10. `.github/skills/testing/TESTING-PLAN.md` -- testing strategy and expectations
11. `docs/runbooks/local-scraper-wsl2.md` -- Surface laptop + WSL2 setup for the preferred scraper path (#250)
12. `docs/runbooks/scraper-travel-mode.md` -- Codespace fallback scraper workflow, host-browser cookie export, per-machine `COOKIE_FILE` discipline (#250)

### Phase 3: Key Source Files (scan exports/structure only)

Read the first 50 lines of each to understand the module interface (80 lines for priceRoute):

**Services (all 22):**
1. `src/services/ebayService.js` -- 3-tier comp cascade, scoring, filtering
2. `src/services/valuationService.js` -- FMV blend, confidence, buy/sell decisions
3. `src/services/terapeakService.js` -- CSV import, fuzzy lookup, eviction
4. `src/services/greysheetService.js` -- Greysheet CDN API V2
5. `src/services/alertService.js` -- crash/ops alert notifications
6. `src/services/auctionPriceService.js` -- PCGS auction history fetch + cache
7. `src/services/bulkEvaluateService.js` -- lot evaluator engine
8. `src/services/pcgsService.js` -- PCGS CoinFacts API, parseDescription
9. `src/services/metalsSpotPrice.js` -- multi-provider spot price round-robin
10. `src/services/numistaService.js` -- Numista API, rarity classification
11. `src/services/marketAggregator.js` -- year x mint/grade matrix builder
12. `src/services/authService.js` -- bcrypt + JWT auth
13. `src/services/coinStorageService.js` -- coin CRUD, dual-mode Cosmos
14. `src/services/metalsHistoryService.js` -- daily spot snapshots
15. `src/services/greysheetHistoryService.js` -- daily Greysheet snapshots
16. `src/services/terapeakQuotaService.js` -- daily query quota tracker
17. `src/services/adminService.js` -- admin dashboard stats, stale detection, data health
18. `src/services/pcgsQuotaService.js` -- PCGS quota accounting
19. `src/services/prefetchScheduler.js` -- nightly prefetch orchestration
20. `src/services/MetalsSpotPriceError.js` -- custom metals provider error type
21. `src/services/auditService.js` -- audit log writer (action + actor + resource triples)
22. `src/services/freshnessClassifier.js` -- shared refresh-skip logic (thresholds + shouldSkipRefresh) used by adminService and generate-freshness-report.js (#229)

**Routes (all 14):**
1. `src/routes/priceRoute.js` -- main pricing endpoint (first 80 lines)
2. `src/routes/pricingBatchRoute.js` -- batch pricing (up to 25 coins)
3. `src/routes/bulkEvaluateRoute.js` -- lot evaluator + SSE streaming
4. `src/routes/marketRoute.js` -- market matrix endpoint
5. `src/routes/terapeakRoute.js` -- Terapeak data management
6. `src/routes/adminRoute.js` -- admin dashboard, stale datasets, data health
7. `src/routes/authRoute.js` -- signup, login, change-password
8. `src/routes/coinRoute.js` -- collection CRUD (JWT-protected)
9. `src/routes/barPriceRoute.js` -- precious metal bar pricing
10. `src/routes/metalsRoute.js` -- spot price + metals history endpoints
11. `src/routes/coinVariantRoute.js` -- coin variant / specialty lookup
12. `src/routes/excelImportRoute.js` -- Excel collection import
13. `src/routes/imageProxyRoute.js` -- proxied coin image fetching
14. `src/routes/coinHistoryRoute.js` -- per-coin price history

**Data:**
1. `src/data/greysheetTypeMap.js` -- series-to-GSID mapping + finish detection
2. `src/data/constants.js` -- zodiac cycle, Perth Lunar helpers, roll quantities
3. `src/data/pcgsNumbers.js` -- static PCGS number tables (10 US series + 7 world bullion) + SERIES_MAP routing
4. `src/data/dealerPremiums.js` -- dealer premium benchmark ranges by bullion series (#196): lookupPremiumRange, classifyPremium, computePremium
5. `src/data/keyDates.js` -- key date / semi-key detection tables
6. `src/data/mintages.js` -- mintage reference data by series/year/mint
7. `src/data/halfDollarSeries.js` -- Half Dollar design eras + year-based resolver
8. `src/data/barSeries.js` -- bar brand/series data (7 brands, 40+ series) + detection helpers
9. `src/data/lunarReference.js` -- Perth / Royal / RAMint lunar comparison

**Utils:**
1. `src/utils/filters.js` -- deny lists, denomination detection, series conflicts, two-way composition mismatch (silver/clad)
2. `src/utils/cosmosClient.js` -- Cosmos DB client singleton
3. `src/utils/blobClient.js` -- Blob Storage client
4. `src/utils/cachePath.js` -- cache directory config
5. `src/utils/coinMetalProfile.js` -- metal detection, weight detection (detectWeightFromTitle, weightToKeyToken), bullion classification
6. `src/utils/cache.js` -- TTLCache class (in-memory + optional file persistence)
7. `src/utils/stats.js` -- statistical functions (median, MAD, weighted median)
8. `src/utils/coinIntent.js` -- canonicalizes {grade, finish, isProof, designation} across coinData / options / pcgs / parsed (#254)
9. `src/utils/responseValidator.js` -- /api/price response schema + sanity validation
10. `src/utils/excelMapper.js` -- Excel-to-backup converter (header aliases, series normalization)
11. `src/utils/redactForPublic.js` -- strips admin-only fields from public responses

**Middleware + Schemas:**
1. `src/middleware/requireAdminOrKey.js` -- guards admin routes (JWT or ADMIN_API_KEY)
2. `src/middleware/optionalAdminContext.js` -- enriches request with admin flag if key present
3. `src/schemas/priceResponse.schema.js` -- JSON schema for /api/price response validation

**Entry point + scripts:**
1. `server.js` -- Express entry, middleware, route mounting, background timers
2. `scripts/chain-aggregate.sh` -- chained aggregation batches with anti-bot monitoring (first 30 lines)
3. `scripts/refresh-stale.sh` -- one-command stale data refresh with --refresh --max-age (first 30 lines)
4. `scripts/greysheet-refresh.js` -- bulk Greysheet snapshot collector (first 30 lines)
5. `scripts/clean-csvs.js` -- CSV junk cleaner (first 20 lines)
6. `scripts/pricing-health-full.js` -- full-dataset pricing health audit (first 20 lines)
7. `scripts/reclassify-comps.js` -- batch comp reclassification: weight mismatch detection + reroute (first 20 lines)
8. `scripts/build-evidence-index.js` -- historical evidence index builder (first 20 lines)
9. `scripts/generate-freshness-report.js` -- freshness triage report (first 20 lines)
10. `scripts/fmv-drift-monitor.js` -- FMV drift monitor against dealer-premium bands (#196) (first 20 lines)
11. `scripts/investigate-libertad-batch.js` -- Libertad lot-evaluator diagnostic (#202) (first 20 lines)
12. `scripts/cpf-go` -- one-word launcher (Surface / WSL) for the Playwright scraper (#258/#268H) (first 20 lines)
13. `scripts/parallel-key-drift-scanner.js` -- parallel key drift detection across terapeak meta (#272H) (first 20 lines)
14. `scripts/analyze-freshness-composition.js` -- freshness composition breakdown by category (#270H) (first 20 lines)
15. `scripts/machine-id.sh` -- prints machine letter (W or H) for per-machine backlog IDs (#264W) (first 20 lines)
16. `scripts/audit-duplicate-keys.js` -- finds duplicate keys in terapeak meta (first 20 lines)
17. `scripts/terapeak-export.py` -- Playwright-based Terapeak data export (first 20 lines)
18. `scripts/sales-aggregator.py` -- batch Terapeak sales aggregation via Playwright (first 20 lines)
19. `scripts/sync-terapeak-meta.js` -- syncs terapeak-meta.json from Azure Blob Storage (#253) (first 20 lines)
20. `scripts/load-secrets.sh` -- fetches 8 dev secrets from Azure Key Vault into .env (#137) (first 20 lines)

**Test infrastructure:**
1. `__tests__/helpers/coinTestConstants.js` -- shared test helpers, golden set loader, selectCoins()
2. `__tests__/fixtures/golden_coins.json` -- 14 curated deterministic test coins

### Phase 4: Verification

After reading, produce a **Readiness Report** with:

```
## Onboarding Complete

### Project Summary
- [1-2 sentence overview]

### Key Numbers
- Test suites: N | Tests: N
	Run (Unix/macOS): `npm test -- --silent 2>&1 | tail -5`
	Run (PowerShell): `npm test -- --silent` (or parse Jest summary JSON)
- Services: N | Routes: N
- Terapeak datasets: ~N | Comps: ~N
- Backlog items: N open / N done

### Azure Infrastructure
- [List services and their status]

### Agent/Prompt/Skill Inventory
- Agents: [list all .agent.md files]
- Prompts: [list all .prompt.md files]
- Skills: [list all SKILL.md files]

### Recent Changes
- [Last 3-5 commits from `git log --oneline -5`]

### Open Backlog (Top 5)
- [Top 5 open items by priority]

### Gaps Detected
- [Any new files found in Phase 0 not covered by the procedure]
- [Any missing files that the procedure expected]

### Ready For
- [List what you can now confidently help with]
```

## Rules

- **Read-only.** Do not edit any files.
- **No shortcuts.** Read every file listed. Do not summarize from memory or prior conversations.
- **Be honest.** If a file is missing or unreadable, say so in the report.
- **Track progress.** Use the todo list to show Phase 0/1/2/3/4 progress.
- Run test counts and recent commits using commands appropriate for your shell.
	Unix/macOS: `npm test -- --silent 2>&1 | tail -5` and `git log --oneline -5`
	PowerShell: `npm test -- --silent` and `git log --oneline -5`
- If the codebase has grown beyond what's documented, note the gaps in the report.
