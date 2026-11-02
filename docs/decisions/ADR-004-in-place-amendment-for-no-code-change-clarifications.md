# ADR-004: In-place amendment of approved contracts for changes with no code impact

Status: Accepted
Date: 2026-11-02
Decision owners: Patrick Moon
Related tasks and contracts: ADR-001 (amended by this decision);
CONTRACT-014 (first amendment under it); TASK-034 (TrueNAS validation)

## Context

ADR-001 says an approved contract's body is never edited: every change goes
through a new, superseding contract. That protects the record of what code
was built against.

During the first production TrueNAS install (2026-11-02), Patrick chose a
host-path dataset for `/data` instead of CONTRACT-014's ix volume, so the
database can be backed up, copied and imported directly. The service
already accepts any writable mount at `/data`; the only operator step
needed was stripping the dataset's inherited ACL. Nothing in the image,
the service or its tests changes. Writing a superseding contract for this
would add a document and a cross-reference without changing what any
implementation is built against.

## Decision

ADR-001 stands, with one exception. An approved contract may be amended in
place when **all** of the following hold:

1. Patrick explicitly approves the amendment and that it is made in place.
2. It requires **no code change**: every existing implementation, test and
   review built against the contract remains correct as written.
3. It widens or clarifies operator-facing options or documentation; it does
   not remove or weaken a guarantee the service gives.

Each such amendment:

- adds an `Amended: <date> by <who>, in place under ADR-004 (<summary>)`
  line to the contract header;
- marks each changed passage "(amended <date>)" and keeps the original text
  where it still describes the original option;
- adds an entry to an `## Amendment log` section at the end of the
  contract.

Anything else, including any change an implementation must follow, still
goes through supersession under ADR-001.

## Alternatives considered

- **Supersede CONTRACT-014's storage sections with a new contract.**
  Compliant with ADR-001 and about a page of writing; rejected by Patrick
  as adding process without a corresponding risk, since no code changes.
- **Document the host path only in operator docs.** Rejected: the contract
  would then describe a narrower setup than production runs.
- **One-off in-place edit without an ADR.** Rejected: it would leave the
  contract history contradicting the recorded rule.

## Consequences

### Benefits

- Operator-facing corrections found in real deployments reach the contract
  quickly, keeping it in line with how the system is actually run.
- The amendment is still visible: header line, inline markers and a log.

### Costs and risks

- Contracts are no longer strictly immutable. Someone reading an old commit
  sees the pre-amendment text; the amendment log is the record of change.
- The "no code change" test needs judgment. When in doubt, supersede.

## Follow-up work

- `docs/contracts/README.md` notes this exception (this same change).
- CONTRACT-014 amended 2026-11-02 for host-path dataset storage.
