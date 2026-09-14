# TASK-009: Emergency key-rotation trigger

Owner role: Implementer
Assigned agent: openai-coder (contract-architect first if the admin action's
authorization shape isn't obvious once scoped)
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: CONTRACT-002
Related ADRs: none
Dependencies: TASK-008

## Desired outcome

An authenticated administrative action that immediately generates a new
signing key pair, publishes it, and drops the previously current key from
JWKS — invalidating every previously issued session token globally, on
demand, for emergency use (Patrick's requested "kill switch" to force
re-authentication of all users at once).

## Context

This is deliberately a global-only mechanism, not per-user revocation —
Patrick has explicitly accepted that tradeoff (a single departing employee's
access is otherwise bounded by the midnight-expiry rule, up to ~24h) and
will handle finer-grained, per-application revocation needs on an
app-by-app basis later, outside this milestone. This task is independently
reviewable from TASK-008 because its authorization/audit surface (who can
trigger a mass logout of every user in the org) is its own security-critical
decision, distinct from ordinary key storage.

## Scope

### Included

- An authenticated trigger (endpoint or admin command) that generates a new
  RS256 key pair, marks it current, publishes it to JWKS, and removes the
  previously current key from JWKS immediately (no overlap window — this is
  the emergency path, distinct from any future routine-rotation-with-overlap
  design).
- A minimal audit trail (who triggered it, when).

### Excluded

- Routine/scheduled key rotation with an overlap window (future work, not
  this milestone).
- Per-user revocation (explicitly out of scope, per Patrick's decision
  above).

## Plan

1. Define who/what may authenticate to trigger this action (e.g., a
   break-glass admin credential, per NOTES.md §4's per-app break-glass
   pattern) — flag to Patrick if this isn't already obvious from existing
   break-glass design.
2. Implement key generation, immediate JWKS publish of the new key, and
   immediate removal of the old key.
3. Implement a minimal audit log entry for each trigger (who, when).

## Acceptance criteria

- [ ] Triggering the action results in a new current key and the old key
      immediately absent from JWKS.
- [ ] A token signed under the now-dropped key fails verification
      immediately after rotation (see also TASK-010).
- [ ] The trigger requires authentication; the authorization mechanism is
      explicit and documented.
- [ ] Each trigger produces an audit record.

## Validation requirements

Mint a token, trigger rotation, confirm the token now fails offline
verification against the refreshed JWKS.

## Risks and assumptions

"Instant" is only as instant as each consuming app's JWKS caching behavior —
not yet a concern with zero consuming apps in this milestone, but must be
stated explicitly in any future consuming-app contract (e.g., CDMS
integration).

## Blocker

None.

## Implementation handoff

Not started.

## Review

Not reviewed.

## Human acceptance

Pending.
