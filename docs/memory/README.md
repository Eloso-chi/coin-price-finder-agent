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

## Inventory (22 files)

| File | Purpose |
|------|---------|
| `agents-and-prompts.md` | Inventory of all `.github/agents/`, `.github/prompts/`, and `.github/skills/` |
| `audience-gating.md` | Public vs admin response gating (PR #85) |
| `azure-infrastructure.md` | Key Vault, Cosmos DB, Blob Storage, App Service |
| `background-processes-status.md` | Background timers, prefetch scheduler (2026-05-26) |
| `bulk-evaluate-feature.md` | Lot Evaluator engine reference |
| `cache-invalidation-fix.md` | Cache TTL / eviction fix (2026-04-11) |
| `codebase-overview.md` | Stack, services, routes, auth, env vars |
| `codespaces-gh-auth.md` | Codespace gh CLI token quirk (`unset GITHUB_TOKEN` for writes) |
| `cosmos-gotchas.md` | Cosmos DB pitfalls and patterns |
| `decision-engine-spec.md` | valuationService FMV modes, confidence, buy/sell spreads |
| `ebay-search-filtering-analysis.md` | Keyword building, deny lists, scoring |
| `finding-api-dead.md` | eBay Finding API decommission context |
| `future-edits.md` | **HISTORICAL ARCHIVE.** Now a deprecation stub. Canonical backlog is `docs/BACKLOG.md`. Holds the renumber map (memory#183->#228, #185->#226, #186->#227) and per-machine ID convention. |
| `key-normalization-fix.md` | 2026-05-08 key normalization |
| `label-feature-context.md` | Label / variant feature design |
| `numismatic-terminology.md` | Strike types, grade prefixes, pool classification, common traps |
| `synthetic-data-audit.md` | Synthetic data purge (2026-05-07) |
| `terapeak-data-structure-analysis.md` | CSV format, column mapping (2026-04-12) |
| `terapeak-export-automation.md` | Playwright aggregation architecture |
| `terapeak-export-process.md` | Correct export steps |
| `terapeak-runbook.md` | Aggregation operations, VNC setup, troubleshooting |
| `README.md` | This file |

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
