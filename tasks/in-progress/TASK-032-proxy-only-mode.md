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

- [ ] Every row of CONTRACT-013 §6's table behaves as specified, including
      `TRUE`, ` false `, empty, and invalid values (`1`, `yes`, `on`).
- [ ] With proxy-only on, untrusted IPv4, IPv6 and IPv4-mapped peers get
      the exact `403` with no `Set-Cookie`; loopback `GET`/`HEAD /health`
      is admitted; loopback `POST /health`, `/health?x=1`, `/health/`,
      `/admin/console` and `/.well-known/jwks.json` are refused.
- [ ] Refused requests run no handler, write no row, do not count toward
      throttles, produce no access-log line, and a refused `POST` with a
      never-finished body gets its `403` promptly.
- [ ] Refusal log rate-limiting, suppressed counts, escaping, truncation
      and bounded memory are tested.
- [ ] Both off modes admit every peer on every route, as today.
- [ ] Mode line, range warning, Cloudflare-settings warning,
      missing-`TRUSTED_PROXIES` warning and connector-drift warning each
      appear exactly when CONTRACT-013 says, and never contain header
      values.
- [ ] Native and container-mode local-only starts (empty `TRUSTED_PROXIES`,
      `http://` issuer, `COOKIE_SECURE=false`) serve sign-in, JWKS and the
      console.
- [ ] `npm run build` and every `scripts/test-*.js` pass on Node 22.
- [ ] `docs/DEVELOPMENT.md` documents the modes, variables and log lines.

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

Not started.

## Review

Not reviewed.
