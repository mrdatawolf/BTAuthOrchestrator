# TASK-018: Minimal HTML login form for local login

Owner role: Implementer
Assigned agent: TBD
Proposed by: Claude (direct request from Patrick to break CONTRACT-005 into
small tasks)
Proposed date: 2026-09-15
Approved by: Patrick
Approved date: 2026-09-15
Related contracts: CONTRACT-005 (§11)
Related ADRs: ADR-003
Dependencies: TASK-015 (wraps its `POST /auth/local-login` endpoint)

## Desired outcome

`GET /auth/local-login` serves a minimal, unstyled HTML form so a human
tester can sign in from a browser without constructing a raw HTTP request.

## Context

Deliberately a thin client-side wrapper, not a second implementation:
CONTRACT-005 §11 requires the form's submission to call TASK-015's
existing `POST /auth/local-login` JSON endpoint via client-side JavaScript,
never a native form POST or any server-side credential-verification logic
of its own.

## Scope

### Included

- `GET /auth/local-login`: minimal HTML page, username/password fields,
  inline `fetch()` call to `POST /auth/local-login`.
- Live only when `LOCAL_LOGIN=true` — same generic-404 gating as the JSON
  endpoint when `LOCAL_LOGIN=false`.
- Success rendering: replace the form with a plain "You're signed in."
  confirmation on the same page (no redirect).
- Failure rendering: display the JSON error response's `error` string
  as-is next to the form (no reinterpretation) — including the exact
  disabled/locked messages when applicable.

### Excluded

- Any change to `POST /auth/local-login`'s own behavior — TASK-015,
  unmodified here.
- Styling, branding, or responsive design — explicitly not required
  (CONTRACT-005 §11).

## Plan

1. Add `GET /auth/local-login` to `index.ts`, gated identically to the
   POST endpoint.
2. Serve a minimal HTML page with a form and an inline `<script>` that
   posts JSON to the existing endpoint via `fetch()`.
3. Render success/failure per CONTRACT-005 §11.

## Acceptance criteria

- [ ] `GET /auth/local-login` returns the HTML form when `LOCAL_LOGIN=true`,
      and the same generic 404 as any unmatched route when
      `LOCAL_LOGIN=false`.
- [ ] Submitting correct credentials via the form results in a `bt_session`
      cookie being set and a visible "You're signed in." confirmation.
- [ ] Submitting incorrect credentials displays the exact error text
      `POST /auth/local-login` returned, unmodified.
- [ ] No credential-verification logic exists in the page itself — the
      only place a username/password is checked is TASK-015's existing
      endpoint.

## Validation requirements

Load the form in a real browser (or headless), submit valid and invalid
credentials, confirm the rendered outcome matches `POST
/auth/local-login`'s actual response in each case.

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
