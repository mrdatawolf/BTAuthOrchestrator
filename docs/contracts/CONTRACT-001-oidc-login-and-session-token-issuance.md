# CONTRACT-001: OIDC login flow & session token issuance

Status: Approved
Approved by: Patrick Moon
Approved date: 2026-09-14
Related tasks: TASK-002 (produced this contract), TASK-001 (source of the
concrete Entra registration values referenced below), TASK-003 (CONTRACT-002,
storage dependency referenced but not designed here), TASK-007
(implementation), TASK-008 (signing/JWKS implementation), TASK-009 (emergency
key rotation, depends on the JWKS shape defined here), TASK-011 (review).

## Purpose

Define the observable behavior of BTAuthOrchestrator's OIDC authorization-code
login flow against Entra ID and its issuance of BTAuthOrchestrator's own
signed session token and cookie, precisely enough that TASK-007 can implement
against it without further architectural decisions, and TASK-011 can review
compliance against it without inspecting implementation internals.

This contract treats the design inputs recorded in TASK-002's Context section
and NOTES.md §3–§5 as settled and does not relitigate them: authorization
code flow with mandatory PKCE/state/nonce, an orchestrator-minted (not
pass-through) session token with an authentication-only claim set, RS256
signing, midnight-local expiry, a kid-aware multi-key JWKS, a
parent-domain-scoped cookie with an explicit `COOKIE_SECURE` flag, and secrets
sourced from CONTRACT-002's storage layer.

## Scope

### Included

- The authorization-code + PKCE/state/nonce handshake, from login initiation
  through redirect to Entra.
- Callback handling: code exchange, ID token validation, claim extraction.
- OIDC handshake state storage (where `state`/`nonce`/PKCE verifier live
  between redirect and callback).
- BTAuthOrchestrator's own session token: claim shape, signing algorithm, and
  expiry computation.
- Session cookie issuance and attributes.
- The JWKS response shape (kid-aware, multi-key-capable).
- Failure behavior for every observable failure mode of the flow, including
  an unreachable Entra tenant.

### Excluded

- Refresh flow, logout, authorization/role gating, admin UI, audit logging.
- The key-rotation trigger mechanism itself (CONTRACT-002 / TASK-009) — this
  contract only requires that the JWKS shape be capable of representing the
  result of a rotation.
- The encrypted storage/schema design itself (CONTRACT-002) — this contract
  only depends on that interface's existence.
- Any consuming-app-specific redirect/return-to handling (no consuming app is
  integrated in this milestone; deferred to a future contract — see
  "Resolved decisions" below).
- Centralized vs. per-app break-glass admin design (NOTES.md §5, still open
  at the project level).

## Actors

- **End user** — an org staff member with an Entra ID (O365) account, acting
  through a browser.
- **BTAuthOrchestrator** — the OIDC relying party and session-token issuer
  defined by this contract.
- **Entra ID** — the org's tenant (ID `0adaaaf4-1740-44d0-94ef-620d1fb75045`),
  acting as the OIDC authorization server / identity provider.
- **CONTRACT-002 storage layer** (indirect actor) — supplies `CLIENT_SECRET`
  and the current RS256 signing key material; treated as an opaque interface
  by this contract.
- **Consuming apps** (indirect, not integrated this milestone) — future
  verifiers of the issued cookie/token and consumers of the JWKS endpoint.

## Inputs and outputs

**Inputs:**
- The end user's browser session (no prior BTAuthOrchestrator cookie
  required to start).
- Entra's authorization response at the callback (`code`, `state`, and
  optionally `error`/`error_description`).
- Entra's ID token (returned from the token endpoint during code exchange).
- `CLIENT_SECRET` and the current RS256 signing key, obtained via
  CONTRACT-002's storage interface.
- Configuration: `TENANT_ID` (`0adaaaf4-1740-44d0-94ef-620d1fb75045`),
  `CLIENT_ID` (`edcb141d-df64-46ec-8ec2-e92e05359e41`), the registered
  redirect URI (`https://orca.biztechro.com/auth/callback`), and
  `COOKIE_SECURE` (env-driven, default `false`).

**Outputs:**
- A 302 redirect to Entra's authorization endpoint (login initiation).
- On successful callback: an HTTP response that sets the session cookie and
  confirms success.
