# AI External Exposure Evaluation

**Backlog:** #297H
**Date:** 2026-08-17
**Decision:** DEFER external OpenAPI/MCP exposure

## Scope

This evaluation covers the deterministic AI-facing tools currently implemented in the application:

- `POST /api/ai/price` -- public-safe conversational pricing and structured handoff.
- `POST /api/ai/collection` -- authenticated, ownership-scoped collection context.
- `POST /api/ai/market` -- bounded market coverage, comparison, and year-series analytics.

No external agent, OpenAPI server, or MCP server is enabled by this decision.

## Decision Summary

Defer external exposure. Keep these tools available only through the existing Express routes and their current middleware boundaries until an approved external gateway is designed and operated separately.

The current implementation is deterministic and useful internally, but exposing it directly would move authentication, rate limiting, audit correlation, and redaction responsibilities outside the route process. That would expand the attack surface without a current user requirement or operational owner.

## Trust Boundary

| Caller | Trusted context | Allowed data |
|---|---|---|
| Structured/public pricing UI | Server route context; public audience | Public-safe valuation and redacted comp provenance |
| Authenticated collection UI | Verified JWT `userId` | Only that user’s collection; no caller-selected user ID |
| Internal market/AI UI | Server route context | Bounded matrix-derived observations and metrics |
| External agent | **Not supported** | No access granted |

Caller-controlled bodies are never trusted for `userId`, admin status, audience, secrets, audit actor identity, or internal provider configuration.

## Candidate Surface Review

### OpenAPI

**Strengths**

- Familiar HTTP contract and generated client support.
- Fits the existing Express routes and JSON response schemas.
- Easier to document and version for a future first-party gateway.

**Risks**

- A published schema can make a private route appear publicly consumable even when deployment controls are incomplete.
- Authentication, tenant ownership, quota enforcement, redaction, and audit correlation would still need an enforcement gateway.
- Collection operations require a user-bound token and must reject arbitrary user identifiers.

**Operational cost**

- Gateway or API management deployment, schema/version lifecycle, key rotation, abuse monitoring, quota policy, and contract compatibility testing.

### MCP

**Strengths**

- Tool-oriented model maps naturally to the allowlisted deterministic boundaries.
- Could make provenance and structured tool results available to an agent without exposing provider credentials.

**Risks**

- Adds a new protocol server, transport, session, tool-discovery, and origin/authentication surface.
- Tool descriptions and returned content become an additional prompt-injection and data-exfiltration boundary.
- Collection tools require especially strict per-session user binding and must not accept model-supplied user IDs.

**Operational cost**

- MCP server lifecycle, transport hardening, session identity, tool allowlists, telemetry, abuse controls, compatibility testing, and an explicit operator/on-call owner.

## Data Classification and Controls

| Tool | Classification | Required controls before exposure |
|---|---|---|
| AI price | Public-safe valuation; licensed comp provenance remains restricted | Response redaction, request quotas, request IDs, audit metadata, schema versioning |
| AI collection | Private user data | JWT or equivalent user-bound identity, ownership enforcement, no arbitrary IDs, zero cross-user caching, audit trail |
| AI market | Derived market intelligence | Bounded series count, bounded lookback, source labels, missing-data semantics, response quotas |

Existing controls that must remain authoritative:

- `optionalAdminContext` and route-derived audience for public/admin gating.
- `coinRoute`-style JWT verification and `req.user.userId` ownership binding.
- Existing API rate limiting and request-ID middleware.
- `redactCompsForPublic` for public comp responses.
- Valuation audit records with algorithm version, config version, timestamp, and request ID.
- Deterministic services as the only source of valuation and analytics calculations.

## Threat Model

The external boundary must assume:

- An attacker can forge request bodies, including `userId`, `isAdmin`, audience, tool arguments, and provider settings.
- An authenticated user can attempt horizontal access to another user’s collection.
- A model or external agent can emit prompt-injected tool arguments or request unsupported operations.
- High-volume callers can exhaust eBay, PCGS, Numista, Terapeak, Cosmos, or local fallback resources.
- Public responses can accidentally redistribute licensed source labels, item identifiers, or admin-only values.
- Schema consumers can depend on unstable fields unless versions are explicit.

The current system does not provide an independently operated gateway with all of these controls, so direct external exposure is not approved.

## Versioning and Audit Requirements

Any future external contract must:

1. Use a versioned prefix such as `/external/v1` or an equivalent MCP tool version.
2. Pin request and response schemas, including explicit missing-data states.
3. Preserve `algorithmVersion`, `configVersion`, and `computedAt` in valuation results.
4. Correlate every request with a server-generated request ID and authenticated external principal.
5. Record tool name, principal, authorization result, response classification, and failure reason without logging secrets or raw private collection data.
6. Treat existing internal `/api/ai/*` routes as implementation details, not an external compatibility promise.

## Rollout and Rollback

No rollout is authorized by this evaluation. If external exposure is later approved, it must be disabled by default behind an explicit deployment/configuration flag and introduced as a separate change set.

Rollback requirements:

- Disable the gateway or external listener first.
- Revoke external credentials or API keys.
- Confirm the internal `/api/ai/*` routes remain available only through their existing local/authenticated paths.
- Verify request logs show no accepted external traffic after shutdown.
- Re-run focused auth, redaction, rate-limit, and response-contract tests.
- Revert only the external gateway/schema/config changes; do not alter deterministic pricing, collection CRUD, or market services.

## Final Recommendation

**DEFER.** Keep the internal deterministic AI routes and UI integrations. Revisit OpenAPI or MCP only when there is a concrete external consumer, an owned deployment boundary, a data-classification review, and an approved security/operations plan. OpenAPI is the likely first candidate for a future first-party gateway; MCP should remain a later option rather than an automatic extension.
