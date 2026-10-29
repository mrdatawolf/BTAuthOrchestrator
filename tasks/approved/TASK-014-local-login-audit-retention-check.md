# TASK-014: Check local_login_audit table growth after testing

Owner role: Implementer
Assigned agent: openai-coder
Proposed by: Patrick Moon
Proposed date: 2026-09-15
Approved by: Patrick Moon
Approved date: 2026-10-28
Related contracts: CONTRACT-005 (local login and user management —
`local_login_audit` and `local_user_admin_audit` are this contract's tables;
CONTRACT-005 explicitly defers a retention policy to this task rather than
designing one speculatively); CONTRACT-009 (self-service password changes
do not write `local_login_audit` rows); CONTRACT-008 (Draft — container
deployment, data directory on a persistent host volume)
Related ADRs: ADR-003 (lists this task as the open retention follow-up)
Dependencies: CONTRACT-005 approved and implemented (done — TASK-015
through TASK-018 completed); a real period of testing activity against
`/auth/local-login` has actually occurred (believed met as of 2026-10-28 —
see Blocker)

## Desired outcome

A decision, backed by real data, on whether `local_login_audit` (and its
sibling `local_user_admin_audit`) needs a retention/cleanup policy — informed by its actual growth rate under real
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

Refreshed 2026-10-28. Nothing since filing has superseded this task:
TASK-018 recorded the retention question as still open, ADR-003 lists this
task as the follow-up, and TASK-027 (admin console) explicitly excluded any
audit change or audit viewer. Since filing:

- `local_user_admin_audit`, the second CONTRACT-005 audit table, is under
  the same "never delete" stance. It grows from admin actions and admin-API
  authentication failures rather than every login, so likely more slowly,
  but deciding both tables together is cheap.
- CONTRACT-009 (TASK-026) confirmed that self-service password-change
  attempts do not write `local_login_audit` rows, so they do not add to its
  growth.
- CONTRACT-008 (Draft) and TASK-025 (proposed) plan a container deployment
  with the PGlite data directory on a persistent host volume. Once deployed,
  unbounded audit growth consumes production host disk rather than only a
  developer's working copy, which raises the practical stakes of this
  decision.

## Scope

### Included

- Inspect `local_login_audit`'s and `local_user_admin_audit`'s actual row
  counts/growth rates after a real period of testing, read-only.
- Decide whether a retention policy (time-based deletion, row-count cap,
  archival, or "no policy needed, growth is negligible") is warranted.
- If a policy is warranted, propose it as a follow-up task or a CONTRACT-005
  supersession (per ADR-001, if it changes the contract's stated
  invariants).

### Excluded

- Any change to either table's schema itself unless a chosen policy
  requires one.
- Implementing any retention policy — that is a follow-up task.
- CONTRACT-003/CONTRACT-004's own audit tables — out of scope, not affected
  by this task.

## Plan

Not yet planned in detail — this is intentionally a placeholder until
enough real testing activity exists to plan against actual data rather than
guesses.

## Acceptance criteria

- [x] Actual row-count/growth data for `local_login_audit` and
      `local_user_admin_audit` collected after a real period of testing.
- [x] An explicit decision recorded for each table: retention policy needed
      (with a proposed shape) or not needed (with reasoning), taking the
      planned container deployment's persistent volume into account.

## Validation requirements

Inspect a private copy using aggregate SELECTs in a read-only transaction;
verify source file contents unchanged, reconcile daily/mix totals, and review
the recorded capacity assumptions. No application tests or build are needed
for this analysis-only change. Required lifecycle moves remain blocked below.

## Risks and assumptions

- Local development data may not represent production load; the growth
  rate observed in `data/` reflects test activity, not real users.
- CONTRACT-008 is still Draft; if container deployment changes shape, the
  disk-growth concern in Context should be revisited.

## Blocker

