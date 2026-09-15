# ADR-001: Contracts are retired by supersession, never amended in place

Status: Accepted
Date: 2026-09-15
Decision owners: Patrick Moon
Related tasks and contracts: TASK-009, TASK-011 (Finding F1); CONTRACT-002
(retired by this decision); CONTRACT-004 (supersedes CONTRACT-002)

## Context

TASK-011's independent review of the milestone-1-2 slice (Finding F1) found
that TASK-009 did not implement CONTRACT-002's normatively-specified
`rotateSigningKey`/`revokeKey` interface. Instead, it implemented
`rotateSigningKeyEmergency`/`recordEmergencyRotationFailure` to satisfy an
atomicity requirement (a rotation and its audit row must never diverge) that
CONTRACT-003 itself had flagged as an open question rather than resolve by
silently amending CONTRACT-002's interface.

This raised a prior-and-more-general question this project had not yet
answered: when an approved contract turns out to need a change, does the
existing document get edited, or does a new contract replace it?

This project's process is explicitly described (`docs/AI_DEVELOPMENT_SYSTEM.md`)
as adapting the *discipline* of Bertrand Meyer's Design by Contract — explicit
obligations, verifiable behavior, clear responsibility boundaries — to a
human/agent workflow, without claiming to reproduce Meyer's Eiffel-level
mechanism. One piece of that discipline is directly relevant here: a contract
is a promise other parties build against. Silently rewriting an approved
contract's body invalidates every implementation, review, and decision that
was made against its previous text, with no durable record that anything
changed. `docs/decisions/README.md` already states this exact principle for
ADRs ("a later ADR supersedes an earlier decision rather than silently
rewriting its history"); contracts had no equivalent rule.

## Decision

Once a contract's Status is `Approved`, its body is never edited again.

A required change is made by creating a new, separately numbered contract
that supersedes it — copying forward everything that still holds and
changing only what actually needs to change — never by editing the approved
document in place.

Concretely:
- The new contract's header gets a `Supersedes: CONTRACT-NNN` field naming
  what it replaces.
- The old contract's header gets `Status: Retired` and a
  `Superseded by: CONTRACT-NNN` field. This status/header update is the
  *only* edit ever made to an approved contract again — its body (Scope,
  Required behavior, Interfaces, etc.) is never touched.
- The retired contract's file is never deleted. It stays in
  `docs/contracts/` as the permanent record of what was actually approved
  and built against at the time.
- Retiring a contract requires the same explicit human approval as
  approving one (`docs/contracts/README.md`already states "An approved
  contract is changed through explicit human review, not silently during
  implementation" — this decision formalizes what that "change" looks like:
  supersession, not amendment).
- Whether a new contract supersedes another *wholly* or only a *section* is
  a case-by-case call. This project's own first instance (CONTRACT-002 →
  CONTRACT-004) supersedes wholly, even though only the rotation-interface
  section actually changed content, so the retired document reads as one
  coherent, complete, point-in-time record rather than a partially-live
  fragment.

## Alternatives considered

- **Amend the approved contract in place, noting the change in a changelog
  section.** Rejected: this is exactly the "silently rewriting an approved
  document" failure mode `docs/decisions/README.md` already rejects for
  ADRs. A reader (or implementer, mid-task) checking out an older commit, or
  reading a stale local copy, would see contradictory or already-overwritten
  requirements with no signal that they're outdated relative to what code
  was actually built against.
- **Partial/section-level supersession only** (a new contract overriding
  just the interface section, CONTRACT-002 otherwise remaining "Approved").
  Rejected for this instance by Patrick: it leaves the reader needing to
  cross-reference two live documents to know the actual current rules, and
  weakens the "a contract is a single coherent point-in-time record" property
  that makes supersession valuable in the first place. The mechanism this
  ADR establishes still permits section-level supersession where it's a
  better fit for a future case; it is not chosen by default here.
- **Do nothing / treat this as one-off implementer discretion.** Rejected:
  the same tension (an approved contract's literal text vs. what
  implementation actually needs) will recur, and without a documented
  convention every future case reopens the same policy question that F1 just
  raised — the same rationale `docs/workflow/change-classification.md` gives
  for requiring an ADR at all ("a durable architectural direction with
  meaningful alternatives").

## Consequences

### Benefits

- Every contract file is an immutable, trustworthy historical record: what
  it says is exactly what was approved and (once implemented) exactly what
  was built against, forever — no risk of reading a since-edited version
  without knowing it changed.
- Supersession chains are traceable by following `Supersedes`/`Superseded
  by` links, mirroring the already-established ADR supersession pattern.
- Removes ambiguity for future implementers and reviewers about whether a
  contract deviation should be "fixed in the code" or "fixed in the
  contract" — the answer is always a new contract, decided by the human,
  never a silent edit either direction.

### Costs and risks

- Retiring a contract wholly (this project's chosen default for the
  CONTRACT-002 instance) means re-stating unchanged sections in the new
  document — more text than a section-level patch, and a small risk of
  transcription drift if copied carelessly. Mitigated by copying verbatim
  and changing only the sections that actually differ.
- `docs/contracts/` accumulates retired documents over time with no pruning
  mechanism. Accepted: this is the same tradeoff ADRs already make, and the
  historical-record value is the entire point.
- Contract numbers are not reused and do not reset — `CONTRACT-004` is the
  fourth contract issued, not "CONTRACT-002, version 2." Naming stays
  purely sequential, matching the existing `CONTRACT-NNN` convention.

## Follow-up work

- `docs/contracts/README.md` and `docs/contracts/TEMPLATE.md` updated to
  state this rule and add the `Supersedes`/`Superseded by`/`Retired` fields
  and status value (this same change).
- CONTRACT-002 retired; CONTRACT-004 issued as its full successor, codifying
  TASK-009's as-built rotation interface (Patrick's decision, 2026-09-15,
  in place of adapting TASK-009's working, independently-verified code to
  match CONTRACT-002's originally-specified but unimplemented
  `rotateSigningKey`/`revokeKey` shape).
- This same convention propagated to the `Project Template DbC` sister
  repository so future projects inherit it by default.
- Future routine (non-emergency, overlap-window) key rotation — which
  CONTRACT-002 anticipated but which was never implemented — has no
  defined interface as of CONTRACT-004. It should be designed fresh against
  real requirements when that work is actually taken up, via a new contract
  (or a further supersession of CONTRACT-004), not by resurrecting
  CONTRACT-002's dropped, never-implemented shape. See CONTRACT-004's own
  "Open questions."
