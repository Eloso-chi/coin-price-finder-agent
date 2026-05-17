# Code Review Skill

Shared review framework used by all code review agents. This skill is
**read-only guidance** -- it must never instruct editing files.

---

## 1. Change Intent Validation

Before evaluating quality, verify that the change matches its stated purpose:

- What was the intent? (commit message, PR title, linked issue)
- Does every touched file contribute to that intent?
- Are there unrelated changes mixed in? Flag them.
- Does the change do more or less than intended?

## 2. Correctness & Safety

Review each changed file for:

| Check | What to look for |
|-------|------------------|
| Edge cases | Null/undefined, empty arrays, zero/negative values, boundary conditions |
| Error handling | Uncaught exceptions, missing try/catch, swallowed errors, incorrect error types |
| Concurrency | Race conditions, shared mutable state, async ordering assumptions |
| Data integrity | Lost writes, partial updates, inconsistent state between stores |
| Input validation | Unsanitized user input, missing bounds checks, type coercion surprises |
| Backward compat | Changed APIs, renamed exports, altered schemas without migration |

## 3. Security Review Heuristics

Apply OWASP Top 10 thinking to every change:

- **Injection** -- SQL, XSS, command injection, template injection, SSRF
- **Auth/access** -- bypassed checks, privilege escalation, missing authorization
- **Secrets** -- hardcoded keys, tokens, credentials, PII in logs or error messages
- **Crypto** -- weak algorithms, short keys, predictable IVs, timing attacks
- **Dependencies** -- new packages (check advisories), pinned versions, supply chain
- **Client-side** -- DOM XSS, unsafe innerHTML, eval, postMessage without origin check

## 4. Performance Review Heuristics

- **Algorithmic** -- O(n^2) or worse on user-controlled input, unnecessary iterations
- **Memory** -- unbounded caches, large object retention, leaked event listeners
- **I/O** -- sequential calls that could be parallel, missing timeouts, no backpressure
- **Caching** -- cache misses on hot paths, stale data served beyond TTL, no invalidation
- **Rendering** -- unnecessary re-renders, layout thrashing, DOM size growth

## 5. Testing Readiness

- Are new code paths covered by tests?
- Are edge cases from section 2 tested?
- If a bug was fixed, is there a regression test?
- Do existing tests still cover refactored code?
- Are test assertions strong (`.toEqual`, not `.toBeDefined()`)?
- Suggest verification commands (`npm test`, targeted suite runs).

## 6. Maintainability

- **Dead code** -- unused exports, unreachable branches, orphan files, commented-out blocks, functions with zero call sites, routes never hit
- **Duplication** -- repeated logic that should be extracted
- **Naming** -- unclear variable/function names, misleading identifiers
- **Complexity** -- deeply nested conditionals, functions > 50 lines, magic numbers
- **Boundaries** -- responsibilities leaking across modules, tight coupling
- **Documentation** -- missing JSDoc on exported functions, outdated comments

## 7. Operability

- **Logging** -- silent failures, missing error context, excessive debug logging
- **Observability** -- no way to tell if a feature is working in production
- **Configuration** -- magic numbers that should be env vars, config drift between envs
- **Graceful degradation** -- does the system handle partial failures (API down, cache miss)?

---

## Severity Levels

| Level | Label | Meaning |
|-------|-------|---------|
| S1 | **Critical** | Security vulnerability, data loss, crash, or silent corruption. Must fix before merge. |
| S2 | **High** | Bug that will affect users, missing error handling on likely paths, broken backward compat. Should fix before merge. |
| S3 | **Medium** | Code smell, missing test, performance concern, maintainability issue. Should fix soon. |
| S4 | **Low** | Style nit, naming suggestion, minor improvement. Fix if convenient. |

## Confidence Levels

| Level | Meaning |
|-------|---------|
| **High** | Reviewer is certain this is a real issue. Evidence in code or docs. |
| **Medium** | Reviewer believes this is likely an issue but acknowledges possible justification. |
| **Low** | Reviewer suspects a potential issue but needs more context to confirm. |

---

## Finding Schema

Every finding must follow this structure:

```
### [S{1-4}] {Title} (Confidence: {High|Medium|Low})

**File:** `path/to/file.ext` (lines N-M)
**Category:** {Correctness|Security|Performance|Testing|Maintainability|Operability}
**Description:** What is wrong and why it matters.
**Suggestion:** How to fix it (without writing the actual code).
```

---

## Report Structure

The final Code Review Report must use this outline:

1. **Summary** -- one paragraph: what changed, overall assessment, critical count
2. **Change Intent** -- restate intent, confirm alignment
3. **Critical & High Findings** (S1 + S2) -- sorted by severity
4. **Medium & Low Findings** (S3 + S4) -- sorted by severity
5. **Testing Gaps** -- missing tests, suggested test cases
6. **Positive Observations** -- things done well (acknowledge good work)
7. **APPLY Candidates** -- numbered list of actionable items for the Implementer

The APPLY Candidates list uses sequential numbers (1, 2, 3...) and each item
references the finding it addresses. The user selects items by number to approve.
