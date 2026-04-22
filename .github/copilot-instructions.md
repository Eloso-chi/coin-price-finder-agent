# Copilot Workspace Instructions

## Testing Rules

- The canonical test command is `jest --verbose` (via `npm test`).
- All test files live in `__tests__/*.test.js`. Shared helpers go in `__tests__/helpers/`.
- Mock HTTP calls with `axios-mock-adapter` -- never make real network requests in tests.
- **Never delete tests.**
- **Never reduce assertion strength** (e.g., replacing `.toEqual` with `.toBeDefined()`).
- **Never skip tests** to hide failures (`test.skip`, `xtest`, `xit`).
- **Never add blanket `jest.retryTimes()`** to mask flakiness.
- Fix flaky tests by addressing root cause (determinism, isolation, time control).
- Run `npm test` after every code change and confirm zero failures before committing.

## Safety

- Never expose secrets, tokens, API keys, or PII. Use placeholder data in tests and docs.
- Validate and sanitize external inputs. Follow OWASP Top 10 principles.
- Ask before deleting files, modifying shared infrastructure, or making hard-to-reverse changes.

## Conventions

- Module system: CommonJS (`require` / `module.exports`).
- No build step -- Express serves `public/` as static files.
- Use ASCII-safe characters only (no Unicode em dashes or en dashes).
- Keep code style consistent with existing patterns in the file being edited.

## Code Review

- Use `/review-deep` for a full approval-gated code review.
- Use `/apply-approved` to implement approved findings.
- Use `/pre-commit` for a quick safety check before committing.
- Use `/test-coverage` to analyze test gaps and generate missing tests.
- Review agents are read-only. The Implementer only acts on explicit `APPLY` commands.
- Use the UX Reviewer agent for accessibility, responsive design, and interaction pattern checks on UI changes.
- Shared review logic lives in `.github/skills/code-review/SKILL.md`.

## Copilot Agents & Prompts

| Agent / Prompt | Purpose |
|----------------|---------|
| `@code-reviewer` | Full approval-gated code review (conductor) |
| `@security-review` | OWASP-focused security sub-reviewer |
| `@performance-review` | Performance bottleneck sub-reviewer |
| `@implementer` | Applies only user-approved review items |
| `@pre-commit-reviewer` | Quick pre-commit safety check |
| `@test-coverage` | Test gap analysis + test generation |
| `@test-monitor` | Test health monitoring and diagnostics |
| `@ux-reviewer` | Accessibility, responsive, interaction review |
| `@onboard` | Project onboarding assistant |
| `/review-deep` | Invoke full code review |
| `/apply-approved` | Implement approved findings |
| `/pre-commit` | Quick pre-commit check |
| `/test-coverage` | Analyze and fill test gaps |
| `/onboard` | Bootstrap project understanding |

## Onboarding

- Use `/onboard` at the start of a new conversation to bootstrap full project understanding.
- Reads all repo memory files, architecture docs, and key source file exports.
- Produces a Readiness Report confirming what was learned.
