# TASK-031: Contract — TrueNAS Custom App deployment with a LAN tunnel connector

Owner role: Contract designer
Assigned agent: contract-architect
Proposed by: Jarvis (TrueNAS deployment proposal, 2026-10-28)
Proposed date: 2026-10-28
Approved by: Patrick Moon
Approved date: 2026-10-28
Related contracts: CONTRACT-012 (to be superseded in full, expected by
CONTRACT-013); CONTRACT-008 (container sections to be superseded, expected by
CONTRACT-014; §1–§6, §7.4 and §7.5 stay in force); CONTRACT-011 (console
sign-in at a `biztechro.com` host)
Related ADRs: ADR-001 (contracts are retired by supersession, never amended
in place)
Dependencies: none. Blocks TASK-025 (returned to in-progress), TASK-032,
TASK-033 and TASK-034.

## Desired outcome

Approved replacement contracts that let BTAuthOrchestrator ("Orca") run on
TrueNAS SCALE 25.10.0.1 (Goldeye) or newer as a single **Custom App installed
through the TrueNAS form**, with no prework on the TrueNAS host and no compose
file. Once approved, TASK-025, TASK-032 and TASK-033 can be implemented
without further architectural decisions.

## Context

TASK-025 was built as a compose stack ("Install via YAML") with a bundled
`cloudflared` service on a private Docker network. Review against TrueNAS
showed it needs host prework (a pre-created dataset at exactly mode 0700,
which clashes with TrueNAS NFSv4 ACLs), builds the image on the host, and
relies on `${VAR:?}` placeholders nothing on TrueNAS fills in. In addition,
Patrick's Cloudflare tunnel connector runs on a **different LAN machine**,
so Orca must publish its port on the LAN. CONTRACT-012's isolation model
(no published port, shared private network) no longer fits.

Jarvis checked the TrueNAS 25.10.0.1 middleware and app library source (not
tested on Patrick's box). Relevant findings:

- The Custom App form pulls a published image; it cannot build from source
  and cannot present custom questions. Settings are entered as environment
  variable rows, storage, user/group and ports.
- Port Host IPs can only be the host's static interface IPs, `0.0.0.0` or
  `::`. Binding to `127.0.0.1` is not possible.
- An ix volume starts root-owned. The form's Storage → Enable ACL (User 568,
  Modify) makes it writable with no shell work. A subfolder the app creates
  itself is then owned by 568 with the mode the app chooses.
- Docker on TrueNAS uses iptables DNAT for published ports, so traffic from
  another host arrives with its real source address. Loopback/hairpin
  traffic goes through `docker-proxy` and appears as the bridge gateway.
  IPv6 published ports may also go through `docker-proxy`, so publish IPv4
  only.

### Patrick's decisions (2026-10-28)

