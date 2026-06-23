## Summary

<!-- One-sentence description of what this PR does. -->

## Backlog Reference

<!-- REQUIRED: Link to the backlog item(s) this PR addresses. -->
<!-- Format: docs/BACKLOG.md#section-name or item number. -->
<!-- New items from #264W onward use a W/H suffix; see docs/BACKLOG.rules.md. -->
<!-- Examples: bare-number #171 (grandfathered), #265W (Codespace), #260H (home). -->

- Backlog item:
- Status change: <!-- e.g. "Planned -> Done", "New item proposed", "N/A (explain below)" -->

## Backlog Update

<!-- Check one: -->
- [ ] `docs/BACKLOG.md` updated to reflect this PR
- [ ] No backlog update needed (justification below)

<!-- If no update: explain why. -->

## Changes

<!-- Bullet list of what changed. Keep it concise. -->

-

## Testing

<!-- How was this verified? -->

- [ ] Existing tests pass (`npm test`)
- [ ] New tests added (describe)
- [ ] Manual verification (describe)

## Documentation

<!-- REQUIRED: every PR must either update docs or explicitly justify why not. -->
<!-- See CONTRIBUTING.md "Documentation Expectations" for the full mapping. -->
<!-- Tick every doc surface this PR updates. Tick "No documentation update needed" -->
<!-- ONLY if none of the surfaces below are affected. -->

- [ ] `README.md` (user/dev-facing behavior, setup, env vars)
- [ ] `docs/ARCHITECTURE.md` (module map, data flow, schemas)
- [ ] `docs/api-reference.md` (HTTP endpoint surface)
- [ ] `docs/data-dictionary.md` (data stores, schemas, classifications)
- [ ] `docs/memory/*.md` (long-lived corpus knowledge)
- [ ] `docs/runbooks/*.md` (operational procedures)
- [ ] `.github/agents/onboard.agent.md` (onboard read list / Phase order)
- [ ] `docs/memory/agents-and-prompts.md` (agent/prompt/skill inventory)
- [ ] `docs/BACKLOG.md` / `docs/BACKLOG.rules.md` (backlog governance or status)
- [ ] `SECURITY.md` (auth, middleware, audit, secrets, OWASP-relevant changes)
- [ ] Other (specify):
- [ ] No documentation update needed

### Justification (required if "No documentation update needed" is checked)

<!-- Explain why no docs change is warranted. Trivial test-only changes, -->
<!-- pure refactors with no behavior change, and dependency bumps are -->
<!-- common valid reasons. Spell it out so the reviewer can confirm. -->
<!-- -->
<!-- IMPORTANT: do NOT tick BOTH a doc-surface box AND "No documentation -->
<!-- update needed". Pick one. Reviewers will reject contradictory ticks. -->



## Risk & Rollback

<!-- What could go wrong? How to revert? -->

- Risk:
- Rollback:

## Review Gates

<!-- Per `.github/skills/workflow/SKILL.md` tiered execution model. -->
<!-- Pick ONE tier. Reviewers may upgrade; do not downgrade without author concurrence. -->

- Tier (pick one):
  - [ ] **XS** -- pure cleanup, zero behavioral change (pre-commit only)
  - [ ] **S** -- single-file doc / non-load-bearing agent tweak (pre-commit + self-review)
  - [ ] **M** -- multi-file change affecting agent behavior, SKILL content, source services (pre-commit + deep review)
  - [ ] **L** -- schema change, route signature change, migration, auth or money (pre-commit + deep review + targeted sub-reviews + manual smoke)

- Gates run:
  - [ ] Pre-commit reviewer (`@pre-commit-reviewer`) -- report attached or PASS confirmed
  - [ ] Deep review (`@code-reviewer.approval-gated`) -- required for M / L; report attached
  - [ ] `@numismatic-audit` Step 5b -- required if PR touches pool-isolation surfaces (ebayService classifyGradeType / applyFilters, valuationService pool selection)
  - [ ] Tests pass (`npm test`)
  - [ ] No `--no-verify` (or active hooks verified absent)