Analysis finished; lifecycle transition blocked by session filesystem permissions.
The authorized `git mv tasks/approved/TASK-014-local-login-audit-retention-check.md
tasks/in-progress/` failed with `Unable to create .../.git/index.lock:
Read-only file system` (exit 128), before an untracked-file check. This session
cannot write `.git`, and escalation is unavailable. No index state was changed;
no filesystem-only rename was substituted. Patrick or a session with writable
Git metadata must add this approved file alone if needed, then perform the
approved → in-progress → review moves via `git mv`. Do not move to completed.
Human authorization is already present; no further approval is requested.

The data dependency is only partially representative: historical testing rows
exist, but just three active dates per table, with no recent October 27–28
rows. This is sufficient for size measurement and a qualified decision, not
for a measured production arrival rate.

## Implementation handoff

Task: TASK-014
Implementer: openai-coder
Date: 2026-10-28

### Changes made

Collected aggregate measurements and recorded a decision for both tables.
Proposed TASK-030 for policy design and contract supersession, not policy
implementation. No retention, schema, source, deployment, `.env`, or original
database changes were made. Assigned agent is set; required lifecycle moves
could not execute (see Blocker).

### Validation performed

Used Node v20.19.2 with `--env-file=.env`, without printing any configuration
values. Inspection script lives only in the human-specified scratchpad:
`/tmp/claude-1000/-home-patrick-Documents-Github-BT-BTAuthOrchestrator/efdd1559-ef97-4a34-b624-9e31d5b1e250/scratchpad/inspect.cjs`.

Copied `data/` there, verified the copy's file-content hashes matched the
source and that source contents stayed stable during copying, then opened
only the copy. No source application lock was present. Replicated the exact
`PGlite.create(dataDirectory)` call from `src/database.ts`; deliberately did
not call `openDatabase`, because that wrapper runs schema migrations and
manages lock files. Ran `BEGIN READ ONLY`, confirmed
`SHOW transaction_read_only = on`, queried, rolled back, and closed. Verified
source contents still matched the pre-copy hashes. Removed the private copy
after inspection; no source lock file was removed. File hashes were compared
in memory, not emitted. This confirms content preservation, not access-time
preservation or an atomic live-backup guarantee.

Encryption clarification: CONTRACT-005's Interface to CONTRACT-004 and the
actual source establish per-value encryption of secrets/signing private keys,
not encryption of every database page or these audit tables. The environment
key was loaded but no audit query required it; no protected secret was selected
or decrypted. This is the existing open path, not an alternate decryption scheme.

For each table `t`, queried `count(*)`, `min/max(timestamp)`,
`avg/min/max(pg_column_size(t))`, `pg_relation_size`, `pg_indexes_size`, and
`pg_total_relation_size`. Daily grouping used `(timestamp AT TIME ZONE
'UTC')::date`; outcome grouping used `result, failure_reason`, plus `action`
for admin audit. Only aggregate sizes, dates and category counts were returned.

### Acceptance criteria evidence

All timestamps below are UTC. Sizes are bytes, measured on the copy.

| Metric | local_login_audit | local_user_admin_audit |
|---|---:|---:|
| Rows | 32 | 13 |
| Earliest | 2026-09-16 16:04:49.246Z | 2026-09-16 16:05:04.361Z |
| Latest | 2026-10-19 16:15:09.598Z | 2026-10-16 22:46:10.107Z |
| Mean row bytes (`pg_column_size`) | 112.71875 | 161.53846 |
| Minimum / maximum row bytes | 107 / 127 | 120 / 183 |
| Heap | 8,192 | 8,192 |
| Indexes | 16,384 | 16,384 |
| Total relation size | 32,768 | 32,768 |
| Allocated total / row | 1,024 | 2,520.62 |

Allocated totals include indexes and ancillary relation allocation. The very
small tables occupy minimum pages; total/row is not a reliable marginal
storage estimate. Row averages exclude index/page/free-space overhead and
database-wide WAL, backups, snapshots, and other tables.

