# TASK-030: Design bounded local audit retention and contract supersession

Owner role: Contract Designer
Assigned agent: TBD
Proposed by: openai-coder (TASK-014 recommendation)
Proposed date: 2026-10-28
Approved by: Patrick
Approved date: 2026-10-29
Related contracts: CONTRACT-005, CONTRACT-008, CONTRACT-009, CONTRACT-012
Related ADRs: ADR-001, ADR-003
Dependencies: Human acceptance of TASK-014 analysis and approval of this task

## Desired outcome

An owner-reviewed retention contract for `local_login_audit` and
`local_user_admin_audit`, bounding live-table growth while preserving the
investigation history the owner needs. No retention implementation in this task.

## Context

TASK-014 measured 32 login rows and 13 admin rows, each table 32,768 bytes.
Mean tuple sizes were 112.71875 and 161.53846 bytes, respectively. Three
active days each are insufficient to forecast production traffic. At 1,000
logins/day, raw tuples add 41.14 MB/year; at 100 client IPs each producing
20 audited failures per 5 minutes, they add 23.70 GB/year. Equivalent public
password-change attempts add 33.96 GB/year to the admin table. These are
conditional capacity scenarios, not throughput measurements; physical storage
includes additional index/page/WAL and snapshot/backup costs.

CONTRACT-008's TrueNAS host volume persists across container recreation.
CONTRACT-012's Cloudflare Access protects `/admin/*`, but `/auth/*` remains
public and CONTRACT-009 records password-change attempts in admin audit.

## Scope

### Included

- Decide online windows and any category differences, evidence preservation,
  archival lifetime/retrieval, capacity budget, and operational failure behavior.
- Starting proposal: verified archival before time-based live-table removal;
  consider 90 days for login and 365 days for admin, explicitly unapproved.
- Define archive destination/security, verification, idempotence, failure-safe
  removal, recovery, scheduling compatible with the PGlite single-process lock,
  and how disk usage and snapshot retention are accounted for.
- Draft a separately numbered contract superseding CONTRACT-005's relevant
  retention behavior under ADR-001; identify the exact supersession scope and
  carry forward unaffected obligations. Obtain explicit human approval before
  changing approved status/header metadata or authorizing implementation.
- Propose a separate implementation task after the design is approved.

### Excluded

- Deleting/archiving any real rows, changing schema/source/deployment, or
  implementing a scheduler or retention policy.
- Editing CONTRACT-005's approved body or changing other audit tables.
- Adding rate limits or changing audit emission requirements by implication.

## Plan

1. Review TASK-014 evidence and obtain the owner's evidence-age and capacity
   requirements; confirm production mode and relevant deployment controls.
2. Compare time-based deletion, verified archival, and row caps. Address why
   a row cap alone can let an attack displace legitimate history.
3. Specify chosen behavior, operational ownership, bounded work, failure cases,
   archive recovery, and measurable capacity/retention acceptance checks.
4. Draft the superseding contract and submit for human review. Retention that
   removes live rows requires CONTRACT-005 supersession even if archived copies
   survive: §6 currently specifies no retention/cleanup and never deletes rows.
   ADR-001 forbids silently amending that body. An export-only design that
   retains all live rows would not change that invariant, but would not bound
   live-table growth; explicitly resolve that tradeoff if selected instead.
5. After approval, propose scoped implementation and validation work separately.

## Acceptance criteria

- [ ] Owner has decided windows, archive lifetime/retrieval, and disk budget.
- [ ] Both tables and public password-change events are explicitly covered.
- [ ] Archive-before-removal guarantees, failures, recovery, and single-process
      operation are specified with testable outcomes.
- [ ] Host volume, free-page reuse versus file shrinkage, snapshots/backups,
      burst growth, and archive storage consumption are addressed.
- [ ] CONTRACT-005/ADR-001 supersession is explicit; unchanged audit behavior
      and other contracts are preserved.
- [ ] Draft submitted for review; no policy or real-data mutation implemented.

## Validation requirements

Review traceability to TASK-014 figures and existing contracts; recalculate
capacity scenarios. Specify future isolated tests for cutoff boundaries,
archive failure preventing removal, retries, restore verification, concurrent
ingestion, restart/lock behavior, and measured physical growth/reclamation.
Do not run destructive validation on the local or production database.

## Risks and assumptions

The observed tables are tiny. Production rates, row widths and available host
capacity remain unknown. An archive on the same host still consumes that host;
its lifetime and destination must be resolved. Retention does not itself stop
abuse or guarantee free disk during bursts. Proposed windows are discussion
inputs, not approved policy or compliance claims.

## Blocker

Not authorized for implementation; awaiting human approval of this proposed
design task and owner decisions listed above.

## Implementation handoff

Not started.

## Review

Not reviewed.
