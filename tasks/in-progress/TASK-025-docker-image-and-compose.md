# TASK-025: Docker image and container code for the TrueNAS Custom App

Owner role: Implementer
Assigned agent: openai-coder
Proposed by: Patrick Moon
Proposed date: 2026-10-20
Approved by: Patrick Moon
Approved date: 2026-10-20 (scope rewritten for CONTRACT-014 on 2026-10-29,
after the restructure Patrick approved on 2026-10-28)
Related contracts: CONTRACT-014 (approved 2026-10-29; supersedes
CONTRACT-008's container sections); CONTRACT-008 (§1–§6, §7.4, §7.5 still in
force); CONTRACT-013 (approved 2026-10-29; ingress, proxy-only mode and the
local-only profile, implemented by TASK-032)
Related ADRs: ADR-001
Dependencies: CONTRACT-014 approved (done). TASK-034 Phase 0 check A passes
(an app-created folder on an ACL-enabled ix volume reports `0700`, owner
568). Can run in parallel with TASK-032. TASK-033 publishes the image this
task builds.

> **History.** Built 2026-10-28 as a compose stack with a bundled
> `cloudflared` (see "Previous implementation handoff" below), then returned
> from review to in-progress by Patrick on 2026-10-28 when the deployment
> model changed. Scope rewritten 2026-10-29 for CONTRACT-014. The filename is
> kept per the lifecycle rules.

## Desired outcome

An image that installs on TrueNAS SCALE 25.10.0.1 (Goldeye) or newer through
the Custom App form alone, as CONTRACT-014 specifies: no compose file, no
dataset prework, no shell. Storage is an ix volume at `/data`, the database
lives in the app-created `/data/pglite`, and every setting is a form field.

## Context

Carried over from the compose build (already implemented, keep unless
CONTRACT-014 says otherwise): the liveness-socket process lock
(`src/processLock.ts`), `--non-interactive` seed mode, environment-only
inputs, root refusal, the Node 22 baseline, the entrypoint and the
healthcheck. CONTRACT-008's OQ answers (env-only inputs, seed-input
warnings, 568:568 default, no auto-chown, Docker's default stop grace) still
stand.

