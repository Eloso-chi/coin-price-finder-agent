# Workflow Skill

Canonical PR workflow for coin-price-finder-agent. Applies to ALL changes:
code, docs, config, agents, skills, tests, data, schemas.

This skill is the single source of truth for the workflow. Other docs
(CONTRIBUTING.md, operating-rules.md, pull_request_template.md, the agent
definitions) summarize or invoke this content -- they do not duplicate it.

---

## Hard Rule

**Never commit directly to `main`.** Every change goes through a feature
branch + PR + review.

There is exactly one carve-out: `docs/WASTE-LEDGER.md` postmortem entries
that reference an already-merged or already-closed PR/branch may commit
direct to `main`. See "WASTE-LEDGER Carve-Out" section below.

No other exceptions. Reverts, doc-only PRs, agent-config PRs, and skill
updates all go through the workflow. INC-013 rule #18 (added 2026-06-23)
makes this explicit because the previous "low-risk" framing was used to
justify direct commits that should have gone through review.

---

## Tiered Execution

PRs are sized by impact, not by line count. The author picks the tier and
states it in the PR body. Reviewers may upgrade the tier; they may not
downgrade without author concurrence.

| Tier | When to use | Required gates |
|------|-------------|----------------|
| XS | Pure cleanup (typo fixes, stale comment removal, dead-file deletion) with zero behavioral change | Pre-commit reviewer only |
| S | Single-file doc change, non-load-bearing agent tweak, version bump | Pre-commit reviewer + author self-review |
| M | Multi-file change affecting agent behavior, SKILL content, source services, schemas (non-breaking) | Pre-commit reviewer + deep review (`@code-reviewer.approval-gated`) |
| L | Schema breaking change, route signature change, migration, anything touching auth or money | Pre-commit + deep review + targeted sub-reviews (security, performance) + manual smoke test |

---

## Scope Isolation Rule

When a change set naturally spans data refreshes, operator behavior, and CI,
split it into separate PRs so each PR has one rollback surface.

Required split (when applicable):

- **Data checkpoint PR**: `data/terapeak/**` + `data/terapeak-meta.json` only.
- **Operator behavior PR**: `scripts/terapeak-operator.sh` and closely related
  operator scripts only.
- **CI/workflow PR**: `.github/workflows/**` only.

Do not mix these surfaces in one PR unless an emergency exception is approved.

### Emergency Exception (mixed-scope PR)

Allowed only when delaying a combined change is likely to increase risk
(for example, active data-loss prevention/recovery work).

Required controls:

1. Add `EXCEPTION APPROVED:` in the PR body with approver + reason.
2. Add `Exception rollback plan` section with exact revert/cherry-pick steps.
3. Open follow-up PR(s) to re-separate concerns after stabilization.
4. Reference related INC entry or backlog item tracking the exception.

Absent all four controls, mixed-scope PRs are out of policy.

---

## Step-by-Step

### 1. Create feature branch

Branch from current `main`:

```bash
git fetch origin
git checkout main
git pull --ff-only
git checkout -b <type>/<scope>-<short-desc>
```

Naming convention: `<type>/<scope>-<short-desc>`.

- `type`: `feat`, `fix`, `docs`, `refactor`, `revert`, `chore`
- `scope`: backlog id (`271W`), incident id (`INC-013`), or subsystem (`ebay`)
- Examples: `docs/271W-onboard-hard-rules`, `fix/252-bullion-merge`,
  `revert/252-pool-merging`, `feat/270W-adaptive-lookback`

### 2. Make changes

