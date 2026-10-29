# CONTRACT-013: TrueNAS LAN ingress, proxy-only mode and trusted client address

Status: Approved
Approved by: Patrick
Approved date: 2026-10-29
Related tasks: TASK-031 (this contract's drafting task), TASK-032 (proxy-only
mode implementation), TASK-025 (container image and code), TASK-034 (TrueNAS
validation), TASK-029 (built CONTRACT-012 §2, which this contract keeps)
Related ADRs: ADR-001
Supersedes:
- CONTRACT-012, in full.
- Carried forward from CONTRACT-012, unchanged in substance:
  - CONTRACT-008, only for: the "Reverse proxy" actor; §8 in full; the Scope
    exclusions naming the Caddy image, `Caddyfile` and Caddy's certificate
    mode; OQ-9's deferral, which CONTRACT-012 resolved; and Resolved
    decision #21. Wherever CONTRACT-008 says "the reverse proxy", read "the
    Cloudflare Tunnel connector on its separate LAN host" (§1).
  - CONTRACT-003, only for how `source_ip` is derived (its schema note for
    `emergency_rotation_audit.source_ip` and the assumption in its Open
    questions item 12 that Caddy is the only path to the service).
  - CONTRACT-005, only for how `source_ip` is derived for `local_login_audit`
    and `local_user_admin_audit`, and for which address §3's per-source-IP
    throttle counts.
- CONTRACT-012 also superseded CONTRACT-008's Preconditions bullet that only
  the reverse proxy reaches the Node port, and its Interfaces "Ingress"
  line. This contract does **not** carry those two items forward. CONTRACT-014
  supersedes them as part of CONTRACT-008's container preconditions and
  container interface bullets, and points back to this contract for ingress.
  For that reason this contract is approved, and CONTRACT-012 retired, only
  together with CONTRACT-014 (resolved question 7).

All other behavior in CONTRACT-003, CONTRACT-005, CONTRACT-008, CONTRACT-009
and CONTRACT-011 remains in force.
Superseded by:

## Purpose

Patrick decided on 2026-10-28 (TASK-031) to run BTAuthOrchestrator ("Orca")
on TrueNAS SCALE as a Custom App installed through the TrueNAS form. His
Cloudflare Tunnel connector (`cloudflared`) runs on a **different LAN
machine**, not beside the app. CONTRACT-012's isolation model (no published
port, a private compose network shared only by the app and the connector) no
longer fits:

- Orca publishes its port on the TrueNAS host's static LAN IPv4 address.
- The connector reaches it over the LAN as plain HTTP.
- `TRUSTED_PROXIES` names the connector machine's single LAN address.

Because the port is now on the LAN, any LAN host can reach Node directly.
This contract adds **proxy-only mode** (`PROXY_ONLY`), which refuses every
request that does not come from a trusted proxy, so that a tunnel install can
be made reachable only through Cloudflare.

Patrick also decided that Orca must stay usable entirely on the LAN without
Cloudflare. The **local-only profile** (§8) is a supported deployment, not a
degraded one, and is the intended demo setup.

CONTRACT-012's client-address algorithm (§2.1 here) and its Cloudflare
Access rule (§5 here) are kept unchanged.

### Relationship to CONTRACT-012

This contract supersedes CONTRACT-012 in full (ADR-001). These are the
complete list of differences:

1. **Header.** New title, related tasks and Supersedes list. CONTRACT-012's
   CONTRACT-008 Preconditions bullet and Interfaces "Ingress" line pass to
   CONTRACT-014.
2. **Purpose, Scope, Actors, Inputs and outputs, Preconditions.** Rewritten
   for the separate connector host, the published LAN port, proxy-only mode
   and the local-only profile.
3. **§1 Ingress topology.** Rewritten.
4. **§2 Request admission and client address.** New §2.0 (proxy-only gate).
   §2.1 is CONTRACT-012 §2, word for word.
5. **§3 `TRUSTED_PROXIES`.** The format and validation are unchanged. The
   container rule (the compose subnet) is replaced by the connector's single
   address, and the startup-log rule now sits in §7.
6. **§4 Deployment invariants.** Rewritten, including residual trust.
7. **§5 Admin paths at Cloudflare.** CONTRACT-012 §5, word for word, plus one
   paragraph on paths that bypass Cloudflare.
8. **§6 `PROXY_ONLY`, §7 Startup reporting and warnings, §8 Local-only
   profile.** New.
9. **Postconditions, Failure behavior, Interfaces, UX, Validation.**
   Rewritten. They keep every CONTRACT-012 row that still applies.