| UTC day | Login rows | Admin rows |
|---|---:|---:|
| 2026-09-16 | 8 | 9 |
| 2026-09-17 | 2 | 2 |
| 2026-10-16 | 0 | 2 |
| 2026-10-19 | 22 | 0 |
| Total | 32 | 13 |

All other dates between the respective earliest and latest dates had zero
rows. Login averages 0.94 rows/calendar day across 34 inclusive days;
admin averages 0.42 across 31 inclusive days. Peaks are 22 and 9 rows/day.
These describe sparse local activity only, not requests per second or a
production forecast. Neither table contains rows dated October 20–28.

| Table | Action | Result | Failure reason | Count |
|---|---|---|---|---:|
| Login | — | success | null | 23 |
| Login | — | failure | bad_password | 5 |
| Login | — | failure | unknown_username | 4 |
| Admin | create | success | null | 8 |
| Admin | auth_failure | failure | bad_credential | 5 |

Daily and outcome counts independently reconcile to 32 and 13. No admin
updates/deletes appear in this sample; that does not exclude those event
types or CONTRACT-009 self-service updates from production growth.

**Production extrapolation.** Assume 365 days/year and similar row widths.
Formula: audited rows/day × 365 × measured mean row bytes. Decimal MB/GB are
used below. A separate 3× planning allowance illustrates heap/index/free-space
overhead; it is an assumption, not measured mature-table overhead or an upper
bound. Actual row widths and workload require remeasurement.

| Scenario | Table | Audited rows/day | Row bytes/year | 3× allowance/year |
|---|---|---:|---:|---:|
| Routine local sign-ins, local mode all year | Login | 1,000 | 41.14 MB | 123.43 MB |
| Routine admin changes/password changes/failures | Admin | 10 | 0.590 MB | 1.769 MB |
| One IP, 20 failed attempts every 5 minutes | Login | 5,760 | 236.98 MB | 710.94 MB |
| Same rate at public password-change endpoint | Admin | 5,760 | 339.62 MB | 1.019 GB |
| 100 IPs at that per-IP rate | Login | 576,000 | 23.70 GB | 71.09 GB |
| 100 IPs at password-change endpoint | Admin | 576,000 | 33.96 GB | 101.89 GB |
| Admin auth failures reaching origin at 1/second | Admin | 86,400 | 5.094 GB | 15.283 GB |

Abuse figures are capacity scenarios conditional on origin throughput, not a
benchmark or claim that this single-process service sustains those rates.
The 20/5-minute values are contract defaults, not asserted current `.env`
settings. Throttled/malformed login requests are not audited, so their HTTP
request rate is not the row rate. Successful logins are not bounded by the
failure throttle. Restarted counters, concurrency, and varying row widths
mean the illustrated rate is not a strict storage ceiling. Password changes
have a separate throttle and write admin audit, not login audit.

CONTRACT-008 is now Approved (the earlier task text calling it Draft is stale).
Its persistent TrueNAS host volume mounted at `/data` survives container
recreation: replacing an image does not reclaim audit history. Capacity and
snapshot/backup growth accumulate on the host. CONTRACT-012 replaces Caddy
ingress with Cloudflare Tunnel and trusted client-address extraction; it
requires Access on `/admin/*`, reducing public admin-authentication traffic.
It leaves `/auth/*` public, including password change. Distributed clients
still have distinct throttle buckets; Tunnel/Access is not an audit-retention
policy. The admin 1/second case assumes Access-authorized faulty automation,
compromise, or deployment misconfiguration, not ordinary blocked internet
traffic. No edge rate limit, disk quota, compression ratio, available host
capacity, or deployed Access correctness was measured or assumed guaranteed.

