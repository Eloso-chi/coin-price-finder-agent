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

When behavior, architecture, or workflows change, update docs in the same PR:

- README.md for user/dev-facing behavior and setup
- docs/ARCHITECTURE.md for module/data-flow details
- .github/agents/onboard.agent.md when onboarding instructions drift
- docs/BACKLOG.md and docs/BACKLOG.rules.md when backlog governance or status changes

## Security Reporting

A dedicated SECURITY.md policy is recommended. Until that file exists, report vulnerabilities privately to project maintainers and do not open public exploit details in issues or PRs.

## Licensing

All code and documentation are proprietary. See [LICENSE](LICENSE) for terms. Key points:

- **Public GitHub visibility ≠ license grant.** Being able to read the code does not permit use, distribution, modification, or deployment.
- **No forking or redistribution.** Cloning the repo for study/feedback is encouraged; forking and republishing is not permitted without written consent.
- **Internal contributors:** You have implicit use rights for work on this project. Do not assume rights to use code in other projects without asking.

See package.json `"license": "UNLICENSED"` for alignment.
