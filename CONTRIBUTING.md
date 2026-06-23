# Contributing

Thanks for contributing to coin-price-finder-agent.

This guide is the contributor workflow reference. For architecture and product behavior, see README.md and docs/ARCHITECTURE.md.

## Prerequisites

- Node.js 22+
- npm
- Git
- Access to required environment variables in .env (see README.md and docs/runbooks/secret-bootstrap.md)

## Local Setup

1. Clone the repository.
2. Install dependencies:

   npm install

3. Start the app locally:

   npm run dev

4. Run tests:

   npm test

## Core Development Rules

- Module system is CommonJS (require and module.exports).
- Keep changes consistent with existing file style.
- Do not expose secrets, tokens, API keys, or PII in code, docs, tests, or commits.
- Validate and sanitize external inputs.
- Do not make destructive or hard-to-reverse infra changes without explicit approval.

## Testing Requirements

- Canonical command: npm test (jest --verbose).
- Run tests after every code change and before opening a PR.
- Do not delete tests to make failures disappear.
- Do not weaken assertions (for example replacing precise equality assertions with vague existence checks).
- Do not skip tests (test.skip, xtest, xit).
- Do not add blanket retries to mask flakiness.
- Fix flaky tests at root cause (determinism, isolation, time control).
- Mock HTTP calls in tests using axios-mock-adapter. Do not make live network calls from tests.

## Branching and Backlog IDs

Backlog is authoritative in docs/BACKLOG.md.

For new backlog entries from #264 onward, IDs are per-machine:

- W for Codespace/work environment
- H for home workstation

Before adding a backlog item:

1. Run scripts/machine-id.sh (or bash scripts/machine-id.sh on PowerShell with Git Bash/WSL).
2. If missing, follow its one-time setup message to create .machine-id.
3. Do not guess the machine letter.
4. Select next number in your machine series per docs/BACKLOG.rules.md.

Recommended branch naming:

- feat/<id><suffix>-short-topic
- fix/<id><suffix>-short-topic
- docs/<id><suffix>-short-topic

Example:

- docs/278H-doc-sync-services-routes-tests

## Pull Request Process

**Never commit directly to `main`.** Every change -- code, docs, config,
agents, skills, tests, data, schemas -- goes through a feature branch + PR.
The canonical workflow lives in
[.github/skills/workflow/SKILL.md](.github/skills/workflow/SKILL.md)
(tiered execution model, 8-step lifecycle, author checklist).

The only carve-out is `docs/WASTE-LEDGER.md` postmortem entries that
reference an already-merged or already-closed PR / branch -- see the
"WASTE-LEDGER Carve-Out" section of the workflow SKILL for the
constraints. All other doc changes (BACKLOG, runbooks, memory docs,
CONTRIBUTING itself) follow the full workflow.

Every PR must do at least one of the following:

- Reference an existing backlog item
- Propose a new backlog item
- Update backlog status
- Explicitly justify why no backlog update is needed

Before requesting merge:

1. Fetch latest main and rebase your branch:
   ```bash
   git fetch origin
   git rebase origin/main
   # If conflicts arise, resolve them, then:
   git add .
   git rebase --continue
   ```
2. Ensure tests pass locally: `npm test`
3. Fill PR template completely.
4. Summarize changed files and risk.

## Required Reviews

Use project review prompts/agents:

- /pre-commit for a fast safety pass
- /review-deep for approval-gated full review
- /test-coverage for missing test analysis
- /ux-reviewer when UI changes are included

Important threshold:

- Any PR that adds or modifies more than 5 test files must run /review-deep before merge, even if no production code changed.

## Documentation Expectations

Every PR must update documentation in the same change set when it touches the
matching code surface, OR include an explicit no-doc justification in the PR
template's Documentation section. This is enforced by the PR template
checklist and by the Pre-commit Reviewer agent.

Use the following mapping to decide which doc surfaces are affected:

| Code change | Doc surface(s) to update |
|---|---|
| New or changed route (`src/routes/`) | `docs/api-reference.md`; `README.md` routes table if user-facing |
| New or changed service contract (`src/services/`) | `docs/ARCHITECTURE.md`; `docs/memory/codebase-overview.md` if structure shifts |
| Data model, schema, or storage layout (`src/data/`, `src/schemas/`, `data/**`) | `docs/data-dictionary.md` |
| Terapeak / CSV format or import behavior | `docs/memory/terapeak-data-structure-analysis.md`; `docs/memory/terapeak-runbook.md` |
| Azure infra (Cosmos, Key Vault, Blob, Files) | `docs/memory/azure-infrastructure.md`; relevant `docs/runbooks/*.md` |
| New environment variable | `README.md` env table; `docs/ARCHITECTURE.md` if it shapes data flow |
| New operational procedure | `docs/runbooks/*.md`; link from `README.md` if user-facing |
| New or changed agent / prompt / skill | `docs/memory/agents-and-prompts.md` AND `.github/agents/onboard.agent.md` (Phase 2 read list) |
| New top-level file under `docs/memory/` or `docs/runbooks/` | `.github/agents/onboard.agent.md` (read list) AND `docs/memory/README.md` (index) |
| Backlog item or backlog governance | `docs/BACKLOG.md` / `docs/BACKLOG.rules.md` (already gated by Backlog section) |
| Public API response shape | `docs/api-reference.md`; `docs/data-dictionary.md` |
| Security policy, auth, or audit behavior | `SECURITY.md`; `docs/ARCHITECTURE.md` |

Drift is a real cost on this project: stale docs mislead future contributors
and onboarded agents. When in doubt, update the doc -- a few lines is cheaper
than the next reader's confusion.

### When adding a new doc file

If you create a new file under `docs/memory/` or `docs/runbooks/`, you must
also:

1. Register it in `.github/agents/onboard.agent.md` (Phase 1 or Phase 2 read
   list) so onboarded agents discover it.
2. Reference it from `docs/memory/README.md` (corpus index).
3. Add a one-line entry to `docs/memory/agents-and-prompts.md` if it documents
   an agent, prompt, or skill.

## Security Reporting

Use [SECURITY.md](SECURITY.md) for the official vulnerability reporting process.

- Report privately via GitHub Security Advisory (preferred) or maintainer contact listed there.
- Do not post exploit details publicly before a fix is available.

## Licensing

All code and documentation are proprietary. See [LICENSE](LICENSE) for terms. Key points:

- **Public GitHub visibility ≠ license grant.** Being able to read the code does not permit use, distribution, modification, or deployment.
- **No forking or redistribution.** Cloning the repo for study/feedback is encouraged; forking and republishing is not permitted without written consent.
- **Internal contributors:** You have implicit use rights for work on this project. Do not assume rights to use code in other projects without asking.

See package.json `"license": "UNLICENSED"` for alignment.
