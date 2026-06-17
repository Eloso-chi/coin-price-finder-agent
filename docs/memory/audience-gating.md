# Audience Gating (Public vs Admin) — PR #85

Shipped 2026-06-02 (commit `bf9fce5`). Redacts Terapeak provenance from
non-admin API responses so dealer/legal-sensitive labels don't leak.

## Why
Terapeak comps had `_source: "terapeak"` exposed to anonymous callers.
Compliance risk + competitive intel leak. Public callers now see
`_source: "ebay-sold"` instead; admins still see real `"terapeak"`.

## Surface area (5 routes wired)
- `src/routes/priceRoute.js` (final `res.json` wrapped)
- `src/routes/barPriceRoute.js`
- `src/routes/pricingBatchRoute.js`
- `src/routes/bulkEvaluateRoute.js` — SSE `/stream` + GET `/:jobId` poll + `_runJob`
- `src/routes/coinHistoryRoute.js` — 2 hardcoded `source` literals rewritten

## Mechanism: `src/utils/redactForPublic.js`
- Exports `{ redactCompsForPublic }`. No-op when `isAdmin === true`.
- Walks `response.ebay.{us,global}.comps[]` (single) and
  `response.results[].ebay.{us,global}.comps[]` (batch).
- **Shallow-clones** ebay, each side, comps array, and each rewritten comp.
  Non-terapeak comps pass through by reference (preserve identity).
- Critical: shallow-cloning prevents mutation of `ebayService` TTLCache
  and `terapeakService` dataset cache (regression test covers this).

## Admin signal
All call sites use `req.isAdmin === true` (strict; set by
`optionalAdminContext` middleware — JWT-with-admin OR `x-api-key ===
ADMIN_API_KEY` timing-safe).

## Bulk SSE per-subscriber redaction
Job `listeners` is now `Map<res, {isAdmin}>` (was Set). `job.results[i]`
stores RAW per-coin results; redaction happens per-subscriber at fanout
time. Prevents admin-created-job + anon-subscriber leak (the BLOCKING
finding from the 3-perspective review).

## Tests
- `__tests__/redactForPublic.test.js` (11 cases: admin no-op, US+global
  rewrite, preserves fields, batch shape, cache-safety of upstream
  ebay.us/global identity, idempotency, null/missing inputs)
- `__tests__/coinHistoryRoute.test.js` assertion updated `'terapeak'` →
  `'ebay-sold'`

## Future escalations (BACKLOG #243)
- Option B: strip `itemId` + `url` from terapeak comps for public
- Option C: strip entire `comps[]` for public, return summary stats only
- Trigger: only if compliance flags

## Strict-equality rule
Always pass `req.isAdmin === true` (not `req.isAdmin`) to
`redactCompsForPublic`. Truthy-checks let middleware bugs leak admin
data to public.
