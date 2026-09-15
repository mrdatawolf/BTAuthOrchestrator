# TASK-016: Local user admin CRUD API

Owner role: Implementer
Assigned agent: TBD
Proposed by: Claude (direct request from Patrick to break CONTRACT-005 into
small tasks)
Proposed date: 2026-09-15
Approved by:
Approved date:
Related contracts: CONTRACT-005 (§4, §6's admin-audit half)
Related ADRs: ADR-003
Dependencies: TASK-015 (needs `local_users` schema and the password-hashing
path to exist)

## Desired outcome

`POST/GET/PATCH/DELETE /admin/users*` exist per CONTRACT-005 §4: a
dedicated `LOCAL_USER_ADMIN_TOKEN` gates all of them, independent of
`LOCAL_LOGIN`'s value, and every action produces a `local_user_admin_audit`
row.

## Context

Depends on TASK-015 for the `local_users` table and password-hashing
function — this task adds the HTTP surface and its own authorization/audit
around them.

## Scope

### Included

- `POST /admin/users`, `GET /admin/users`, `GET /admin/users/:id`,
  `PATCH /admin/users/:id`, `DELETE /admin/users/:id` per CONTRACT-005 §4
  and Interfaces' exact request/response shapes.
- `LOCAL_USER_ADMIN_TOKEN` bearer check: constant-time comparison, generic
  401, never distinguishing missing/malformed/wrong.
- `local_user_admin_audit` table and its writes (every action, success or
  failure).
- Confirm this surface remains reachable regardless of `LOCAL_LOGIN`'s
  value (CONTRACT-005's confirmed decision — not gated by that switch).
- Username immutability: no rename via `PATCH` (confirmed — delete and
  recreate instead).

### Excluded

- `POST /auth/local-login` itself and `local_login_audit` — TASK-015.
- `scripts/seed.js` — TASK-017.
- The HTML login form — TASK-018.

## Plan

1. Add `local_user_admin_audit` to `database.ts`'s schema string.
2. Add `LOCAL_USER_ADMIN_TOKEN` bearer-check middleware/helper, reusing the
   same constant-time-comparison pattern CONTRACT-003's endpoint already
   established in `index.ts`.
3. Implement the five endpoints per CONTRACT-005 §4/Interfaces, using
   TASK-015's password-hashing function for `create`/`password`-bearing
   `update`.
4. Write an audit row for every action (success and failure).

## Acceptance criteria

- [ ] Each of the five endpoints behaves per CONTRACT-005 §4/Interfaces,
      including exact status codes for conflicts (409) and not-found (404).
- [ ] A request with a missing/wrong `Authorization` header is rejected
      (401) regardless of `LOCAL_LOGIN`'s value.
- [ ] A valid `bt_session` cookie alone does not authorize any
      `/admin/users*` request.
- [ ] No response body, at any endpoint, ever includes a password hash or
      hashing parameter.
- [ ] Every action (success or failure) produces exactly one
      `local_user_admin_audit` row.

## Validation requirements

Per CONTRACT-005's Validation requirements section, the subset naming
`/admin/users*`.

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
