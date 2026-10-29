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

## Review

Not reviewed.