10. **Resolved questions.** New, decided by Patrick on 2026-10-29.
    CONTRACT-012's decided questions are recorded under "Resolved decisions
    carried forward".

## Scope

### Included

- The ingress topology for a TrueNAS Custom App with the tunnel connector on
  a separate LAN host (§1), and its deployment invariants and residual trust
  (§4).
- Proxy-only mode: the admission gate (§2.0), the `PROXY_ONLY` setting and
  how its default is derived (§6), and the logging and startup reporting it
  needs (§7).
- How the service derives a request's client address, in every deployment
  mode (§2.1, unchanged).
- `TRUSTED_PROXIES` (§3).
- Protecting `/admin/*` at Cloudflare (§5).
- The local-only profile for native and container installs (§8).

### Excluded

- The container image, the storage, the runtime user and the full list of
  form inputs (CONTRACT-014). The input table in CONTRACT-014 §7.2 lists
  `TRUSTED_PROXIES` and `PROXY_ONLY` for each profile.
- TLS between the connector and TrueNAS (Patrick's decision 4: plain HTTP on
  the LAN is accepted).
- The Cloudflare dashboard and connector-host steps themselves (TASK-025
  documentation and TASK-034 validation).
- A compose or "Install via YAML" path, or a TrueNAS catalog app.
- Any change to what is audited, the throttle thresholds, or how
  `source_ip` is used. Only the value changes, as in CONTRACT-012.
- Honoring `X-Forwarded-For` or any other proxy's header.
- Cloudflare WAF, rate limiting or caching rules beyond §5.
- Publishing on IPv6.

## Actors

- **Client**: a browser, a consuming app, or an operator script. In a tunnel
  install it reaches the service at `https://orca.biztechro.com` through
  Cloudflare. In a local-only install, or in the "tunnel plus direct LAN"
  mode (§6), it may connect directly to the published LAN port.
- **Cloudflare edge**: terminates TLS, sets `CF-Connecting-IP` to the
  address the client connected from (overwriting any value the client
  sent), and forwards the request into the tunnel.
- **Tunnel connector** (`cloudflared`): runs on a **separate LAN host**
  ("connector machine"). It holds the tunnel token and forwards requests to
  `http://<truenas-lan-ip>:<published-port>` as plain HTTP.
- **Connector machine**: the LAN host running the connector. Its LAN address
  is fixed by a DHCP reservation (or a static assignment) and is the one
  entry in `TRUSTED_PROXIES`.
- **TrueNAS host and Docker**: publish the container port on the TrueNAS
  static LAN IPv4. Docker forwards published-port traffic from another host
  with its real source address (iptables DNAT). This is an assumption from
  reading the TrueNAS source, and TASK-034 verifies it (§4).
- **Container healthcheck**: the image's healthcheck, which calls
  `GET /health` over loopback inside the container (§2.0).
- **BTAuthOrchestrator**: admits or refuses each request (§2.0) and derives
  the client address (§2.1).
- **Operator**: sets `TRUSTED_PROXIES`, `PROXY_ONLY` and the other inputs in
  the TrueNAS form (container) or the environment (native).

## Inputs and outputs

| Input | Source | Notes |
|---|---|---|
| Socket peer address | the TCP connection | normalized under §2.1 step 1 |
| Request method and request target | the request line | used only by §2.0's `/health` exception |
| `CF-Connecting-IP` | request header | used only from a trusted peer (§2.1) |
| Other Cloudflare headers (`CF-Ray`, `CF-Visitor`, `CF-IPCountry`, `CDN-Loop`) | request headers | presence only, for §7's warning; never used for the client address |
| `TRUSTED_PROXIES` | environment, read at startup | §3 |
| `PROXY_ONLY` | environment, read at startup | §6; optional |
| Tunnel token | the connector machine's configuration | never in the repo, an image, or the TrueNAS form |

Outputs:

- Per request, either admission or a `403` refusal (§2.0).
- For an admitted request, one client address or none. It is used for every
  `source_ip` audit value, for CONTRACT-005 §3's per-IP throttle, and for
  the CONTRACT-009 password-change throttle, which uses the same address.
- Startup log lines stating the ingress mode (§7).
- Rate-limited log lines for refusals and for Cloudflare headers arriving at
  an install with no `TRUSTED_PROXIES` (§2.0, §7).

## Preconditions

**Tunnel profile (proxy-only, or tunnel plus direct LAN):**

- Patrick's Cloudflare Tunnel exists. Its public hostname
  `orca.biztechro.com` routes to `http://<truenas-lan-ip>:<published-port>`.
- The connector machine has a DHCP reservation (or a static address) on the
  LAN, and `TRUSTED_PROXIES` is exactly that address.
