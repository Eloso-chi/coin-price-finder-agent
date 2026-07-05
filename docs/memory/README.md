# Memory Corpus

This folder is the **canonical, git-tracked** project memory corpus. It is the
single source of truth for the Onboard agent (`.github/agents/onboard.agent.md`,
Phase 1) and any other agent or human that needs persistent project context.

Before 2026-06-17, these files lived only in machine-local memory storage at
`/memories/repo/` -- visible only to the Copilot client running on a particular
machine. That made the W (Codespace) and H (home) machines hold subtly different
project understandings depending on who wrote which note. This migration moves
the corpus into git so both machines see the same content.

## Migration

| Field | Value |
|-------|-------|
| Migration date | 2026-06-17 |
| Branch / PR | `docs/memory-corpus-migration` |
| Source path | `/memories/repo/` (machine-local memory tool storage) |
| Source machine | W (Codespace) |
| Files migrated | 21 markdown files |
| Banner added | Originals at `/memories/repo/` carry a `MIGRATED to docs/memory/...` notice and are retained as a non-authoritative backup. |

## Inventory (31 files)

| File | Purpose |
|------|---------|
| `agents-and-prompts.md` | Inventory of all `.github/agents/`, `.github/prompts/`, and `.github/skills/` |
| `agent-loading-order.md` | How Copilot loads memory scopes / agents / prompts / skills; where new content belongs (added under #271W F18) |
| `audience-gating.md` | Public vs admin response gating (PR #85) |
| `azure-infrastructure.md` | Key Vault, Cosmos DB, Blob Storage, App Service |
| `background-processes-status.md` | Background timers, prefetch scheduler (2026-05-26, refreshed 2026-07-03 for #277W) |
| `bulk-evaluate-feature.md` | Lot Evaluator engine reference |
| `cache-invalidation-fix.md` | Cache TTL / eviction fix (2026-04-11) |
| `codebase-overview.md` | Stack, services, routes, auth, env vars |
| `codespace-connection-stability.md` | Two-problems taxonomy for "codespace froze" (server-side idle-stop vs client connection drop), keep-alive script usage, mitigations per client, myths debunk. Added 2026-07-05 (2026-06-30 audit migration). |
| `codespaces-gh-auth.md` | Codespace gh CLI token quirk (`unset GITHUB_TOKEN` for writes) |
| `cosmos-gotchas.md` | Cosmos DB pitfalls and patterns |
| `decision-engine-spec.md` | valuationService FMV modes, confidence, buy/sell spreads |
| `ebay-search-filtering-analysis.md` | Keyword building, deny lists, scoring |
| `finding-api-dead.md` | eBay Finding API decommission context |
| `flaky-tests.md` | Known flaky tests + isolation results + rerun policy (`terapeakService.test.js` freshness check flake documented). Added 2026-07-05. |
| `future-edits.md` | **HISTORICAL ARCHIVE.** Now a deprecation stub. Canonical backlog is `docs/BACKLOG.md`. Holds the renumber map (memory#183->#228, #185->#226, #186->#227) and per-machine ID convention. |
| `key-normalization-fix.md` | 2026-05-08 key normalization |
| `label-feature-context.md` | Label / variant feature design |
| `numismatic-terminology.md` | Strike types, grade prefixes, pool classification, common traps |
| `operator-status-format.md` | User-required schema for operator/codespace/run status reports (pass number, coins run, new rows, dup rows, highlights). Added 2026-07-05. |
| `pcgs-numbers-collisions.md` | 80-PCGS# collision data bug between Silver Eagle and Gold Eagle tables (`src/data/pcgsNumbers.js`). Referenced from `__tests__/prefetchScheduler.test.js` and `src/services/prefetchScheduler.js`. Migrated 2026-07-05 to make the code refs resolve cross-machine. |
| `pool-isolation-rule.md` | **MANDATORY READ-FIRST for `ebayService.js` pool gates.** INC-013 safety rule ($17-33 cost + 5 days polluted FMV from PR #252 revert). Migrated 2026-07-05. |
| `production-state-lookup.md` | **CRITICAL OBSERVABILITY CONTRACT.** Codespace `cache/` is `.gitignore`d and never production truth; use `/api/admin/*` endpoints or `gh run` logs. Added 2026-07-03 under #277W after a Copilot misdiagnosis ("prefetch hasn't run in 3 nights" from a stale local file). |
| `synthetic-data-audit.md` | Synthetic data purge (2026-05-07) |
| `terapeak-cache-wipe-gotcha.md` | `cache/terapeak_sold.json` wipe + CSV-only re-import produces degraded `compCount`; self-heals on next hydration. Design, not a bug. Added 2026-07-05. |
| `terapeak-data-structure-analysis.md` | CSV format, column mapping (2026-04-12) |
| `terapeak-export-automation.md` | Playwright aggregation architecture |
| `terapeak-export-process.md` | Correct export steps |
| `terapeak-runbook.md` | Aggregation operations, VNC setup, troubleshooting |
| `terapeak-startup-auto-cleanup.md` | What `node server.js` boot does with stale CSVs + meta (evict/purge/import chain in `server.js` L247-265). Includes "lesson learned" about not misreading legitimate drift. Added 2026-07-05. |
| `README.md` | This file |

**Not migrated (superseded):**

- `/memories/repo/terapeak-operator-pr168.md` -- content is covered by [../runbooks/local-scraper-wsl2.md](../runbooks/local-scraper-wsl2.md) (preflight + UPLOAD_MODE, with #251 overriding pr168's api->blob claim) and [../../.github/agents/terapeak-operator.agent.md](../../.github/agents/terapeak-operator.agent.md). Unique detail (python resolver order) lives in `scripts/terapeak-operator.sh::resolve_python_bin()`. `PR-168-ALIGNMENT-REPORT.md` referenced there no longer exists.

## Audit notes (2026-06-17)

The migration included a content audit. Findings:

### Sanitized in this PR

The production `ADMIN_API_KEY` value was removed from two locations
in `docs/memory/` before commit:

- `docs/memory/terapeak-runbook.md` (curl example + Key Facts section -- two occurrences)
- `docs/memory/terapeak-export-automation.md` (Environment Variables section)

Each occurrence was replaced with a reference to:
- Local `.env` (gitignored)
- Azure Key Vault secret `ADMIN-API-KEY` (production)
- `bash scripts/load-secrets.sh` for fresh-machine bootstrap

### Known remaining exposure -- tracked under backlog #265W

The same key value is still committed in:

1. `scripts/bar-pricing-health.js` line 14 -- hardcoded fallback (the
   `process.env.ADMIN_API_KEY || '<literal>'` pattern), in git since commit
   `d6e0f17`
2. Git history -- the key was added in PR-era commits before this migration;
   sanitizing the live tree does not retroactively remove history

The machine-local `/memories/repo/` backups also still contain the value
(intentional -- backups are not edited and are gitignored).

Rotation + script-sanitization is tracked as **#265W** in `docs/BACKLOG.md`.

### PII / secret scan

Beyond the ADMIN_API_KEY noted above, no other credentials, tokens, OAuth
secrets, JWT signing keys, connection strings, or PII were found in the
corpus. References to other secret-bearing env vars (PCGS_API_KEY,
GOLDAPI_KEY, etc.) appear only as variable names, never as literal values.

## Editing rules

- **Edit `docs/memory/*.md` only.** It is the canonical, peer-reviewed version.
- **Do not edit `/memories/repo/*.md` directly.** Those are non-authoritative
  backups. If you want a change to persist across machines and reviewers, edit
  the `docs/memory/` copy and open a PR.
- The Onboard agent (Phase 1) reads `docs/memory/`; the legacy `/memories/repo/`
  is only a fallback when a file is missing.
- New project memory goes here -- not into the memory tool, not into ad-hoc
  notes in `.github/`.

## Related documents

- [docs/BACKLOG.md](../BACKLOG.md) -- canonical backlog (single source of truth)
- [docs/BACKLOG.rules.md](../BACKLOG.rules.md) -- backlog governance + per-machine ID convention
- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) -- system architecture
- [docs/runbooks/](../runbooks/) -- operational runbooks
- [.github/agents/onboard.agent.md](../../.github/agents/onboard.agent.md) -- agent that reads this corpus
