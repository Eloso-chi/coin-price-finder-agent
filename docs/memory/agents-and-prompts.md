# Agents & Prompts Inventory

> This file is the canonical inventory of agents, prompts, and skills shipped
> in `.github/`. It is read by the **Onboard** agent during Phase 1 so the agent
> knows what tools are available.
>
> Updated 2026-06-17 as part of the memory-corpus migration
> (`docs/memory-corpus-migration` branch). A non-authoritative copy lives at
> `/memories/repo/agents-and-prompts.md` on the W (Codespace) machine; that
> copy may drift and should not be edited directly.

All files live in `.github/agents/`, `.github/prompts/`, and `.github/skills/`.
The `.github` directory is hidden -- use explicit paths.

## Agents

| Agent File | Name | Mode | Purpose |
|---|---|---|---|
| `code-reviewer.approval-gated.agent.md` | Code Reviewer | Read-only | Deep multi-agent review (delegates to Security + Performance sub-agents). Produces structured report. Waits for `APPLY <N>` before any edits. |
| `pre-commit-reviewer.agent.md` | Pre-commit Reviewer | Read-only | Fast staged-changes review: secrets scan, test pass, data model sync. BLOCK/WARN severity. |
| `implementer.approval-only.agent.md` | Implementer | Write | Applies ONLY explicitly approved findings from Code Review Report. Minimal diffs. |
| `onboard.agent.md` | Onboard | Read-only | Bootstraps full project context (reads `docs/memory/`, docs, key source files). |
| `sales-aggregator.agent.md` | Sales Aggregator | Mixed | Manages Terapeak data pipeline: dashboard, freshness, batch runs. |
| `freshness-triage.agent.md` | Freshness Triage | Read-only | Generates freshness report, presents prioritized triage. |
| `pricing-health.agent.md` | Pricing Health | Read-only | End-to-end pricing flow validation, comp attrition audit, cross-route FMV comparison. |
| `numismatic-audit.agent.md` | Numismatic Audit | Read-only | Audits classification/filter functions against `.github/skills/numismatics/SKILL.md` ground truth. Catches grade/finish/pool misclassification (e.g. Proof-Like as Proof, Burnished into proof pool, raw into graded pool). |
| `test-coverage.agent.md` | Test Coverage Engineer | Write | Identifies behavioral gaps, writes new tests using existing helpers. |
| `test-monitor.agent.md` | Test Monitor | Write | Test health monitoring, flaky diagnosis, slow test optimization. |
| `ux-reviewer.agent.md` | UX Reviewer | Read-only | WCAG 2.2 AA, responsive design, dark theme, Nielsen heuristics. |
| `security-review.sub.agent.md` | Security Reviewer | Read-only (sub) | OWASP Top 10, injection, auth bypass, secrets exposure. Called by Code Reviewer. |
| `performance-review.sub.agent.md` | Performance Reviewer | Read-only (sub) | Bottlenecks, memory, caching, algorithmic efficiency. Called by Code Reviewer. |

## Prompts (slash commands)

| File | Invocation | Purpose |
|---|---|---|
| `pre-commit.prompt.md` | `/pre-commit` | Trigger pre-commit reviewer |
| `review-deep.prompt.md` | `/review-deep` | Trigger deep code reviewer |
| `apply-approved.prompt.md` | `/apply-approved` | Trigger implementer for approved findings |
| `onboard.prompt.md` | `/onboard` | Trigger onboarding agent |
| `pricing-health.prompt.md` | `/pricing-health` | Trigger pricing health check |
| `test-coverage.prompt.md` | `/test-coverage` | Trigger test coverage analysis |

## Skills

| Path | Purpose |
|---|---|
| `.github/skills/code-review/SKILL.md` | Shared review framework (severity defs, finding schema, report structure) |
| `.github/skills/numismatics/SKILL.md` | Domain knowledge: classification decision tree, finish detection, audit checklist |
| `.github/skills/testing/TESTING-PLAN.md` | Testing standards, batch plan, coverage targets |

## PR Workflow (from operating-rules.md)

1. Create feature branch
2. Make changes
3. Run **Pre-commit Reviewer** (via `/pre-commit` or invoking agent directly)
4. Create PR
5. Run **Code Reviewer** (via `/review-deep` or invoking agent directly)
6. Present findings to user for approval
7. If approved, run **Implementer** (via `/apply-approved`)

## Doc-Coverage Gate (added 2026-06-22)

Every PR must update documentation in the same change set when it touches a
matching code surface, OR include an explicit no-doc justification. The
expectation is enforced in three places:

1. **`.github/pull_request_template.md`** -- Documentation section with a
   checklist of doc surfaces and a required justification field.
2. **`CONTRIBUTING.md`** -- "Documentation Expectations" section with the
   full code-surface to doc-surface mapping table.
3. **`.github/agents/pre-commit-reviewer.agent.md`** -- Documentation
   Coverage check (Step 2.G) that inspects staged paths and WARNs when a
   matching doc was not also updated.

When adding a new file under `docs/memory/` or `docs/runbooks/`, also
register it in:

- `.github/agents/onboard.agent.md` (Phase 1 or Phase 2 read list)
- `docs/memory/README.md` (corpus index)
- this file (if it documents an agent / prompt / skill)

## Invocation Note

These agents are workspace-scoped (`.github/agents/`). They are NOT listed in
the `<agents>` system prompt section -- only `Explore` (a built-in subagent) is.
To invoke them:

- **From VS Code chat**: use `@agent-name` (the `name:` field from frontmatter)
- **From a subagent call**: pass the agent's full prompt body to `Explore` as a
  delegated task, since `runSubagent` only recognizes `Explore` by default
- **Via slash command**: see the Prompts table above

