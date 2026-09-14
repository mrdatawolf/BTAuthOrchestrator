# TASK-011: Independent review of milestone 1-2 slice

Owner role: Reviewer
Assigned agent: quality-assurance
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: CONTRACT-001, CONTRACT-002
Related ADRs: none
Dependencies: TASK-007, TASK-008, TASK-009, TASK-010

## Desired outcome

An independent review confirming the full milestone-1-2 slice (Entra
registration through offline verification proof) meets both contracts and
carries no regressions or security gaps, before Patrick accepts the work.

## Context

Covers everything built across TASK-004 through TASK-010.

## Scope

### Included

- Contract compliance against CONTRACT-001 and CONTRACT-002.
- PKCE/state/nonce correctness.
- Cookie/secret handling.
- Confirmation that no security decision derives from `NODE_ENV`.
- Private key isolation (never exposed via any endpoint/log).
- Envelope-encryption correctness (ciphertext at rest, KEK never in the
  database).
- Data-directory permissions.
- Single-process constraint.
- Rotation behavior (both the emergency trigger and the offline-verification
  proof of a rotated-out key failing).
- Entra-unreachable failure path.

### Excluded

- Implementing fixes (reviewer reports findings only, per
  `docs/roles/reviewer.md`).

## Plan

1. Review implementation against CONTRACT-001 and CONTRACT-002 clause by
   clause.
2. Verify security-sensitive behaviors listed in Scope > Included directly
   (inspect stored data, attempt to trigger `NODE_ENV`-derived behavior,
   etc.), not just read the code.
3. Record findings per `docs/templates/review-report.md`, separating
   blocking findings from recommendations.

## Acceptance criteria

- [ ] Review recorded per the repo's review-report template.
- [ ] Every item in Scope > Included addressed explicitly (pass/fail/
      finding).
- [ ] Blocking findings clearly distinguished from non-blocking
      recommendations.

## Validation requirements

N/A — this task is itself the validation step for TASK-004–010.

## Risks and assumptions

None.

## Blocker

None.

## Implementation handoff

Not started.

## Review

Not reviewed.

## Human acceptance

Pending.
