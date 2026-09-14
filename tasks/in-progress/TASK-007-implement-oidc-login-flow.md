# TASK-007: Implement OIDC login flow

Owner role: Implementer
Assigned agent: openai-coder
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: CONTRACT-001
Related ADRs: none
Dependencies: TASK-002 (CONTRACT-001 approved), TASK-004 (scaffold),
TASK-006 (`CLIENT_SECRET` available in storage)

## Desired outcome

A working OIDC authorization-code login flow against Entra ID, per
CONTRACT-001, culminating in an issued session cookie.

## Context

Implements CONTRACT-001 exactly. `CLIENT_SECRET` is read from the encrypted
storage layer (TASK-005/006), never from `.env`.

## Scope

### Included

- Redirect-to-Entra endpoint.
- Callback handling.
- Authorization code exchange.
- PKCE/state/nonce enforcement.
- ID token validation.
- Issuing BTAuthOrchestrator's own session token and cookie on success.
- Failure behavior when Entra is unreachable, per CONTRACT-001.

### Excluded

- Signing/JWKS internals (TASK-008).
- Refresh, logout, authorization gating (out of scope per CONTRACT-001).

## Plan

1. Implement the redirect-to-Entra endpoint with PKCE/state/nonce
   generation.
2. Implement the callback endpoint: validate state/nonce, exchange the
   code, validate the ID token.
3. On success, call into TASK-008's minting logic and set the session
   cookie per CONTRACT-001's attributes.
4. Implement the Entra-unreachable failure path per CONTRACT-001.

## Acceptance criteria

- [ ] Full login round-trip succeeds against a real Entra tenant.
- [ ] PKCE/state/nonce are enforced; a tampered or missing value is
      rejected.
- [ ] Entra-unreachable failure path matches CONTRACT-001.
- [ ] Cookie attributes match CONTRACT-001 exactly (Domain, HttpOnly,
      `COOKIE_SECURE`-driven Secure, no `NODE_ENV`-derived logic).

## Validation requirements

End-to-end manual test against the real Entra tenant registered in
TASK-001.

## Risks and assumptions

Assumes TASK-001's redirect URI/HTTPS findings didn't force a CONTRACT-001
rework.

## Blocker

None.

## Implementation handoff

Not started.

## Review

Not reviewed.

## Human acceptance

Pending.