- On any failure: a clear, human-readable error response (never a raw
  unhandled exception / framework stack trace), with a status code per the
  taxonomy in "Failure behavior."
- A JWKS document at a well-known path, containing only public key material.

## Preconditions

- TASK-001's Entra app registration is complete and unchanged in the
  properties this contract depends on: tenant ID, client ID, and a redirect
  URI that exactly matches `https://orca.biztechro.com/auth/callback`.
- BTAuthOrchestrator's own origin (`https://orca.biztechro.com`) is served
  over TLS (TASK-003d) — Entra will not accept a non-HTTPS redirect URI.
- CONTRACT-002's storage layer is available, seeded (TASK-006), and exposes
  at minimum: (a) a way to retrieve the current decrypted `CLIENT_SECRET`,
  and (b) a way to retrieve the current signing key (private key for
  signing, public component + `kid` for JWKS), plus any other currently
  valid (not-yet-expired-from-JWKS) keys.
- The host's system clock is correct, and its configured local timezone is
  the timezone the midnight-expiry rule is intended to use (see Required
  behavior).
- BTAuthOrchestrator runs as a single process on a single host, per
  CONTRACT-002's single-process constraint. This contract's in-memory
  handshake-state design (below) relies on that constraint and does not
  hold if that constraint is ever relaxed.
- None beyond the app registration as already completed — `upn` is sourced
  from Entra's default `preferred_username` claim (see §4), so no additional
  Entra Token-configuration change is required beyond TASK-001's existing
  registration.

## Required behavior

### 1. Login initiation — `GET /auth/login`

On request, BTAuthOrchestrator must:

1. Generate a cryptographically random `state`, a cryptographically random
   `nonce`, and a PKCE `code_verifier` (with its S256 `code_challenge`).
2. Store a handshake entry (see §2) keyed by `state`, containing `nonce`,
   `code_verifier`, and a creation timestamp.
3. Respond with a 302 redirect to Entra's authorization endpoint
   (`https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/authorize`)
   with, at minimum: `client_id`, `response_type=code`,
   `redirect_uri=https://orca.biztechro.com/auth/callback`,
   `scope=openid profile email`, `state`, `nonce`, `code_challenge`,
   `code_challenge_method=S256`.

PKCE, `state`, and `nonce` are mandatory on every authorization request —
there is no code path that omits any of the three.

### 2. OIDC handshake state storage

**Decision: in-memory, server-side store, keyed by `state`, single-use, with
a 10-minute TTL.** Each entry is deleted immediately after being read
back at the callback (whether the rest of the callback succeeds or fails),
so a given `state` value can be redeemed at most once. Entries older than 10
minutes are treated as expired even if never explicitly cleaned up.

Rationale, since TASK-002 left this decision to this contract:
- CONTRACT-002 already imposes a single-process, single-host constraint on
  this service, which is exactly the condition under which an in-memory
  store is safe (no cross-process/cross-node consistency problem).
- It avoids introducing a second cookie-signing scheme purely to protect
  handshake material, and avoids ever putting the PKCE verifier in front of
  the browser at all — the server holds it start to finish.
- It expires and single-use-invalidates naturally, without relying on cookie
  expiry semantics or client cooperation.

Accepted tradeoff: a service restart during the handshake window (redirect
issued, callback not yet received) invalidates any in-flight login attempts.
This must fail closed and clearly (see Failure behavior — this surfaces as
an ordinary "expired, please try again" state-lookup failure, not a special
case) rather than silently.

### 3. Callback handling — `GET /auth/callback`

On request, BTAuthOrchestrator must, in order:

1. If Entra's response includes an `error` parameter, fail per Failure
   behavior ("Entra returned an authorization error") without attempting a
   state lookup.
2. Look up the handshake entry for the received `state`. If absent or
   expired, fail per Failure behavior ("handshake invalid or expired").
   Delete the entry immediately upon lookup, regardless of what happens
   next, so it cannot be reused.
