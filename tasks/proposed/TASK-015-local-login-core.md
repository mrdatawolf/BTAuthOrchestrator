# TASK-015: Local login core — schema, password hashing, login endpoint, mode switch

Owner role: Implementer
Assigned agent: TBD (Codex/openai-coder normally; substituted this session
per Codex MCP being disconnected — confirm current status before dispatch)
Proposed by: Claude (direct request from Patrick to break CONTRACT-005 into
small tasks)
Proposed date: 2026-09-15
Approved by:
Approved date:
Related contracts: CONTRACT-005 (§1–§3, §7, §9, §10), CONTRACT-001
(`mintSessionToken`/cookie logic reused, not modified), CONTRACT-004
(`getCurrentSigningKey()` consumed, not modified)
Related ADRs: ADR-003
Dependencies: CONTRACT-005 approved (it is)

## Desired outcome

`POST /auth/local-login` exists and works end-to-end: a correct
username/password mints and sets a `bt_session` cookie byte-identical in
shape to CONTRACT-001's Entra path; wrong credentials, disabled accounts,
and locked accounts fail correctly and distinctly per CONTRACT-005 §2; and
`LOCAL_LOGIN` correctly gates this endpoint against CONTRACT-001's Entra
routes as a strict either/or switch.

## Context

This is the foundational piece of CONTRACT-005 — TASK-016 (admin CRUD),
TASK-017 (seed.js bootstrap), and TASK-018 (HTML form) all depend on the
schema and password-hashing path this task establishes. Deliberately scoped
to exclude the admin API, seed-script changes, and the HTML form so this
stays reviewable on its own.

## Scope

### Included

- `local_users` table (CONTRACT-005 §1's exact schema).
- scrypt password hashing per CONTRACT-005 §1's exact parameters, including
  the `maxmem` requirement.
- `POST /auth/local-login` per CONTRACT-005 §2: request/response shape,
  the two-tier enumeration-resistance scheme (merged unknown-username/
  wrong-password; distinct disabled/locked responses), and the uniform-cost
  timing mitigation.
- Brute-force protection per CONTRACT-005 §3: per-account lockout,
  per-source-IP throttle, all four thresholds configurable via the optional
  `.env` variables CONTRACT-005 specifies (`LOCAL_LOGIN_MAX_FAILED_ATTEMPTS`,
  `LOCAL_LOGIN_LOCKOUT_MINUTES`, `LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS`,
  `LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES`).
- `local_login_audit` table and its writes (CONTRACT-005 §6, the
  local-login half only — not the admin-audit table, which is TASK-016's).
- The `LOCAL_LOGIN` mode switch itself (CONTRACT-005 §7): config.ts
  validation, and gating `POST /auth/local-login` vs. CONTRACT-001's
  `GET /auth/login`/`GET /auth/callback` as a strict either/or, both
  falling through to the existing generic 404 when inert.
- The `TENANT_ID`/`CLIENT_ID` conditional-requirement change (CONTRACT-005
  §10): required only when `LOCAL_LOGIN=false`.
- `mintSessionToken`/cookie-construction reuse per CONTRACT-005 §9 — call
  the existing function, do not reimplement it.
- `LOCAL_USER_ADMIN_TOKEN`'s config.ts validation (required, ≥32 chars) —
  the admin API itself is TASK-016's scope, but the env var and its
  startup validation belong here alongside `LOCAL_LOGIN`'s own validation,
  since both are config.ts changes.

### Excluded

- The admin CRUD API (`/admin/users*`) and `local_user_admin_audit` —
  TASK-016.
- `scripts/seed.js` changes — TASK-017.
- The HTML login form (`GET /auth/local-login`) — TASK-018.

## Plan

1. Add the `local_users` and `local_login_audit` tables to `database.ts`'s
   schema string.
2. Implement scrypt-based password hashing/verification (a new module or
   an addition to an existing one — implementer's call, document it).
3. Add `LOCAL_LOGIN`, `LOCAL_USER_ADMIN_TOKEN`, and the four optional
   threshold variables to `config.ts`, including the conditional
   `TENANT_ID`/`CLIENT_ID` requirement.
4. Implement `POST /auth/local-login` in `index.ts`: credential
   verification (§2), lockout/throttle (§3), audit write (§6), token
   minting via the existing `mintSessionToken` (§9).
5. Implement the `LOCAL_LOGIN` gating for both the new endpoint and
   CONTRACT-001's existing routes (§7).

## Acceptance criteria

- [ ] A user created directly in the database (via a validation script —
      the admin API doesn't exist yet) can log in via `POST
      /auth/local-login` and receive a valid `bt_session` cookie.
- [ ] Unknown username and wrong password produce identical 401 responses;
      disabled and locked accounts produce their own distinct responses
      (CONTRACT-005 §2's exact status codes/messages).
- [ ] Ten consecutive wrong-password attempts lock the account; the
      configured lockout window is honored; a correct password after it
      passes succeeds and clears lockout state.
- [ ] `LOCAL_LOGIN=true` makes CONTRACT-001's Entra routes fall through to
      generic 404; `LOCAL_LOGIN=false` makes `/auth/local-login` do the
      same — verified both directions.
- [ ] `LOCAL_LOGIN=true` with `TENANT_ID`/`CLIENT_ID` absent from `.env`
      starts successfully.

## Validation requirements

Per CONTRACT-005's own Validation requirements section (the subset
applicable to this task's scope — excludes anything naming `/admin/users*`
or the HTML form).

## Risks and assumptions

None beyond CONTRACT-005 being approved (it is).

## Blocker

None.

## Implementation handoff

Not started.

## Review

Not reviewed.

## Human acceptance

Pending.
