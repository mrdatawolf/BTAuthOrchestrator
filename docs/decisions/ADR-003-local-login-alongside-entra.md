# ADR-003: A permanent local username/password login path, alongside Entra

Status: Accepted
Date: 2026-09-15
Decision owners: Patrick Moon
Related tasks and contracts: CONTRACT-005 (local login and user management —
the full behavioral specification this decision authorizes); CONTRACT-001
(the Entra OIDC path this coexists with, unaffected); NOTES.md §3 (the
original Entra-vs-local-accounts reasoning this decision partially revisits)

## Context

Testing BTAuthOrchestrator end-to-end requires a login to actually happen.
Entra's OIDC flow requires a real, interactively-authenticated human browser
session — impractical to drive repeatedly for iterative development,
automated tests, or anyone testing the system who isn't sitting at a browser
completing a live Microsoft sign-in each time.

NOTES.md §3 chose Entra ID over local per-app accounts as the org's identity
source, rejecting "keep local per-app accounts" as "the exact thing this
project exists to replace." That reasoning is about *consuming apps* each
rolling their own login (CDMS-style) as the org's primary identity
mechanism — it does not by itself rule out BTAuthOrchestrator having its own
local-credential path for testing purposes, which is a different question:
not "should the org's tools trust local per-app passwords instead of Entra,"
but "can BTAuthOrchestrator's own login surface be exercised without a live
Entra dependency."

## Decision

BTAuthOrchestrator gets a second, permanent login path: local
username/password authentication, fully specified in CONTRACT-005. Key
properties of this decision:

- **Permanent, not scaffolding.** This is not throwaway test tooling to be
  deleted once Entra integration is proven — it stays in the codebase
  indefinitely, built with the same rigor (real password hashing, audit
  trails, brute-force protection) as every other security-sensitive surface
  in this project.
- **Byte-identical output.** A local login mints the exact same `bt_session`
  token CONTRACT-001's Entra path produces, via the same `mintSessionToken`
  call — no consuming app, and no part of this codebase downstream of
  minting, needs to know or care which path authenticated a given session.
- **Mutually exclusive with Entra, not additive.** A single env variable,
  `LOCAL_LOGIN`, is a strict mode switch: exactly one of the two login paths
  is reachable in a given running instance, never both, never neither. When
  one is active, the other's routes fall through to the same generic `404`
  used for any nonexistent route — not a distinct "disabled" error — so a
  stale or weak local credential can never be used to attack a deployment
  that isn't currently running in local mode, and Entra's own routes are
  equally inert (not just credential-rejecting) when local mode is active.
- **User management via an HTTP admin API**, gated by its own dedicated
  credential (`LOCAL_USER_ADMIN_TOKEN`), deliberately separate from
  CONTRACT-003's `EMERGENCY_ROTATION_TOKEN` on least-privilege grounds.

CONTRACT-005 is the normative specification; this ADR records *why* the
capability exists and its shape at the architectural level, so a future
reader doesn't have to reconstruct the reasoning from a 1000+ line contract
or from chat history.

## Alternatives considered

- **Don't build it; find another way to drive Entra logins for testing**
  (e.g., a scripted browser automation against Entra's real sign-in UI).
  Rejected: brittle, slow, and still ultimately dependent on a live Entra
  tenant and real credentials being available in whatever environment tests
  run in — doesn't actually decouple testing from Entra's availability.
- **A local login path, but temporary/scaffolding only, removed once Entra
  integration is proven.** Rejected by Patrick: a permanent capability is
  more useful long-term (ongoing local dev, and a possible fallback if
  Entra itself is ever unreachable, distinct from CONTRACT-003's kill
  switch) and not meaningfully more expensive to build properly than to
  build as a hack and discard later.
- **An additive toggle** (local login available alongside Entra
  simultaneously, rather than mutually exclusive). Rejected by Patrick,
  explicitly: a stale/weak local credential must never be a live attack
  surface in a deployment that isn't actually in local-testing mode — a
  strict either/or switch is the only way to guarantee that, since
  "additive" would mean the local path is always reachable, always a
  potential target, in every deployment including production.
- **CLI-only user management** (extending `scripts/seed.js`-style tooling
  instead of an HTTP admin API). Rejected by Patrick in favor of an HTTP
  API, for faster iterative testing and as a natural base for future
  tooling, accepting the tradeoff of a new authenticated HTTP surface that
  needs its own authorization design (solved via `LOCAL_USER_ADMIN_TOKEN`,
  mirroring CONTRACT-003's precedent).

## Consequences

### Benefits

- The entire system — login, token minting, JWKS, emergency rotation,
  offline verification — can be exercised end-to-end by a human or an
  automated test suite with zero live Entra/Azure dependency.
- Because local login reuses CONTRACT-001's exact minting/cookie machinery,
  testing against the local path is testing the *real* downstream behavior
  (JWKS publication, consuming-app verification), not a parallel mock.
- The mutual-exclusivity design means this capability introduces no new
  standing attack surface in any deployment configured for Entra-only
  operation — the local path is provably inert, not merely
  credential-gated, whenever `LOCAL_LOGIN=false`.

### Costs and risks

- A second authentication code path is more code to maintain and reason
  about security-wise than one. Mitigated by reusing CONTRACT-001's minting
  machinery directly rather than reimplementing it, and by giving the local
  path its own explicit brute-force/enumeration-resistance design
  (CONTRACT-005 §2–3) rather than treating it as a lesser-scrutinized
  addition.
- Real password storage (even hashed) is a new category of secret this
  project didn't previously have to protect, alongside `CLIENT_SECRET` and
  signing keys. Addressed via scrypt (memory-hard, no new dependency) with
  parameters stored per-row for future upgradability.
- Operators must remember to set `LOCAL_LOGIN=false` (or omit it, if that
  becomes the validated default) before any deployment that should only
  ever accept Entra sign-ins — a misconfigured flag is now a real
  operational failure mode that didn't exist before this decision. No
  additional safeguard beyond CONTRACT-005's fail-closed startup validation
  (the flag itself must be explicitly `true` or `false`, no silent default
  either direction) is introduced here; revisit if this proves error-prone
  in practice.

## Follow-up work

- CONTRACT-005 is the full behavioral specification; implementation tasks
  are filed and approved separately once the contract itself is approved
  (per CLAUDE.md, this ADR/contract pair does not itself authorize
  implementation).
- TASK-014 (proposed) tracks a future, data-informed decision on
  `local_login_audit`'s retention policy, deliberately deferred rather than
  designed speculatively now.