- The TrueNAS host's LAN IPv4 address is static (Patrick's decision 3).
- `SERVICE_ISSUER` is `https://orca.biztechro.com` and `COOKIE_SECURE` is
  `true`, because clients use HTTPS at the edge even though Node receives
  plain HTTP.
- In Entra mode, the Entra redirect URI stays
  `https://orca.biztechro.com/auth/callback`.
- The Cloudflare Access application of §5 is in place before the public
  hostname is enabled.

**Local-only profile:** see §8.

## Required behavior

### 1. Ingress topology (TrueNAS tunnel profile)

- Orca is one TrueNAS Custom App. It publishes container port `3210` (the
  image default `PORT`, CONTRACT-014) over TCP on the TrueNAS host's
  **static LAN IPv4 address only**. The published host port is the
  operator's choice.
- The app publishes on no other host address: not `0.0.0.0`, not `::`, and
  not with an empty Host IP. No IPv6 port is published, because Docker may
  forward IPv6 published ports through `docker-proxy`, which hides the real
  source address.
- The tunnel connector runs on a separate LAN host. Its public-hostname
  route targets `http://<truenas-lan-ip>:<published-port>`. The hop from the
  connector to TrueNAS is plain HTTP on the LAN (Patrick's decision 4).
- Cloudflare's edge serves HTTPS with its own certificate and redirects
  HTTP to HTTPS ("Always Use HTTPS").
- With proxy-only on (§6), the tunnel is the only working ingress. LAN
  clients reach the service through Cloudflare as well. Only the container's
  own loopback healthcheck is answered without passing through a trusted
  proxy (§2.0).
- With proxy-only off and `TRUSTED_PROXIES` set ("tunnel plus direct LAN"),
  LAN clients may also connect directly to the published port. §2.1's trust
  rules apply and nothing is refused.

### 2. Request admission and client address

#### 2.0 Proxy-only gate (new)

This step runs for every request **before** any route handling, request
logging, body reading, session or cookie processing, database access or
throttle accounting. It uses the socket peer address normalized as in §2.1
step 1, and "loopback" means `127.0.0.0/8` or `::1` after that
normalization.

When proxy-only is **off** (§6), every request is admitted and continues to
§2.1 exactly as today.

When proxy-only is **on**:

1. If the socket has no peer address, the request is refused.
2. If the peer address is inside `TRUSTED_PROXIES`, the request is admitted
   and continues to §2.1.
3. If the peer address is loopback, the method is `GET` or `HEAD`, and the
   request target is exactly `/health` (no query string, no trailing slash,
   no other spelling), the request is admitted. It is then handled exactly as
   today: this contract does not change what the `/health` route returns for
   either method (resolved question 5: the route stays `GET`-only).
4. Otherwise the request is refused.

A **refusal**:

- Responds `403` with the fixed body
  `Forbidden. This service only accepts requests through its configured proxy.`
  followed by a newline, `Content-Type: text/plain; charset=utf-8`,
  `Cache-Control: no-store` and `Connection: close`.
- Is identical for every method, path and header combination, including
  `/health` from a non-loopback peer, `/.well-known/jwks.json`, `/admin/*`,
  unknown paths and malformed request targets.
- Runs no route handler and does not read the request body. The connection
  is closed after the response.
- Sets no cookie (no `Set-Cookie` header of any kind), writes nothing to the
  database, writes no audit row, and does not count toward any throttle.
- Produces no per-request access-log line. Refusals are logged only as
  follows.

**Refusal logging.** Refusals are logged at most once per peer address per
60 seconds. A logged line names the
peer address, the request path without its query string, and how many
refusals from that peer were suppressed since its last line. It contains no
header names or values and no query string. The path is truncated to a
bounded length and has control characters escaped, so a client cannot inject
log lines. The memory used to track per-peer rate limits is bounded, so a
flood of distinct peers cannot exhaust memory; once the bound is reached,
refusals may be logged less often but are never logged per request. A
request with no peer address is logged under a fixed placeholder in place of
the address.

#### 2.1 Client address (CONTRACT-012 §2, unchanged)

For each request:

1. Take the socket peer address. Normalize an IPv4-mapped IPv6 address
   (`::ffff:a.b.c.d`) to `a.b.c.d`.
2. If `TRUSTED_PROXIES` is empty or unset, the client address is the peer
   address. Forwarded headers are ignored (OQ-1).
3. If the peer address is not inside `TRUSTED_PROXIES`, the client address
   is the peer address. Forwarded headers are ignored.
4. If the peer is inside `TRUSTED_PROXIES` and the request has exactly one
   `CF-Connecting-IP` header whose trimmed value is a valid IPv4 or IPv6
   literal, the client address is that value, normalized as in step 1.
5. Otherwise, the client address is the peer address.

`X-Forwarded-For` is never consulted (OQ-2). The derived value is
always an IP literal, never raw header text. If the socket has no peer
address, the client address is `null`, as today.

("OQ-1" and "OQ-2" in this subsection refer to CONTRACT-012's decided
questions, recorded below under "Resolved decisions carried forward".)

### 3. `TRUSTED_PROXIES`

- Optional. A comma-separated list of IPv4 or IPv6 addresses or CIDR
  ranges. Whitespace around entries is ignored, and empty entries are not
  allowed. (Unchanged from CONTRACT-012.)
- Read and validated once at startup. Any invalid entry fails startup
  closed, with an error that names the variable and the bad entry.
  (Unchanged.)
- **TrueNAS tunnel profile:** set to the connector machine's single LAN
  IPv4 address, for example `192.168.1.40`. Not a range, and never an
  address listed as forbidden in §4.
- **Range warning (resolved question 3).** At startup, each entry that
  covers more than one address (an IPv4 prefix shorter than `/32`, or an
  IPv6 prefix shorter than `/128`) logs one warning naming the entry and
  saying that every host in it is trusted. Startup continues; ranges are
  not rejected.
- **Local-only profile:** empty or unset (§8).
- An empty or unset value turns proxy-only off unless `PROXY_ONLY` says
  otherwise, and `PROXY_ONLY=true` with an empty value fails startup (§6).
- The trusted entries appear in the startup log (§7). They are not secret.

### 4. Deployment invariants and residual trust

These replace CONTRACT-012 §4:

- The app's port is published only on the TrueNAS static LAN IPv4 (§1).
- `TRUSTED_PROXIES` contains only the connector machine's address. It must
  never contain:
  - the Docker bridge gateway or any container-network address. Hairpin
    traffic from the TrueNAS host itself, and any traffic Docker forwards
    through `docker-proxy`, appears to come from the gateway, so trusting it
    would trust every client that reaches the port that way;
  - the TrueNAS host's own addresses;
  - any range that covers other LAN hosts.
- If TASK-034 finds that published-port traffic from another host arrives
  with the gateway's address rather than its real source (for example
  because Docker's userland proxy is in use), the tunnel profile is not
  deployable as specified. With proxy-only on, the symptom is that every
  tunnel request is refused (a visible outage). The fix is never to add the
  gateway to `TRUSTED_PROXIES`.
- The connector machine keeps its address through a DHCP reservation or a
  static assignment.

**Residual trust (documented, accepted with the design):**

- Trust is based only on the connector machine's IP address. Any process on
  that machine can send requests with any `CF-Connecting-IP` and have them
  believed, and with proxy-only on it can reach every path, including
  `/admin/*`, without passing Cloudflare Access.
- Anyone who takes over the connector's address on the LAN (address
  spoofing, ARP poisoning, or reuse of the address after the reservation
  lapses) gains the same trust.
