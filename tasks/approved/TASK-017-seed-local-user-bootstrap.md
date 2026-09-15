# TASK-017: Extend scripts/seed.js to bootstrap the first local user

Owner role: Implementer
Assigned agent: TBD
Proposed by: Claude (direct request from Patrick to break CONTRACT-005 into
small tasks)
Proposed date: 2026-09-15
Approved by: Patrick
Approved date: 2026-09-15
Related contracts: CONTRACT-005 (§5), CONTRACT-004 (§4's existing
idempotent seeding pattern, extended not modified)
Related ADRs: ADR-003
Dependencies: TASK-015 (needs `local_users` schema and the password-hashing
path to exist)

## Desired outcome

`scripts/seed.js` optionally provisions the first `local_users` row,
alongside its existing `CLIENT_SECRET`/signing-key seeding, unconditional
on `LOCAL_LOGIN`'s value.

## Context

CONTRACT-005 §5 reversed an earlier draft default: pre-staging a local user
during the same one-time bootstrap flow was judged more convenient than a
separate manual `POST /admin/users` call. This extends CONTRACT-004 §4's
existing idempotent "determine what needs seeding" pattern with one more
check, rather than introducing a parallel bootstrap mechanism.

## Scope

### Included

- A new check in `scripts/seed.js`'s existing per-piece seeding logic:
  if zero `local_users` rows exist, prompt for username/email/password
  (hidden interactive prompt by default, or a one-time input file for
  non-interactive use, mirroring `--client-secret-file`'s exact
  read-once-then-unlink-or-abort behavior) and create the first local user
  via TASK-015's password-hashing path.
- If one or more `local_users` rows already exist, skip and report so,
  matching the script's existing per-piece skip behavior.
- Runs regardless of `LOCAL_LOGIN`'s value (confirmed — not conditional).

### Excluded

- Any change to how `CLIENT_SECRET`/the signing key are seeded — unaffected.
- The admin API — TASK-016, already landed by the time this runs in
  practice, but not a hard dependency of this task's own scope.

## Plan

1. Add a `local_users` existence check to the seed script's existing
   "what needs seeding" logic.
2. Prompt for username/email/password using the same input-handling
   conventions already established for `CLIENT_SECRET`.
3. Hash via TASK-015's scrypt path (not a separate/simplified routine) and
   insert with `is_active = true`, `created_by = 'seed-script'`.

## Acceptance criteria

- [ ] A fresh, unseeded database gets exactly one `local_users` row after
      running the seed script, in addition to its existing
      `CLIENT_SECRET`/signing-key seeding.
- [ ] Re-running the script against an already-seeded `local_users` table
      skips that piece and reports it, without duplicating or overwriting
      the existing row.
- [ ] The seeded user can immediately log in via `POST /auth/local-login`
      (TASK-015) with the credentials supplied at seed time.
- [ ] The interactive password prompt is hidden (not echoed); the
      file-input path deletes its input file immediately after reading, or
      aborts without writing if the delete fails — same as
      `--client-secret-file`.

## Validation requirements

Per CONTRACT-005's Validation requirements section, the bootstrap-specific
bullets.

## Risks and assumptions

None beyond TASK-015 landing first.

## Blocker

None (depends on TASK-015 completing, not literally blocked yet).

## Implementation handoff

Not started.

## Review

Not reviewed.

## Human acceptance

Pending.
