# TASK-032: Proxy-only mode and ingress warnings

Owner role: Implementer
Assigned agent: openai-coder
Proposed by: Claude (TASK-031 follow-up)
Proposed date: 2026-10-29
Approved by: Patrick
Approved date: 2026-10-29
Related contracts: CONTRACT-013 (§2.0, §3, §6, §7, §8; Failure behavior;
Validation requirements)
Related ADRs: ADR-001
Dependencies: CONTRACT-013 approved (done 2026-10-29). TASK-034 Phase 0
check B passes (the container sees the connector's real IP). Can run in
parallel with TASK-025; the two touch different files except
`docs/DEVELOPMENT.md` and `src/index.ts` startup logging, so coordinate if
both run at once.

## Desired outcome

The service implements CONTRACT-013's admission gate, `PROXY_ONLY` setting
and startup reporting, in native and container installs alike, so a
published port on the LAN cannot be used to bypass Cloudflare.

## Context

CONTRACT-013 replaced CONTRACT-012 because the tunnel connector runs on a
separate LAN machine, so Orca's port is published on the LAN. TASK-029 built
CONTRACT-012 §2 (`src/clientAddress.ts`, `createClientAddressResolver`,
`parseTrustedProxies`), which CONTRACT-013 keeps unchanged as §2.1. This
task adds §2.0 in front of it.

Decided by Patrick (CONTRACT-013 resolved questions, 2026-10-29): the
default of `PROXY_ONLY` comes from `TRUSTED_PROXIES`; Cloudflare-settings,
range and connector-drift checks are warnings, not failures; `/health` stays
`GET`-only; the drafted texts and intervals stand.

## Scope

### Included

- **Configuration (§6):** parse `PROXY_ONLY` in `src/config.ts` (empty =
  unset, case-insensitive `true`/`false`, anything else a configuration
  error), derive the effective mode from §6's table, and fail startup for
  `PROXY_ONLY=true` with empty `TRUSTED_PROXIES`, naming both, in the
  existing "Configuration error" format.
- **Admission gate (§2.0):** one check that runs before any other request
  processing, including request monitoring, routing and body reading. Exact
  `403` body and headers, `Connection: close`, no `Set-Cookie`, no database,
  audit or throttle effect, loopback `GET`/`HEAD` exactly `/health`
  admitted, no-peer requests refused.
- **Refusal logging (§2.0):** once per peer per 60 s with suppressed count,
  no headers or query string, path escaped and truncated, bounded tracking
  memory, fixed placeholder for no-peer requests.
- **Startup reporting (§7):** the mode line before listening, stating set
  vs. derived; the configuration line includes the effective proxy-only
  value.
- **Warnings (§3, §7):** range warning at startup; Cloudflare-settings
  warnings when proxy-only is on; missing-`TRUSTED_PROXIES` warning and
  connector-drift warning, each at most once per 10 minutes per process,
  never with header values.
- **Tests:** a new `scripts/test-proxy-only.js` in the style of
  `scripts/test-trusted-proxies.js` covering every item in CONTRACT-013's
  Validation requirements except the TrueNAS checks. Every existing test
  script still passes.
- **Docs:** `docs/DEVELOPMENT.md` section on ingress modes (proxy-only,
  tunnel plus direct LAN, local-only), the variables, the log lines and
  what each mode gives up (CONTRACT-013 §4, §8). Release note that a native
  install which sets `TRUSTED_PROXIES` becomes proxy-only on upgrade.

### Excluded

- Container image, storage and form documentation (TASK-025).
- Changing the `/health` route or CONTRACT-012 §2's algorithm.
- TrueNAS validation (TASK-034).

## Plan

1. Config parsing and effective-mode derivation, with startup failures.
2. Admission gate wired in front of `withRequestMonitoring` /
   `createRequestHandler` in `src/index.ts`.
3. Refusal logging and the three runtime warnings.
4. Startup mode line and the two startup warnings.
5. Tests, then docs.

## Acceptance criteria

- [x] Every row of CONTRACT-013 §6's table behaves as specified, including
      `TRUE`, ` false `, empty, and invalid values (`1`, `yes`, `on`).
- [x] With proxy-only on, untrusted IPv4, IPv6 and IPv4-mapped peers get
      the exact `403` with no `Set-Cookie`; loopback `GET`/`HEAD /health`
      is admitted; loopback `POST /health`, `/health?x=1`, `/health/`,
      `/admin/console` and `/.well-known/jwks.json` are refused.
- [x] Refused requests run no handler, write no row, do not count toward
      throttles, produce no access-log line, and a refused `POST` with a
      never-finished body gets its `403` promptly.
- [x] Refusal log rate-limiting, suppressed counts, escaping, truncation
      and bounded memory are tested.
- [x] Both off modes admit every peer on every route, as today.
- [x] Mode line, range warning, Cloudflare-settings warning,
      missing-`TRUSTED_PROXIES` warning and connector-drift warning each
      appear exactly when CONTRACT-013 says, and never contain header
      values.
- [x] Native and container-mode local-only starts (empty `TRUSTED_PROXIES`,
      `http://` issuer, `COOKIE_SECURE=false`) serve sign-in, JWKS and the
      console.
- [x] `npm run build` and every `scripts/test-*.js` pass on Node 22.
- [x] `docs/DEVELOPMENT.md` documents the modes, variables and log lines.

## Validation requirements

Isolated tests as above; no socket binding needed for the gate tests beyond
what existing test scripts already do. TrueNAS checks belong to TASK-034.

## Risks and assumptions

- The gate must run before request monitoring; otherwise refused requests
  would appear in the console's request monitor (CONTRACT-013 §2.0 "no
  per-request access-log line").
- Existing tests that use `TRUSTED_PROXIES` with direct requests may now be
  proxy-only by default and need `PROXY_ONLY=false` or a trusted peer.

## Blocker

None.

## Implementation handoff

Implemented by openai-coder, 2026-10-29. Ready for independent review and
human acceptance; not marked accepted.

### Changes

- `src/config.ts`: strict optional PROXY_ONLY parsing, effective default,
  explicit/derived metadata, and aggregated Configuration errors naming
  both variables when true has no trusted entries.
- `src/ingress.ts`: one admission wrapper outside monitoring and routing;
  exact refusal, loopback health exception, no-peer refusal, bounded refusal
  logging, mode reporting and all warnings. Tracking holds at most 4,096
  peers, paths are bounded to 256 characters before escaping, intervals are
  60 seconds and 10 minutes. Full tracking suppresses new-peer logs; expired
  entries with no pending suppressed count can free capacity. Pending counts
  are retained until reported. No active rate-limit entry is evicted.
- `src/index.ts`: wraps monitoring with admission, reports effective mode
  before listening, and routes Node checkContinue/checkExpectation events
  through that same gate, preventing automatic 100/417 replies before a 403.
- `scripts/test-proxy-only.js`: configuration and admission matrices,
  inaccessible monitoring/store/route pipeline on refusal, logging limits,
  warning privacy and conditions, real unfinished-body TCP refusal (including
  Expect headers), actual process startup for all modes and explicit/derived
  variants, and native/container local-only routes.
- `docs/DEVELOPMENT.md`: appended only the self-contained Ingress modes
  section, including variables, logs, trust limitations and upgrade note.
  Re-read immediately before editing; a byte comparison against that snapshot
  verified all preexisting content remained unchanged.
- Task moved approved → in-progress with Assigned agent: openai-coder,
  then review with this handoff. No commit created.

`src/clientAddress.ts` is byte-for-byte unchanged against Git; CONTRACT-013
§2.1 remains TASK-029's algorithm. None of the prohibited TASK-025 files
were edited. Existing unrelated changes were preserved.

### Validation

Every Node/npm command used
`PATH=/home/patrick/.nvm/versions/node/v22.22.3/bin:$PATH` and
`npm_config_cache=/tmp/npm-cache` (Node 22.22.3).

- `./node_modules/.bin/tsc`: both prerequisite compilation runs passed.
- `node scripts/test-proxy-only.js`: all five standalone runs passed as
  coverage was expanded; also passed in the full suite. Final run includes
  production proxy-only refusals and GET/HEAD health route preservation.
- `node scripts/test-trusted-proxies.js`: narrow run passed, including
  resolver matrix, independent client throttle buckets and login/admin/
  rotation audit attribution; also passed in the full suite.
- `npm run build`: both runs passed, including console asset copying.
- Full suite command: `for test in scripts/test-*.js; do node "$test"; done`
  (each script's output captured separately in `/tmp/task032-<basename>.log`
  and its individual exit code checked). Results:
  - `scripts/test-admin-console.js`: exit 0.
  - `scripts/test-api-docs.js`: exit 0.
  - `scripts/test-console-sign-in.js`: exit 0.
  - `scripts/test-container-deployment.js`: exit 0.
  - `scripts/test-local-password-change.js`: exit 0.
  - `scripts/test-local-registration.js`: exit 0.
  - `scripts/test-proxy-only.js`: exit 0.
  - `scripts/test-trusted-proxies.js`: exit 0.
- `git diff --check -- src/config.ts src/index.ts docs/DEVELOPMENT.md`:
  passed; new-file whitespace checks with `git diff --no-index --check
  /dev/null` for `src/ingress.ts` and `scripts/test-proxy-only.js` passed.
- `git diff --exit-code -- src/clientAddress.ts`: exit 0, unchanged.
- Python byte comparison of DEVELOPMENT against its immediate pre-edit
  snapshot: passed. An initial display comparison stripped the snapshot's
  trailing newline and printed false; the exact-prefix check and corrected
  exact-section comparison both passed. No document content was lost.

No existing test script needed modification: the trusted-proxy tests already
use trusted peers for tunnel traffic, and direct cases have no trusted list.
No acceptance criterion remains unchecked. Store/DB/audit/throttle exclusion
is verified by the gate never entering the actual monitoring/route pipeline,
with throwing store/body/monitoring sentinels, rather than adding test hooks
inside the private throttle implementations.

### Assumptions, deviations and remaining risks

- No contract behavior deviation. The local-only mode line adds explicit/
  derived metadata to the proposed wording to meet §7's general requirement.
- The bounded tracking size and path bound are implementation choices; the
  contract specifies bounded memory/length without prescribing numbers.
- Node's HTTP machinery suppresses response bodies on HEAD on the wire;
  the refusal handler supplies the identical fixed body for every method.
  The health route stays GET-only; real HEAD /health remains 404 after
  admission, as required.
- Container-mode startup tests redirect only filesystem boundaries for
  `/data` and mountinfo into scratch storage. Real container guards, config,
  database and server execute. This verifies the isolated container-mode
  requirement, not Docker/TrueNAS deployment, image building or a real tunnel.
- Phase 0's recorded result takes precedence over its earlier prediction:
  TrueNAS-to-own-LAN traffic has the host LAN IP, which is not trusted.
- TASK-025 was being edited concurrently. Its test suite passed; no failure
  was attributed to it. No container/compose documentation was edited here;
  this section identifies CONTRACT-013 as governing older topology guidance.
- TrueNAS and real Cloudflare checks remain TASK-034's responsibility.
  IP-based connector trust, plain HTTP exposure and Cloudflare Access bypass
  by a trusted-host process remain the contract's accepted residual risks.


### Follow-up documentation note (2026-10-29)

Updated `.env.example`'s `TRUSTED_PROXIES` block for CONTRACT-013's
connector LAN IP and ingress defaults, and added a commented `PROXY_ONLY`
line explaining parsing, derivation and the startup requirement. Validated
with `git diff -- .env.example`, a byte comparison confirming all content
outside that block is unchanged, and whitespace checks. No wording conflicts
or behavior changes; task remains in `tasks/review/`.

### QA rework handoff (openai-coder, 2026-10-29)

Changes made for Patrick's returned scope:

- Finding 1: `src/ingress.ts` now expires every stale entry when a new peer
  needs capacity in the full 4,096-peer table, regardless of pending counts.
  Pending counts on expired entries are dropped. This is the simplest
  authorized choice: no expiry log burst or additional state, bounded memory,
  and no eviction before the 60-second interval ends. Retained peers still
  report their suppressed counts normally. This supersedes the original
  handoff's statement that pending counts are retained until reported.
- Finding 2: Expect processing applies only to HTTP/1.1, after admission.
  HTTP/1.0 ignores Expect and proceeds through normal processing/refusal.
- Regression coverage in `scripts/test-proxy-only.js`: fill all 4,096 slots
  with pending counts, verify a new peer is initially unlogged, advance
  beyond 60 seconds, and verify that peer is logged. Raw sockets cover
  HTTP/1.0 and HTTP/1.1 with both `100-continue` and `foo`, admitted and
  refused: HTTP/1.0 gets no 100/417; refused HTTP/1.1 gets 403 without either;
  admitted HTTP/1.1 still gets 100 or 417 as appropriate.
- Finding 5: re-read `docs/DEVELOPMENT.md` immediately before editing and
  changed only the client-address heading to CONTRACT-013, the trusted-proxy
  default bullet, and the peer-cap explanation (including dropped counts).

Validation performed on Node 22.22.3, with the requested PATH exported;
`npm_config_cache=/tmp/npm-cache` for the build/full suite:

- `./node_modules/.bin/tsc`: passed (prerequisite compilation for tests that
  import `dist/`).
- `node scripts/test-proxy-only.js`: passed first, before build/full suite.
- `npm run build`: passed, including console asset copying.
- `for test in scripts/test-*.js; do node "$test"; done`, with individual
  output captured under `/tmp/task032-rework-<basename>.log` and each exit
  code checked:
  - `node scripts/test-admin-console.js`: exit 0.
  - `node scripts/test-api-docs.js`: exit 0.
  - `node scripts/test-console-sign-in.js`: exit 0.
  - `node scripts/test-container-deployment.js`: exit 0.
  - `node scripts/test-local-password-change.js`: exit 0.
  - `node scripts/test-local-registration.js`: exit 0.
  - `node scripts/test-proxy-only.js`: exit 0.
  - `node scripts/test-trusted-proxies.js`: exit 0.
- `git diff --check`: passed before handoff; scoped final whitespace check
  and acceptance-criteria preservation check also passed after handoff.

Assumptions, deviations and unresolved risks:

- Dropping pending counts on stale eviction follows Patrick's explicit
  authorization and CONTRACT-013's bounded-memory/rate-limiting allowance.
  Counts lost on expiry are the chosen tradeoff; no unresolved contract
  ambiguity or expanded implementation scope.
- Findings 3 and the remaining finding 4 gaps stay accepted follow-ups.
  Real Cloudflare/TrueNAS validation remains TASK-034's responsibility.
- TASK-025 edits were concurrent; no validation failures occurred, including
  its container-deployment script. None of its protected files, clientAddress,
  contracts, or approved acceptance criteria were edited by this rework.
- No commit created. Task moved from in-progress to review for independent
  review and human acceptance; not marked accepted.

## Review

### QA review

Reviewer: QualityAssurance (independent), 2026-10-29. Reviewed the working
tree against 91add8e (`src/ingress.ts`, `src/config.ts`, `src/index.ts`,
`scripts/test-proxy-only.js`, `.env.example`, `docs/DEVELOPMENT.md`)
against CONTRACT-013 §2.0, §3, §6, §7, §8, Failure behavior and Validation.

**Outcome: Human decision required** (one should-fix finding is about how to
read the contract; no blocking defects).

Validation run by the reviewer (Node v22.22.3 on PATH):
`npm run build` passed; every `scripts/test-*.js` exited 0 (admin-console,
api-docs, console-sign-in, container-deployment, local-password-change,
local-registration, proxy-only, trusted-proxies). A scratch probe script
(outside the repo) checked the gate over real sockets and the bounded
refusal-log state.

Verified as conforming: the gate wraps monitoring and routing, and is also
wired to `checkContinue`/`checkExpectation`, so a refused `Expect` request
gets 403 with no 100/417 first. Only the trusted peer, or loopback
(127/8, ::1, mapped) GET/HEAD to exactly `/health`, is admitted; absolute-form
`/health`, `?x=1` and `/health/` are refused. The 403 body and headers are
exact, with no Set-Cookie and the connection closed. A refused request with
an unfinished body closes promptly, and pipelined requests after a refusal
are not served. The no-peer placeholder is used. The 60 s per-peer interval
reports suppressed counts; paths are JSON-escaped (plus C1, U+2028/2029) and
truncated at 256 characters, with no query string and no headers. PROXY_ONLY
parsing (trim, case-insensitive, invalid fails, derived default, true with
empty TRUSTED_PROXIES fails naming both) works through the aggregated
Configuration error before listening. The mode line comes before listening
and says set/derived. Range, Cloudflare-settings, missing-TRUSTED_PROXIES and
drift warnings fire under the right conditions, contain no header values and
use a 10-minute interval. CF-Connecting-IP is honoured only from trusted
peers (`clientAddress.ts` unchanged). An admitted HTTP/1.1
`Expect: 100-continue` still gets 100 and its body is processed (probe). The
container healthcheck (127.0.0.1 on a dual-stack listener) is admitted.

Findings:

1. **Should-fix: refusal logging can be switched off for good for new
   peers.** `src/ingress.ts:63-72`. When the map is full, only entries with
   `suppressed === 0` that are past their interval are freed. An entry with
   a pending suppressed count is kept until that same peer is refused again,
   which may never happen. Probe: 4,096 peers each refused twice within 60 s,
   then the clock advanced 24 h, then a new peer `192.168.1.99` was refused.
   Result: 0 log lines, and no new peer is ever logged again for the life of
   the process. Failure scenario: someone with about 4k routable source
   addresses fills the table once. After that, the "Connector IP drifts,
   proxy-only on" failure row ("The refusal log names the new address")
   breaks. Every tunnel request is then refused with no log naming the
   connector's new address, and the operator loses CONTRACT-013's UX promise
   that logs show "which addresses are being refused". The contract allows
   refusals to be "logged less often", but stopping new-peer logging forever
   goes beyond that. Recommended: let stale entries expire whatever their
   pending count (drop the count or emit it), or evict the oldest stale
   entry. Add a test with pending counts. The human may instead accept this
   as residual risk, since only the LAN IPv4 is published.
2. **Minor: regression for HTTP/1.0 requests with `Expect`.**
   `src/ingress.ts:100-105`. Node itself ignores `Expect` on HTTP/1.0
   requests (it emits `request`), but the wrapper now acts on the header for
   every version. Probe: HTTP/1.0 `Expect: foo` now gets 417 (it used to be
   handled), and HTTP/1.0 `Expect: 100-continue` gets an interim
   `HTTP/1.1 100 Continue`, which RFC 9110 §10.1.1 says a server must not
   send to an HTTP/1.0 request. Recommended: only handle `Expect` when
   `httpVersion === "1.1"`, matching Node.
3. **Minor: malformed request targets get Node's 400, not the 403.** §2.0
   says the refusal is identical for "malformed request targets". Targets
   that llhttp rejects (for example `GET /a b c HTTP/1.1`) get Node's default
   `400 Bad Request` from `clientError` before the gate runs (probe). No
   handler runs and nothing leaks, so this is a wording deviation, not a
   security problem. Recommended: either a `clientError` handler that sends
   the fixed 403 in proxy-only mode, or the human records it as accepted.
4. **Minor: test gaps.** `scripts/test-proxy-only.js` does not cover the
   admitted `Expect` path in production wiring, saturation with pending
   suppressed counts (finding 1), the verbatim mode-line or warning wording,
   or HTTP/1.0. Contract failure rows are otherwise covered.
5. **Minor: docs.** `docs/DEVELOPMENT.md:161` is still headed "CONTRACT-012"
   and its `TRUSTED_PROXIES` bullets do not say that setting the variable
   now turns on proxy-only by default (only a link to Ingress modes). The
   Ingress modes text "excess new peers are silently refused until expired
   entries free capacity" is misleading given finding 1. `.env.example`
   agrees with the contract.

Residual risk (accepted by the contract): IP-based connector trust, plain
HTTP on the LAN hop, no Cloudflare Access for direct LAN in off modes.
TrueNAS checks are still TASK-034's.

Recommended next transition: the human decides on finding 1. If a fix is
wanted, return to `in-progress` (findings 1 and 2 are small). Otherwise
accept from `review/` with findings 2-5 as follow-ups.

### Returned to in-progress (Patrick, 2026-10-29)

Patrick accepted the QA recommendation to fix before acceptance. Rework
scope, limited to these items:

1. QA finding 1 (should-fix): refusal-log state in `src/ingress.ts` must not
   stop logging permanently when the peer table is full. Stale entries must
   expire or be evicted whatever their pending suppressed count, so a new
   peer is still logged (rate-limited per CONTRACT-013). Add a test with a
   full table where every entry has a pending count.
2. QA finding 2 (minor): handle `Expect` only for HTTP/1.1 requests;
   HTTP/1.0 keeps Node's default behaviour. Add a test.
3. QA finding 5 (minor): `docs/DEVELOPMENT.md` heading near line 161 names
   CONTRACT-013, the section says setting `TRUSTED_PROXIES` turns proxy-only
   on by default, and the peer-cap note matches the fixed behaviour.

Findings 3 and 4 stay as accepted follow-ups unless they fall out of the
above. Update the implementation handoff and move the task to `review/` when
done.