- The connector → TrueNAS hop is plain HTTP. Anyone able to observe LAN
  traffic between those two hosts can read passwords, `bt_session` cookies
  and bearer tokens in transit (Patrick's decision 4).
- In the "tunnel plus direct LAN" mode and in the local-only profile, LAN
  clients reach `/admin/*` without Cloudflare Access (§5).
- TASK-025's documentation states each of these.

### 5. Admin paths at Cloudflare (CONTRACT-012 §5, unchanged)

- A Cloudflare Access application covers `orca.biztechro.com/admin/*`.
  Only people allowed by its policy reach the console, the admin API,
  `/admin/session`, `/admin/reset-password` or emergency rotation.
- Scripts that call admin endpoints, such as an emergency rotation from a
  shell, use a Cloudflare Access service token in addition to the bearer
  token.
- `/auth/*`, `/.well-known/jwks.json`, `/health`, `/api/*`, `/docs` and
  `/openapi.json` stay
  reachable without Access, because users sign in through them and
  consuming apps fetch JWKS from servers that cannot complete Access.
- This is configured in Cloudflare and needs no code change. The bearer
  tokens and CONTRACT-011 session rules still apply behind it.

**Added:** Access protects only requests that pass through Cloudflare. A
request that reaches the published port directly is not covered. With
proxy-only on, such a request is refused unless it comes from the
connector's address (§4). With proxy-only off, `/admin/*` is reachable from
the LAN behind the bearer tokens and CONTRACT-011's session rules only.

### 6. `PROXY_ONLY`

- Optional boolean, read and validated once at startup, in every install
  type (native and container).
- Parsing: an unset value, or a value that is empty after trimming, counts
  as unset. Otherwise the trimmed value, compared case-insensitively, must
  be exactly `true` or `false`, the same convention as `LOCAL_LOGIN`. Any
  other value fails startup closed, naming `PROXY_ONLY` and the accepted
  values.
- The effective mode is:

| `TRUSTED_PROXIES` | `PROXY_ONLY` | Proxy-only | Mode name (§7) |
|---|---|---|---|
| empty or unset | unset | off | local-only |
| empty or unset | `false` | off | local-only |
| empty or unset | `true` | — | **startup fails closed**, naming both `PROXY_ONLY` and `TRUSTED_PROXIES` |
| set | unset | **on** (derived) | proxy-only |
| set | `true` | on | proxy-only |
| set | `false` | off | tunnel plus direct LAN |

- The default is derived from `TRUSTED_PROXIES` (Patrick's decision 5). A
  tunnel install that forgets `TRUSTED_PROXIES` therefore starts in
  local-only mode, open to the LAN, rather than refusing to start. Patrick
  accepted this so that a demo install needs no proxy settings at all. §7's
  startup line and warning are the mitigations.
- **Compatibility.** Existing native installs without `TRUSTED_PROXIES` are
  unchanged. A native install that already sets `TRUSTED_PROXIES` becomes
  proxy-only on upgrade unless it sets `PROXY_ONLY=false`. From then on it
  refuses direct and loopback requests other than loopback `/health`. No
  such install is known; TASK-032's release notes say so.
- A `PROXY_ONLY` error is reported together with any other configuration
  errors, in the existing "Configuration error" format, and the process
  exits before listening.

### 7. Startup reporting and warnings

- **Mode line.** At startup, after configuration loads and before the
  service listens, the service logs one plain-language line stating the
  effective mode and whether `PROXY_ONLY` was set or derived. Proposed
  wording:
  - Proxy-only: "Ingress mode: proxy-only. Only requests from
    TRUSTED_PROXIES (`<entries>`) are served; all other requests get 403,
    except loopback GET/HEAD /health. (PROXY_ONLY `<set to true | not set,
    derived from TRUSTED_PROXIES>`.)"
  - Tunnel plus direct LAN: "Ingress mode: tunnel plus direct LAN.
    CF-Connecting-IP is trusted only from TRUSTED_PROXIES (`<entries>`);
    direct requests are served and recorded under their own address.
    (PROXY_ONLY set to false.)"
  - Local-only: "Ingress mode: local-only. TRUSTED_PROXIES is empty, so
    every request is served and recorded under its connection address, and
    Cloudflare headers are ignored. If this install is behind a Cloudflare
    Tunnel, set TRUSTED_PROXIES to the connector machine's address."
- The existing startup configuration line includes the trusted entries, as
  in CONTRACT-012, and the effective proxy-only value.
- **Missing-`TRUSTED_PROXIES` warning.** When `TRUSTED_PROXIES` is empty and
  an admitted request carries `CF-Connecting-IP`, `CF-Ray`, `CF-Visitor` or
  `CF-IPCountry`, or a `CDN-Loop` header containing `cloudflare`, the
  service logs a warning at most once per 10 minutes for the whole process
  The warning names the peer
  address and says the install looks like a tunnel install missing
  `TRUSTED_PROXIES`, that every tunnel user is being recorded under the
  connector's address, and that proxy-only mode is off. It never includes
  header values. The headers are still ignored for the client address
  (§2.1 step 2). The request is otherwise handled normally.
- **Connector-drift warning (resolved question 4).** In "tunnel plus direct
  LAN" mode (`TRUSTED_PROXIES` set, proxy-only off), when a request from a
  peer outside `TRUSTED_PROXIES` carries any of the Cloudflare headers
  listed above, the service logs a warning at most once per 10 minutes for
  the whole process. It names the peer address, says the connector's address
  may have changed, and names `TRUSTED_PROXIES`. It never includes header
  values. The headers are still ignored and the request is otherwise
  handled normally. (With proxy-only on, such requests are refused and
  appear in §2.0's refusal log instead.)
- **Cloudflare-settings warning (resolved question 1).** When proxy-only is
  on, startup logs one warning for each of these that does not hold:
  `SERVICE_ISSUER` starts with `https://`; `COOKIE_SECURE` is `true`. Each
  warning names the setting and the expected value. Startup continues. No
  such check runs when proxy-only is off (§8).

### 8. Local-only profile

A local-only install is supported for native installs (systemd, Windows)
and container installs alike, and is the intended demo setup.

- **Inputs.** Empty or unset `TRUSTED_PROXIES`; `PROXY_ONLY` unset or
  `false`; an `http://` LAN `SERVICE_ISSUER` (for example
  `http://192.168.1.10:3210`, or an `http://` host name that resolves to the
  host on the LAN); and `COOKIE_SECURE=false`. In a container install the
  port is published on the TrueNAS static LAN IPv4 exactly as in §1.
- **Behavior.** Proxy-only is off, every request is admitted, and the client
  address is always the connection's own address (§2.1 step 2). On TrueNAS
  that is the real LAN client address, given Docker's DNAT forwarding (§4).
- **No rule may make this profile impossible.** No container-mode rule in
  this contract or CONTRACT-014 may require Cloudflare, an HTTPS issuer,
  secure cookies or a non-empty `TRUSTED_PROXIES`. Any check that assumes
  Cloudflare applies only when proxy-only is on.
- **What local-only gives up** (documented by TASK-025):
  - No Cloudflare Access in front of `/admin/*`. Only the bearer tokens and
    CONTRACT-011's session rules protect it.
  - Plain HTTP on the LAN: passwords, cookies and tokens cross the LAN
    unencrypted.
  - Console sign-in (CONTRACT-011) stores its cookie only at a host under
    `biztechro.com`. At a bare IP or `localhost`, sign-in appears to succeed
    but the console falls back to tokens. A LAN DNS or hosts-file entry for
    a `biztechro.com` name, used as `SERVICE_ISSUER`, makes console sign-in
    work over HTTP with `COOKIE_SECURE=false`.
  - Nothing is reachable from outside the LAN.
  - Entra sign-in (resolved question 6). Microsoft Entra accepts
    plain-HTTP redirect URIs only for `localhost`, so a LAN local-only
    install is in practice limited to `LOCAL_LOGIN=true`.
- **`CLIENT_SECRET` in a demo.** Container installs, local-only included,
  always require the operator to supply `CLIENT_SECRET` at first boot
  (CONTRACT-014 §7.2). A native local-login demo generating a random
  `CLIENT_SECRET` instead is Patrick's decision of 2026-10-29, specified by
  a separate seed-interface contract change (TASK-035), not by this
  contract.

## Postconditions and invariants

- With proxy-only on, no request from a peer outside `TRUSTED_PROXIES`
  reaches any route handler, except loopback `GET`/`HEAD` `/health`.
- A refused request leaves no database row, audit row, throttle count or
  cookie behind, and its body is never read.
- Proxy-only is never on while `TRUSTED_PROXIES` is empty.
- A forwarded header from a peer outside `TRUSTED_PROXIES` never affects
  any `source_ip` or throttle key. (CONTRACT-012.)
- With `TRUSTED_PROXIES` unset, the client address is the peer address on
  every route. (CONTRACT-012.)
- Two clients signing in through Cloudflare are counted separately by the
  per-IP throttle. (CONTRACT-012.)
- `source_ip` values are always IP literals or `null`. (CONTRACT-012.)
- The startup log always states the effective ingress mode.
- In the TrueNAS profile, the app port is never published on IPv6 or on all
  host addresses (a deployment invariant, §1 and §4).

## Failure behavior

| Condition | Result |
|---|---|
| Invalid `TRUSTED_PROXIES` entry | Startup fails closed, naming the variable and entry |
| `PROXY_ONLY` not `true`/`false` (case-insensitive) and not empty | Startup fails closed, naming `PROXY_ONLY` and the accepted values |
| `PROXY_ONLY=true` with empty or unset `TRUSTED_PROXIES` | Startup fails closed, naming both variables |
| Proxy-only on, peer outside `TRUSTED_PROXIES` | Fixed `403`; no handler, no body read, no cookie, no database or audit write; rate-limited refusal log line |
| Proxy-only on, request has no peer address | Refused as above |
| Proxy-only on, loopback request other than `GET`/`HEAD` exactly `/health` | Refused as above |
| Connector IP drifts, proxy-only on | Every tunnel request is refused: a visible outage at Cloudflare. The refusal log names the new address. Fix: restore the reservation or update `TRUSTED_PROXIES` |
| Connector IP drifts, proxy-only off (tunnel plus direct LAN) | Requests are served. Every tunnel user is recorded under the connector's new address and shares one per-IP throttle bucket. `CF-Connecting-IP` is ignored, so attribution is degraded but cannot be forged. §7's connector-drift warning is logged |
| `TRUSTED_PROXIES` entry covers more than one address | Startup continues; one warning per such entry (§3) |
| Proxy-only on, `SERVICE_ISSUER` not `https://` or `COOKIE_SECURE` not `true` | Startup continues; one warning per setting (§7) |
| Tunnel install with `TRUSTED_PROXIES` forgotten | Starts in local-only mode, open to the LAN. Startup line says "local-only". The first Cloudflare request triggers §7's warning. Attribution is the connector's address |
| Published-port traffic arrives from the Docker gateway rather than its real source | With proxy-only on, every request is refused. With it off, every client shares the gateway's address. Never fixed by trusting the gateway (§4) |
| Trusted peer, no `CF-Connecting-IP` | Peer address used (CONTRACT-012) |
| Trusted peer, malformed or repeated `CF-Connecting-IP` | Peer address used (CONTRACT-012) |
| Untrusted peer sends `CF-Connecting-IP` or `X-Forwarded-For` (proxy-only off) | Ignored; peer address used (CONTRACT-012) |
| Tunnel down | Unreachable through Cloudflare. With proxy-only on, unreachable for everyone, including the LAN. With it off, direct LAN access still works. No data effect |

## Interfaces

- Configuration: `TRUSTED_PROXIES` (optional, §3) and `PROXY_ONLY`
  (optional, §6). Each profile's required and optional inputs are listed in
  CONTRACT-014 §7.2.
- HTTP: no endpoint is added or changed. Proxy-only adds the `403` refusal
  of §2.0, which can be returned for any method and path.
- Logs: §2.0's refusal line, §7's mode line and warning.
- Internally, every caller that derives a client address uses one function
  implementing §2.1 (today `createClientAddressResolver` in
  `src/clientAddress.ts`, called as `extractSourceIp` in `src/index.ts`),
  and one admission check implementing §2.0 runs before any other request
  processing. Carried forward from CONTRACT-012 as an approved constraint.

## UX expectations

- No change for end users reaching the service through Cloudflare.
- A LAN user who opens the published port directly while proxy-only is on
  sees a short plain-text explanation, not a blank page or a generic error.
- An operator reading only the app logs can tell which mode the service is
  in, why (set or derived), which address is trusted, which addresses are
  being refused, and when a tunnel install is missing `TRUSTED_PROXIES`.
- In "tunnel plus direct LAN" mode with `COOKIE_SECURE=true`, browsers
  reaching the plain-HTTP LAN port directly will not keep the session
  cookie. TASK-025's documentation says so and recommends using the tunnel
  hostname instead.

## Validation requirements

Isolated handler tests, in the style of the existing `scripts/test-*.js`
files, cover:

- **CONTRACT-012's rows, unchanged:** every row of §2.1; unset setting;
  untrusted peer with forged `CF-Connecting-IP` and `X-Forwarded-For`;
  trusted peer with a valid IPv4 and a valid IPv6 header; trusted peer with
  a missing, malformed or repeated header; IPv4-mapped peer addresses; CIDR
  and single-address entries; startup validation of `TRUSTED_PROXIES`; the
  per-IP login throttle counting two `CF-Connecting-IP` values from a
  trusted peer separately; audit rows on login, admin and rotation paths
  recording the derived address.
- **`PROXY_ONLY` matrix:** every row of §6's table, plus `TRUE`, ` false `,
  an empty value, and invalid values such as `1`, `yes` and `on`. Startup
  failures name the right variables and the process does not listen.
- **Gate, proxy-only on:**
  - A trusted peer is admitted on several routes.
  - An untrusted IPv4 peer, an untrusted IPv6 peer, and an IPv4-mapped
    untrusted peer each get the exact `403` body and headers, with no
    `Set-Cookie`.
  - Loopback `GET /health` and `HEAD /health` (IPv4, IPv6 and IPv4-mapped
    loopback) are admitted. Loopback `POST /health`, `/health?x=1`,
    `/health/`, `/admin/console` and `/.well-known/jwks.json` are refused.
  - A request with no peer address is refused.
  - Refused requests run no handler, write no database or audit row, do not
    count toward the login or password-change throttles, and produce no
    access-log line.
  - The body is not read: a refused `POST` with a large or never-finished
    body gets its `403` promptly and the connection closes.
- **Gate, proxy-only off:** both off modes admit untrusted and loopback
  peers on every route, as today.
- **Logging:** many refusals from one peer within the interval give one
  line, followed by a line with the suppressed count; two peers give two
  lines; lines contain no header values or query strings; a path with
  control characters or extreme length is escaped and truncated; tracking
  memory stays bounded under many distinct peers.
- **Mode line:** each mode, set and derived, logs its line before
  listening.
- **Missing-`TRUSTED_PROXIES` warning:** with an empty `TRUSTED_PROXIES`, a
  request carrying each listed Cloudflare header triggers the warning once
  per interval, without header values, and the recorded address is still
  the peer. With `TRUSTED_PROXIES` set, no such warning appears.
- **Connector-drift warning:** in "tunnel plus direct LAN" mode, an
  untrusted peer sending a Cloudflare header triggers the warning once per
  interval, without header values; a trusted peer does not. In proxy-only
  and local-only modes this warning never appears.
- **Range warning:** `TRUSTED_PROXIES` entries `192.168.1.0/24` and
  `fd00::/64` each log one warning at startup; `192.168.1.40`,
  `192.168.1.40/32` and a `/128` do not. Startup succeeds in every case.
- **Cloudflare-settings warning:** with proxy-only on, an `http://`
  `SERVICE_ISSUER` and `COOKIE_SECURE=false` each log their warning and
  startup succeeds. With proxy-only off, neither warning appears.
- **Local-only profile:** a native start and a container start with empty
  `TRUSTED_PROXIES`, an `http://` issuer and `COOKIE_SECURE=false` start
  and serve sign-in, JWKS and the console.
- Every existing test script still passes.

**TrueNAS deployment checks, recorded in TASK-034:**

- First, on TrueNAS: `docker version`, `/etc/docker/daemon.json` (userland
  proxy setting), and the iptables DNAT rule for the published port. Confirm
  that a request from another LAN host is logged with that host's address.
- The app's port is published on the TrueNAS static LAN IPv4 only: not on
  other addresses, not on IPv6.
- Cloudflare Access is required for `/admin/console`, and not for
  `/auth/local-login` or `/.well-known/jwks.json`.
- Through the tunnel, two clients' sign-ins record their own public
  addresses.
- A client-supplied `CF-Connecting-IP` sent through the tunnel does not
  change the recorded address. A `CF-Connecting-IP` sent directly to the
  published port from a LAN host does not either (proxy-only off), or the
  request is refused (proxy-only on).
- With proxy-only on, a direct request from a LAN host gets the `403` body,
  and the refusal is logged.
- The TrueNAS app shows the container healthy while proxy-only is on.
- Startup logs show the expected mode line.
- A local-only demo install on TrueNAS (empty `TRUSTED_PROXIES`, `http://`
  issuer, `COOKIE_SECURE=false`) serves sign-in from a LAN browser and
  records the browser's LAN address.

## Resolved questions

Patrick accepted every drafted recommendation on 2026-10-29. The body
above already reflects each answer.

1. **Startup checks that assume Cloudflare:** warn, do not fail (§7,
   Cloudflare-settings warning).
2. **Drafting choices:** as drafted. The §2.0 refusal body text, the
   60-second per-peer refusal-log interval, the 10-minute warning interval,
   an empty `PROXY_ONLY` counting as unset, and case-insensitive
   `true`/`false`.
3. **Wider `TRUSTED_PROXIES` values:** warn at startup, do not reject (§3).
4. **Drift warning in "tunnel plus direct LAN" mode:** yes (§7).
5. **`HEAD /health`:** the route is unchanged; the image healthcheck uses
   `GET` (§2.0).
6. **Entra mode in local-only:** stated in "what local-only gives up" (§8).
7. **Approval:** this contract is approved, and CONTRACT-012 retired, only
   together with CONTRACT-014.

Also decided by Patrick on 2026-10-29: no native install currently sets
`TRUSTED_PROXIES`, so §6's compatibility change affects no known install.

## Resolved decisions carried forward

From CONTRACT-012, decided by Patrick on 2026-10-28:

- **CONTRACT-012 OQ-1:** forwarded headers are ignored unless
  `TRUSTED_PROXIES` is set (§2.1 step 2).
- **CONTRACT-012 OQ-2:** the forwarded header is `CF-Connecting-IP`;
  `X-Forwarded-For` is never read.
- **CONTRACT-012 OQ-3:** Cloudflare Access on `/admin/*` is required before
  go-live (§5).
- **CONTRACT-012 OQ-4:** TASK-003d is retired by Patrick.

From TASK-031, decided by Patrick on 2026-10-28:

- **Decision 1:** the trusted proxy is entered in the TrueNAS form as
  `TRUSTED_PROXIES`, the connector machine's LAN address (§3).
- **Decision 2:** local-only operation stays supported (§8).
- **Decision 3:** TrueNAS's LAN IPv4 is static and is the Host IP for the
  published port (§1).
- **Decision 4:** plain HTTP on the LAN is accepted for the connector hop and
  local-only use (§1, §4, §8).
- **Decision 5:** `PROXY_ONLY` is an optional override, defaulting from
  `TRUSTED_PROXIES` in every install type, with the startup line and the
  missing-`TRUSTED_PROXIES` warning as mitigations (§6, §7).
