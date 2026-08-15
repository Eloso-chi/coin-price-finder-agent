# Repository Agents

Project-specific Copilot agents live in [`.github/agents/`](.github/agents/).
See [`docs/memory/agents-and-prompts.md`](docs/memory/agents-and-prompts.md)
for the canonical inventory, invocation guidance, prompts, skills, and PR
workflow.

| Agent | Purpose | Definition |
|---|---|---|
| Code Reviewer | Approval-gated correctness and maintainability review | [`.github/agents/code-reviewer.approval-gated.agent.md`](.github/agents/code-reviewer.approval-gated.agent.md) |
| Freshness Triage | Prioritize stale, thin, and missing Terapeak datasets | [`.github/agents/freshness-triage.agent.md`](.github/agents/freshness-triage.agent.md) |
| Implementer | Apply only explicitly approved review findings | [`.github/agents/implementer.approval-only.agent.md`](.github/agents/implementer.approval-only.agent.md) |
| Numismatic Audit | Check classification and filtering against numismatic rules | [`.github/agents/numismatic-audit.agent.md`](.github/agents/numismatic-audit.agent.md) |
| Onboard | Bootstrap repository architecture, rules, and operational context | [`.github/agents/onboard.agent.md`](.github/agents/onboard.agent.md) |
| Performance Reviewer | Review performance, caching, memory, and I/O risks | [`.github/agents/performance-review.sub.agent.md`](.github/agents/performance-review.sub.agent.md) |
| Pre-commit Reviewer | Check staged changes for regressions, secrets, and missing tests | [`.github/agents/pre-commit-reviewer.agent.md`](.github/agents/pre-commit-reviewer.agent.md) |
| Pricing Health | Validate pricing routes, FMV consistency, and comp attrition | [`.github/agents/pricing-health.agent.md`](.github/agents/pricing-health.agent.md) |
| Sales Aggregator | Manage Terapeak collection priorities and batch runs | [`.github/agents/sales-aggregator.agent.md`](.github/agents/sales-aggregator.agent.md) |
| Security Reviewer | Review OWASP, authentication, secret, and supply-chain risks | [`.github/agents/security-review.sub.agent.md`](.github/agents/security-review.sub.agent.md) |
| Terapeak Operator | Run the canonical guarded Terapeak startup workflow | [`.github/agents/terapeak-operator.agent.md`](.github/agents/terapeak-operator.agent.md) |
| Test Coverage Engineer | Find behavioral coverage gaps and add focused tests | [`.github/agents/test-coverage.agent.md`](.github/agents/test-coverage.agent.md) |
| Test Monitor | Diagnose flaky or slow tests and track suite health | [`.github/agents/test-monitor.agent.md`](.github/agents/test-monitor.agent.md) |
| UX Reviewer | Review accessibility, responsive behavior, and interaction design | [`.github/agents/ux-reviewer.agent.md`](.github/agents/ux-reviewer.agent.md) |

Reusable slash commands are under [`.github/prompts/`](.github/prompts/), and
shared workflow and domain knowledge is under [`.github/skills/`](.github/skills/).