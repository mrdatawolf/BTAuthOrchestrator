# ADR-002: Break-glass is each consuming app's own concern, never BTAuthOrchestrator's

Status: Accepted
Date: 2026-09-15
Decision owners: Patrick Moon
Related tasks and contracts: NOTES.md §4/§5 (open question this resolves);
CONTRACT-001 (names this as still-open at its own approval time — see
"Consequences" below for why this ADR does not edit that document);
CONTRACT-003 (BTAuthOrchestrator's own separate, unrelated kill-switch
mechanism — see "Context" for the distinction)

## Context

NOTES.md §4 identified that any real SSO deployment needs an out-of-band
admin path, because the IdP integration itself is a single point of
failure (tenant outage, a misconfigured app registration, a network egress
problem, anything). CDMS already has exactly this — an `.env`-configured
`FALLBACK_ADMIN_USERNAME`/`PASSWORD` fallback login, independent of its
primary auth path or database — and NOTES.md §6 requires it to keep working
unregressed through CDMS's migration onto BTAuthOrchestrator.

NOTES.md left one question genuinely open (§5, and referenced from both
CONTRACT-001 and CONTRACT-003 as "still open" at their approval dates):
does BTAuthOrchestrator own a single, central break-glass path that every
consuming app falls back to, or does each app keep its own independent
one? NOTES.md §4 already leaned toward "each app keeps its own" but
deliberately left it undecided pending "the first non-CDMS integration."

This is a different concept from CONTRACT-003's emergency key-rotation
trigger (`POST /admin/emergency-rotate-keys`), which is BTAuthOrchestrator's
own admin-triggered global logout — a kill switch that assumes
BTAuthOrchestrator itself is up and reachable. The question this ADR
resolves is the opposite scenario: what a consuming app does when
BTAuthOrchestrator (or Entra) is *not* reachable.

## Decision

Each consuming app owns its own break-glass authentication path, built
entirely internally to that app. BTAuthOrchestrator has no central
break-glass mechanism, no visibility into any app's break-glass design, and
is never queried or consulted about what an app's break-glass mechanism is
— an app that wants an auth override for when BTAuthOrchestrator/Entra is
unreachable builds and owns that override itself, the same way CDMS already
owns its `FALLBACK_ADMIN_USERNAME`/`PASSWORD` path today.

This requires nothing further of BTAuthOrchestrator itself: no interface,
no registration mechanism, no coordination point. It is a statement that
this is permanently out of BTAuthOrchestrator's scope, not merely deferred.

## Alternatives considered

- **BTAuthOrchestrator owns one central break-glass path for all apps.**
  Rejected. A central break-glass mechanism is itself a single point of
  failure for exactly the outage scenario it exists to cover — if
  BTAuthOrchestrator (or its break-glass subsystem specifically) is down or
  compromised, every app loses its fallback simultaneously. This also
  contradicts the project's already-established decentralization principle
  (NOTES.md §4: "verification stays local to each app... this matters...
  because it keeps request-path latency independent of BTAuthOrchestrator
  being reachable, and it means BTAuthOrchestrator is only a hard runtime
  dependency at login time").
- **BTAuthOrchestrator defines a shared break-glass interface/contract that
  every app must implement, even if each app's actual credential/storage
  is local.** Not chosen. Even a shared *interface* requirement would mean
  BTAuthOrchestrator's design constrains or is consulted about every app's
  fallback path, which is exactly the coupling this decision avoids. Each
  app's break-glass shape (CDMS's env-configured username/password, or
  whatever a future Python/PHP tool chooses) is entirely that app's own
  technology and operational choice.

## Consequences

### Benefits

- No new interface, coordination point, or shared failure mode is
  introduced. BTAuthOrchestrator's scope stays exactly what NOTES.md
  already established: mint tokens at login time, publish public keys,
  nothing else on the critical path of a request.
- CDMS's existing fallback continues to work unmodified — this decision
  requires no migration work on CDMS's part.
- Every future consuming app is free to choose whatever break-glass shape
  fits its own stack (env-configured credentials, a local admin table,
  whatever), without needing BTAuthOrchestrator's design input or approval.

### Costs and risks

- No org-wide visibility into which apps have a break-glass path, whether
  it's still functional, or when it was last tested — that responsibility
  is fully decentralized to each app's own operator. Accepted: centralizing
  that visibility would mean building the coordination point this decision
  deliberately avoids.
- Inconsistent break-glass UX/security posture across apps over time (one
  app's fallback could be materially weaker than another's) is possible
  since there is no shared standard. Accepted as the tradeoff for avoiding
  a shared single point of failure; revisit only if a specific app's
  break-glass design becomes a demonstrated weak point.

### Why this ADR, not an edit to CONTRACT-001 or CONTRACT-003

Both contracts mention this question as "still open" — accurate as of their
own approval dates, per [ADR-001](ADR-001-contracts-are-retired-by-supersession.md):
an approved contract's body is never edited after the fact. Neither
contract's actual behavior depends on this decision (CONTRACT-001 already
scoped it out as "not this milestone"; CONTRACT-003 already scoped it out
as governing only BTAuthOrchestrator's own trigger), so no supersession is
needed — this ADR is the up-to-date record going forward, and the
contracts' own text remains a correct historical snapshot of what was known
at approval time.

## Follow-up work

- NOTES.md §4 and §5 updated to record this decision and remove it from
  "Open" (this same change).
- No task or contract work is required by this decision itself. It becomes
  directly relevant at NOTES.md §6 step 3/4 (CDMS integration, then the
  first non-Node consuming app): each integration confirms the target app's
  existing or planned break-glass path continues to work, without
  BTAuthOrchestrator needing to know its shape.