- Read existing code/docs before editing (operating-rules.md "Safety &
  Change Management").
- For pool-isolation surfaces (`src/services/ebayService.js`
  classifyGradeType / applyFilters, `src/services/valuationService.js` pool
  selection): read the JSDoc GOVERNING DOCS banner first; it cites the
  required reading.
- For hot files in general: consult
  `.github/skills/process-discipline/SKILL.md` "Hot Files -- INC Mapping".

### 3. Run pre-commit reviewer

Invoke `@pre-commit-reviewer`. Verify all checks PASS (or that WARNs are
acknowledged in PR body). Checks include:

- Secrets scan (BLOCK)
- Test suite (BLOCK)
- Data Model Sync (WARN -- including pool-isolation rows for ebay/valuation services, see #271W F5)
- Lint / get_errors (WARN)
- UX / IA review trigger (WARN if UI changed)
- Documentation Coverage (WARN per the table in `CONTRIBUTING.md`)
- Commit message quality (WARN)

### 4. Commit

Conventional Commits style. Subject MUST include backlog id when
applicable. Body MUST cite the finding(s) closed, verification done,
self-found issues fixed during review.

**Do NOT use `--no-verify`.** Check active hooks first:

```bash
ls .git/hooks/ | grep -v sample
```

If hooks are sample-only, `--no-verify` is a no-op but still signals a bad
habit (INC-013 rule #20).

### 5. Push

In a Codespace, unset the restricted token first (the codespace `GITHUB_TOKEN`
cannot push to branch-protected branches):

```bash
unset GITHUB_TOKEN GH_TOKEN
git push -u origin <branch>
```

This is documented in `/memories/gh-cli-codespaces.md` (machine-local user
memory) and `docs/memory/codespaces-gh-auth.md` (repo memory).

### 6. Open PR

Use the PR template (`.github/pull_request_template.md`). Required
sections:

- **Summary** -- what changed and why
- **Backlog Reference** -- existing item, new proposal, or explicit
  no-update justification (per `CONTRIBUTING.md` Pull Request Process)
- **Changes** -- file-by-file or grouped-by-finding
- **Testing** -- evidence that `npm test` ran and result
- **Documentation** -- which doc surfaces were updated, or no-doc
  justification
- **Review Gates** -- which tier, which gates were run
- **Risk & Rollback** -- one-line risk assessment + how to revert

### 7. Review + approval

- **XS / S tier:** present pre-commit report + diff stat inline, request
  merge approval.
- **M / L tier:** run `@code-reviewer.approval-gated`, present findings
  inline as a structured report (per `.github/skills/code-review/SKILL.md`
  Report Structure), wait for user `APPLY <items>` or merge approval.

The deep reviewer MUST execute Step 3b (Load Domain Context) before
delegating sub-reviews (per #271W F4). Skipping Step 3b is the recurrence
vector for INC-013.

### 8. Merge

```bash
unset GITHUB_TOKEN GH_TOKEN
gh pr merge <N> --admin --merge --delete-branch
```

Default merge strategy is `--merge` (commit-preserving) unless the user
specifies otherwise. After merge:

```bash
git checkout main
git pull --ff-only
git remote prune origin   # clean up tracking refs for deleted remote branches
```

### 9. Post-merge bookkeeping (BACKLOG status flip)

GitHub auto-closes the PR on merge, but `docs/BACKLOG.md` rows do NOT
flip automatically. Closing the row is part of the workflow, not an
optional follow-up.

**Two patterns, pick the right one:**

- **Single-PR umbrella** (the PR fully closes one backlog item): flip
  the umbrella row status inside the PR's own diff. The `## Backlog
  Update` section of the PR body cites the in-diff flip.
- **Multi-PR umbrella** (an umbrella with sub-PRs, e.g. `#271W`): the
  FINAL sub-PR -- the one closing the last finding -- flips the
  umbrella row in its own diff, citing all constituent merge SHAs. The
  prior sub-PRs only flip their own row (sub-PR column populated)
  and leave the umbrella status as `OPEN`.

**If the flip was missed:** open a follow-up XS-tier PR named
`chore(#NNN): mark backlog closed`. It must:

- touch ONLY `docs/BACKLOG.md`,
- cite all constituent PR numbers and merge SHAs,
- pass pre-commit reviewer (no deep review required for XS).

This is a regular PR, NOT a carve-out -- the reviewer's job is to
verify each cited merge SHA actually landed on `main`.

---

## WASTE-LEDGER Carve-Out (added 2026-06-23, moved from operating-rules.md under #271W F6)

Entries documenting an already-merged or already-closed PR/branch may
commit direct to `main` without their own feature branch.

**Rationale:** the ledger entry IS the postmortem of a process violation;
gating it behind the same workflow it documents adds Copilot / Codespace
cost without adding safety.

**Constraints (ALL must hold):**

- The referenced PR/branch must already be merged or closed.
- The diff must touch ONLY `docs/WASTE-LEDGER.md`.
- The commit message must name the INC-NNN id and reference the underlying
  PR(s) and their merge/close state.
- Self-review of the entry against the schema in
  `.github/skills/process-discipline/SKILL.md` "WASTE-LEDGER Author Guide"
  is still required before push.

All other doc changes (BACKLOG, runbooks, memory docs, etc.) still follow
the full workflow.

---

## Author Checklist

Before requesting merge:

- [ ] Branch from latest `main` (rebase if needed)
- [ ] Tier picked and stated in PR body
- [ ] Pre-commit reviewer run; report attached or PASS confirmed
- [ ] Tests pass (`npm test`)
- [ ] No `--no-verify` reflex (or active hooks verified absent)
- [ ] PR body cites backlog item or justifies no-update
- [ ] Documentation surfaces updated per `CONTRIBUTING.md` Documentation
      Expectations OR no-doc justification stated
- [ ] For pool-isolation surfaces (ebayService classifyGradeType /
      applyFilters, valuationService pool selection): `@numismatic-audit`
      Step 5b run and PASS, cited in PR body
- [ ] For other hot files (per process-discipline SKILL Hot Files table):
      relevant INC and governing doc cited

---

## Cross-References

- `CONTRIBUTING.md` -- contributor-facing summary of this SKILL
- `.github/pull_request_template.md` -- PR template
- `.github/agents/pre-commit-reviewer.agent.md` -- pre-commit checks (Step 3)
- `.github/agents/code-reviewer.approval-gated.agent.md` -- deep review (Step 7 M/L tier)
- `.github/skills/code-review/SKILL.md` -- review framework used by both reviewer agents
- `.github/skills/process-discipline/SKILL.md` -- hot-file -> INC mapping + WASTE-LEDGER author guide
- `docs/WASTE-LEDGER.md` -- cost ledger + carve-out source
- `/memories/operating-rules.md` -- user-side operating rules (PR Workflow section is now a pointer to this SKILL)