**Decision — local_login_audit: policy needed as planned follow-up; no urgent
cleanup justified by this sample.** Present storage is negligible, but normal
login volume accumulates indefinitely and distributed failures can materially
consume a persistent volume. Proposed shape: time-based archival followed by
removal from the live table only after archive verification, with a finite
online window. Consider 90 days online as a discussion starting point; owner
must decide duration and archive lifetime/retrieval requirements. A row cap
alone is disfavored because an attack can evict recent legitimate evidence.

**Decision — local_user_admin_audit: policy needed as planned follow-up; no
urgent cleanup justified by this sample.** Routine CRUD alone is tiny and
would not warrant cleanup. However, CONTRACT-009's public password-change
attempts and unthrottled admin credential failures invalidate treating it as
a rare-event-only table. Proposed shape: verified time-based archival with a
longer online window for admin investigations (365 days as an unapproved
starting point), then removal from the live table. Preserve event detail and
history independently of user deletion. Determine whether event categories
need different windows during contract design, not here.

Both proposed live-table deletion policies change CONTRACT-005 §6's
no-retention/never-delete behavior, even if an archive retains the records.
They require an explicitly approved, separately numbered superseding contract
under ADR-001 before implementation. TASK-030 records that prerequisite;
CONTRACT-005's body is unchanged. Nothing here authorizes deletion or commits
the owner to the illustrative windows or an archive architecture.

### Assumptions and deviations

- Sparse historical rows are actual measurements, but not evidence that all
  later test suites exercised this persistent database. No synthetic load was
  generated and no production-rate confidence is claimed.
- Archive format, location, access controls, expiry, scheduling, disk budget,
  legal/operational evidence requirements, and failure recovery remain owner
  decisions in follow-up design. Archiving on the same host alone does not
  bound total host usage.
- Source code inspection resolved the prompt's whole-database-encryption
  assumption; audit-only aggregates do not require decryption.
- Git lifecycle moves could not run due to the read-only `.git` mount. The
  task remains in approved solely for that reason, with its finished analysis
  recorded here. This is not a claim of completed lifecycle acceptance.

### Unresolved risks

No database-inspection blocker remains. Lifecycle movement is blocked as
described above. Small samples and attacker-controlled field lengths limit
size estimates; 3× is not a capacity guarantee. Deletion alone may make pages
reusable without shrinking files, and snapshots can retain deleted blocks;
future design must address host-space accounting. Neither retention nor
archival alone prevents a short burst exhausting disk. Deployment validation
belongs to TASK-025, and no changes were made to that agent's work.

### Documentation updated

Only this task and `tasks/proposed/TASK-030-local-audit-retention-contract.md`.
No commit, contract edits, or application changes.

### Inspection and validation command ledger

Commands ran from repository root. Read commands below returned guidance/source
only, never `.env` contents. Broad reads exceeded output limits in places;
targeted reads recovered retention, storage, ingress and audit behavior.

