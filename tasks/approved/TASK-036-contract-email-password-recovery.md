# TASK-036: Contract — email password recovery and session revocation on password change

Owner role: Contract designer
Assigned agent: TBD
Proposed by: Claude, from Patrick's review of PR #3 (2026-10-30)
Proposed date: 2026-10-30
Approved by: Patrick
Approved date: 2026-10-30
Related contracts: CONTRACT-009 (excludes "forgot password" self-service;
defines self-service change and admin reset); CONTRACT-005 (local login,
`bt_session` verification, schema); CONTRACT-001 §4 (session token claims,
unchanged by this task); CONTRACT-014 (container environment inputs and the
TrueNAS form); CONTRACT-013 (ingress; proxy-only mode)
Related ADRs: ADR-001
Dependencies: Patrick approves this task. Sequence with TASK-030, which
also supersedes parts of CONTRACT-005 and CONTRACT-009 and covers the same
audit table, so that two supersessions of the same contract never run at
once. Start after v0.9.0 ships (TASK-033, TASK-034) unless Patrick says
otherwise.

## Desired outcome

A local-login user who has forgotten their password can reset it from an
emailed link. Any password change (self-service, admin reset, or email
reset) ends that user's existing Orca sessions. The session token format
does not change.

## Context

PR #3 (https://github.com/mrdatawolf/BTAuthOrchestrator/pull/3, by Frixon21,
based on `f62524a`) implements email recovery but cannot be merged as is:

- It conflicts with `master` in `.dockerignore`, `docs/DEVELOPMENT.md` and
  `src/index.ts`.
- It contradicts CONTRACT-009, which excludes forgot-password self-service,
  and CONTRACT-001 §4 / CONTRACT-005, which say the session token has exactly
  six claims; the PR adds a seventh (`btv`).
- It reuses the ID TASK-030, which already belongs to local audit retention.
- It adds `LISTEN_HOST`, which conflicts with CONTRACT-013/014; on TrueNAS
  the bind address is the form's Host IPs.
- Its rate-limit table, once full, silently stops sending mail while still
  returning the generic confirmation.

The PR's code and tests are useful reference material: tokens hashed with
SHA-256, single use, a 30-minute expiry, generic responses, origin checks,
and a mail boundary that tests can inject.

## Decisions already made (Patrick, 2026-10-30)

Session revocation uses time, not a new claim:

1. Each local user gets `password_changed_at`. When Orca verifies a
   `bt_session` token, it rejects the token if `iat` is earlier than
   `password_changed_at` rounded down to whole seconds. A token issued in
   the same second as the change survives, and that is accepted. Orca's Node
   process and its database share one server clock.
2. All three password changes set `password_changed_at`: the self-service
   change (CONTRACT-009), the admin reset (CONTRACT-009) and a completed
   email reset. Requesting a reset changes nothing, so nobody can sign a
   user out just by knowing their email.
3. A self-service password change sends a fresh `bt_session` cookie in the
   same response, so the user who made the change stays signed in.
4. An empty `password_changed_at` means the user's sessions are never
   revoked on that basis. The migration leaves existing users empty, so
   nobody is signed out on upgrade.
5. A reset link is valid only if it was issued after `password_changed_at`
   (as well as being unused and inside its 30-minute life). A password
   change by any route therefore cancels outstanding links. Changing the
   user's email or disabling the account also cancels them.
6. The link lifetime is 30 minutes.
7. Other apps that verify tokens offline (ExpenseReport, BTAuthAPI and
   others) keep accepting a revoked user's existing token until it expires
   at local midnight. This is accepted and documented as a known limit.