3. Exchange `code` at Entra's token endpoint using the standard
   `authorization_code` grant: `client_id`, `client_secret` (from
   CONTRACT-002's storage interface), `code`, `redirect_uri` (must be the
   exact registered value), and `code_verifier` (from the handshake entry).
   - A network-level failure (DNS failure, connection refused, timeout) or a
     5xx response from Entra at this step is Entra-unreachable (Failure
     behavior, 502-class).
   - A 4xx response from Entra at this step (e.g. `invalid_grant`) is a
     protocol-level failure (Failure behavior, 400-class).
4. Validate the returned ID token: signature against Entra's own published
   JWKS (see §9), `iss` matches the expected tenant issuer, `aud` matches
   `CLIENT_ID`, `exp`/`iat`/`nbf` are within valid bounds, and the token's
   `nonce` claim matches the `nonce` stored in the handshake entry exactly.
   Any failure here is a validation failure (Failure behavior, 400-class)
   and must not proceed to token minting.
5. Extract exactly three identity values from the validated Entra ID token:
   - `sub` (BTAuthOrchestrator's) ← Entra's `oid` claim (the tenant-stable
     object ID), **not** Entra's own `sub` claim, which is pairwise per app
     registration and would change if the app registration is ever
     recreated. Confirmed by Patrick.
   - `email` ← Entra's `email` claim.
   - `upn` ← Entra's `preferred_username` claim. Confirmed by Patrick; no
     additional Entra optional-claim configuration is required.
   If any of these three cannot be populated from the validated ID token,
   treat this as a server/configuration error (Failure behavior, 500-class),
   not a user-facing "try again" condition — it will not resolve on retry.
6. Mint BTAuthOrchestrator's own session token (§5–§6) and set the session
   cookie (§7).
7. Respond with a success confirmation. No consuming app is integrated in
   this milestone, so this contract does not define an app-specific
   redirect target; that is deferred to a future contract (see "Resolved
   decisions" below).

Entra's own ID token, access token, and any refresh token returned during
this exchange are used only transiently, in memory, for the duration of
steps 3–5. They are never persisted, never logged, never forwarded to the
browser, and never embedded in BTAuthOrchestrator's own session token or
cookie in any form. Any refresh token Entra returns is discarded unused —
refresh is explicitly out of scope for this contract.

### 4. Session token claim shape

BTAuthOrchestrator's session token is a JWT with exactly these claims and no
others:

| Claim | Value |
|---|---|
| `sub` | Entra `oid` for the authenticated user |
| `email` | Entra `email` for the authenticated user |
| `upn` | Entra's `preferred_username` claim for the authenticated user |
| `iat` | Issuance time, epoch seconds |
| `exp` | Per §6 below, epoch seconds |
| `iss` | BTAuthOrchestrator's own canonical origin, `https://orca.biztechro.com` |

No `aud`, no roles, no groups, no scopes, and no other claim of any kind.
This is a deliberate authentication-only design: each consuming app owns its
own authorization logic and receives no signal here beyond who the user is.
The absence of `aud` is intentional and consistent with the shared,
domain-scoped cookie: the same token is usable by every app under the parent
domain by design, not by oversight.

### 5. Signing

- Algorithm: **RS256.** (Settled; ES256 is not used, despite NOTES.md §4
  leaving both on the table originally.)
- The JWT header's `kid` must match the `kid` of the key used to sign,
  which must in turn appear in the JWKS response (§9) at the moment of
  signing.
- The private key is obtained transiently from CONTRACT-002's storage
  interface for the signing operation and must not be logged, cached in a
  way that outlives the request, or exposed via any response.

### 6. `exp` computation — local-midnight expiry

`exp` is the next local-midnight boundary strictly after `iat`, computed
using the host's configured system-local timezone — **not** UTC, and not a
fixed-duration TTL added to `iat`.

Precise rule: let `iat` be the issuance instant in the host's local time.
`exp` is the first midnight (00:00:00 local) that is strictly later than
`iat`. Concretely:
- Login at 08:00 local → `exp` at that day's 24:00 (i.e. next 00:00) local:
  a ~16-hour token.
- Login at 23:59:59 local → `exp` one second later: a ~1-second token.
- Login at 00:00:01 local → `exp` at the *next* day's midnight: a
  ~23h59m59s token (this is the stated worst case, "close to 24 hours").
- Login at exactly 00:00:00.000 local → `exp` must be the *following* day's
  midnight (24 hours later), not the same instant. A token must never be
  minted with `exp <= iat`.

This is a single-dedicated-host design: server-local time is unambiguous
because there is exactly one instance minting tokens. `exp` is stored and
verified as an absolute epoch value, so this local-time computation only
matters at mint time — consuming apps verify `exp` normally regardless of
timezone.

**Implementation note (not a required behavior, flagged for awareness):** on
the two DST transition nights per year, the host's local clock moves
backward or forward by an hour, so the wall-clock interval between `iat` and
the following local midnight will be roughly 23 or 25 hours instead of 24 on
those two nights. This is accepted as within the already-approximate
"worst case ~24h" bound and requires no special-case handling.

### 7. Session cookie issuance

On successful login, BTAuthOrchestrator sets exactly one cookie, named
**`bt_session`**, carrying the session token (compact JWT serialization) as
its value, with these attributes:

- **`Domain=.biztechro.com`**: the parent domain shared by all consuming
  apps. All consuming apps (CDMS and others) live under `biztechro.com`
  subdomains — this is a confirmed deployment-topology fact, not an
  assumption.
- **`HttpOnly`**: always set. Never readable from JavaScript.
- **`Secure`**: driven **only** by the `COOKIE_SECURE` environment variable,
  which defaults to `false`.
- **`SameSite=Lax`** — permits the cookie to be sent on top-level navigation
  between apps under the parent domain, while withholding it from genuinely
  cross-site requests.
- **`Path=/`**.
- **`Expires`/`Max-Age`** set to match the token's `exp` exactly, so cookie
  lifetime and token validity agree.

#### Rule: `COOKIE_SECURE` is independent of `NODE_ENV`

No code path may derive the cookie's `Secure` attribute from `NODE_ENV`,
build mode, or any other environment/deploy-mode signal. `COOKIE_SECURE`
must be its own explicit, independently-set environment variable, defaulting
to `false`. This repeats and formalizes NOTES.md §4's account of the CDMS
incident (`secure: NODE_ENV === "production"` silently breaking login over
plain HTTP) and TASK-003d's explicit instruction not to flip this as a side
effect of provisioning TLS on the orchestrator's own origin. TLS on
`orca.biztechro.com` (TASK-003d) has no bearing on this flag — `COOKIE_SECURE`
is governed solely by whether *consuming apps* are served over TLS, which
they currently are not. This is exactly the kind of correctness-looking
"fix" (flip to `true` on sight of a padlock) that would silently break SSO
for every other app, and this contract treats avoiding it as an explicit,
named requirement, not an implicit assumption implementers are expected to
infer.

### 8. Failure responses are never raw errors

Every failure path defined in "Failure behavior" below renders a plain,
human-readable response — never an unhandled exception, stack trace, or raw
framework error page.

### 9. Entra discovery and JWKS caching (for validating Entra's ID token)

BTAuthOrchestrator must fetch and cache Entra's own OIDC discovery document
and JWKS (used to validate Entra's ID token in §3.4) rather than requiring a
live Entra round trip on the metadata itself for every login. Startup must
not block on or fail because of this fetch — the service (including its
health-check endpoint from TASK-004) must start and remain healthy even if
Entra is unreachable at boot; `/auth/login` and `/auth/callback` degrade per
Failure behavior instead. The exact cache/refresh interval is an
implementation detail this contract does not prescribe, provided a
transient Entra outage after the first successful fetch does not
unnecessarily take down logins that don't require a fresh fetch.

### 10. JWKS endpoint — `GET /.well-known/jwks.json`

- Returns a standard JWKS document (RFC 7517/7518 shape): `{"keys": [...]}`,
  each entry `{"kty": "RSA", "use": "sig", "alg": "RS256", "kid": "...",
  "n": "...", "e": "..."}`.
- Contains **only** public key material. Private key components never
  appear in this or any other response.
- Must be able to represent more than one simultaneously valid key, each
  with a distinct `kid`. Only one key exists in this milestone, but the
  response shape and code path must not assume exactly one — this is the
  foundation TASK-008/TASK-009 build key rotation on.
- Responses must instruct against caching (e.g. `Cache-Control: no-store`)
  so no intermediary (including the Caddy reverse proxy from TASK-003d)
  delays visibility of a rotation. Any in-memory caching a *consuming* app
  chooses to do on its own side is that app's own concern and out of scope
  here (already flagged as a risk in TASK-009).

## Postconditions and invariants

**Postconditions (true after a successful login):**
- Exactly one session cookie is set, with a value that is a well-formed
  RS256 JWT containing exactly the six claims in §4 — no more, no fewer.
- The token's `kid` header matches an entry currently present in the JWKS
  response.
- `exp > iat` always holds (see §6's zero-lifetime edge case rule).
- Entra's own ID/access/refresh tokens have not been persisted anywhere.

**Invariants (always true, regardless of outcome):**
- `COOKIE_SECURE`'s effective value never depends on `NODE_ENV` or any
  build-mode flag (see the named rule in §7).
- No private key or `CLIENT_SECRET` value ever appears in a log line, error
  response, or the JWKS document.
- A given `state` value can be successfully redeemed at most once.
- Every failure path produces the defined clear-error response, never a raw
  unhandled exception.

## Failure behavior

Failures are classified into three tiers with distinct, fixed HTTP status
ranges. Response bodies are plain, human-readable, non-technical, and never
include a stack trace or raw upstream error payload (upstream detail may be
logged server-side).

| Condition | Status | User-facing message theme |
|---|---|---|
| Entra unreachable: network/DNS/timeout, or 5xx, when calling Entra's discovery endpoint, token endpoint, or Entra's own JWKS | 502-class | "Unable to reach the organization's sign-in service right now. Try again in a few minutes." |
| `state` missing, unrecognized, expired, or already consumed | 400-class | "Your sign-in attempt has expired or is no longer valid. Please start again." |
| Entra returned an explicit authorization error (`error=access_denied`, etc.) at the callback | 400-class | "Sign-in was cancelled or denied." (distinct message from expiry) |
| Entra returned a 4xx at the token-exchange step (e.g. `invalid_grant`) | 400-class | "Your sign-in attempt could not be completed. Please start again." |
| ID token validation failure (bad signature, `nonce` mismatch, bad `iss`/`aud`, expired) | 400-class | Generic "your sign-in attempt could not be completed" — do not reveal which specific check failed |
| A required identity claim (`oid`/`email`/UPN source) is missing from an otherwise-valid Entra ID token | 500-class | Generic "something went wrong signing you in; this has been logged" — this is a configuration problem, not something the user can fix by retrying |
| Any other unhandled exception in the login/callback path | 500-class | Same generic 500-class message |

The Entra-unreachable message (502-class row) does not name a specific
break-glass path, since centralized vs. per-app break-glass is still an
explicit open decision at the project level (NOTES.md §5) and no consuming
app is integrated yet in this milestone. Confirmed by Patrick as acceptable
for this milestone. Once a consuming app with a local break-glass path
exists, that app's own
verification and break-glass paths are unaffected by this outage regardless
— per NOTES.md §4, verification is local to each app and does not require
BTAuthOrchestrator to be reachable except at login/refresh time.

`nonce` mismatch specifically must be logged as a distinct event from
ordinary expiry (it is a stronger signal of tampering/replay than a stale
`state`), even though the user-facing message is deliberately generic.

## Interfaces

**HTTP endpoints (BTAuthOrchestrator):**

| Method & path | Purpose |
|---|---|
| `GET /auth/login` | Initiates the authorization-code + PKCE/state/nonce handshake; 302 to Entra. |
| `GET /auth/callback` | Entra's registered redirect URI (`https://orca.biztechro.com/auth/callback`, fixed by TASK-001's registration — must not change without also updating the Entra app registration). Handles code exchange, validation, minting, cookie issuance. |
| `GET /.well-known/jwks.json` | Publishes BTAuthOrchestrator's current public signing key(s), kid-aware. |

`/auth/login`'s path is this contract's own choice (not Entra-registered,
freely changeable without any Entra-side coordination), stated here so
TASK-007 has a fixed value to implement rather than inventing one.

**Interface to Entra ID (external):**
- Authorization endpoint, token endpoint, discovery document, and JWKS, per
  standard OIDC, at the tenant identified by `TENANT_ID`.

**Interface to CONTRACT-002's storage layer (internal, forthcoming):**
This contract depends on, but does not define, an interface exposing:
- The current decrypted `CLIENT_SECRET`.
- The current signing key (private key for signing; `kid` + public key
  material for JWKS), and any other currently-valid (still-published) key.
This contract treats that interface as opaque; TASK-003/CONTRACT-002 owns
its shape.

**Interface to consuming apps:** none in this milestone. Consuming apps are
expected to eventually verify the cookie's JWT offline using the JWKS
endpoint's public keys — that verification-side contract is out of scope
here (NOTES.md §4) and belongs to each consuming app's own integration work.

## UX expectations

No visual design or branding is required in this milestone (NOTES.md §6:
"no UI polish"). The following minimum bar applies regardless:

- Every error response is plain HTML (or an equivalent minimal format),
  legible to a non-technical staff member, and free of stack traces, raw
  JSON error payloads from Entra, or other implementation detail.
- At minimum, four distinct message themes are distinguishable to the user:
  unreachable/outage, cancelled/denied, expired/invalid attempt, and a
  generic internal-error fallback (see the Failure behavior table).
- The success response is a minimal confirmation; it does not need to be
  styled, but must not expose the token value or any Entra response detail
  in its body.

## Validation requirements

- End-to-end manual login against the real Entra tenant (TASK-001)
  succeeds and results in a session cookie whose JWT decodes to exactly the
  six claims in §4.
- A callback attempted with a missing, wrong, or reused `state` is
  rejected (400-class), and a reused `state` cannot succeed even if all
  other values are correct.
- A callback with a `nonce` in the ID token that does not match the
  handshake's stored `nonce` is rejected (400-class).
- Simulated Entra unreachability (e.g., blocked network path to
  `login.microsoftonline.com`) at both the discovery/JWKS-fetch stage and
  the token-exchange stage produces the defined 502-class response, not a
  500 or unhandled exception.
- The minted token's `kid` header matches an entry in
  `/.well-known/jwks.json`, and that entry contains only public key
  material.
- Manually inserting a second valid key (simulating a rotation) results in
  both keys appearing in the JWKS response, each correctly kid-tagged —
  confirming the shape supports multiple keys even though only one exists
  today.
- Cookie attributes are inspected directly (not just code-read) for both
  `COOKIE_SECURE=false` and `COOKIE_SECURE=true`, confirming `Secure`
  tracks only that flag — and confirming that changing `NODE_ENV` alone
  (with `COOKIE_SECURE` unchanged) has no effect on the `Secure` attribute.
- `exp` is checked against concrete timestamps spanning the edge cases in
  §6 (a login just after midnight, a login just before midnight, and a
  login at exactly midnight).
- No log line or response body, across all failure paths, contains
  `CLIENT_SECRET`, private key material, or a raw stack trace.

## Open questions

None outstanding. All judgment calls made in drafting this contract (listed
below under "Resolved decisions") have been reviewed and confirmed by
Patrick.

## Resolved decisions

The following were judgment calls this contract made because TASK-002 did
not settle them explicitly. Each has since been reviewed and confirmed by
Patrick, and is reflected as required behavior in the sections noted:

1. **`upn` source claim** — Entra's `preferred_username` claim, with no
   additional Entra Token-configuration change required. See §3.5, §4,
   Preconditions.
2. **`sub` mapping** — Entra's `oid` (stable, tenant-scoped object ID),
   not Entra's own pairwise `sub`. See §3.5, §4.
3. **Parent cookie domain** — `.biztechro.com`, confirmed as the actual
   deployment topology: all consuming apps (CDMS and others) live under
   `biztechro.com` subdomains. See §7.
4. **Cookie name** — `bt_session`. See §7.
5. **`SameSite=Lax`** — confirmed as the default. See §7.
6. **Cookie `Expires`/`Max-Age` matching token `exp`** — confirmed, rather
   than a browser-session-only cookie. See §7.
7. **Post-login destination** — deferred to a future contract, written
   alongside the first real consuming-app integration (CDMS); this
   contract defines only a minimal orchestrator-owned success confirmation
   for this milestone. See §3.7, Scope > Excluded.
8. **Break-glass pointer text on the Entra-unreachable error page** — kept
   generic for this milestone, since centralized-vs-per-app break-glass is
   still an explicit open decision at the project level (NOTES.md §5). See
   Failure behavior.
