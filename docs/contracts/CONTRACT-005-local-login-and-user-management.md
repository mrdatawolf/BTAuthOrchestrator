# CONTRACT-005: Local username/password login and user management

Status: Proposed
Approved by:
Approved date:
Related tasks: None yet. This contract was commissioned directly by Patrick in
conversation (2026-09-15) rather than from an existing task file — he decided
live that a permanent local-login path and an HTTP user-admin API are wanted,
and asked for a contract to be drafted directly against that direction. Per
`CLAUDE.md` ("do not begin implementation without an approved task"), a task
file translating this contract into an implementation plan still needs to be
filed and approved before any of this is built; this contract does not itself
authorize implementation.
Related ADRs: None govern this directly. See Open questions for whether this
decision (a permanent local-login path alongside Entra, reversing part of
NOTES.md §3's original reasoning) warrants its own ADR for the record, the
way ADR-002 recorded the break-glass decision.
Supersedes:
Superseded by:

## Purpose

Define, precisely enough to implement without further architectural
decisions, a permanent local username/password login path that mints a
BTAuthOrchestrator session token and cookie byte-identical in shape to
CONTRACT-001's Entra-issued token, plus an HTTP admin API for creating,
listing, updating, and disabling/deleting the local user records this login
path authenticates against.

This exists so the system can be exercised end-to-end — by both automated
tests and real people during testing — without depending on a live,
interactively-driven Entra OIDC flow. Per Patrick's explicit direction, this
is a **permanent** addition that coexists with Entra once Entra work resumes,
built with the same rigor as the rest of this project — not throwaway test
scaffolding, and not a design this contract treats as needing to relitigate
NOTES.md §3's original Entra-vs-local-accounts reasoning. That reasoning
still holds for why Entra is the org's primary identity source; this contract
adds a second, parallel front door for a different purpose (testability), not
a replacement. "Coexists" describes the codebase/capability, not simultaneous
runtime reachability: per Required behavior §7, exactly one of the two login
paths is live in a given running instance at a time, governed by the
`LOCAL_LOGIN` mode switch — this is a permanent *option* the service
supports, not a permanently-simultaneous pair of live front doors.

This contract treats the following as settled, per direct instruction:
- The local-login path must mint the exact same `bt_session` token shape
  CONTRACT-001 defines, via the same `mintSessionToken` function, so nothing
  downstream (JWKS, consuming-app verification) needs to know or care which
  path minted a given token.
- User CRUD is exposed via an HTTP admin API, not a CLI-only tool (Patrick's
  explicit choice over extending `scripts/seed.js`-style tooling).
- Real, non-stub password hashing is required.
- User creation is admin/operator-driven; there is no self-service signup
  flow, consistent with NOTES.md §2's "no external/self-service user"
  constraint.

## Scope

### Included

- Schema for local user records: identity fields satisfying CONTRACT-001's
  claim shape, password hash storage, and an active/disabled flag.
- The password hashing scheme: algorithm, parameters, and storage format.
- The local-login endpoint: request/response shape and failure behavior,
  including which of "unknown user," "wrong password," "disabled," and
  "locked" are distinguishable to the caller (a two-tier scheme — see
  Required behavior §2).
- Brute-force/credential-stuffing protection on the local-login endpoint:
  per-account lockout, a coarse per-source-IP throttle, and a timing-based
  mitigation against username enumeration via response latency.
- The admin CRUD API: endpoints, request/response shapes, and its own
  authorization mechanism (a dedicated bearer credential, distinct from
  CONTRACT-003's `EMERGENCY_ROTATION_TOKEN`).
- How the very first local user is provisioned (the bootstrap
  chicken-and-egg problem).
- An audit trail for local-login attempts and for admin CRUD actions.
- Whether/how this entire capability can be disabled in a given deployment.
- This contract's relationship to CONTRACT-001 (token minting/cookie reuse)
  and CONTRACT-004 (storage conventions, explicitly not reused for password
  hashing — see "Interfaces").

### Excluded

- Any change to CONTRACT-001's or CONTRACT-004's own text, schema, or
  interfaces. Both are referenced as-is; neither is edited (CONTRACT-004 is
  `Proposed`, not yet approved, and CONTRACT-001 is `Approved` and therefore
  immutable per ADR-001 regardless).
- Self-service signup, password reset via email, "must change password on
  first login," or any invite-link flow — all excluded per NOTES.md §2's
  no-external-user, admin-driven-only framing. Not designed here; flagged in
  Open questions only where the absence is a genuine judgment call.
- Per-user session revocation (killing an already-issued token before its
  natural `exp`). Disabling a local user prevents *future* logins only; an
  already-minted token for that user remains valid until its midnight-local
  expiry, the same accepted bound CONTRACT-001/CONTRACT-003 already establish
  for the Entra path. Immediate global revocation remains CONTRACT-003's
  emergency-rotation "kill switch," unchanged and out of scope here.
- Any browser-rendered login form or admin UI. This contract specifies a
  JSON HTTP API only, consistent with NOTES.md's "no UI polish" posture and
  CONTRACT-003's "no browser-facing admin UI" precedent — see Open questions
  for whether a minimal HTML login form is separately wanted given real
  people (not just automated tests) are expected to use this.
- Rotating `DB_ENCRYPTION_KEY` or any other concern already scoped to
  CONTRACT-004; this contract adds new tables alongside CONTRACT-004's but
  does not touch its envelope-encryption machinery (see Interfaces for why).
- Migration ownership (which task/tool applies the schema below) — not
  prescribed here, same posture as CONTRACT-003's Open question #8.

## Actors

- **Local test user** — a person (or an automated test harness acting as
  one) authenticating with a username and password instead of interactively
  through Entra. Not synonymous with any Entra identity; a local user record
  and an Entra account are entirely independent, even if the same human holds
  both.
- **User-admin operator** — a human (initially Patrick) who possesses the
  dedicated `LOCAL_USER_ADMIN_TOKEN` credential and uses it to create, list,
  update, or delete local user records via the admin API.
- **BTAuthOrchestrator process** — authenticates local-login attempts,
  authenticates admin-API requests, performs password verification, mints
  session tokens (via CONTRACT-001's existing `mintSessionToken`), and writes
  audit records.
- **CONTRACT-004 storage layer** (indirect actor) — supplies
  `getCurrentSigningKey()`, unchanged, for token minting. This contract's own
  new tables (`local_users`, `local_login_audit`, `local_user_admin_audit`)
  live in the same PGlite database but are not part of CONTRACT-004's
  `SecretsStore` interface — see Interfaces.
- **Consuming apps** (indirect) — unaffected. They verify `bt_session`
  exactly as CONTRACT-001 already defines, with no visibility into or
  dependency on which login path minted a given token.

## Inputs and outputs

**Inputs:**
- `LOCAL_USER_ADMIN_TOKEN` (from `.env`) — the admin API's dedicated bearer
  credential.
- `LOCAL_LOGIN` (from `.env`) — the mode-switch flag governing whether
  `/auth/local-login` or CONTRACT-001's Entra routes are the live login path
  (Required behavior §7). Confirmed by Patrick directly as the canonical
  name (matching the tracked `.env.example`); the real, git-ignored `.env`'s
  `ALLOW_LOCAL` was a stale/mistaken value he will correct separately, not a
  competing canonical name.
- `POST /auth/local-login` request body: `{ "username": string, "password":
  string }`.
- `POST /admin/users`, `PATCH /admin/users/:id` request bodies carrying
  `username`/`email`/`password`/`isActive`/optional `actedBy` fields (see
  Interfaces for exact shapes per endpoint).
- The current RS256 signing key, obtained via CONTRACT-004's
  `getCurrentSigningKey()` — unchanged, same call CONTRACT-001's callback
  handler already makes.

**Outputs:**
- On successful local login: the identical class of response CONTRACT-001's
  callback produces on success — a `bt_session` cookie (via the same
  `mintSessionToken` call and cookie-construction logic) plus a minimal JSON
  confirmation that never includes the token value.
- On admin-API success: a JSON representation of the affected user record
  (id, username, email, active flag, timestamps) — **never** a password hash
  or any hashing parameter.
- Durable audit records for every local-login attempt (success or failure)
  and every admin CRUD action (success or failure), per Required behavior §6.
- On any failure: a clear, generic, non-revealing JSON error response,
  status-coded per the taxonomy in Failure behavior — never a raw exception
  or stack trace, matching CONTRACT-001's and CONTRACT-003's existing
  posture.

## Preconditions

- `LOCAL_USER_ADMIN_TOKEN` is present in `.env`, non-empty, and at least 32
  characters — same format/length rule as CONTRACT-003's
  `EMERGENCY_ROTATION_TOKEN`, and deliberately a **separate** value from it
  (see Required behavior §4 for the least-privilege reasoning). If absent or
  too short, the process fails closed at startup.
- `LOCAL_LOGIN` is present in `.env` and, after trimming and case-folding,
  equals exactly `"true"` or `"false"` — required, like every other variable
  in `config.ts`'s `requiredVariables` list, with **no implicit default**.
  Any other value (missing, empty, or anything other than `true`/`false`
  case-insensitively — e.g. `"1"`, `"yes"`, a typo) fails the process closed
  at startup with a clear, non-secret-revealing error naming the variable,
  the same class of validation `config.ts` already applies to
  `DB_ENCRYPTION_KEY` and `EMERGENCY_ROTATION_TOKEN`. This is a real,
  explicit decision this variable directly controls (per Patrick's own
  framing: "if true, the system uses local username/passwords, otherwise
  Entra required"), not a soft default the way `COOKIE_SECURE`'s value is
  currently only presence-checked, not format-validated, in `config.ts` as
  it exists today — see Required behavior §7's note on this being a slight
  strengthening beyond `COOKIE_SECURE`'s current literal validation.
- A migration adding this contract's three new tables (`local_users`,
  `local_login_audit`, `local_user_admin_audit`; schema in Interfaces) has
  been applied to `PGLITE_DATA_DIR` before either `/auth/local-login` or any
  `/admin/users*` endpoint serves a request.
- CONTRACT-004's storage layer is available and seeded (a current signing key
  exists), since local login mints tokens via the same
  `getCurrentSigningKey()` call CONTRACT-001's path uses.
- BTAuthOrchestrator's origin is served over TLS (TASK-003d), identical to
  CONTRACT-001's and CONTRACT-003's precondition — this endpoint carries a
  human password in a request body and must never be reachable over a plain
  HTTP listener path.
- CONTRACT-004's single-process constraint holds; this contract's in-memory
  per-source-IP throttle (§3) relies on it the same way CONTRACT-001's
  in-memory handshake store does.
- `TENANT_ID` and `CLIENT_ID` are required, non-empty preconditions **only
  when `LOCAL_LOGIN=false`**; when `LOCAL_LOGIN=true` they are not
  preconditions at all and may be absent — see Required behavior §10.

## Required behavior

### 1. Schema and password hashing

**Table `local_users`:**

| Column | Type | Notes |
|---|---|---|
| `id` | text, primary key | `crypto.randomUUID()`, generated once at creation, never reused — this is the session token's `sub`. |
| `username` | text, unique, not null | Login identifier; stored and compared lowercase (normalized at write time). Also the session token's `upn` — the closest local equivalent to Entra's `preferred_username`. 3–64 characters, application-validated as lowercase ASCII letters, digits, `.`, `-`, `_`. |
| `email` | text, unique, not null | The session token's `email`. |
| `password_hash` | bytea, not null | scrypt derived key. Stored as plain bytes, **not** further AES-GCM-wrapped — see "Resolved decisions" #1 for why this deliberately does not reuse CONTRACT-004's envelope encryption. |
| `password_salt` | bytea, not null | 16 random bytes, freshly generated per password set/change. |
| `password_algorithm` | text, not null, default `'scrypt'` | Application-validated against a small allow-list, not DB-constrained — same pattern as `signing_keys.algorithm`, so a future algorithm needs no schema change. |
| `password_cost_n` | integer, not null | scrypt `N`. Stored per-row (not just globally) so a future default-parameter change doesn't invalidate existing hashes — see §1's parameter note. |
| `password_block_size_r` | integer, not null | scrypt `r`. |
| `password_parallelization_p` | integer, not null | scrypt `p`. |
| `password_key_length` | integer, not null | Derived key length in bytes. |
| `is_active` | boolean, not null, default `true` | `false` blocks future logins without deleting the record or its audit history. |
| `failed_login_attempts` | integer, not null, default `0` | See §3. |
| `locked_until` | timestamptz, nullable | See §3. |
| `created_at` | timestamptz, not null, default `now()` | |
| `updated_at` | timestamptz, not null, default `now()` | |
| `created_by` | text, nullable | Operator-self-asserted label (`actedBy`), same unverified-attribution caveat as CONTRACT-003's `triggered_by`. |

**Table `local_login_audit`:**

| Column | Type | Notes |
|---|---|---|
| `id` | text, primary key | `crypto.randomUUID()`. |
| `attempted_at` | timestamptz, not null, default `now()` | |
| `username` | text, not null | As submitted, even if it matches no row — useful for spotting enumeration/spray attempts. |
| `result` | text, not null | `'success'` or `'failure'`. |
| `failure_reason` | text, nullable | One of `'unknown_username'`, `'bad_password'`, `'disabled'`, `'locked'`. Populated only on failure. This is intentionally **more granular than the HTTP response** — see §2's enumeration-resistance discussion for why the caller never sees this distinction but an operator inspecting audit rows can. |
| `source_ip` | text, nullable | Best-effort, same extraction convention as CONTRACT-003's `source_ip` (`X-Forwarded-For` first entry, else socket peer address). |

**Table `local_user_admin_audit`:**

| Column | Type | Notes |
|---|---|---|
| `id` | text, primary key | `crypto.randomUUID()`. |
| `occurred_at` | timestamptz, not null, default `now()` | |
| `action` | text, not null | One of `'create'`, `'update'`, `'delete'`, `'auth_failure'`. |
| `target_user_id` | text, nullable | Null if the action failed before an id existed (e.g. bad bearer token, or a create that failed validation). |
| `target_username` | text, nullable | |
| `changed_fields` | text, nullable | Comma-separated field names actually changed by an `update` action (e.g. `"email,isActive"`). Never includes the password value itself. |
| `result` | text, not null | `'success'` or `'failure'`. |
| `failure_reason` | text, nullable | Short category (e.g. `'bad_credential'`, `'not_found'`, `'validation_error'`, `'conflict'`). |
| `actor_label` | text, nullable | Operator-self-asserted `actedBy`, same unverified-attribution caveat as CONTRACT-003. |
| `source_ip` | text, nullable | |

**Password hashing scheme: scrypt (Node's built-in `crypto.scrypt`), not
bcrypt or argon2id.**

Chosen specifically because this project currently has exactly two runtime
dependencies (`@electric-sql/pglite`, `jose`), and every existing
security-sensitive primitive in the codebase (AES-256-GCM in
`secrets.ts`, `timingSafeEqual` in `index.ts`) already uses Node's built-in
`crypto` module rather than a third-party library. `crypto.scrypt` is
memory-hard (unlike bcrypt, which is not, and is generally regarded as more
GPU/ASIC-resistant than bcrypt for equivalent tuning) and requires zero new
dependencies, consistent with this project's established posture. Argon2id
is the more current OWASP first choice, but is unavailable in Node's
standard library and would require adding a native-module dependency purely
for this feature. This was a real tradeoff, and `scrypt` is **confirmed by
Patrick (2026-09-15)** rather than left as an open question — see "Resolved
decisions."

**Parameters** (stored per-row so future changes don't retroactively
invalidate existing hashes):
- `N` (cost factor): `131072` (2^17).
- `r` (block size): `8`.
- `p` (parallelization): `1`.
- Derived key length: `64` bytes.
- Salt: `16` random bytes (`crypto.randomBytes(16)`), fresh per password
  set/change, never reused.

**Implementation note (interoperability requirement, not an implementation
suggestion):** Node's `crypto.scrypt`/`scryptSync` default `maxmem` is 32 MiB
(`32 * 1024 * 1024` bytes). The chosen `N`/`r`/`p` require approximately
`128 * N * r * p` = ~128 MiB, which exceeds that default and will throw
`ERR_CRYPTO_INVALID_SCRYPT_PARAMS` unless an explicit `maxmem` of at least
that size is passed on every call (both hashing and verification). This
contract requires `maxmem` be set to at least `268435456` (256 MiB) on every
scrypt invocation this feature performs, with headroom above the ~128 MiB
minimum. This is stated as a required parameter (like CONTRACT-004's IV/tag
lengths), not an implementation detail, because getting it wrong is an
observable functional failure (every hash operation throws), not a style
choice.

**Storage format:** `password_hash`/`password_salt` as raw `bytea`, with
`password_algorithm`/`password_cost_n`/`password_block_size_r`/
`password_parallelization_p`/`password_key_length` as sibling columns
(rather than a single packed/PHC-style string), matching this project's
existing convention of typed columns over an encoded blob (see
`signing_keys`).

### 2. Local-login endpoint — `POST /auth/local-login`

Request: `Content-Type: application/json`, body `{ "username": string,
"password": string }`. Both fields required, non-empty strings; anything
else is a 400 (malformed request) before any user lookup or hashing occurs.

**Credential verification, in order, every time (see also §3 for lockout
interaction):**

1. Check the per-source-IP throttle (§3). If exceeded, respond 429
   immediately — no user lookup, no hashing.
2. Normalize `username` to lowercase and look up the matching `local_users`
   row.
3. **Regardless of whether a row was found**, perform a password-derivation
   computation of the same cost:
   - If found: derive a candidate hash using the row's stored
     `password_salt`/`password_cost_n`/`password_block_size_r`/
     `password_parallelization_p`/`password_key_length`, and compare to
     `password_hash` via `crypto.timingSafeEqual` (never `===`).
   - If not found: derive against a fixed, non-secret, hardcoded dummy
     salt/password using the same current default parameters (`N=131072,
     r=8, p=1, keylen=64`) new users are created with, so response latency
     for an unknown username is not measurably cheaper than for a known
     username with a wrong password. The exact dummy value is an
     implementation detail (fixed and deterministic, never derived from the
     request), not prescribed further here.
   - **This computation happens even if the row is found but `is_active =
     false` or currently locked** — the outcome is decided only *after* the
     computation completes, so that the disabled/locked/wrong-password/
     unknown-username cases are not distinguishable from each other by
     response timing either.
4. Determine the outcome:
   - Row not found → failure, `failure_reason = 'unknown_username'`.
   - Row found, `locked_until` is non-null and in the future → failure,
     `failure_reason = 'locked'`, regardless of whether the password
     matched. Lockout state is left untouched by this attempt (see §3 — an
     attempt made while already locked never further extends the lockout).
   - Row found, `is_active = false` → failure, `failure_reason =
     'disabled'`, regardless of whether the password matched.
   - Row found, active, not locked, password does not match → failure,
     `failure_reason = 'bad_password'`; increment `failed_login_attempts`
     (see §3).
   - Row found, active, not locked, password matches → success; reset
     `failed_login_attempts = 0` and `locked_until = NULL`.
5. Write one `local_login_audit` row for this attempt (best-effort — see
   Failure behavior for what happens if this write itself fails).
6. Respond.

**Response by outcome — a two-tier scheme, confirmed by Patrick
(2026-09-15), not full-generic-for-everything.** `POST /auth/local-login`'s
HTTP response depends on which of the four outcomes in step 4 applies:

- **Merged/generic (enumeration-resistant):** unknown username and wrong
  password produce the **identical** response — `401`, body
  `{"error":"Invalid username or password."}`. These two remain
  indistinguishable because they are the pair that most directly benefits
  an external attacker (confirming a username exists at all, vs. merely
  continuing to guess its password) — the same "don't reveal which specific
  check failed" posture CONTRACT-001 already applies to ID-token validation
  failures.
- **Disabled account — its own distinct response:** `403`, body
  `{"error":"This account has been disabled."}`.
- **Locked account — its own distinct response, naming the unlock time:**
  `423`, body `{"error":"This account is temporarily locked. Try again
  after <locked_until, ISO 8601>."}`.

**Why disabled/locked get distinct responses while unknown/wrong-password
stay merged.** This is an internal, admin-provisioned tool with no public
signup — the population that can legitimately hit "disabled" or "locked" is
exactly the set of testers/operators who already know their own username
exists, so telling them apart from "you mistyped your password" is more
valuable here than the marginal enumeration resistance given up: a 403/423
response tells a prober only that the *specific username they already
guessed* exists and is currently disabled/locked, not its password, and
per-account lockout (§3) already bounds how many guesses produce that
signal at all. Enumeration resistance for the unknown-vs-wrong-password
pair — the signal an attacker actually needs to make guessing worthwhile —
is unchanged and remains as strict as before.

**This split does not reopen a timing side channel.** The uniform-cost
password-derivation computation in step 3 runs to completion — for all four
outcomes, including disabled and locked — *before* the outcome is decided in
step 4. The two-tier response scheme introduced here only changes what is
sent *after* that already-uniform, already-completed computation; it does
not change when, whether, or how expensively that computation runs. An
attacker measuring response latency still cannot distinguish "unknown
username" from "known username, wrong password" — the pair that still
merges into one response — by timing, because both paths do the same
work before diverging. Disabled and locked are now distinguishable by
response *content* (403/423 vs. 401), which was always a more direct and
intentional signal than timing ever was for those two causes.

**Success response:** `200`, `Content-Type: application/json`, body
`{"status":"signed_in","username":"<username>"}`, and a `Set-Cookie` header
carrying the `bt_session` cookie — see §9 for how this is produced. The token
value never appears in the JSON body.

### 3. Brute-force / credential-stuffing protection

Human-chosen passwords are not high-entropy the way CONTRACT-003's
`EMERGENCY_ROTATION_TOKEN` is (CONTRACT-003 explicitly reasoned that its
bearer token's 32+ random characters make network brute force impractical
and skipped rate-limiting on that basis). That reasoning does not transfer
here, so this contract defines explicit protection rather than silently
omitting it:

**Per-account lockout.** After `10` consecutive failed attempts against a
given `username` (tracked via `local_users.failed_login_attempts`), the
account is locked: `locked_until` is set to `now() + 15 minutes`. While
`locked_until` is in the future, every attempt fails with `reason='locked'`
(§2) regardless of the password supplied, and lockout state is **not**
further modified by attempts made during the lockout window (so repeated
retries during lockout cannot indefinitely extend it). Once `locked_until`
has passed, attempts are evaluated normally again; a further wrong password
immediately re-locks (extending `locked_until` again from that point), and a
correct password succeeds and clears both fields. `10` attempts / `15`
minutes are this contract's own judgment calls, not derived from any stated
requirement — flagged in Open questions.

**Per-source-IP throttle (secondary defense against spraying across many
usernames from one source, which per-account lockout alone does not stop).**
An in-memory, single-process counter (same class of mechanism, and same
accepted "resets on restart" tradeoff, as CONTRACT-001's in-memory OIDC
handshake store) tracks failed `/auth/local-login` attempts per source IP
over a rolling 5-minute window. At `20` failed attempts from one source IP
within that window, further attempts from that IP receive `429` (`{"error":
"Too many sign-in attempts. Try again later."}`) without a user lookup or
hashing, until the window rolls forward. This does not apply to
`/admin/users*` — see the reasoning below.

**No rate-limiting on the admin API's own bearer credential.** Consistent
with CONTRACT-003's own reasoning for `EMERGENCY_ROTATION_TOKEN`:
`LOCAL_USER_ADMIN_TOKEN` is required to be at least 32 random characters
(Preconditions), making network brute force impractical within any human
timescale. This contract applies the same reasoning CONTRACT-003 applied and
does not add throttling there, for the same reason.

### 4. Admin CRUD API authorization

**A dedicated, separate bearer credential, `LOCAL_USER_ADMIN_TOKEN`, distinct
from `EMERGENCY_ROTATION_TOKEN`.** Provisioned the same way
(`.env`-configured, operator-generated e.g. via `openssl rand -hex 32`, read
directly from `process.env`, never stored in PGlite), and checked the same
way: `Authorization: Bearer <token>`, compared via `crypto.timingSafeEqual`
over equal-length buffers (unequal lengths are an immediate mismatch),
never `===`. On mismatch or malformed header: `401`, generic body
(`{"error":"Unauthorized"}`), does not distinguish missing/malformed/wrong —
identical posture to CONTRACT-003 §2.

**This is deliberately a separate token, not a reuse of
`EMERGENCY_ROTATION_TOKEN`, on least-privilege grounds:** emergency rotation
is a rare, global, maximal-blast-radius action (invalidates every session in
the org instantly); local-user CRUD is a routine, narrow-blast-radius action
(affects only local test accounts, and does not itself invalidate any
existing session). Anyone who can create/disable a test user should not
thereby also be able to trigger a global kill switch, and vice versa —
conflating the two credentials would widen the blast radius of a leak of
either one. This mirrors CONTRACT-003's own reasoning for why an
otherwise-valid `bt_session` cookie must never substitute for
`EMERGENCY_ROTATION_TOKEN`: different trust boundaries get different
credentials. **Confirmed by Patrick (2026-09-15)** — see "Resolved
decisions."

`LOCAL_USER_ADMIN_TOKEN`'s value never appears in any log line, audit
record, response body, or error message, in either the success or failure
path — same posture already required for `EMERGENCY_ROTATION_TOKEN`,
`CLIENT_SECRET`, and `DB_ENCRYPTION_KEY`.

**Error specificity on the admin surface is intentionally different from the
public login surface.** Unlike `/auth/local-login` (§2), authenticated admin
endpoints may return specific error messages (e.g. "a user with that
username already exists," "no such user") without weakening enumeration
resistance in any meaningful way — the caller already holds
`LOCAL_USER_ADMIN_TOKEN` and can already enumerate every user via `GET
/admin/users`. Enumeration resistance only matters on the unauthenticated
surface.

### 5. Bootstrap: provisioning the first local user

There is no chicken-and-egg problem for the admin API itself:
`LOCAL_USER_ADMIN_TOKEN` is read from `.env` at process start, exactly like
`EMERGENCY_ROTATION_TOKEN`, so the admin API is reachable as soon as the
process is up — it requires no prior database seeding. Unlike
`CLIENT_SECRET`/the initial signing key (which CONTRACT-001's login flow
needs before it can handle its very first request, and which therefore
*must* be seeded via `scripts/seed.js` before startup), no local user is
needed until someone actually calls `/auth/local-login` — so **this contract
does not require extending `scripts/seed.js`.** The first local user is
created the same way every subsequent one is: `POST /admin/users` with
`Authorization: Bearer <LOCAL_USER_ADMIN_TOKEN>`, once the service is
running.

This is flagged as an explicit Open question rather than treated as
obviously settled, since a `scripts/seed.js` extension (optionally seeding
one local user at bootstrap time, mirroring how `CLIENT_SECRET`/the signing
key are seeded) is a real, only-slightly-more-complex alternative that some
operators might prefer for convenience in a fresh environment.

### 6. Audit trail

Every `/auth/local-login` attempt (success or failure, per §2) produces
exactly one `local_login_audit` row. Every admin CRUD action — `create`,
`update`, `delete` — and every admin-API authentication failure produces
exactly one `local_user_admin_audit` row, mirroring CONTRACT-003 §4's
"attempt, not just success, is audited" posture. As with CONTRACT-003, "who"
for an admin action is necessarily "the holder of a valid
`LOCAL_USER_ADMIN_TOKEN`, optionally self-identified via `actedBy`" — the
same unverified-attribution limitation CONTRACT-003 already accepts for a
shared static secret, carried forward here rather than re-litigated.

Audit writes are best-effort and must never block the response they
describe: if a `local_login_audit` or `local_user_admin_audit` insert fails
(e.g. database unreachable), the caller's response is not affected, and a
server-side log line records at minimum a timestamp and the attempted
action/result category as a backstop — identical posture to CONTRACT-003's
audit-write failure handling.

No retention/cleanup policy is specified — rows are never deleted by this
contract's own behavior, mirroring CONTRACT-003/CONTRACT-004's stance on
their own audit/history tables. This is flagged as a genuinely new
consideration in Open questions, since (unlike the rare emergency-rotation
trigger) `/auth/local-login` may be called very frequently by automated test
suites, and unbounded audit-row growth from routine automated testing is a
different operational shape than CONTRACT-003 ever had to consider.

### 7. Mode-switch flag — `LOCAL_LOGIN`

**Decided by Patrick directly, confirmed in two stages:**

1. *"if true[,] the system uses local username/password[s], otherwise entra
   required. This will keep a local out of date username/password from being
   used to attack the system."*
2. Final confirmation, verbatim: *"LOCAL_LOGIN is a switch. if true only
   local logins are allowed and if false only Entra/Azure type logins are
   allowed."*

This settles both *whether* to gate local login and *how mutually exclusive*
the two paths are: **`LOCAL_LOGIN` is a strict, whole-service mode switch,
not an additive toggle.** Exactly one of the two login paths is live at any
time — never both, never neither. What follows specifies this precisely
enough to implement; it is no longer an open design question.

**When `LOCAL_LOGIN=false` (Entra-only mode):**
- `POST /auth/local-login` is fully inert: a request to that path falls
  through to the same generic `404` ("Not found") response used for every
  other unmatched route, identical to CONTRACT-003's own treatment of a
  wrong-method/wrong-path request to its trigger endpoint. No
  username/password comparison, lockout check, or audit-table read/write of
  any kind occurs — the route is inert, not merely credential-rejecting.
  This directly satisfies Patrick's stated reasoning: a stale or weak local
  credential sitting in `local_users` must not be usable to attack the
  system at all while this mode isn't active.
- `GET /auth/login` and `GET /auth/callback` (CONTRACT-001's Entra routes)
  are live and behave exactly as CONTRACT-001 already specifies, entirely
  unaffected.

**When `LOCAL_LOGIN=true` (local-only mode):**
- `POST /auth/local-login` is live and behaves exactly as §1–§6 and §9
  specify.
- `GET /auth/login` and `GET /auth/callback` become fully inert by the same
  standard as above: a request to either path falls through to the generic
  `404` response used for every other unmatched route — not a distinct
  "Entra disabled" error, so an unauthenticated prober cannot distinguish
  "this route doesn't exist" from "this route exists but is disabled" in
  either direction of the switch. No Entra discovery fetch, no handshake
  entry, no token exchange, no code in CONTRACT-001's required behavior
  executes while inert.

**What this flag does *not* gate, in either state:**
- `GET /.well-known/jwks.json` remains live regardless of `LOCAL_LOGIN`.
  Both login paths mint tokens using the same current signing key
  (CONTRACT-004's `getCurrentSigningKey()`, §9), so consuming apps must
  always be able to verify a `bt_session` token — including one minted
  before a mode switch, or under whichever mode was active when it was
  issued — without needing to know or care which mode the service is
  currently in.
- `POST /admin/emergency-rotate-keys` (CONTRACT-003) is entirely unaffected;
  it has no relationship to this flag.
- `/admin/users*` is **not** gated by `LOCAL_LOGIN` — the admin CRUD API
  remains reachable (subject only to its own `LOCAL_USER_ADMIN_TOKEN` check)
  regardless of this flag's value, so an operator can provision/curate local
  user records whether or not local-login mode is currently active (e.g.
  pre-staging accounts before switching a deployment into local-only mode).
  This is a separate judgment call, not directly addressed by Patrick's
  words about the login-mode switch itself, and remains flagged in Open
  questions.

**A consequence worth stating plainly, not left implicit:** in a deployment
running `LOCAL_LOGIN=true`, no one can sign in via Entra at all, including
real staff members who would otherwise use their normal O365 credentials —
that deployment's login surface is entirely local-username/password for as
long as the flag is set that way. This is the direct, intended effect of
Patrick's "switch," not an accepted side effect this contract is working
around.

### 8. Failure responses are never raw errors

Every failure path defined in "Failure behavior" renders a plain JSON error
body — never an unhandled exception, stack trace, or raw framework error —
identical posture to CONTRACT-001 §8 and CONTRACT-003's failure handling.

### 9. Reuse of CONTRACT-001's minting machinery — byte-for-byte, not a
reimplementation

On a successful local login, BTAuthOrchestrator must:

1. Obtain the current signing key via CONTRACT-004's `getCurrentSigningKey()`
   — the exact same call CONTRACT-001's callback handler makes.
2. Call `mintSessionToken({ sub: user.id, email: user.email, upn:
   user.username }, signingKey, config.issuer, now)` — the exact same
   function (`src/tokens.ts`) CONTRACT-001's callback handler calls, with no
   modification to that function's signature or behavior.
3. Build and set the `bt_session` cookie using the identical name, domain,
   `HttpOnly`, `Secure` (governed only by `COOKIE_SECURE`, never `NODE_ENV`),
   `SameSite=Lax`, `Path=/`, and `Expires`/`Max-Age`-matches-`exp` rules
   CONTRACT-001 §7 defines — the same cookie-construction logic CONTRACT-001's
   implementation already uses, not a separate implementation that happens to
   produce a matching shape.

This is the mechanism by which "nothing downstream needs to know or care
which path minted a token" is actually guaranteed, rather than merely
asserted: both paths converge on the same function calls, so any future
change to CONTRACT-001's token/cookie shape automatically applies to this
path too without this contract needing a matching edit.

### 10. Conditional startup requirement — `TENANT_ID`/`CLIENT_ID` required
only when `LOCAL_LOGIN=false`

**Confirmed by Patrick (2026-09-15).** `config.ts`'s validation must treat
`TENANT_ID` and `CLIENT_ID` as required only when `LOCAL_LOGIN=false`. When
`LOCAL_LOGIN=true`, both may be absent or empty in `.env` without failing
startup; if present anyway, they are simply unused, since `GET
/auth/login`/`GET /auth/callback` are inert in that mode (§7), and their
values (if any) are not validated.

**This does not touch CONTRACT-001's own text.** CONTRACT-001 depends on
`TENANT_ID`/`CLIENT_ID` being available *when its routes are reachable*, but
its document does not itself mandate that `config.ts` require them
unconditionally at every process startup regardless of whether those routes
will ever be reached — that unconditional requirement was TASK-007's own
`config.ts` implementation choice, not a requirement CONTRACT-001 states.
Making the requirement conditional on `LOCAL_LOGIN` is therefore a change to
`config.ts`'s existing validation logic, introduced by this contract, not an
edit to CONTRACT-001's approved text — no ADR-001 immutability conflict.

Required behavior:
- At startup, configuration loading reads `LOCAL_LOGIN` before evaluating
  whether `TENANT_ID`/`CLIENT_ID` are required.
- If `LOCAL_LOGIN=false`: `TENANT_ID` and `CLIENT_ID` are required and
  non-empty, exactly as `config.ts` already validates today — unchanged in
  this case, and still fails the process closed at startup if either is
  missing or empty.
- If `LOCAL_LOGIN=true`: `TENANT_ID` and `CLIENT_ID` are **not** required.
  Their absence, or an empty value, is not a startup error. If present with
  a non-empty value anyway (e.g. left over from a prior Entra-enabled
  configuration), the process starts normally and simply never uses them.
- `CLIENT_SECRET` needs no equivalent change: it is read lazily from
  CONTRACT-004's storage only at actual Entra-callback time — never at
  startup, and never at all in a deployment that only ever runs
  `LOCAL_LOGIN=true` — so it was never a startup blocker to begin with.
- `LOCAL_USER_ADMIN_TOKEN` and `LOCAL_LOGIN` itself remain unconditionally
  required regardless of `LOCAL_LOGIN`'s own value (Preconditions); this
  conditional-requirement treatment applies only to `TENANT_ID`/`CLIENT_ID`.

This directly resolves the friction this contract's own motivating goal
otherwise had: a deployment intended purely for `LOCAL_LOGIN=true` testing
can now omit `TENANT_ID`/`CLIENT_ID` from `.env` entirely, with no Entra app
registration required at all to start the process.

## Postconditions and invariants

**Postconditions (true after a successful local login):**
- Exactly one `bt_session` cookie is set, with a value that is a
  well-formed RS256 JWT containing exactly CONTRACT-001 §4's six claims —
  indistinguishable in shape from a token minted via the Entra path.
- The authenticated user's `failed_login_attempts` is `0` and `locked_until`
  is `NULL`.
- Exactly one `local_login_audit` row exists for this attempt with
  `result = 'success'`.

**Postconditions (true after a successful admin CRUD action):**
- `create`: exactly one new `local_users` row exists, with a freshly
  generated `id` never reused from any prior (including deleted) row, and a
  freshly generated `password_salt`.
- `update` (password change): `password_hash`/`password_salt`/parameter
  columns reflect the new password; `failed_login_attempts = 0`,
  `locked_until = NULL`.
- `delete`: the `local_users` row no longer exists; existing
  `local_login_audit`/`local_user_admin_audit` rows referencing that
  username/id are **not** deleted (no foreign key ties them to the user
  row — same "audit history outlives the thing it describes" pattern
  CONTRACT-003's audit table already establishes relative to `signing_keys`).
- Exactly one new `local_user_admin_audit` row exists with
  `result = 'success'`, naming the action and affected user.

**Invariants (always true):**
- `LOCAL_USER_ADMIN_TOKEN` never appears in any log line, audit row,
  response body, or error message.
- No `local_users` row's `password_hash`, `password_salt`, or any password
  parameter ever appears in any HTTP response, from either the login
  endpoint or any admin endpoint.
- Response latency for `unknown_username` and `bad_password` outcomes on
  `/auth/local-login` does not, by construction (§2 step 3), differ in a way
  that trivially distinguishes the two — both remain merged into one `401`
  response. `disabled` and `locked` outcomes are distinguishable from the
  merged pair and from each other, but only via deliberate response content
  (`403`/`423`, §2), never via timing: the same uniform-cost computation
  (§2 step 3) still runs to completion for these two causes as well, before
  the outcome — and therefore the response content — is decided.
- A `local_users.id` value, once generated, is never reused by a different
  row, even after the original row is deleted (§9's `sub` claim depends on
  this for correctness).
- `is_active = false` or a deleted local user never causes an
  already-issued, not-yet-expired `bt_session` token to fail verification —
  that would require CONTRACT-003's emergency rotation, which this contract
  does not trigger automatically.
- A given source IP's failed-attempt count against `/auth/local-login`
  resets only on process restart or the natural rolling-window expiry, never
  mid-window on a single success (a successful login from one IP does not
  clear other IPs' or even that IP's own prior failed-attempt count within
  the window) — this is a coarse, resource-protection control, not a
  precise one.
- **Exactly one of the two login paths is live at any moment, determined
  solely by `LOCAL_LOGIN`: never both, never neither.** `LOCAL_LOGIN=true` ⇒
  `/auth/local-login` live, `GET /auth/login`/`GET /auth/callback` inert
  (generic 404). `LOCAL_LOGIN=false` ⇒ the reverse. `GET
  /.well-known/jwks.json` is live in both states (§7).

## Failure behavior

| Condition | Status | Response body theme |
|---|---|---|
| `LOCAL_USER_ADMIN_TOKEN` missing or under 32 characters at startup | Process fails to start | Clear, non-secret-revealing error naming the missing/invalid variable |
| `LOCAL_LOGIN` missing (not exactly `"true"`/`"false"` case-insensitively) at startup | Process fails to start | Same |
| `LOCAL_LOGIN=false` and a request hits `/auth/local-login` | 404 | Generic "Not found" — identical to any unmatched route; no credential check, lockout check, or audit write occurs |
| `LOCAL_LOGIN=true` and a request hits `GET /auth/login` or `GET /auth/callback` | 404 | Generic "Not found" — identical to any unmatched route; no Entra discovery fetch, handshake entry, or token exchange occurs (§7) |
| `TENANT_ID` or `CLIENT_ID` missing/empty at startup while `LOCAL_LOGIN=false` | Process fails to start | Clear, non-secret-revealing error naming the missing variable(s) — unchanged from `config.ts`'s existing behavior (§10) |
| `TENANT_ID`/`CLIENT_ID` missing/empty at startup while `LOCAL_LOGIN=true` | Not a startup error | Process starts normally; the values are simply unused (§10) |
| `/auth/local-login`: missing/empty `username` or `password` | 400 | `{"error":"username and password are required"}` |
| `/auth/local-login`: per-source-IP throttle exceeded | 429 | `{"error":"Too many sign-in attempts. Try again later."}` |
| `/auth/local-login`: unknown username or wrong password | 401 | `{"error":"Invalid username or password."}` — deliberately identical for both causes (§2) |
| `/auth/local-login`: disabled account | 403 | `{"error":"This account has been disabled."}` (§2) |
| `/auth/local-login`: locked account | 423 | `{"error":"This account is temporarily locked. Try again after <locked_until, ISO 8601>."}` (§2) |
| `/auth/local-login`: signing-key retrieval or token minting fails after successful credential verification | 500 | `{"error":"Something went wrong signing you in; this has been logged."}` |
| `/admin/users*`: `Authorization` header missing, malformed, or not matching `LOCAL_USER_ADMIN_TOKEN` | 401 | `{"error":"Unauthorized"}`; a `local_user_admin_audit` row with `action='auth_failure'` is written (best effort) |
| `/admin/users*`: malformed JSON body, or a required field missing/wrong type | 400 | Specific validation message naming the field (admin-only surface — see §4) |
| `POST /admin/users`: `username` or `email` already exists | 409 | `{"error":"A user with that username already exists."}` (or the email-specific variant) |
| `PATCH /admin/users/:id`: new `email` collides with another user | 409 | `{"error":"A user with that email already exists."}` |
| `GET/PATCH/DELETE /admin/users/:id`: no such `id` | 404 | `{"error":"No such user."}` |
| Any admin-API database error | 500 | `{"error":"Unable to complete the request."}`; a `local_user_admin_audit` row with `result='failure'` is written if the database is reachable enough to accept it, else a server-side log-line backstop (timestamp + action + failure category only) |
| `local_login_audit` or `local_user_admin_audit` insert fails on any path | Does not affect the caller's response | Server-side log-line backstop (timestamp, action/result category only — never a credential or password value) |

## Interfaces

**HTTP endpoints:**

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /auth/local-login` | None (public, subject to §3's throttling) | Verifies username/password; on success, mints and sets `bt_session` exactly as CONTRACT-001 §4–§7 define. Live only when `LOCAL_LOGIN=true`; otherwise falls through to generic 404 (§7). |
| `GET /auth/login`, `GET /auth/callback` (CONTRACT-001, referenced not redefined) | Per CONTRACT-001 | Live only when `LOCAL_LOGIN=false`; otherwise fall through to generic 404 (§7) — this contract adds this new reachability condition on top of CONTRACT-001's existing routes without editing CONTRACT-001's own document. |
| `POST /admin/users` | `Authorization: Bearer <LOCAL_USER_ADMIN_TOKEN>` | Create a local user. Body: `{ "username": string, "email": string, "password": string, "actedBy"?: string }`. `201` on success with the created user's public fields. |
| `GET /admin/users` | Same | List all local users (no pagination in this milestone — see Scope > Excluded). `200` with `{ "users": [...] }`, never including password material. |
| `GET /admin/users/:id` | Same | Fetch one local user by id. `200` or `404`. |
| `PATCH /admin/users/:id` | Same | Update `email`, `password`, and/or `isActive` (at least one required). Body may include `actedBy`. Username is **not** renamable via this endpoint (see Open questions) — delete and recreate instead. `200` with the updated record. |
| `DELETE /admin/users/:id` | Same | Hard-deletes the `local_users` row. `200` with `{"status":"deleted","id":string,"username":string}`. Audit history referencing this user is retained (Postconditions). |

All admin responses include `Cache-Control: no-store`, matching CONTRACT-003's
posture for security-sensitive JSON responses.

**Schema:** see Required behavior §1 for the full `local_users`,
`local_login_audit`, and `local_user_admin_audit` table definitions.

**Interface to CONTRACT-001:** this contract's local-login path is, by
construction (§9), a second caller of CONTRACT-001's existing
`mintSessionToken` function and existing cookie-construction logic — it does
not reimplement, extend, or modify anything CONTRACT-001 defines. CONTRACT-001's
own document is not edited (it is `Approved`; ADR-001 forbids editing it in
place regardless). No new claim, signing algorithm, expiry rule, or cookie
attribute is introduced by this contract.

Separately, per §7, this contract imposes a new **reachability** condition
on CONTRACT-001's own `GET /auth/login`/`GET /auth/callback` routes —
they are live only when `LOCAL_LOGIN=false`. This is an additional external
gating condition layered on top of CONTRACT-001 (analogous to how a reverse
proxy or firewall rule could make a route unreachable without the
underlying contract's text changing), not a change to what those routes do
or require when they *are* reachable — CONTRACT-001's own required
behavior, preconditions, and failure taxonomy for those routes are
unmodified and apply exactly as written whenever `LOCAL_LOGIN=false` makes
them live. `GET /.well-known/jwks.json` is explicitly excluded from this
gating and remains live in both modes (§7).

**Interface to CONTRACT-004:** this contract's local-login path consumes
`getCurrentSigningKey()` exactly as CONTRACT-001's callback handler already
does — no change to that function or to CONTRACT-004's `SecretsStore`
interface. This contract's own new tables (`local_users`,
`local_login_audit`, `local_user_admin_audit`) live in the same PGlite
database as CONTRACT-004's `secrets`/`signing_keys`/(CONTRACT-003's)
`emergency_rotation_audit` tables but are **not** part of CONTRACT-004's
envelope-encryption module boundary. This is a deliberate distinction, not
an oversight: CONTRACT-004's `encryptValue`/`decryptValue` machinery exists
to protect **reversible** secrets (`CLIENT_SECRET`, private signing keys)
that the process must later decrypt back to plaintext to use. Password
hashes are the opposite — deliberately one-way and never decrypted, only
compared — so reusing AES-GCM envelope encryption on top of an already
one-way hash would add complexity (a dependency on `DB_ENCRYPTION_KEY` for a
value that doesn't need it) without a corresponding security benefit. See
"Resolved decisions" #1.

**No interface to CONTRACT-003.** This contract does not read, set, or
depend on `EMERGENCY_ROTATION_TOKEN`, and `LOCAL_USER_ADMIN_TOKEN` grants no
authority over emergency rotation or vice versa (§4).

## UX expectations

No browser-rendered login form or admin UI is provided or required by this
contract (Scope > Excluded) — consistent with CONTRACT-001's "no UI polish"
and CONTRACT-003's "no browser-facing admin UI" precedents. The minimum bar
that does apply:

- Every JSON error response is a small, flat object with a single `error`
  string — legible to a human reading raw JSON (e.g. via `curl`), free of
  stack traces or raw database error text.
- On the public `/auth/local-login` surface, unknown-username and
  wrong-password are deliberately presented identically to the caller
  (`401`); disabled and locked accounts each get their own distinct
  status/message (`403`/`423`) — this two-tier split is a stated
  requirement (§2), not an inconsistency.
- On the authenticated `/admin/users*` surface, error messages may be
  specific (e.g. naming which field failed validation, or that a username
  already exists) since the caller already holds `LOCAL_USER_ADMIN_TOKEN`.
- Success responses never include a password, password hash, or the session
  token value in their body, matching CONTRACT-001's "success response...
  must not expose the token value" posture.

## Validation requirements

- Creating a user via `POST /admin/users`, then logging in via
  `POST /auth/local-login` with the same credentials, results in a
  `bt_session` cookie whose JWT decodes to exactly CONTRACT-001's six claims,
  with `sub` equal to the created user's `id`, `email` equal to the created
  user's `email`, and `upn` equal to the created user's `username`.
- The resulting token verifies successfully against
  `/.well-known/jwks.json` using the same offline verification approach
  CONTRACT-001's own validation requirements describe — confirming
  indistinguishability from an Entra-minted token.
- An unknown username and a known username with the wrong password both
  produce the identical `401` status and body.
- A known username on a disabled account produces the distinct `403`
  ("This account has been disabled.") — different from both the `401` pair
  and from the locked response.
- A known username on a locked account produces the distinct `423`,
  naming the exact `locked_until` timestamp in the message.
- Measuring response latency across repeated attempts for "unknown
  username" vs. "known username, wrong password" shows no reliably
  exploitable difference (confirms §2 step 3's timing mitigation for the
  pair that remains merged).
- Measuring response latency for the disabled and locked cases shows they
  take approximately the same time as the merged 401 pair (confirming the
  uniform-cost computation still runs for these two causes, even though
  their response content is now intentionally distinct — §2).
- Ten consecutive wrong-password attempts against one account lock it;
  the eleventh attempt (even with the correct password) fails with the
  distinct `423` locked response while `locked_until` is in the future;
  after `locked_until` passes, the correct password succeeds and clears
  both lockout fields.
- Twenty-one failed attempts from one source IP within a 5-minute window
  produce a `429` on the next attempt, regardless of which username is
  targeted; a request from a different source IP in the same window is
  unaffected.
- `LOCAL_LOGIN=false`: confirm `POST /auth/local-login` returns the
  same `404` body as an arbitrary unmatched route, that no
  `local_login_audit` row is written for the attempt, that `GET
  /auth/login`/`GET /auth/callback` behave exactly per CONTRACT-001, and
  that `/admin/users*` remains reachable with a valid
  `LOCAL_USER_ADMIN_TOKEN`.
- `LOCAL_LOGIN=true`: confirm `GET /auth/login` and `GET /auth/callback`
  both return the same generic `404` body as an arbitrary unmatched route
  (no discovery fetch, no handshake entry created), that `POST
  /auth/local-login` behaves per §1–§6/§9, and that `GET
  /.well-known/jwks.json` remains reachable and unaffected in both states.
- `LOCAL_USER_ADMIN_TOKEN` unset or under 32 characters: confirm the process
  fails to start.
- A deployment with `LOCAL_LOGIN=true` and `TENANT_ID`/`CLIENT_ID` entirely
  absent from `.env` starts successfully (§10).
- A deployment with `LOCAL_LOGIN=false` and `TENANT_ID` or `CLIENT_ID`
  missing/empty fails to start, exactly as `config.ts` requires today (§10).
- A request to any `/admin/users*` endpoint with a missing, malformed, or
  incorrect `Authorization` header: confirm `401` and a
  `local_user_admin_audit` row with `action='auth_failure'`.
- A request to `/admin/users*` bearing only a valid `bt_session` cookie (no
  `Authorization` header): confirm `401` — a signed-in session never
  substitutes for `LOCAL_USER_ADMIN_TOKEN`, mirroring CONTRACT-003's
  equivalent validation requirement for `EMERGENCY_ROTATION_TOKEN`.
- `DELETE /admin/users/:id` followed by inspecting `local_login_audit`:
  confirm prior audit rows referencing that username remain intact.
- Directly inspecting `local_users.password_hash`/`password_salt` after
  creation: confirm the value is not the plaintext password or any
  recognizable encoding of it, and that two users given the same password
  have different `password_hash` values (proving per-user salting).
- Confirm no HTTP response, at any endpoint this contract defines, ever
  contains `password_hash`, `password_salt`, `LOCAL_USER_ADMIN_TOKEN`, or a
  raw stack trace.

## Open questions

Patrick has reviewed and decided four items from this contract's initial
draft (password hashing algorithm, admin-token separation, enumeration
messaging, and the `TENANT_ID`/`CLIENT_ID` startup requirement) — those are
now recorded in "Resolved decisions" below, not here. The remaining items
are genuine decision points still flagged explicitly rather than buried in
prose, so they can be approved, amended, or rejected quickly.

1. **`10` failed attempts / `15`-minute lockout, and `20` failed attempts /
   5-minute per-IP throttle window, are my own arbitrary numeric choices**,
   not derived from any stated requirement — analogous to CONTRACT-003's
   Open question #4 flagging its own arbitrary 32-character minimum. Worth
   an explicit call, especially since automated test suites hammering this
   endpoint could plausibly trip either threshold unintentionally during
   normal test runs, not just during an actual attack.

2. **Bootstrapping the first local user via `POST /admin/users` after
   startup, rather than extending `scripts/seed.js`.** This avoids touching
   CONTRACT-004's bootstrap script (which that contract scopes narrowly to
   `CLIENT_SECRET`/the initial signing key) but means a fresh environment
   needs one extra manual `curl` step post-startup rather than everything
   coming from one seed run. If Patrick would rather `scripts/seed.js`
   optionally seed a first local user too, that's a small, well-precedented
   addition — flagged rather than assumed.

3. **JSON-only `/auth/local-login`, no HTML login form**, even though
   Patrick's stated motivation includes real people logging in during
   testing (not only automated checks). A person can still drive this via
   `curl`/Postman/a browser devtools `fetch()` call, but a minimal HTML form
   would be materially more usable for a non-technical tester. Not designed
   here since NOTES.md's "no UI polish" precedent argues against it, but
   flagged explicitly since the "real people" framing pulls the other way.

4. **The admin CRUD API (`/admin/users*`) is not gated by
   `LOCAL_LOGIN`** — it stays reachable (behind its own token)
   regardless of the mode switch, so records can be managed independent of
   which login path is currently live. An alternative is gating it under
   the same flag (e.g. read-only, or entirely unreachable, while
   `LOCAL_LOGIN=false`) for tighter surface reduction. Patrick's confirmed
   words describe the *login* switch precisely but don't address the admin
   API; flagged as a judgment call either way has real merit.

5. **No username rename via `PATCH` — only `email`/`password`/`isActive`
   are updatable; a rename requires delete-and-recreate (getting a new
   `id`/`sub`).** This keeps `sub` stability simple (a rename never silently
   changes what `sub` a username maps to) but is a real limitation if
   Patrick expects testers' usernames to need correction without losing
   their `id`-keyed identity. Worth an explicit call.

6. **No retention or cleanup policy for `local_login_audit`.** Unlike
   CONTRACT-003's rare kill-switch trigger, `/auth/local-login` may be
   called very frequently by automated test suites, so this table could
   grow substantially faster than any existing audit table in this project.
   I did not design a retention policy (mirroring CONTRACT-003/CONTRACT-004's
   "no retention policy required" stance on their own audit/history
   tables), but flag this as a materially different operational shape
   worth an explicit decision, rather than silently assuming the same
   "never delete" posture scales the same way here.

7. **Whether this decision (a permanent local-login path, reversing part
   of NOTES.md §3's original Entra-only reasoning) warrants its own ADR**,
   the way ADR-002 recorded the break-glass decision, for the same
   "keep lasting project knowledge in the repository" reason CLAUDE.md
   states. I did not write one, since I wasn't asked to and it's not
   strictly this role's responsibility, but flag it as a reasonable
   process step alongside approving this contract.

8. **No task file exists yet for this work** (see header). Per CLAUDE.md,
   implementation cannot begin without an approved task; this contract
   alone does not authorize building anything. Flagged so this isn't
   mistaken for an oversight when no implementation follows immediately
   from approving this document.

## Resolved decisions

Items 1–7 below are judgment calls I made because no prior document settled
them, which I judged low-risk/easily-reversible enough to state as default
required behavior rather than list as open questions. Items 8–11 are
Patrick's own direct confirmations of items that *were* originally listed as
open questions in an earlier draft of this contract. All remain changeable
on review like anything else in a `Proposed` contract.

1. **Password hashes are stored as plain `bytea`, not further wrapped in
   CONTRACT-004's AES-GCM envelope encryption.** A one-way hash does not
   need to be decrypted back to a usable value the way `CLIENT_SECRET` or a
   private signing key does; the hash's own one-wayness is the protection.
   Wrapping it in AES-GCM would add a dependency on `DB_ENCRYPTION_KEY` for
   no corresponding security benefit. See Interfaces > "Interface to
   CONTRACT-004."
2. **Table names** — `local_users`, `local_login_audit`,
   `local_user_admin_audit` — my own naming choices, easy to change without
   other consequence, flagged only because naming is otherwise silently
   locked in once implemented (same caveat CONTRACT-003 stated about its own
   endpoint path).
3. **Endpoint paths** (`/auth/local-login`, `/admin/users*`) — likewise my
   own naming choices, chosen to sit naturally alongside CONTRACT-001's
   `/auth/*` and CONTRACT-003's `/admin/*` namespaces.
4. **Username format** (lowercase, 3–64 chars, limited character set,
   case-insensitive storage/comparison) and **minimum password length (12
   characters, no additional complexity rule)** — reasonable, NIST-aligned
   defaults, not derived from any stated requirement. Complexity rules
   beyond length are deliberately not imposed, consistent with current
   password-guidance best practice.
5. **`kid`/`id`-style identifier generation** — `crypto.randomUUID()` for
   `local_users.id` and every audit table's `id`, matching this project's
   existing convention everywhere else (`signing_keys.kid`,
   `emergency_rotation_audit.id`).
6. **No pagination on `GET /admin/users`** — reasonable for a small internal
   testing population; would need revisiting if the user count grows large,
   but not designed preemptively here.
7. **`LOCAL_LOGIN`'s recommended/example default is `false` (Entra-only
   mode)** — this was an open question in an earlier draft of this contract;
   it is now settled by inspection of the tracked `.env.example`, which
   already sets `LOCAL_LOGIN=False`, and by Patrick's own framing ("otherwise
   Entra required") treating Entra-only as the ordinary/expected state. A
   fresh deployment therefore starts in Entra-only mode unless an operator
   deliberately opts into local-only mode.
8. **Password hashing algorithm: `scrypt` (Node built-in), not argon2id or
   bcrypt.** Confirmed by Patrick (2026-09-15). No behavior change from the
   original draft — Required behavior §1 already specified `scrypt` with
   the stated parameters; this closes out the tradeoff that section's
   original text left open.
9. **A separate `LOCAL_USER_ADMIN_TOKEN`, distinct from
   `EMERGENCY_ROTATION_TOKEN`, on least-privilege grounds.** Confirmed by
   Patrick (2026-09-15). No behavior change — Required behavior §4 already
   specified this.
10. **Enumeration messaging: a two-tier scheme, not full-generic-for-
    everything.** Confirmed by Patrick (2026-09-15). Unknown username and
    wrong password remain merged into one generic `401` response
    (`{"error":"Invalid username or password."}`); disabled accounts get a
    distinct `403` (`{"error":"This account has been disabled."}`); locked
    accounts get a distinct `423`, naming the exact `locked_until` timestamp
    (`{"error":"This account is temporarily locked. Try again after
    <locked_until>."}`). This **is** a behavior change from the original
    draft (which merged all four causes) — see Required behavior §2, the
    Failure behavior table, and Validation requirements for the updated
    specification, including the explicit reasoning for why this does not
    reopen the timing side channel §2 step 3's uniform-cost computation
    exists to close.
11. **`TENANT_ID`/`CLIENT_ID` are required only when `LOCAL_LOGIN=false`.**
    Confirmed by Patrick (2026-09-15). This **is** a new, additional
    required-behavior item (not present in the original draft, which left
    it as an open question) — see Required behavior §10, Preconditions,
    the Failure behavior table, and Validation requirements. This changes
    `config.ts`'s validation logic (a TASK-007 implementation choice), not
    CONTRACT-001's own approved text — see §10 for why no ADR-001
    immutability conflict arises.
