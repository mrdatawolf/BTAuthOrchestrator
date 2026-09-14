# TASK-010: Offline verification proof

Owner role: Implementer
Assigned agent: openai-coder
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: CONTRACT-001
Related ADRs: none
Dependencies: TASK-007, TASK-008, TASK-009

## Desired outcome

A standalone proof that a minted token can be verified completely offline
using only the public key from JWKS, with zero runtime calls back to
BTAuthOrchestrator beyond the initial key fetch — and that a token signed
under a since-rotated-out key correctly fails verification.

## Context

This is the actual acceptance bar for NOTES.md §6 milestone step 2 ("prove
the mint end works and that a token can be verified offline with only the
public key"). Modeled on CDMS's existing `src/proxy.ts` verification
pattern.

## Scope

### Included

- A standalone verifier (script or test) that fetches the public key(s)
  from JWKS once, then verifies a minted token with no further calls to
  BTAuthOrchestrator.
- A second case proving a token signed under a rotated-out key fails
  verification.

### Excluded

- Building this into any real consuming app (that's milestone step 3+,
  CDMS integration).

## Plan

1. Mint a token via TASK-007's flow.
2. Verify it offline using only JWKS-fetched public key material.
3. Trigger TASK-009's rotation.
4. Confirm the same token now fails offline verification.

## Acceptance criteria

- [ ] A freshly minted token verifies successfully offline using only the
      public key.
- [ ] No call to BTAuthOrchestrator occurs during verification itself, only
      the one-time key fetch.
- [ ] A token signed under a since-rotated-out key fails verification.

## Validation requirements

Run the verifier against both a fresh and a rotated-out token; confirm
expected pass/fail in each case.

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
