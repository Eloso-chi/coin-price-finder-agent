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

## 8. Domain Correctness (added under #271W F4 after INC-013)

Many bugs in this codebase do not violate generic correctness, security, or performance heuristics -- they violate **domain contracts** that only exist in the canonical memory docs and skills. Reviewing without first loading the governing doc means missing this class entirely. INC-013 ($10.03, see `docs/WASTE-LEDGER.md`) is the canonical example: PR #154 passed sections 1-7 cleanly but violated the pool-isolation contract documented in `docs/memory/numismatic-terminology.md`.

| Subsystem | Governing doc(s) | Common violations to look for |
|-----------|-----------------|---------------------|
| Pool classification / FMV | `docs/memory/numismatic-terminology.md`, `.github/skills/numismatics/SKILL.md` ("MANDATORY: Pool-Isolation Contract") | Merging raw + graded + proof pools; treating `prefilterStrikeSplit` as a metric to minimize; weight thresholds gating cross-pool blending; pool fallback that silently blends instead of setting `dataSource` + downgrading `confidence` |
| Terapeak data | `docs/memory/terapeak-data-structure-analysis.md`, `docs/memory/terapeak-runbook.md`, `docs/WASTE-LEDGER.md` INC-001 + INC-011 | CSV overwrite instead of merge; missing shrink guard; reading deep-paginated counts as small; backfill scripts without integration tests |
| Disk writes under test | `docs/WASTE-LEDGER.md` INC-002 | Disk-write functions not guarded by `NODE_ENV === 'test'`; debounce timers writing after `afterAll()` restores state |
| Audience gating | `docs/memory/audience-gating.md` | Leaking admin-only fields into public responses; not applying `redactForPublic`; response-shape changes that bypass the gating layer |
| Cache & freshness | `docs/memory/cache-invalidation-fix.md`, `src/services/freshnessClassifier.js` | Serving stale data past TTL; missing eviction on key rotation; freshness skip logic that diverges between admin route and CLI report |
| Background processes | `docs/memory/background-processes-status.md`, `docs/WASTE-LEDGER.md` INC-003 | Foreground server starts that block terminals; background timers that fire after the conversation ends |
| Branch protection / PR workflow | operating-rules.md (PR Workflow), `docs/WASTE-LEDGER.md` INC-008, INC-013 rule #18 | Direct commits to `main` outside the WASTE-LEDGER carve-out; reverts treated as exempt from review; `--no-verify` reflex when no hooks are even configured |

**Rules for a Category 8 finding:**

1. Cite the doc + section that defines the contract being violated. A finding without a doc citation is NOT a Domain Correctness finding -- it belongs in one of sections 1-7.
2. Explain what part of the staged change violates the contract, in the contract's vocabulary (not generic terms).
3. If the relevant doc is missing or out of date, raise it as a Maintainability finding ("missing governing doc for subsystem X") rather than skipping the review.
4. Domain Correctness findings default to severity S1 or S2 (contract violations have caused real incidents -- see WASTE-LEDGER) unless the reviewer can articulate why a specific instance is lower severity.

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
**Category:** {Correctness|Security|Performance|Testing|Maintainability|Operability|Domain Correctness}
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