1. **Trusted proxy:** entered in the TrueNAS form as `TRUSTED_PROXIES`
   (the connector machine's LAN IP). No other mechanism is needed.
2. **Local-only operation must keep working.** Orca was built to be usable
   entirely on the LAN without Cloudflare; keep that ability unless it is a
   breaking change. See "Proxy-only mode" below.
3. **TrueNAS's LAN IP is static.** Host IP in the form is that IPv4 address.
4. **Plain HTTP on the LAN is acceptable** for the connector → TrueNAS hop
   and for local-only use. No origin TLS.
5. **`PROXY_ONLY`** is the setting name. It is an **optional override**;
   its default comes from `TRUSTED_PROXIES` (set → on, empty → off), in
   every install type. An empty `TRUSTED_PROXIES` therefore means
   local-only. Patrick accepts that a tunnel install which forgets
   `TRUSTED_PROXIES` starts open to the LAN instead of refusing to start,
   because the same behavior makes a quick demo install need no proxy
   settings at all. Mitigations: the startup log states the mode plainly,
   and the app warns when Cloudflare headers arrive while
   `TRUSTED_PROXIES` is empty.
6. **GHCR owner: `mrdatawolf`.** Image
   `ghcr.io/mrdatawolf/btauthorchestrator:vX.Y.Z`, published as a
   **public** package so TrueNAS pulls it without registry credentials.
7. **First release tag: `v0.9.0`.**
8. **Storage: ix volume** mounted at `/data`, created and managed by
   TrueNAS. Accepted risk: uninstalling with "remove ix volumes" ticked
   deletes signing keys and users.
9. **Restructure approved.** TASK-025 returned to in-progress; this task
   created.

## Scope

### Included

**CONTRACT-013, superseding CONTRACT-012 in full.** Keep CONTRACT-012 §2's
client-address algorithm and §5 (Cloudflare Access on `/admin/*`). Rewrite
purpose, actors, preconditions, §1 topology, §3, §4, failure behavior and
validation for:

- Orca publishes container port 3210 on the TrueNAS static LAN IPv4 only
  (no `::`, no empty Host IPs).
- The tunnel connector runs on a separate LAN host. Its route targets
  `http://<truenas-lan-ip>:<published-port>`.
- `TRUSTED_PROXIES` is the connector machine's single address, with a DHCP
  reservation. Residual trust (other processes on that machine, anyone who
  takes over its IP) is documented.
- **Proxy-only mode** (`PROXY_ONLY`, boolean) as a new step 0 before §2:
  - If the socket peer is in `TRUSTED_PROXIES`, continue with §2.
  - Else, if the peer is loopback and the request is `GET`/`HEAD` exactly
    `/health`, serve it (container healthcheck).
  - Otherwise reply 403 with a fixed plain-text body. No route handler runs,
    the body is not read, no `Set-Cookie`, no database or audit writes.
  - Refusals are logged rate-limited per peer (peer and path, no headers).
  - A request with no peer address is refused.
  - **Default (decision 5):** unset `PROXY_ONLY` is `true` when
    `TRUSTED_PROXIES` is non-empty and `false` when it is empty, in native
    and container installs alike. Existing native installs without
    `TRUSTED_PROXIES` are unchanged.
  - Explicit `PROXY_ONLY=false` with `TRUSTED_PROXIES` set is the
    "tunnel plus direct LAN" case: §2 trust rules apply, nothing is
    refused.
  - Explicit `PROXY_ONLY=true` with empty `TRUSTED_PROXIES` fails startup
    closed, naming both variables. Values other than `true`/`false` fail
    closed.
  - The startup log states the resulting mode in plain words.
  - When `TRUSTED_PROXIES` is empty and a request arrives carrying
    `CF-Connecting-IP` (or other Cloudflare headers), log a rate-limited
    warning that the install looks like a tunnel install missing
    `TRUSTED_PROXIES`. The header is still ignored.
- **Local-only deployments** (decision 2) are a supported profile, not a
  degraded one:
  - A local-only install (native or container) needs an empty
    `TRUSTED_PROXIES`, an `http://` LAN `SERVICE_ISSUER` and
    `COOKIE_SECURE=false`. It is the intended demo setup.
  - No container-mode rule may make the local-only profile impossible. Any
    check that assumes Cloudflare (HTTPS issuer, secure cookies) applies
    only when proxy-only is on.
  - Document what local-only gives up: no Cloudflare Access in front of
    `/admin/*`, plain HTTP on the LAN, and console sign-in limits from
    CONTRACT-011's host rule.
- Failure rows for: an untrusted peer, proxy-only with empty
  `TRUSTED_PROXIES`, connector IP drift (proxy-only on → visible outage;
  off → degraded but unforgeable attribution).

**CONTRACT-014, superseding CONTRACT-008's container sections:** the
container preconditions; §7 intro and §7.1; §7.2's `*_FILE` rules
(environment only, per OQ-1); §7.3's ownership and fix-message rules; the
container postconditions and failure rows; the container interface and UX
bullets; resolved decisions #18–#19; and the postcondition "Node listening
port is not published on any host interface", which is now false. It
covers:

- `/data` is an operator-provided mount (ix volume with ACL granting UID 568
  Modify). Missing mount or unwritable `/data` fails closed.
- The database lives in `/data/pglite`, created by the app at mode 0700 and
  owned by the running UID. The strict mode/owner check applies there, not
  to `/data`. The app never chowns or chmods anything it did not create.
- Image defaults for `PORT=3210`, `PGLITE_DATA_DIR` and container mode, so
  the form only needs the operator's settings and secrets.
- Container user 568:568 from the form's Security Context; UID 0 refused.
- All inputs from environment variables (OQ-1 stands); seed inputs removable
  after first boot (OQ-2 stands).
- Fix messages written for the TrueNAS form (which field to change), not for
  a shell.

**Numbering:** assign contract numbers when drafting starts. TASK-030 may
also claim a number and touch CONTRACT-008; do not run two supersessions of
CONTRACT-008 at once.

### Excluded

- Implementation (TASK-025, TASK-032, TASK-033).
- Origin TLS between connector and TrueNAS (decision 4).
- A TrueNAS catalog app or compose/YAML install path.
- Audit retention (TASK-030).

## Plan

1. Read CONTRACT-008, CONTRACT-012, CONTRACT-011, ADR-001, TASK-025 and
   `src/clientAddress.ts`, `src/config.ts`, `src/container.ts`.
2. Draft CONTRACT-013 and CONTRACT-014 as Proposed, marking the sections
   each supersedes.
3. List any open questions for Patrick in each contract rather than
   deciding them.
4. Record the handoff and move this task to `review/`.

## Acceptance criteria

- [ ] CONTRACT-013 and CONTRACT-014 exist as Proposed, each naming exactly
      what it supersedes. CONTRACT-008 and CONTRACT-012 bodies are unedited.
- [ ] A TrueNAS install needs nothing outside the Custom App form and the
      Cloudflare dashboard: no dataset creation, chmod, chown or repo
      checkout on TrueNAS.
- [ ] Proxy-only behavior is specified precisely enough to test, including
      the `/health` exception, startup failures and logging.
- [ ] The local-only profile is specified for both native and container
      installs, and no container rule prevents it.
- [ ] The `PROXY_ONLY` default follows decision 5 (derived from
      `TRUSTED_PROXIES`), including the explicit-override cases and the
      missing-`TRUSTED_PROXIES` warning.
- [ ] Every input the form needs is listed with its required/optional status
      for each profile (tunnel, local-only).
- [ ] Validation requirements cover TASK-034's TrueNAS checks: Access on
      `/admin/*`, two clients' public IPs recorded, forged
      `CF-Connecting-IP` ignored, LAN request refused with 403 when
      proxy-only is on, healthcheck healthy, data kept across an image-tag
      update.

## Validation requirements

Human review of both contracts against Patrick's decisions above. No code is
changed by this task.

## Risks and assumptions

- TrueNAS behavior comes from reading the 25.10.0.1 source, not from
  Patrick's box. TASK-034 should first check `docker version`,
  `/etc/docker/daemon.json` and the DNAT rule for the published port.
- Trust is based on the connector's IP address.
- Uninstalling with "remove ix volumes" deletes all keys and users.
  Snapshots and an off-box copy of `DB_ENCRYPTION_KEY` are the operator's
  responsibility.

## Blocker

None.

## Implementation handoff

Task: TASK-031
Implementer: contract-architect
Date: 2026-10-28

> **Lifecycle note.** This file should be in `tasks/review/`. The
> contract-architect session had no shell or file-move tool, so it could not
> move the file from `approved/` to `in-progress/` or to `review/`. The
> handoff is recorded here in place. Patrick (or the coordinating agent)
> should run
> `mv tasks/approved/TASK-031-contract-truenas-custom-app-deployment.md tasks/review/`.

### Changes made

- Wrote `docs/contracts/CONTRACT-013-truenas-lan-ingress-proxy-only-and-client-address.md`
  (Proposed). It supersedes CONTRACT-012 in full and carries forward
  CONTRACT-012's partial supersessions of CONTRACT-003, CONTRACT-005 and
  CONTRACT-008 (reverse-proxy actor, §8, Caddy exclusions, OQ-9 deferral,
  RD #21). CONTRACT-012's supersession of CONTRACT-008's ingress
  precondition and Interfaces "Ingress" line passes to CONTRACT-014.
  CONTRACT-012 §2 (client address) and §5 (Access on `/admin/*`) are kept
  word for word, as §2.1 and §5. New content: §1 topology (published on the
  TrueNAS static LAN IPv4 only, connector on a separate LAN host), §2.0 the
  proxy-only gate (loopback `GET`/`HEAD` exactly `/health` exception, fixed
  `403`, no handler, no body read, no cookie, no database or audit write,
  rate-limited refusal log), §3 `TRUSTED_PROXIES` as the single connector
  address, §4 invariants and residual trust, §6 `PROXY_ONLY` with the
  default derived from `TRUSTED_PROXIES` (decision 5) and the override
  matrix, §7 the startup mode line and missing-`TRUSTED_PROXIES` warning,
  §8 the local-only profile, failure rows (untrusted peer, proxy-only with
  empty `TRUSTED_PROXIES`, connector IP drift on and off), and validation
  including TASK-034's TrueNAS checks.
- Wrote `docs/contracts/CONTRACT-014-truenas-custom-app-container-profile.md`
  (Proposed). It supersedes these CONTRACT-008 sections: the Purpose
  "Container deployment" paragraph; the Container operator and Container
  runtime actors; the container input bullet; the container preconditions
  (including "Node port is not published"); §7 intro and §7.1; §7.2 in full;
  §7.3 in full; the container postconditions and both container invariants
  (retiring "Node listening port is not published on any host interface");
  every "(New, container)" failure row; the container interface subsection;
  the three container UX bullets; the First boot, `*_FILE` channel,
  Ownership, Data path and Ingress validation bullets; and Resolved decisions
  #18–#19. CONTRACT-008 §1–§6, §7.4 and §7.5 stay in force, and the section
  numbers match so that §7.4's cross-references still resolve. New content:
  `/data` as an ix volume with an ACL (writable, never chmodded or chowned),
  the app-created `/data/pglite` at `0700` where CONTRACT-008 §5 applies,
  image defaults (`PORT=3210`, `PGLITE_DATA_DIR=/data/pglite`, container
  mode, `568:568`, healthcheck), an environment-only input table with
  required/optional status for the tunnel and local-only profiles plus the
  non-environment form settings, root refusal through Security Context, and
  form-oriented fix messages.
- Did not edit CONTRACT-008's or CONTRACT-012's body or header, any other
  task, any application code, or `docs/contracts/README.md`, which has no
  contract index.

### Validation performed

Checked both drafts against Patrick's decisions 1–9 and each acceptance
criterion of this task, against CONTRACT-008, CONTRACT-011, CONTRACT-012 and
ADR-001, and against `src/clientAddress.ts`, `src/config.ts`,
`src/container.ts`, `src/database.ts`, `src/index.ts` (`/health` routing)
and `scripts/container-healthcheck.js`. No code was run; this task changes
none.

### Assumptions and deviations

- Contract numbers 013 and 014 were free. TASK-030 is still proposed and has
  claimed no number.
- CONTRACT-014's superseded list goes beyond the task's list. Five more
  CONTRACT-008 items contradicted the new profile: the Purpose paragraph,
  two actors, one input bullet, and the container validation bullets. §7.2
  and §7.3 are superseded in full rather than only their `*_FILE`,
  ownership and fix-message rules. All of this is flagged as CONTRACT-014
  Open question 6.
- `PGLITE_DATA_DIR` becomes `/data/pglite` in container mode. CONTRACT-008
  §5 then applies to it unchanged, which is how "strict check on
  `/data/pglite`, not `/data`" is expressed without touching §5.
- Proposed defaults are in the drafts and marked for confirmation: the
  refusal body text, log intervals (60 s per peer, 10 min warning), empty
  `PROXY_ONLY` treated as unset, and fix-message wording.

### Open questions for Patrick

CONTRACT-013: (1) Cloudflare-assuming startup checks when proxy-only is on
(none, warn, or fail); (2) small drafting choices (body text, intervals,
empty-means-unset, case-insensitivity); (3) whether to warn on
`TRUSTED_PROXIES` ranges wider than one address; (4) a drift warning in
tunnel-plus-direct-LAN mode; (5) `HEAD /health` route behavior; (6) Entra
mode in local-only (an observation); (7) approve together with CONTRACT-014.

CONTRACT-014: (1) existing `/data/pglite` with the wrong mode but the app's
own owner (refuse with a shell-exception message, auto-narrow, or
reinstall); (2) the contingency if inherited NFSv4 ACLs prevent `0700`;
(3) confirm the fixed `PGLITE_DATA_DIR=/data/pglite`; (4) the pre-TASK-031
`/data` root database layout; (5) whether the form can switch off container
mode; (6) section-level versus whole supersession of CONTRACT-008, and
sequencing with TASK-030; (7) `CLIENT_SECRET` required at first boot in
local-login demos (an observation); (8) ix volume only, or document host
path too.

### Unresolved risks

- TrueNAS behavior (DNAT source preservation, the ACL result on app-created
  folders) is still read from source and unverified. TASK-034 should check
  it first. CONTRACT-014 OQ-2 covers the ACL case, and CONTRACT-013 §4 the
  DNAT case.
- On approval, CONTRACT-012's header needs `Status: Retired` and
  `Superseded by: CONTRACT-013`. CONTRACT-008's header needs its
  `Superseded by` extended to name CONTRACT-013 (carried-forward items) and
  CONTRACT-014. Both are header-only edits that need Patrick's approval
  (ADR-001).

### Documentation updated

None beyond the two new contracts.

## Review

Not applicable. This is a contract-designer task with no independent
reviewer role. Patrick reviews and approves the contracts directly.
