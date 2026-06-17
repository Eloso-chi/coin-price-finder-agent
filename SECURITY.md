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

Out of scope (unless a maintainers-approved exception exists):

- Social engineering, phishing, or physical attacks
- Denial-of-service requiring unrealistic resources
- Reports without a reproducible technical finding
- Issues in third-party services with no project-controlled impact

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
