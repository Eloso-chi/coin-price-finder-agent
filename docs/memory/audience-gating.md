# Audience Gating (Public vs Admin) -- Current Contract

The original source-label change shipped in PR #85. This document describes the
current contract; implementation details and route coverage should be kept in
sync with `src/utils/redactForPublic.js` and its call sites.

## Why
Terapeak comps must not expose their source brand to anonymous callers.
Public callers see `_source: "ebay-sold"` instead of `"terapeak"`; internal
`_productIdentity` and `_compositeCohort` markers are also removed. Admin
responses retain those fields for authorized diagnostics.

## Surface area
The shared helper is used by:
- `src/routes/priceRoute.js`
- `src/routes/barPriceRoute.js`
- `src/routes/pricingBatchRoute.js`
- `src/routes/bulkEvaluateRoute.js` -- response, SSE, and poll paths
- `src/routes/terapeakRoute.js` -- public lookup response
- `src/routes/aiPriceRoute.js`
- `src/services/aiOrchestratorService.js` -- tool results before they reach the model

`src/routes/coinHistoryRoute.js` separately emits the public-safe `ebay-sold`
source label; it does not call the shared helper.

## Mechanism: `src/utils/redactForPublic.js`
- Exports `{ redactCompsForPublic }`. No-op only when `isAdmin === true`.
- Supports single response `ebay.{us,global}.comps[]`, batch
  `results[].ebay.{us,global}.comps[]`, and top-level `comps[]` shapes.
- Rewrites `_source: "terapeak"` to `"ebay-sold"` and removes internal
  `_productIdentity` and `_compositeCohort` fields from public comp objects.
- Shallow-clones the affected arrays and comp objects so the upstream
  `ebayService` TTL cache and `terapeakService` store are not mutated.

## Admin signal
HTTP routes pass trusted request context from `optionalAdminContext`, which
derives it from an admin JWT or a timing-safe `x-api-key === ADMIN_API_KEY`
comparison. `redactCompsForPublic()` itself is fail-closed and bypasses
redaction only for the literal boolean `true`; call sites may pass the
middleware's boolean `req.isAdmin` or an equivalent trusted boolean. The AI
orchestrator receives that trusted flag from its route; it is not caller or
model supplied.

## Bulk SSE per-subscriber redaction
Job listeners retain each subscriber's trusted admin context. Raw per-coin job
results are redacted separately at fanout time, preventing an admin-created
job from leaking internal fields to an anonymous subscriber.

## Tests
- `__tests__/redactForPublic.test.js` (13 cases: admin no-op, US+global
  rewrite, preserves fields, batch shape, cache-safety of upstream
  ebay.us/global identity, idempotency, null/missing inputs)
- `__tests__/coinHistoryRoute.test.js` assertion updated `'terapeak'` →
  `'ebay-sold'`

## Scope boundary
The completed #243 change masks source labels and removes internal identity and
composite markers. It intentionally retains public comp title, price, sold date,
item ID, and URL. Any broader removal of comp fields requires a separate
licensing/compliance decision and updates to the public API/UI contract.

## Strict-equality rule
Do not use truthiness to decide whether to skip redaction. The helper's
`isAdmin === true` check is the authorization boundary: only a boolean `true`
from trusted middleware may bypass redaction; strings such as `"true"` remain
public and are redacted.
