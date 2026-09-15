# TASK-014: Check local_login_audit table growth after testing

Owner role: Implementer
Assigned agent: TBD
Proposed by: Patrick Moon
Proposed date: 2026-09-15
Approved by:
Approved date:
Related contracts: CONTRACT-005 (local login and user management —
`local_login_audit` is this contract's table; CONTRACT-005 explicitly defers
a retention policy to this task rather than designing one speculatively)
Related ADRs: none
Dependencies: CONTRACT-005 approved and implemented; a real period of
testing activity against `/auth/local-login` has actually occurred

## Desired outcome

A decision, backed by real data, on whether `local_login_audit` needs a
retention/cleanup policy — informed by its actual growth rate under real
testing load, not designed speculatively ahead of time.

## Context

CONTRACT-005 defines `local_login_audit` with no retention policy,
deliberately mirroring CONTRACT-003/CONTRACT-004's "never delete" stance on
their own audit tables — but those tables grow from rare events (an
emergency rotation, a key bootstrap), while `/auth/local-login` may be
called very frequently by automated test suites once local-login testing is
underway. Patrick asked (2026-09-15) for this to be picked up as its own
task once testing is far enough along to have produced a real growth
pattern, rather than have CONTRACT-005 guess at a policy now. Explicitly
low priority — do not pick this up until testing activity has actually
accumulated meaningful data.

## Scope

### Included

- Inspect `local_login_audit`'s actual row count/growth rate after a real
  period of testing.
- Decide whether a retention policy (time-based deletion, row-count cap,
  archival, or "no policy needed, growth is negligible") is warranted.
- If a policy is warranted, propose it as a follow-up task or a CONTRACT-005
  supersession (per ADR-001, if it changes the contract's stated
  invariants).

### Excluded

- Any change to `local_login_audit`'s schema itself unless a chosen policy
  requires one.
- CONTRACT-003/CONTRACT-004's own audit tables — out of scope, not affected
  by this task.

## Plan

Not yet planned in detail — this is intentionally a placeholder until
enough real testing activity exists to plan against actual data rather than
guesses.

## Acceptance criteria

- [ ] Actual row-count/growth data for `local_login_audit` collected after a
      real period of testing.
- [ ] An explicit decision recorded: retention policy needed (with a
      proposed shape) or not needed (with reasoning).

## Validation requirements

TBD, depends on the decision reached.

## Risks and assumptions

None beyond CONTRACT-005 being approved and implemented first.

## Blocker

Waiting on a real period of `/auth/local-login` testing activity to
accumulate before this task is meaningful to work — intentionally not
ready for approval yet.

## Implementation handoff

Not started.

## Review

Not reviewed.

## Human acceptance

Pending.
