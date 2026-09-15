# Review Report

Task: TASK-011 — Independent review of milestone 1-2 slice (TASK-004 through
TASK-010: Entra registration through offline verification proof)
Reviewer: QualityAssurance (Claude Sonnet 5)
Date: 2026-09-15
Outcome: **Human decision required**

Patrick was away during this review; he pre-approved TASK-011 before leaving
and asked that work continue in his absence, with findings documented for his
return. Nothing below was fixed by the reviewer — per `docs/roles/reviewer.md`
this report only records findings.

## Summary

Every functional/security behavior directly probed in this review — the OIDC
handshake (PKCE/state/nonce, replay, tampering, all failure tiers including
Entra-unreachable), cookie issuance and `NODE_ENV` independence, envelope
encryption at rest, data-directory permissions, the single-process lock,
CONTRACT-003's emergency-rotation trigger (authentication, atomicity,
concurrency, audit trail), and the offline-verification proof — passed when
exercised hands-on against the real compiled service (either over a real
loopback socket or, where noted, via the project's established
exported-handler-invocation pattern). No defect was found in any of these.

One finding requires Patrick's decision rather than being a pass/fail defect:
TASK-009 did not implement CONTRACT-002's normatively-specified
`rotateSigningKey`/`revokeKey` interface functions; it implemented a
different function (`rotateSigningKeyEmergency` +
`recordEmergencyRotationFailure`) to solve an atomicity problem CONTRACT-003
itself flagged as a genuinely unresolved open question (Open question #7)
requiring Patrick's or a contract-designer's resolution before
implementation. The implementer proceeded and documented the deviation
transparently, but did not pause for the escalation CONTRACT-003 explicitly
asked for. This does not cause any observed behavioral defect — independently
verified rotation, atomicity, and audit behavior are all correct — but it
leaves CONTRACT-002's own literal interface section unfulfilled and
unilaterally resolves a decision that was flagged as Patrick's to make. See
Finding F1.

A second, lower-severity item: CONTRACT-001/CONTRACT-003 both require
TLS-only exposure as a precondition, and TASK-003d (Caddy/TLS provisioning)
is still in `tasks/approved/`, not implemented. This is not a new finding —
TASK-009's own handoff already flagged it as an unresolved risk pointing back
to TASK-003d — but it is restated here as a real, currently-open precondition
of both contracts this review evaluated. See Finding F2 (non-blocking,
already tracked).

Everything else: Pass.

## Contract and acceptance review

### CONTRACT-001 (OIDC login flow & session token issuance)

| Requirement | Status | Evidence |
|---|---|---|
| §1 Login initiation, mandatory PKCE/state/nonce | Pass | Directly exercised (see Validation). Real `/auth/login` redirect (both against the real Entra tenant's authorize URL, confirmed live, and against a mock Entra) contains `state`, `nonce`, `code_challenge`, `code_challenge_method=S256` on every request; no code path omits any of the three (source-inspected `handleLogin` in `src/index.ts`). |
| §2 Handshake state storage (in-memory, single-use, 10-min TTL) | Pass | `src/oidc.ts` `createHandshakeStore`; directly exercised: a reused `state` fails (400) after a successful callback, and a fabricated/never-issued `state` fails (400). |
| §3 Callback handling, ordered steps | Pass | Directly exercised end-to-end against a purpose-built mock Entra server (27/27 checks passed) and independently against the real Entra tenant's public discovery metadata for the real `/auth/login` redirect. `error=` param short-circuits before state lookup (confirmed). |
| §3.3 Token exchange, Entra-unreachable vs. 4xx classification | Pass | Directly reproduced: pointing the discovery fetch at an unreachable host/port produces exactly `502` with the exact contract wording, no stack trace, no leaked internals (`ECONNREFUSED` not present in the body). An `invalid_grant`-equivalent 4xx from the token endpoint produces `400`. |
| §3.4-3.5 ID token validation, claim extraction (`oid`→`sub`, `email`, `preferred_username`→`upn`) | Pass | Mock-Entra round trip confirms exact claim mapping; nonce mismatch produces 400 and is logged as a distinct `nonce_mismatch:` event (confirmed in source and in live output); missing identity claim produces 500. |
| §3 "Entra's own tokens never persisted/logged/forwarded" | Pass | Source-grepped every log/response-body site touching `clientSecret`/`idToken`/access/refresh tokens; none is interpolated into a log line or response. |
| §4 Session token claim shape (exactly 6 claims) | Pass | Directly decoded a live-minted token: `email,exp,iat,iss,sub,upn` and nothing else. |
| §5 Signing (RS256, `kid` matches JWKS) | Pass | Live JWKS `kid` matched the minted token's header `kid` in every run. |
| §6 `exp` = next local midnight | Pass | Directly computed via the real `nextLocalMidnightEpochSeconds` for all four contract edge cases (08:00 → 57,600s; 23:59:59 → 1s; 00:00:01 → 86,399s; exactly 00:00:00 → 86,400s) — all matched exactly, `exp > iat` in every case. |
| §7 Cookie issuance, exact attributes | Pass | Live `Set-Cookie` matched `bt_session=<jwt>; Domain=.biztechro.com; Path=/; Expires=...; Max-Age=...; HttpOnly; SameSite=Lax` exactly, with no `Secure` when `COOKIE_SECURE=false`. |
| §7 `COOKIE_SECURE` independent of `NODE_ENV` | Pass | Source-grepped: zero occurrences of `NODE_ENV` anywhere in `src/` or `scripts/`. Directly exercised: set `NODE_ENV=production` in the review process before a full mock-Entra login round trip — the cookie still had no `Secure` attribute (governed only by `COOKIE_SECURE=false`). `Secure`'s appearance under `COOKIE_SECURE=true` was confirmed by source inspection (`const cookieSecure = config.cookieSecure...; if (secure) attributes.push("Secure")` — driven by nothing but the config value) plus TASK-007's own live transcript (`COOKIE_SECURE=true -> Set-Cookie includes Secure`); not independently re-run live by this reviewer due to time, but the code path is unambiguous and was read directly. |
| §8 Failure responses never raw errors | Pass | Every failure path exercised (missing/unknown/replayed state, Entra error param, Entra unreachable, nonce mismatch, PKCE mismatch, missing claim) rendered plain HTML with the exact contract message text, never a stack trace. |
| §9 Discovery/JWKS caching, startup does not block on Entra | Pass | Source-inspected `start()` in `src/index.ts`: discovery is never fetched at startup, only lazily on first `/auth/login`/`/auth/callback`; `/health` is registered independently and unaffected. |
| §10 JWKS endpoint shape, public-only, multi-key-capable, `no-store` | Pass | Live JWKS responses contained exactly `kty,use,alg,kid,n,e`; `Cache-Control: no-store` present on every response; a revoked key was independently confirmed absent after rotation. |

### CONTRACT-002 (Encrypted secret & key storage)

| Requirement | Status | Evidence |
|---|---|---|
| Envelope encryption (AES-256-GCM, fresh IV, AAD binding) | Pass | Directly inspected raw PGlite rows after a real seed: ciphertext is opaque binary (not plaintext or a recognizable encoding), distinct IVs per row. Directly tested: wrong `DB_ENCRYPTION_KEY` throws; AAD swap (correct ciphertext/IV/tag, wrong AAD label) throws; a single tampered ciphertext byte throws. All three via the real `decryptValue`. |
| `DB_ENCRYPTION_KEY` never stored in PGlite | Pass | Directly scanned every column of every row in `secrets` and `signing_keys` for the real hex key value used in the review's own seeded database — zero occurrences. |
| Schema (tables/columns/status vocabulary/one-current constraint) | Pass | Source-inspected `src/database.ts`; matches CONTRACT-002 §2 exactly (already independently verified at the catalog level by TASK-005's own handoff, which this reviewer did not need to re-run given the schema is unchanged since then and was independently re-derived from the currently running schema during this review's own seeding/inspection). |
| Bootstrap/seed interface | Pass | Directly ran `node dist/seed.js --client-secret-file=...` against a fresh directory: produced the exact confirmation lines, deleted the input file, and left exactly one `CLIENT_SECRET` row and one `current` signing key. Re-running against an already-created (but empty) directory with wrong permissions correctly failed closed before touching the database (see next row). |
| Data-directory permissions (0700, fail-closed) | Pass | Directly created a `0755` data directory and confirmed the process refused to start with the exact `chmod 700 ...` message; confirmed a freshly auto-created directory is `0700`, owned by the running user. |
| Single-process enforcement | Pass | Directly started a real second instance against an already-open data directory: failed fast (observable error, no hang, no corruption) while the first instance was healthy; confirmed clean lock release on `SIGTERM`. |
| Key lifecycle / `rotateSigningKey`/`revokeKey` interface (Interfaces section) | **Finding (F1)** | CONTRACT-002's Interfaces section specifies `rotateSigningKey(...)` and `revokeKey(...)` as normative function names. Neither exists in `src/secrets.ts`. TASK-009 instead added `rotateSigningKeyEmergency`/`recordEmergencyRotationFailure`. See Finding F1 below — behaviorally correct, but a literal contract-interface gap and an unescalated resolution of a flagged open question. |
| `insertSigningKey` bootstrap-only semantics | Pass | Source-inspected and confirmed by TASK-006's own transcript (a second `insertSigningKey` call throws `"A current signing key already exists."`); not independently re-run by this reviewer (low-risk, unchanged code path). |

### CONTRACT-003 (Emergency key-rotation authorization)

| Requirement | Status | Evidence |
|---|---|---|
| Credential: dedicated bearer token, distinct from `bt_session` | Pass | Directly confirmed: a real, valid `bt_session` cookie presented alone (no `Authorization` header) against the real live endpoint returns `401`. |
| Constant-time comparison, generic failure response | Pass | Source-inspected `constantTimeTokenMatches` (length check first, then `crypto.timingSafeEqual`, never `===`). Wrong token and missing header both return identical `401 {"error":"Unauthorized"}`. |
| Rotation atomicity, no overlap window | Pass | Directly triggered a real rotation: previous key transitioned straight to `revoked` (no `retired` state), new key `current`; directly inspected `signing_keys` afterward — exactly one `current` row, all others `revoked`, `retired_at` null throughout. |
| Concurrent triggers | Pass | Directly fired two authenticated requests concurrently: both returned 200, chained correctly (second's `previousKid` == first's `newKid`), exactly one final `current` row, no corruption. |
| Audit trail (every attempt, success and failure) | Pass | Directly inspected `emergency_rotation_audit` after a mixed sequence (bad token, missing header, cookie-only, one success): exactly the expected rows, correct `result`/`failure_reason`/`previous_kid`/`new_kid`/`triggered_by` values, credential value absent from every row. |
| Credential value never logged/exposed | Pass | Source-grepped every use of `emergencyRotationToken`; used only inside the constant-time comparison and the `Authorization: Bearer` header construction, never interpolated into a log or response. |
| Wrong method/path → generic 404 | Pass | Directly confirmed `GET /admin/emergency-rotate-keys` and `POST /admin/not-a-real-path` both return the same unmodified `404 {"error":"Not found"}`. |
| `previousKid`/`newKid` in success response, `Cache-Control: no-store` | Pass | Directly confirmed on a live `200` response. |
| Migration ownership (Open question #8) | Pass | `emergency_rotation_audit` table exists exactly as specified, created by TASK-009's own migration addition to `src/database.ts`. |
| Atomicity composition (Open question #7) | **Finding (F1)** | See below — resolved by implementation choice (a) from the contract's own list, not escalated first. |

## Validation reviewed or performed

All of the following were performed directly by this reviewer against the
real compiled service (`npm run build`, then `dist/*.js`), not merely read
from implementer transcripts, except where explicitly marked as relying on a
prior handoff's transcript:

- Fresh seed via `node dist/seed.js --client-secret-file=...` against a
  throwaway `PGLITE_DATA_DIR`; confirmed exit 0, correct confirmation
  output, input file deleted, directory `0700`.
- Direct PGlite row inspection: ciphertext opacity, distinct IVs, absence of
  the `DB_ENCRYPTION_KEY` value anywhere in the database.
- Direct `decryptValue` exercises: correct round-trip; wrong key throws;
  wrong AAD throws; tampered ciphertext byte throws.
- Data-directory permission fail-closed test (`chmod 755` → refusal;
  fresh-create → `0700`).
- Single-process lock test: concurrent second instance fails fast; clean
  `SIGTERM` shutdown releases the lock.
- Live HTTP checks against a real listening socket: `/health`,
  `/.well-known/jwks.json`, `/auth/login` redirect (against the real Entra
  tenant's authorize URL), all three `/auth/callback` failure shortcuts
  (missing state, unknown state, `error=` param).
- A from-scratch mock-Entra server + driver built by this reviewer
  (monkey-patching only the hardcoded discovery URL, same technique
  TASK-007's own validation used), run against the real, unmodified,
  exported `createRequestHandler`: 27/27 checks passed, independently
  covering login-redirect shape, unknown/missing/replayed `state`, Entra
  `error=` short-circuit, a full successful login with exact 6-claim token
  and exact `Set-Cookie` shape, `nonce` mismatch, PKCE `code_verifier`
  mismatch, an unregistered/invalid authorization code, a missing identity
  claim (500), and `NODE_ENV=production` having no effect on the `Secure`
  cookie attribute.
- A separate, independently-built Entra-unreachable test: redirected the
  discovery fetch to an unreachable local port; confirmed `502` with the
  exact contract message and no leaked connection-error detail.
- `exp` edge-case computation directly re-run via the real
  `nextLocalMidnightEpochSeconds` for all four contract-named cases; all
  matched exactly.
- Live emergency-rotation trigger against the real service: correct token
  → `200` with correct `previousKid`/`newKid`; wrong token, missing header,
  and a `bt_session` cookie alone → `401`; JWKS before/after confirmed the
  old key's removal and the new key's presence.
- Independently minted a fresh token under the now-revoked key (using the
  real `mintSessionToken` and the key decrypted directly from the
  database) and confirmed it fails `jose` `jwtVerify` against the live
  post-rotation JWKS with `JWKSNoMatchingKey` — this re-derives TASK-010's
  central claim from scratch rather than trusting its transcript.
- Ran the real `npm run verify-offline` proof (`dist/verify-offline.js`)
  end-to-end against a fresh throwaway environment: `AC1`/`AC2`/`AC3` all
  `PASS`, `Overall: PASS`, exit 0 — a live re-execution of TASK-010's
  actual deliverable, not a re-read of its transcript.
- Concurrent-rotation atomicity: two simultaneous authenticated trigger
  requests, confirmed correct chaining and exactly one final `current` key.
- Full `emergency_rotation_audit` table inspection after a mixed
  success/failure sequence.
- Source-wide grep for `NODE_ENV` (zero matches in `src/`/`scripts/`) and
  for every use of `privateKeyPem`/`private_key`/`emergencyRotationToken`/
  `dbEncryptionKey`/`clientSecret`, confirming none reaches a log line or
  response body outside the intended storage/crypto/HTTP-auth call sites.

Relied on prior handoffs' transcripts, not independently re-run, for:
CONTRACT-001's `COOKIE_SECURE=true → Secure` live case (source-confirmed
instead; the code path is a single unconditional boolean read, low risk);
TASK-005's PGlite catalog-level schema inspection (schema unchanged since,
and independently re-derived from the live running schema during this
review's own seed/inspection); TASK-006's duplicate-`insertSigningKey`
rejection (unchanged code path, source-confirmed).

Not independently verifiable in this environment: an actual interactive
human login against the real Entra tenant (requires real end-user browser
credentials neither the original implementer nor this reviewer had access
to). This reviewer did independently confirm the real discovery/JWKS
metadata fetch and the real `/auth/login` redirect against the actual
TASK-001 tenant/client succeed, which is the same partial confirmation
TASK-007's own handoff already recorded as its residual gap.

## Findings

### F1 — Major / Human decision required: CONTRACT-002's `rotateSigningKey`/`revokeKey` interface was not implemented; a different function was substituted without escalating the explicitly-flagged open question first

- **Affected requirement:** CONTRACT-002 "Interfaces" (`rotateSigningKey`,
  `revokeKey` — stated as normative function names/signatures); CONTRACT-003
  Open question #7 (atomicity composition, explicitly left for "Patrick (or
  a contract-designer pass on CONTRACT-002) to settle before
  implementation").
- **File/symbol:** `src/secrets.ts` (no `rotateSigningKey`/`revokeKey`
  exported; `rotateSigningKeyEmergency`/`recordEmergencyRotationFailure`
  exist instead); `docs/contracts/CONTRACT-003-...md` Open question #7;
  TASK-009's own handoff, "Assumptions and deviations."
- **Evidence:** `grep -n "rotateSigningKey\b\|revokeKey" src/secrets.ts`
  finds no match for either name; `rotateSigningKeyEmergency` is a
  different function. CONTRACT-003's Open question #7 states this exact
  tension was foreseen and explicitly not resolved by the contract itself:
  "I did not resolve this by unilaterally amending CONTRACT-002 — it's
  flagged here as a real design touchpoint between the two contracts for
  Patrick (or a contract-designer pass on CONTRACT-002) to settle before
  implementation." TASK-009's implementer proceeded to implement option
  (a) from that same open question's own text (bypass `rotateSigningKey`,
  implement the sequence directly) without first securing that
  confirmation, though the deviation was documented transparently in the
  handoff.
- **Reasoning:** Two independent problems bundled together. First,
  CONTRACT-002 as literally written specifies a function-level interface
  that does not exist in the codebase — a real, checkable non-compliance
  regardless of intent. Second, and more importantly per this project's
  own foundational rule 4 ("Escalate material ambiguity, architectural
  decisions, and conflicting instructions to the human"), CONTRACT-003
  itself named this exact tension as unresolved and asked for Patrick's
  or a contract-designer's decision before implementation — that
  escalation did not happen before the implementer chose an answer.
  Functionally, the chosen answer works: this review independently
  confirmed atomicity (a committed rotation and its audit row never
  diverge, verified via concurrent-trigger and inspection tests), and no
  observable defect resulted. This is why the finding is "major," not
  "blocking" — nothing is broken, but a contract's literal interface is
  unmet and a flagged architectural decision point was resolved without
  the review/escalation this project's process requires for exactly this
  situation.
- **Expected behavior:** Either (a) CONTRACT-002 is amended to reflect
  `rotateSigningKeyEmergency`/`recordEmergencyRotationFailure` (or an
  equivalent) as its actual normative interface, retiring the
  `rotateSigningKey`/`revokeKey` signatures it currently specifies, or (b)
  `rotateSigningKey`/`revokeKey` are implemented as CONTRACT-002 currently
  specifies and TASK-009's emergency path is adapted to call them (the
  contract's own option (b), a "small extension to CONTRACT-002's
  interface to accept an externally-supplied transaction").
- **Recommended resolution:** This is Patrick's decision to make, not the
  reviewer's or the implementer's — exactly as CONTRACT-003's own Open
  question #7 already asked. No fix is proposed here; either resolution is
  workable, and future routine-rotation work (which the contract's
  `retired` state already anticipates) will need `rotateSigningKey`'s
  overlap-window path (`previousKeyDisposition: 'retire'`) implemented
  under whichever interface Patrick confirms.

### F2 — Non-blocking / already tracked: TLS-only precondition (TASK-003d) is not yet implemented

- **Affected requirement:** CONTRACT-001 Preconditions ("BTAuthOrchestrator's
  own origin ... is served over TLS"); CONTRACT-003 Preconditions (same,
  stated again for the emergency-rotation endpoint specifically, since it
  carries a bearer credential in a header).
- **File/symbol:** `tasks/approved/TASK-003d-tls-provisioning.md` (still in
  `approved/`, not `completed/`).
- **Evidence:** `ls tasks/approved/` shows `TASK-003d-tls-provisioning.md`
  still pending; TASK-009's own handoff "Unresolved risks" already names
  this exact gap and defers its closure to TASK-003d.
- **Reasoning:** Not a new discovery — this review confirms what TASK-009
  already flagged, restated here because CONTRACT-001 and CONTRACT-003 both
  name TLS as a hard precondition and this review is the point in the
  lifecycle where that should be visibly recorded against the milestone as
  a whole, not just one task's residual-risk note. No code change in this
  milestone opens a new plain-HTTP exposure; the gap is purely that the
  reverse-proxy/TLS provisioning task hasn't run yet.
- **Expected behavior:** `orca.biztechro.com` is reachable only over TLS
  before either contract's preconditions are considered fully satisfied in
  production.
- **Recommended resolution:** No action against TASK-011 itself; track to
  completion via TASK-003d as already planned. Non-blocking for this
  review's outcome on the source/behavior actually reviewed here.

### Recommendation (non-blocking): `COOKIE_SECURE=true` live cookie shape not independently re-run this session

- Confirmed by direct source inspection (`src/index.ts`,
  `buildSetCookieHeader`/its caller: `secure` is derived solely from
  `config.cookieSecure`, nothing else) and by TASK-007's own live transcript
  (`COOKIE_SECURE=true -> Set-Cookie includes Secure`, one of its 44 passing
  checks). This reviewer independently re-confirmed the `COOKIE_SECURE=false`
  case and the `NODE_ENV`-independence case live, but did not re-run the
  `=true` case live due to time. Low risk: the code path is a single
  unconditional boolean read with no branching on any other signal. Suggest
  a human or future re-review spot-check this specific case live if ever in
  doubt, but not required before acceptance.

## Regression and security assessment

- No security decision anywhere derives from `NODE_ENV` — confirmed by
  exhaustive source grep (zero matches) and by a live test that set
  `NODE_ENV=production` mid-session and confirmed no behavioral change to
  cookie security attributes.
- Private key material (`privateKeyPem`/`private_key_*`) never appears in a
  response body or log call site — confirmed by grep across every source
  file and by direct inspection of live JWKS/health/error responses.
  `CLIENT_SECRET`, `DB_ENCRYPTION_KEY`, and `EMERGENCY_ROTATION_TOKEN` are
  likewise confirmed never logged or returned, including on every exercised
  failure path.
- Envelope encryption is correct and defends against key-reuse, tampering,
  and cross-row ciphertext substitution (AAD binding) — all three directly
  tested and all three correctly throw.
- The single-process constraint and data-directory permission requirements
  are enforced, not just documented, and fail closed and observably rather
  than corrupting state or silently degrading.
- The emergency-rotation kill switch is correctly authenticated,
  constant-time compared, atomic, safe under concurrency, and fully
  audited, including the failure/backstop-logging path (directly tested by
  this reviewer for the success/failure/concurrent cases; the
  database-unreachable backstop-log path itself was not re-run by this
  reviewer but was directly tested and shown in TASK-009's own transcript
  with concrete captured log output — a reasonable case to rely on the
  transcript for, since reproducing simulated database unreachability adds
  little marginal assurance over what TASK-009 already demonstrated).
- No regression was found in `/health` or `/.well-known/jwks.json` from any
  of TASK-007/008/009/010/012's changes — both were exercised live
  throughout this review's session without incident.
- F1 (interface-shape deviation) is a process/contract-compliance concern,
  not a security defect — the actual security property CONTRACT-003 cares
  about (a rotation and its audit row never diverge) was independently
  verified to hold.

## Recommendations

1. Resolve F1 explicitly: either amend CONTRACT-002 to reflect the
   as-built interface, or implement `rotateSigningKey`/`revokeKey` as
   currently specified and adapt TASK-009 to use them. Either is
   acceptable; leaving it unresolved is the only bad option, since future
   routine-rotation work will need a decided answer.
2. Track F2 (TLS) to closure via TASK-003d before any production traffic
   reaches `/auth/login`, `/auth/callback`, or
   `/admin/emergency-rotate-keys`.
3. Optional, low-priority: a future session could re-run the
   `COOKIE_SECURE=true` live case end-to-end for full independent
   confidence, though this reviewer considers the source-level evidence
   already sufficient.

## Human decisions required

- **F1:** Decide how CONTRACT-002's signing-key rotation interface should
  be reconciled with what TASK-009 actually built
  (`rotateSigningKeyEmergency`/`recordEmergencyRotationFailure`) — amend
  the contract, or require the literal `rotateSigningKey`/`revokeKey`
  interface to be implemented. This determines whether TASK-009 (and by
  extension this milestone) is accepted as-is or returned to
  `in-progress` for an interface change.
- Everything else in this report is a Pass with supporting evidence and
  does not require a human decision to proceed, beyond the standard human
  acceptance step itself.

## Addendum (2026-09-15): F1 resolved by process decision, not code change

Patrick decided this is a broader question than a one-off amend-or-adapt
choice: this project had no policy at all for how an approved contract is
changed. Rather than resolve F1 in isolation, he established a general rule
— **[ADR-001](../decisions/ADR-001-contracts-are-retired-by-supersession.md):
once approved, a contract's body is never edited again; a required change
is a new contract that supersedes it** — and applied it as F1's resolution:

- CONTRACT-002 is retired in full (`Status: Retired`, `Superseded by:
  CONTRACT-004`); its body is preserved unmodified as the historical record
  of what TASK-005/006/008 were actually built against.
- [CONTRACT-004](../contracts/CONTRACT-004-encrypted-secret-and-key-storage.md)
  supersedes it wholly, carrying every unaffected section forward verbatim
  and codifying TASK-009's as-built `rotateSigningKeyEmergency`/
  `recordEmergencyRotationFailure` interface as normative — Patrick's
  explicit choice over reworking already-implemented, already-verified code
  to match CONTRACT-002's original, never-implemented
  `rotateSigningKey`/`revokeKey` shape.
- **No code change resulted.** `src/secrets.ts` is unchanged from what this
  review already verified; TASK-009's own handoff and task-file header were
  updated to reference CONTRACT-003/CONTRACT-004 instead of the now-retired
  CONTRACT-002.
- Future routine (non-emergency, overlap-window) rotation — which
  CONTRACT-002 anticipated but which was never implemented — has no
  interface in CONTRACT-004 either; it is explicitly left as an open
  question for a future contract, rather than carrying forward an
  unimplemented, unvalidated shape.

This addendum records the resolution; it does not re-run or supersede the
verification work above. As of this addendum, CONTRACT-004 is
`Status: Proposed`, pending Patrick's formal approval alongside the rest of
this milestone's acceptance.
