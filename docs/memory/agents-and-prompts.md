# Agents & Prompts Inventory

> This file is the canonical inventory of agents, prompts, and skills shipped
> in `.github/`. It is read by the **Onboard** agent during Phase 1 so the agent
> knows what tools are available.
> The root [`AGENTS.md`](../../AGENTS.md) provides a concise discoverability
> index for contributors and tools that expect that convention.
>
> Migrated 2026-06-17 and inventory-verified 2026-08-13
> (`docs/memory-corpus-migration` branch). A non-authoritative copy lives at
> `/memories/repo/agents-and-prompts.md` on the W (Codespace) machine; that
> copy may drift and should not be edited directly.

All files live in `.github/agents/`, `.github/prompts/`, and `.github/skills/`.
The `.github` directory is hidden -- use explicit paths.

## Agents

| Agent File | Name | Mode | Purpose |
|---|---|---|---|
| `code-reviewer.approval-gated.agent.md` | Code Reviewer | Read-only | Primary correctness, testing, maintainability, domain, and operability review, including test persistence isolation via no-op or mocked/temp paths. Runs beside specialist reviewers under `/review-deep`. |
| `pre-commit-reviewer.agent.md` | Pre-commit Reviewer | Read-only | Staged-change gate: secrets/tests, data-model sync, mapped documentation, Onboard acceptance, support-ready incident evidence, and merge readiness. |
| `implementer.approval-only.agent.md` | Implementer | Write | Applies ONLY explicitly approved findings from Code Review Report. Minimal diffs. |
| `onboard.agent.md` | Onboard | Read-only | Bootstraps full project context and reports `BLOCKING_DELTA`, `PRE_EXISTING_DEBT`, and `OPTIONAL` findings with one correction pass and one verification rerun. |
| `sales-aggregator.agent.md` | Sales Aggregator | Mixed | Uses portable repository-root commands and verifies listener ownership before background startup; manages Terapeak dashboard, freshness, and deep batches using pages 2-5/250 results for non-gold bullion, page 2/100 results for gold and non-bullion, and a 120-search recycle default. |
| `freshness-triage.agent.md` | Freshness Triage | Read-only | Uses portable repository-root commands; if unhealthy, verifies listener ownership before guarded tool-level background startup. |
| `pricing-health.agent.md` | Pricing Health | Read-only | Uses portable repository-root commands to validate pricing flows and comp attrition; verifies listener ownership before background startup. |
| `numismatic-audit.agent.md` | Numismatic Audit | Read-only | Audits classification/filter functions against `.github/skills/numismatics/SKILL.md` ground truth. Catches grade/finish/pool misclassification (e.g. Proof-Like as Proof, Burnished into proof pool, raw into graded pool). |
| `terapeak-operator.agent.md` | Terapeak Operator | Mixed | Runs the canonical local Terapeak startup flow with strict preflight, interactive login, and freshness-only loop mode. Use when: starting a reliable Terapeak run from chat without ad-hoc command construction. |
| `test-coverage.agent.md` | Test Coverage Engineer | Write | Identifies behavioral gaps, writes new tests using existing helpers. |
| `test-monitor.agent.md` | Test Monitor | Write | Test health monitoring, flaky diagnosis, slow test optimization. |
| `ux-reviewer.agent.md` | UX Reviewer | Read-only | WCAG 2.2 AA, responsive design, dark theme, Nielsen heuristics. |
| `security-review.sub.agent.md` | Security Reviewer | Read-only (sub) | OWASP Top 10, injection, auth bypass, secrets exposure. Launched by `/review-deep`. |
| `performance-review.sub.agent.md` | Performance Reviewer | Read-only (sub) | Bottlenecks, memory, caching, algorithmic efficiency. Launched by `/review-deep`. |

## Prompts (slash commands)

| File | Invocation | Purpose |
|---|---|---|
| `pre-commit.prompt.md` | `/pre-commit` | Trigger pre-commit reviewer |
| `review-deep.prompt.md` | `/review-deep` | Launch primary, security, and performance reviewers in parallel, then synthesize the approval-gated report |
| `apply-approved.prompt.md` | `/apply-approved` | Trigger implementer for approved findings |
| `onboard.prompt.md` | `/onboard` | Trigger onboarding agent |
| `pricing-health.prompt.md` | `/pricing-health` | Trigger pricing health check |
| `test-coverage.prompt.md` | `/test-coverage` | Trigger test coverage analysis |