What changed (CONTRACT-014, Patrick's decisions 2026-10-28/29):

- `PGLITE_DATA_DIR` is `/data/pglite`, created by the app at `0700`.
  CONTRACT-008 §5's strict mode/owner check applies there. `/data` must be
  mounted and writable but its mode, owner and ACL are never checked or
  changed.
- Fix messages name TrueNAS form settings (Storage, Security Context,
  Environment Variables), never shell commands, except the wrong-mode
  message for `/data/pglite` (CONTRACT-014 §7.3).
- Container installs always require `CLIENT_SECRET` at first boot, local-login
  demos included (CONTRACT-014 §7.2).
- The image is published to GHCR by TASK-033; this task does not publish.
- The compose stack, the bundled `cloudflared`, the pinned subnet and
  `BT_BUILD_CONTEXT` are dropped.

## Scope

### Included

- **Data path (CONTRACT-014 §7.1):** image default
  `PGLITE_DATA_DIR=/data/pglite`; any other value fails closed with the
  "remove the variable" message. `/data` mount detection kept; a writability
  check that leaves nothing behind; `/data/pglite` created at `0700` or
  verified per CONTRACT-008 §5, never narrowed or chowned.
- **Image (CONTRACT-014 §7.1):** `ENV PORT=3210`, container mode on,
  `USER 568:568`, `HEALTHCHECK` using the effective `PORT`, base images
  pinned by digest (`node:22-bookworm-slim@sha256:...`), OCI labels
  (`org.opencontainers.image.source`, `.version`, `.revision`, `.licenses`
  if known). No `VOLUME`. The image's own `/data` stays root-owned so that,
  if no volume is mounted, the app can't write there and refuses to start.
- **Fix messages (CONTRACT-014 §7.3):** the wording table, adapted to the
  TrueNAS 25.10 form labels, for no mount, `/data` not writable, root,
  `/data/pglite` owned by another UID, wrong mode, and `PGLITE_DATA_DIR`
  changed. Container-mode guidance in `scripts/startup-check.js` and
  `src/container.ts` uses form terms only.
- **Remove:** `docker-compose.yml`, `BT_BUILD_CONTEXT`, compose/YAML install
  docs, and any code or docs that assume the pinned subnet.
- **Tests:** update `scripts/test-container-deployment.js` for
  `/data/pglite`, the writability check, the new messages (asserting no
  `chown`, `chmod`, `.env` or host path except the wrong-mode case) and the
  `PGLITE_DATA_DIR` rules. Every existing test script still passes on Node 22.
- **Docs (`docs/DEVELOPMENT.md`):** replace the compose section with a
  TrueNAS Custom App walkthrough built from CONTRACT-014 §7.2's two tables
  (tunnel and local-only profiles), the ix volume and Enable ACL steps,
  removing first-boot secrets afterwards, the exposure tradeoff, snapshot
  and off-box `DB_ENCRYPTION_KEY` advice, and the Cloudflare dashboard steps
  (tunnel route to `http://<truenas-ip>:<port>`, Access on `/admin/*`).
  Link TASK-032's ingress-modes section rather than duplicating it.
  TASK-034 Phase 0 showed three form settings that are easy to miss, so the
  walkthrough must call each one out: Security Context's custom-user
  setting (otherwise the container runs as root), the ix volume at `/data`
  with Enable ACL (otherwise nothing is mounted), and Host IPs set to the
  TrueNAS IPv4 only (left empty, it publishes on every IPv4 and IPv6
  address).

### Excluded

- Proxy-only mode and ingress warnings (TASK-032).
- GHCR publishing and CI container checks (TASK-033).
- TrueNAS validation (TASK-034).
- Native demo `CLIENT_SECRET` generation (TASK-035).

## Plan

1. Data-path and storage-check changes in `src/container.ts` /
   `src/database.ts`, with tests.
2. Fix-message rewrite and startup-check guidance.
3. Dockerfile changes and removal of compose artifacts.
4. Docs.
5. Local build and tests on Node 22. If a Docker host is available, run
   `docker build` and a smoke start; otherwise TASK-033's CI covers it.

## Acceptance criteria

- [ ] With an empty writable `/data`, first start creates only
      `/data/pglite`, mode `0700`, owned by the runtime UID; `/data` is
      unchanged.
- [ ] No mount, unwritable `/data`, `/data/pglite` owned by another UID,
      `/data/pglite` mode `0755`, `/data/pglite` as a file, UID 0,
      `PGLITE_DATA_DIR=/elsewhere` and `PGLITE_DATA_DIR=/data` each fail
      closed with CONTRACT-014's message for that case.
- [ ] Messages name the form setting and contain no `chown`, `chmod`,
      `setfacl`, `.env`, `npm run seed`, `start.sh` or host path, except the
      wrong-mode message.
- [ ] Setting `DB_ENCRYPTION_KEY_FILE` or `CLIENT_SECRET_FILE` in container
      mode supplies nothing.
- [ ] Dockerfile: digest-pinned bases, `PORT` and `PGLITE_DATA_DIR`
      defaults, `USER 568:568`, healthcheck on the effective `PORT`, OCI
      labels, no `VOLUME`.
- [ ] `docker-compose.yml` and `BT_BUILD_CONTEXT` are gone, and no doc
      describes a compose or YAML install.
- [ ] `docs/DEVELOPMENT.md` has the form walkthrough for both profiles.
- [ ] `npm run build` and every `scripts/test-*.js` pass on Node 22.

## Validation requirements

Isolated tests in the style of the existing `scripts/test-*.js`. Docker
image checks run in TASK-033's CI; TrueNAS checks in TASK-034.

## Risks and assumptions

- If TASK-034 Phase 0 finds inherited ACLs make `/data/pglite` report a mode
  other than `0700`, this task is blocked and returns to contract
  (CONTRACT-014 resolved question 2).
- Environment-only secrets are visible in `docker inspect` and the TrueNAS
  app configuration (accepted, CONTRACT-008 OQ-1).
- Uninstalling with "remove ix volumes" deletes all keys and users
  (accepted, Patrick's decision 8); docs must say so prominently.
- Audit tables grow on the ix volume until TASK-030 lands.

## Blocker

None. TASK-034 Phase 0 check A passed on 2026-10-29: the app-created folder
reports `700`, owner `568:568`.

## Implementation handoff

Not started (for the rewritten scope).

## Previous implementation handoff (compose design, superseded 2026-10-29)

Task: TASK-025
Implementer: openai-coder
Date: 2026-10-28

### Changes made

- Added `src/processLock.ts`: POSIX Unix-domain liveness sockets, atomic
  exclusive publication of complete lock records using hard links, and stale
  takeover guards keyed by the prior holder UUID. Socket listening precedes
  publication. Guard recovery uses the same protocol so interrupted takeovers
  recover too. PID is diagnostic only; no PID-table liveness test. Windows
  retains its exclusive-create PID file behavior.
- Updated `src/database.ts` to use the lock and container storage checks.
  Added `src/container.ts` for explicit container mode, non-root enforcement,
  `/data` enforcement, Linux mountinfo detection, and host ownership guidance.
  No automatic chmod/chown.
- Updated `src/seed.ts` and `scripts/seed.js`: environment-only
  `--non-interactive` mode, all-needed-input validation before seed writes,
  already-seeded exit 0, per-start named ignored-input warnings, no `.env`
  loading in automatic mode. Plain CLI exit 1 and both read-then-unlink paths
  remain. Unknown argument errors no longer echo arbitrary argument values.
- Updated `scripts/startup-check.js` with container guidance and the public
  issuer instead of private-network DNS hints; container checks decrypt both
  the signing key and CLIENT_SECRET in either login mode.
- Added multi-stage `Dockerfile`, `.dockerignore`,
  `scripts/container-entrypoint.sh`, `scripts/container-healthcheck.js`, and
  `docker-compose.yml`. Runtime is Node 22 slim, default 568:568; build uses
  `npm run build`, copying the console. No host ports or stop-grace override.
  Official cloudflared image, environment token, dedicated 172.30.10.0/29
  network, matching TRUSTED_PROXIES, canonical HTTPS issuer/secure cookies.
- Set `engines.node` to `>=22.12.0`, `@types/node` to `22.20.5`, and updated
  package-lock. The 22.12 minimum supports this CommonJS project's existing
  `require(esm)` use of jose (per the installed jose README).
- Added `scripts/test-container-deployment.js`; expanded
  `docs/DEVELOPMENT.md`. Task moved approved → in-progress → review with
  Assigned agent set to openai-coder (filesystem moves; Git limitation above).
- Did not edit contracts, TASK-029 code/task, or the unrelated TASK-014 move.
  Additional externally made task changes appeared during this session
  (TASK-003d, TASK-029, TASK-030); these were also left untouched.

### Validation performed

All builds and functional tests below used
`PATH=/home/patrick/.nvm/versions/node/v22.22.3/bin:$PATH`;
`node --version` reported **v22.22.3**. The default shell Node was v20.19.2
and was not used for functional tests.

| Command | Actual result |
|---|---|
| `npm install --save-dev --save-exact @types/node@22 --ignore-scripts` | Initial attempt failed EROFS writing the default ~/.npm cache; no success claimed. |
| `npm install --cache /tmp/bt-task025-npm-cache --save-dev --save-exact @types/node@22 --ignore-scripts` | Exit 0; one package changed; zero audit vulnerabilities. |
| `npm ci --cache /tmp/bt-task025-npm-cache` | Exit 0; seven packages installed; zero audit vulnerabilities. |
| `npm run build` | Exit 0 on each run, including after clean npm ci; tsc succeeded and copied four console files into dist/console. |
| `node scripts/test-container-deployment.js` | Final exit 0. Details below. Initial suite passed; adding unlink-failure coverage exposed one harness-only invocation failure (Node interpreted a custom flag, exit 9). Added `--` to delimit Node options; final expanded rerun passed. |
| `node scripts/test-admin-console.js` | Exit 0; 13 PASS groups. |
| `node scripts/test-local-registration.js` | Exit 0; six PASS groups. |
| `node scripts/test-console-sign-in.js` | Exit 0; 11 PASS groups. |
| `node scripts/test-api-docs.js` | Exit 0; one PASS group covering routes/assets, modes, security and health. |
| `node scripts/test-trusted-proxies.js` | Exit 0; four PASS groups. No TASK-029 implementation changed. |
| `node scripts/test-local-password-change.js` | Exit 0; seven PASS groups. |
| `node <repository>/scripts/verify-offline.js` | Executed by the new suite with cwd in /tmp, a scratch .env and throwaway seeded database. Exit 0; AC1/AC2/AC3 and Overall PASS over real HTTP, including emergency rotation and rejection of the old token. |
| Python/PyYAML static assertions over docker-compose.yml, Dockerfile, .dockerignore and package files | Pass: YAML parses, exactly two services, no ports, no stop_grace_period, matching network/trusted subnet, issuer/cookie settings, bind create_host_path false, default USER, no VOLUME, exclusions and lockfile metadata agree. This is not Docker Compose runtime validation. |
| `sh -n scripts/container-entrypoint.sh` | Exit 0. |
| `node --check scripts/container-healthcheck.js` and `node --check scripts/test-container-deployment.js` | Exit 0 under Node 22.22.3; also passed an earlier syntax-only invocation under shell-default Node 20.19.2. |
| `git diff --check` | Exit 0. |
| `docker --version` | Command not found. No Docker build/run/history/layer-inspection claim. |
| Requested `git mv` transitions | Failed: cannot create .git/index.lock (read-only filesystem); ordinary mv used, no staging. |

The new suite verifies: root/wrong-path guard units, alternate non-root UID,
mount parser and actual missing mount refusal; live and SIGSTOP-paused holders;
SIGKILL stale recovery; eight races with four simultaneous starters (exactly
one winner each); an interrupted recovery guard; fail-closed legacy/missing
socket/overlong path cases; mode 0755 refusal; every missing seed variable and
invalid username/email/password with zero seed rows; rejection of file flags
in automatic mode and no CLIENT_SECRET_FILE channel; first boot, unchanged
row snapshots on restart, named warnings without secret values, seed-input
removal, stored-secret/key decryption and password verification, partial
bootstrap preserving prior ciphertext/key rows; plain CLI no-op exit 1,
both file deletions and both simulated unlink failures before database open;
first-run file bootstrap; startup checks accepting seeded data and refusing a
wrong key; real HTTP healthcheck, concurrent server refusal, PGlite persistence
after SIGKILL, and clean SIGTERM with the lock removed.

Test data was generated under `/tmp/bt-deploy-*` and removed in finally blocks.
Only throwaway credentials were used. Diagnostic logs are outside the repo:
`/tmp/bt-task025-container-tests-final.log` and
`/tmp/bt-task025-test-*.js.log`. No real credentials were read or written.

### Acceptance criteria evidence

Checked only documentation and the additional locally verified criteria above.
The original Docker-specific criteria remain unchecked: host process tests do
not prove namespace/mount/image behavior. All Docker checks remain pending:
compose build, image UID, first boot/restart, down/up persistence, kill/paused/
concurrent containers, root/path/mount refusals, docker stop and image history/
layer secret inspection. No image exists from this session.

TrueNAS/tunnel criteria remain unchecked and were not attempted: remote health,
console/assets and real-browser sign-in, Access gates, two public source IPs,
forged CF-Connecting-IP rejection through Cloudflare, and host exposure checks.
The shipped YAML statically publishes no ports and contains only variable
references for operator secrets. No secrets were committed; no commit was made.

### Assumptions and deviations

- OQ answers govern; no approved contract was amended. No *_FILE channels.
- Omitted VOLUME /data to prevent Docker automatically provisioning anonymous
  storage. Root-owned image /data plus the mountinfo check fail closed without
  the required operator mount. Shipped compose requires an existing bind path.
- Atomic hard-link publication replaces the old POSIX create-then-write
  window while retaining an exclusive filesystem lock. Recovery guards and
  their UUID checks prevent stale contenders unlinking a new live lock.
- Probe timeout is one second, logged; at most eight nested interrupted
  recovery guards are inspected. Uncertain state fails closed with the relative
  lock filename and manual instructions. Full socket path limit is 103 UTF-8
  bytes; use a short POSIX data path. Local filesystem/one kernel only.
- Legacy PID-only locks cannot establish cross-namespace liveness and require
  manual recovery with every instance stopped. Windows behavior is retained
  in code but was not executed on a Windows host; interactive TTY bootstrap
  was not manually exercised. Both existing CLI file paths were exercised.
- Node >=22.12.0 is intentional, rather than claiming every early Node 22
  release supports the existing jose CommonJS imports.
- TrueNAS YAML is an operator-populated private copy, with absolute build
  context or a loaded local image. Do not rely on a login shell's exported
  variables reaching TrueNAS middleware. No registry publishing/CI was added.
- Git metadata is read-only; lifecycle paths moved without staging. No routine
  approval was requested because filesystem moves were already authorized.

### Unresolved risks

- Docker, cross-container namespaces, TrueNAS ACL behavior, Cloudflare, and
  actual browser behavior still require operator validation before go-live.
- Environment secret exposure is accepted: inspect, TrueNAS config/exports,
  process environments. Remove first-boot credentials after success.
- Network isolation is essential. Do not publish Node or attach other
  containers to the trusted subnet. Confirm no subnet conflict on TrueNAS.
- Moving upstream image tags require recording resolved digests at release.
- Network filesystems are unsupported. Unknown/legacy lock state intentionally
  needs manual intervention; pre-publication crashes may leave harmless
  orphan socket/staging files, removable only with all instances stopped.
- No open architectural question for Patrick; pending work is validation and
  operator configuration, plus staging the task rename in a writable Git session.

### Documentation updated

`docs/DEVELOPMENT.md`: Node baseline; POSIX stale-lock behavior and recovery;
container inputs/seed semantics; TrueNAS path ownership/ACLs and YAML workflow;
VOLUME decision; secret exposure/removal; Cloudflare hostname, Access and HTTPS
steps with official documentation links; CONTRACT-012 §4 invariants; pending
Docker and operator validation checklist.

## Review

Not reviewed.