1. `cat CLAUDE.md AGENTS.md docs/workflow/lifecycle.md docs/roles/implementer.md docs/templates/implementation-report.md docs/templates/task.md tasks/approved/TASK-014-local-login-audit-retention-check.md` — success.
2. `rg --files docs/contracts docs/decisions tasks | sort` — success; highest task 029.
3. `cat docs/contracts/CONTRACT-005* docs/contracts/CONTRACT-009* docs/contracts/CONTRACT-008* docs/contracts/CONTRACT-012* docs/decisions/ADR-003* docs/decisions/ADR-001* docs/AI_DEVELOPMENT_SYSTEM.md docs/DEVELOPMENT.md` — success, output truncated.
4. `git status --short` — initial state: proposed TASK-014 deleted, approved TASK-014 untracked.
5. `rg --files -g AGENTS.md -g '*pglite*' -g '*db*' -g '*audit*' -g package.json -g '*encrypt*' scripts src tasks data` — success; narrow filename matches.
6. `rg -n 'PGlite|encryption|openDatabase|lock' src/storage* scripts/startup-check.js package.json` — missing `src/storage*`; startup-check matches found.
7. `rg --files src` — success; located database/localUsers modules.
8. `wc -l docs/contracts/CONTRACT-{005,009,008,012}* docs/DEVELOPMENT.md` — success; established read sizes.
9. `cat docs/decisions/ADR-001* docs/decisions/ADR-003* docs/AI_DEVELOPMENT_SYSTEM.md` — success.
10. `git mv tasks/approved/TASK-014-local-login-audit-retention-check.md tasks/in-progress/` — failed, exit 128, read-only `.git/index.lock`; no move/add executed.
11. `cat src/database.ts scripts/startup-check.js` — success; identified exact open path and migration side effects.
12. `rg -n 'retention|never delete|throttl|audit|TrueNAS|volume|encrypt|Cloudflare' docs/contracts/CONTRACT-008* docs/contracts/CONTRACT-009* docs/contracts/CONTRACT-012* src/localUsers.ts src/index.ts` — success; combined output truncated.
13. `sed -n '350,800p' docs/contracts/CONTRACT-005-local-login-and-user-management.md` — success.
14. `cat docs/contracts/CONTRACT-009* docs/contracts/CONTRACT-012*` — success.
15. `sed -n '1,110p'`, `sed -n '290,360p'`, and `sed -n '600,640p'` against `docs/contracts/CONTRACT-008-container-deployment-secret-and-key-storage.md` — success; read approval, encryption and persistent storage requirements.
16. `mkdir -p` the scratchpad path above — success; no repo mutation.
17. `node --version` — v20.19.2.
18. `rg --files -g AGENTS.md tasks docs` — no additional matching guidance.
19. `sed -n '1,80p' src/localUsers.ts` and `sed -n '960,1005p' src/index.ts` — success; confirmed audit boundary and throttle exclusions.
20. `cat docs/contracts/CONTRACT-009-local-password-change-and-admin-reset.md` — success; confirmed admin audit writes from public password change.
21. Wrote `inspect.cjs` using `cat > <scratchpad>/inspect.cjs`, then ran `node --env-file=.env <scratchpad>/inspect.cjs` — exit 0; all copy/source integrity flags true, read-only transaction on, measurements above, copy removed. The script contains the exact aggregate SQL described above; no migration or secret queries.
22. `sed -n '800,1219p' docs/contracts/CONTRACT-005-local-login-and-user-management.md` and `sed -n '1,180p' docs/DEVELOPMENT.md` — success; combined output truncated.
23. `sed -n '360,600p'` and `sed -n '640,790p'` against `docs/contracts/CONTRACT-008-container-deployment-secret-and-key-storage.md` — success; read storage, locks and container profile.
24. `python3 -` arithmetic calculation — evaluated rows/day values 10, 1000, 5760, 576000 and 86400 at 112.71875 and 2100/13 bytes/row, multiplying by 365 and optionally 3; results recorded above.
25. `rg --files tasks | sort` — reconfirmed 029 highest before creating 030.
26. `git diff --name-only` and `git diff --cached --name-only` — existing proposed TASK-014 deletion only; cached diff empty.
27. `git diff --check` — exit 0. Because new task files are untracked, also directly checked their whitespace in the next command.
28. `node --env-file=.env -` validation — exit 0: both task files contain no loaded values for DB_ENCRYPTION_KEY, LOCAL_USER_ADMIN_TOKEN, EMERGENCY_ROTATION_TOKEN, CLIENT_SECRET or INITIAL_LOCAL_USER_PASSWORD; no trailing whitespace; TASK-030 contains every template section; assignment correct. Only pass/fail emitted. Lifecycle blocker confirmed.
29. `git status --short` and `git diff --cached --name-only` — success; index still unchanged/empty. Concurrent TASK-025 source changes and unrelated task moves now present; left untouched. TASK-014 still approved/untracked, TASK-030 proposed/untracked.

Edits used `apply_patch` on these two task files only. No build, service start,
application test suite, or live-database SQL was run.

## Review

Not reviewed.
