# Process Discipline Skill

Process rules condensed from `docs/WASTE-LEDGER.md` postmortems. Two uses:

1. **Before editing a hot file** -- consult the Hot Files table below for
   the relevant INC(s) and governing doc(s) you must read first.
2. **When filing a new INC entry** -- follow the WASTE-LEDGER Author Guide
   for the required schema and post-entry housekeeping.

This skill is read-only guidance; the source of truth for past incidents
is `docs/WASTE-LEDGER.md` itself.

---

## Hot Files -- INC Mapping

These files are where past incidents happened. Before editing any of them,
read the linked INC entries and the governing doc(s). Doing so is
load-bearing -- skipping has cost the project real money (cumulative
> $20 to date).

| File / Surface | INC(s) (cost) | Governing doc(s) | Required reading before edit |
|---|---|---|---|
| `src/services/ebayService.js` (classifyGradeType, applyFilters strike-split, prefilterStrikeSplit branch) | INC-013 ($10.03) | `docs/memory/numismatic-terminology.md` MANDATORY Pool-Isolation Contract | The JSDoc GOVERNING DOCS banner at top of the file + numismatic SKILL MANDATORY contract + the `prefilterStrikeSplit: 0` regression test at `__tests__/ebayFetchSoldComps.test.js:476` |
| `src/services/valuationService.js` (pool selection, pool fallback, FMV blending) | INC-013 ($10.03) | `docs/memory/numismatic-terminology.md` + `docs/memory/decision-engine-spec.md` | The JSDoc GOVERNING DOCS banner + decision-engine spec |
| `src/services/terapeakService.js` (saveStore, saveMetaSidecar, any disk-write addition) | INC-002 ($2.22), INC-011 ($0.99) | -- | INC-002 (Jest debounce race) + INC-011 (backfill truncated sidecar); verify `NODE_ENV=test` guard before any new disk-write |
| `scripts/terapeak-export.py` (CSV write, session lifecycle) | INC-001 ($3.72), INC-004 ($0.56) | `docs/memory/terapeak-runbook.md` | INC-001 (CSV overwrite destroyed deep-paginated data) -- use `_merge_csv()` with shrink guard, never `.rename(dest)`; INC-004 (bot detection at 22%) -- respect session ttl |
| `.github/workflows/nightly-prefetch.yml` reporting steps | INC-010 ($0.29) | -- | INC-010 (inline-Python heredoc bug masked failure for 5 days); prefer jq + bash over inline Python heredocs |
| `node server.js` launch (any agent invocation) | INC-003 ($0.14) | `/memories/server-management.md` | INC-003 (foreground launch blocked terminal); always start with `isBackground: true` and kill port 3000 first |
| `gh pr merge` / `git push origin main` (any write to `main` in Codespace) | INC-008 ($1.55) | `/memories/gh-cli-codespaces.md`, `docs/memory/codespaces-gh-auth.md` | INC-008 (token reuse + branch-protection bypass); `unset GITHUB_TOKEN GH_TOKEN` before any gh write op in Codespace |
| `docs/BACKLOG.md` status edits | INC-009 ($1.67) | -- | INC-009 (multi-pass reconciliation forced by stale status); update status in the SAME PR as the work, not in a sweep |

When the file you're editing is in this table, the PR body MUST cite the
relevant INC and the governing doc section. Pre-commit reviewer Data Model
Sync check enforces this for the pool-isolation rows (ebay + valuation);
for the others it is author discipline.

---

## WASTE-LEDGER Author Guide

### When to file a new INC

File a new INC entry for any of the following:

- Any incident costing > $0.10 of agent / compute / human time
- Any agent-violation that broke an established rule, regardless of cost
- Any data-corruption event, regardless of cost
- Any process gap surfaced by a near-miss (file the INC even if no actual
  cost; mark the cost row $0 and explain the gap)

### Required schema

Copy this template verbatim. All fields are required unless marked
optional. Examples live in `docs/WASTE-LEDGER.md` itself -- read a few
recent entries before authoring.

```markdown
### INC-NNN: <Short Title>

| Field | Value |
|---|---|
| Date | YYYY-MM-DD or YYYY-MM-DD through YYYY-MM-DD |
| Category | one or more of: `data-corruption`, `agent-violation`, `duplicate-pull`, `bot-detection`, `code-bug`, `config-error`, `recovery-ops`, `observability-debt` (join with ` / ` if multiple) |
| Root Cause | one paragraph naming the specific bug / violation |
| Impact | what broke for the user / system / data |
| Mistakes | (required when Category includes `agent-violation`) numbered list of what the agent did vs what it should have done |
| Codespace | hours x $0.18/hr = $X.XX |
| Copilot | requests x $0.04 = $X.XX |
| Azure | $X.XX or `< $0.01` |
| **Total** | **$X.XX** |
| Resolution | what fixed it (PR / commit + short description) |
| Rule Added / Rules Added | numbered list of new rules with explicit "must" / "never" language |
```

### Cost rate card

- Codespace: $0.18 / hour (round to nearest 0.5 hour)
- Copilot: $0.04 / premium request
- Azure: actual ledger amount; `< $0.01` is acceptable

### Post-entry housekeeping

After adding the entry:

1. Update the **Summary** table at the bottom of `docs/WASTE-LEDGER.md`
2. Update the **Metrics** section (Running Total, Worst Category, etc.)
3. If a new rule was added, also update the appropriate downstream surface
   so the next agent can find it:
   - User-side / cross-workspace rule -> `/memories/operating-rules.md`
     or topic-specific user-memory file
   - Repo-scoped rule -> the relevant `.github/skills/<topic>/SKILL.md`
     or `docs/memory/<topic>.md`
   - Pool-isolation rule -> `docs/memory/numismatic-terminology.md`
     MANDATORY contract section
4. Cite the new rule's location in the INC's "Resolution" or "Rule Added"
   row so future readers can find the enforcement

### Citation discipline

Every "Rule Added" entry SHOULD link or path-cite the downstream surface
where the rule was actually written. An INC that ends with "rule added: do
better next time" without a concrete enforcement surface is a near-miss,
not a fix. (This is what INC-013 corrected: rules #18 / #19 / #20 were not
just text -- they were anchored in operating-rules.md and now in this
SKILL and the workflow SKILL.)

---

## Carve-Out Commits (direct to `main`)

If the INC postmortem references an already-merged or already-closed
PR / branch, this commit may go direct to `main` (see
`.github/skills/workflow/SKILL.md` "WASTE-LEDGER Carve-Out").

The commit message MUST:

- Name the INC-NNN id
- Reference the underlying PR(s) and their merge / close state
- Cite the workflow SKILL carve-out clause (e.g.,
  "per .github/skills/workflow/SKILL.md WASTE-LEDGER Carve-Out")

The diff MUST touch ONLY `docs/WASTE-LEDGER.md`. Any other change in the
same commit (even a typo fix in a sibling doc) loses the carve-out and
requires a feature branch + PR.

Self-review against the schema above is still required before push.

---

## Cross-References

- `docs/WASTE-LEDGER.md` -- the ledger itself
- `.github/skills/workflow/SKILL.md` -- canonical PR workflow + carve-out source
- `/memories/operating-rules.md` -- user-side operating rules
- `docs/memory/numismatic-terminology.md` -- pool-isolation contract (INC-013)
- `docs/memory/terapeak-runbook.md` -- Terapeak ops (INC-001, INC-002, INC-004, INC-011)
- `docs/memory/codespaces-gh-auth.md` -- gh CLI token quirk (INC-008)
- `/memories/server-management.md` -- server-launch rules (INC-003)