8. CONTRACT-001 §4 is unchanged: still six claims, no `btv`.
9. Mail uses PR #3's design: Resend's HTTP API, called with Node's
   built-in `fetch`, no new npm dependency, a 10-second timeout, plain
   text, provider responses never logged, and delivery behind an
   injectable function so tests never contact Resend. Changes for the
   contract designer to confirm:
   1. Move it into a general mail module (for example `src/mail.ts`,
      `sendMail({ to, subject, text })`). The recovery code builds its own
      message, and later notification emails can reuse the module.
   2. Use general names for the mail settings (for example `MAIL_FROM`
      and `RESEND_API_KEY`), and a separate setting for the public origin
      used in links.
   3. Bad settings give "Configuration error: …" messages, never a raw
      exception.
   4. The sender may include a display name, for example
      `Orca <notifications@trustbiztech.com>`.
   5. The subject line is neutral or configurable, not hard-coded to
      "BTAuth".
   6. Replace the PR's real-mail test, which has a hard-coded recipient
      and a Windows `.ps1` launcher, with an operator check that sends one
      test email to an address the operator chooses.

   Delivery is asynchronous with no queue: an email in flight when the
   process crashes is lost, and the user requests another. This is
   accepted. The sending domain must be verified in Resend with DNS
   records; that is a deployment step.

## Scope

### Included

A contract, superseding the affected sections of CONTRACT-009 and
CONTRACT-005 under ADR-001 (plus CONTRACT-014's environment-input list if
new variables are added), that records the decisions above and settles:

- **Routes and pages:** forgot-password and reset-password, scanner-safe
  GET (never consumes a link), the token in the URL fragment, responses that
  look the same for unknown, disabled and throttled accounts, and the
  wording when recovery is not configured.
- **Live links:** whether a new request replaces any earlier link, giving
  one live link per user. Recommended: yes.
- **Rate limits:** per-IP and per-email limits, with bounded memory that
  does not fail silently when full (the same defect QA found in TASK-032's
  refusal log).
- **Mail delivery:** reuse PR #3's Resend sender (decision 9), with the
  changes listed there. The contract defines the general mail interface,
  the settings and their validation, and errors in the project's
  "Configuration error: …" format. Recovery stays off unless every
  required setting is present. Also: what an outbound call to Resend means
  for an install that is otherwise offline.
- **Trusted public origin:** the origin used to build links, never taken
  from Host headers, and how it relates to `SERVICE_ISSUER` and the
  Cloudflare hostname.
- **TrueNAS form:** the environment variables the operator adds, and
  whether the API key should be marked secret.
- **Proxy-only mode (CONTRACT-013):** confirm that the new routes are
  admitted only via the trusted proxy, with no new exceptions.
- **Session check:** where it happens. Read `password_changed_at` in the
  query that already loads the user, so it adds no extra query. Also how
  the cookie refresh works on a self-service change.
- **Admin console sessions:** confirm whether the same rule applies to them.
- **Audit:** what is recorded for requests and completed resets, without
  email addresses or tokens in logs. Coordinate with TASK-030.
- **Migration:** additive and idempotent, with empty
  `password_changed_at` for existing users.
- **Failure rows and validation requirements:** for each of the above.

### Excluded

- Implementation. A follow-up implementer task reworks PR #3's code onto
  `master` against the approved contract, keeping the contributor's
  authorship where their code is reused.
- `LISTEN_HOST`.
- Revocation that other apps can see, such as an introspection endpoint.
  That would need a later decision.
- Any change to CONTRACT-001 §4 token claims.

## Plan

1. Patrick approves this task.
2. Contract designer drafts the superseding contract, listing open
   questions.
3. Patrick resolves the questions and approves the contract.
4. Implementer task created; PR #3 closed or superseded with a pointer to
   it.

## Acceptance criteria

- [ ] An approved contract records decisions 1–9 and settles every item
      under Included.
- [ ] The contract supersedes CONTRACT-009's forgot-password exclusion,
      and the affected CONTRACT-005 sections, by ADR-001 supersession, not
      by editing them in place.
- [ ] CONTRACT-001 §4 is unchanged.

## Validation requirements

Human review of the contract.

## Risks and assumptions

- Other apps keep a revoked user's token until midnight (accepted,
  decision 7).
- A one-second window where a token issued just before a password change
  survives (accepted, decision 1).
- Email delivery depends on an outside provider and an outbound internet
  connection.
- If the PR's contributor expects the PR to be merged as is, this needs
  communicating with them.

## Blocker

None.

## Implementation handoff

Not started.

## Review

Not reviewed.