## Skills

| Path | Purpose |
|---|---|
| `.github/skills/code-review/SKILL.md` | Shared review framework (severity defs, finding schema, report structure) |
| `.github/skills/numismatics/SKILL.md` | Domain knowledge: classification decision tree, finish detection, audit checklist, MANDATORY Pool-Isolation Contract |
| `.github/skills/testing/TESTING-PLAN.md` | Testing standards, batch plan, coverage targets |
| `.github/skills/workflow/SKILL.md` | Canonical PR workflow (hard rule, tiered execution, 10-step lifecycle, WASTE-LEDGER carve-out) |
| `.github/skills/process-discipline/SKILL.md` | Hot-file -> INC mapping + WASTE-LEDGER author guide (schema, rate card, citation discipline) |
| `.github/skills/valuation/SKILL.md` | FMV / confidence / buy-sell decision engine routing reference; cites decision-engine-spec, pool-isolation contract, INC-013 |
| `.github/skills/comp-data/SKILL.md` | eBay 3-tier cascade + Terapeak ingestion / lookup; cites terapeak-runbook, pool-isolation contract, INC-001/002/004/011/013 |

## PR Workflow

Canonical workflow: see [`.github/skills/workflow/SKILL.md`](../../.github/skills/workflow/SKILL.md).

Summary (the SKILL is authoritative; this is a pointer):

1. Create feature branch from latest `main`
2. Make changes (read hot-file INC mapping in
   [`.github/skills/process-discipline/SKILL.md`](../../.github/skills/process-discipline/SKILL.md)
   before editing any flagged surface)
3. Run **Pre-commit Reviewer** (`@pre-commit-reviewer` or `/pre-commit`)
4. Commit (no `--no-verify` reflex)
5. For material architecture/API/data/operations/environment/customization/user-facing
   workflow changes, run Onboard acceptance against that exact commit; use a
   reviewer-approved documented no-impact exemption only for typo/formatting-only
   or non-behavioral metadata work
6. Push (`unset GITHUB_TOKEN GH_TOKEN`
   first in Codespace)
7. Open PR using `.github/pull_request_template.md`
8. For M / L tier: run `/review-deep` and present its synthesized findings
9. Wait for every required CI check to complete successfully, then after user
   approval merge normally. `--admin` requires explicit approval and a
   documented reason; it is never a shortcut around queued checks.
10. Complete post-merge bookkeeping: update local `main`, prune deleted refs,
    and ensure the backlog status was flipped in the implementing PR (or use a
    follow-up PR if it was missed).

Carve-out: `docs/WASTE-LEDGER.md` postmortem entries referencing
already-merged or already-closed PRs may commit direct to `main` (see
workflow SKILL "WASTE-LEDGER Carve-Out" for constraints).

## Doc-Coverage Gate (added 2026-06-22)

Every PR must update documentation in the same change set when it touches a
matching code surface, OR include an explicit no-doc justification. The
expectation is enforced in three places:

1. **`.github/pull_request_template.md`** -- Documentation section with a
   checklist of doc surfaces and a required justification field.
2. **`CONTRIBUTING.md`** -- "Documentation Expectations" section with the
   full code-surface to doc-surface mapping table.
3. **`.github/agents/pre-commit-reviewer.agent.md`** -- Documentation
   Coverage check (Step 2.G) that inspects staged paths and BLOCKS when a
   matching doc was not also updated.

When adding a new file under `docs/memory/` or `docs/runbooks/`, also
register it in:

- `.github/agents/onboard.agent.md` (Phase 1 or Phase 2 read list)
- `docs/memory/README.md` (corpus index)
- this file (if it documents an agent / prompt / skill)

## Invocation Note

These agents are workspace-scoped (`.github/agents/`) and registered by their
frontmatter `name:` values. Tool restrictions must use capability aliases such
as `read`, `search`, `edit`, `execute`, `todo`, and `agent`; concrete runtime
tool IDs can silently resolve to no tools in custom-agent frontmatter.

To invoke them:

- **From VS Code chat**: use `@agent-name` (the `name:` field from frontmatter)
- **From a top-level agent/prompt**: invoke the registered frontmatter name
- **Nested delegation**: do not depend on an agent launched as a subagent to
   launch more subagents; keep orchestration in the top-level prompt
- **Via slash command**: see the Prompts table above

