# Security Policy

## Purpose

This document explains how to report security vulnerabilities for this repository safely and privately.

Do not disclose security issues publicly before maintainers have had time to investigate and ship a fix.

## Reporting a Vulnerability

Use one of the private channels below:

1. Preferred: GitHub Security Advisory (private report)
   - Repo -> Security -> Advisories -> Report a vulnerability
2. Fallback: contact project maintainers directly through a private channel used by this project team

Do not open a public GitHub issue for active vulnerabilities.

## What to Include in Your Report

Please include as much of the following as possible:

- A clear summary of the issue
- Affected component(s), file path(s), or endpoint(s)
- Severity estimate (if known)
- Reproduction steps (minimal, deterministic)
- Proof of concept (sanitized)
- Impact assessment (data exposure, auth bypass, injection, privilege escalation, etc.)
- Suggested mitigation or patch idea (optional)

Do not include real secrets, tokens, or personal data in reports.

## Response Timeline (Targets)

Maintainers aim to:

- Acknowledge report receipt within 3 business days
- Complete initial triage within 7 business days
- Provide status updates at least every 7 business days while open
- Ship or plan a fix based on severity and operational risk

These are targets, not guarantees.

## Disclosure Policy

- Use coordinated disclosure.
- Do not publish exploit details before a fix or mitigation is available.
- After remediation, maintainers may publish a summary advisory and credit the reporter (if requested).

## Scope

In scope:

- Repository source code and scripts
- API endpoints exposed by the app
- Authentication and authorization paths
- Input validation, injection risks, SSRF, XSS, CSRF, auth bypass, and sensitive data exposure
- Dependency and supply chain issues with practical exploitability

Authentication forms perform client-side missing-field and password-length
checks for accessible error recovery, including field-specific invalid state
and focus. These checks are usability safeguards only: server-side auth routes
remain authoritative for credential validation, authorization, normalization,
rate limiting, and error responses. Ambiguous credential failures are exposed
as form-level errors so the client does not disclose which credential failed.

Out of scope (unless a maintainers-approved exception exists):

- Social engineering, phishing, or physical attacks
- Denial-of-service requiring unrealistic resources
- Reports without a reproducible technical finding
- Issues in third-party services with no project-controlled impact

## AI Pricing Security Boundaries

The internal AI pricing surface is server-controlled and does not grant the
model arbitrary application access:

- The Phase 1 model tool registry exposes only `identify_coin`, `price_coin`,
   and `evaluate_purchase`. Collection, market, history, bulk, administrative,
   mutation, OpenAPI, and MCP tools are not available to the orchestrator.
- Model-produced root and nested arguments are allowlisted and type/bounds
   validated before deterministic services execute. Unknown fields, trusted
   context, user identity, admin status, provider settings, and explicit null
   optional fields are rejected.
- Bullion special marks use registry-backed IDs with a one-mark request limit,
   strict nested-object shape validation, and bounded context fields. Unlisted
   mark text remains length- and character-restricted and cannot inherit a
   registered issue premium. The public registry lookup is read-only and
   protected by the global request limiter.
- Collection context uses only the verified JWT user ID. Caller- or model-
   supplied user IDs cannot select another user's records.
- Deterministic services calculate all numerical results. Numerical LLM
   explanations without matching valuation or purchase-decision evidence are
   rejected; user text, listing titles, notes, and tool arguments are treated
   as untrusted content for prompt-injection purposes.
- Public response redaction runs before restricted comp provenance reaches the
   model or browser. Provider credentials remain server-side and Azure OpenAI
   is disabled unless explicitly configured.
- Public Terapeak lookup responses strip internal product identity and cohort
   metadata. Live Terapeak writers and offline identity migration share an
   ownership-aware lock; dead writer locks are PID-recovered, active migration
   locks fail closed, and successful apply requires restart before writes resume.
- Provider calls and tools have bounded turns, timeouts, input/context limits,
   concurrency limits, request IDs, and deterministic fallback behavior when
   the provider is disabled or unavailable.

Report suspected AI authorization bypass, prompt injection leading to tool
access, cross-user collection access, sensitive-data exposure, or fabricated
financial output through the private channels above. Do not include real
prompts containing personal data, credentials, tokens, or licensed raw data.

## Safe Harbor

If you act in good faith, avoid privacy violations/destructive testing, and report promptly through private channels, maintainers will treat your research as authorized for this policy's scope.

## Secrets and Sensitive Data Handling

- Never commit credentials, API keys, tokens, or private customer/user data.
- Use placeholders in tests and documentation.
- If a secret leak is suspected, report immediately and rotate affected credentials.

## Related References

- `README.md`
- `CONTRIBUTING.md`
- `.github/copilot-instructions.md`
