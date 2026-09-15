# Behavioral Contracts

Contracts describe approved observable behavior without prescribing unnecessary
implementation details. Name contracts `CONTRACT-NNN-short-description.md` and
link them from related tasks and ADRs.

An approved contract is changed through explicit human review, not silently during
implementation.

## Contracts are retired by supersession, never amended in place

Once a contract's `Status` is `Approved`, its body is never edited again. A
required change is made by creating a new, separately numbered contract that
supersedes it — never by editing the approved document. See
[ADR-001](../decisions/ADR-001-contracts-are-retired-by-supersession.md) for
the full rationale.

- The new contract's header names what it replaces: `Supersedes: CONTRACT-NNN`.
- The retired contract's header gets `Status: Retired` and
  `Superseded by: CONTRACT-NNN` — the *only* edit ever made to it again; its
  body is never touched.
- The retired file is never deleted. It stays in `docs/contracts/` as the
  permanent record of what was actually approved and built against.
- Retiring a contract requires the same explicit human approval as approving
  one.
- A supersession may replace a contract wholly or only a section of it —
  whichever leaves the resulting documents as coherent, unambiguous,
  point-in-time records; prefer whole-document supersession when in doubt.
