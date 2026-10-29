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

- [x] With an empty writable `/data`, first start creates only
      `/data/pglite`, mode `0700`, owned by the runtime UID; `/data` is
      unchanged.
- [x] No mount, unwritable `/data`, `/data/pglite` owned by another UID,
      `/data/pglite` mode `0755`, `/data/pglite` as a file, UID 0,
      `PGLITE_DATA_DIR=/elsewhere` and `PGLITE_DATA_DIR=/data` each fail
      closed with CONTRACT-014's message for that case.
- [x] Messages name the form setting and contain no `chown`, `chmod`,
      `setfacl`, `.env`, `npm run seed`, `start.sh` or host path, except the
      wrong-mode message.
- [x] Setting `DB_ENCRYPTION_KEY_FILE` or `CLIENT_SECRET_FILE` in container
      mode supplies nothing.
- [x] Dockerfile: digest-pinned bases, `PORT` and `PGLITE_DATA_DIR`
      defaults, `USER 568:568`, healthcheck on the effective `PORT`, OCI
      labels, no `VOLUME`.
- [x] `docker-compose.yml` and `BT_BUILD_CONTEXT` are gone, and no doc
      describes a compose or YAML install.
- [x] `docs/DEVELOPMENT.md` has the form walkthrough for both profiles.
- [x] `npm run build` and every `scripts/test-*.js` pass on Node 22.

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

Task: TASK-025
Implementer: openai-coder
Date: 2026-10-29

### Changes made

- `src/container.ts`: require `/data/pglite`, preserve Linux mount detection,
  check `/data` directory access with W_OK | X_OK (no probe files, no mode/owner
  inspection or changes), and provide TrueNAS form-oriented failure guidance.
- `src/database.ts`: create/verify `/data/pglite` at 0700, distinguish file,
  owner and mode failures; preserve native behavior and all process-lock code.
- `scripts/startup-check.js`: form guidance and profile-neutral service-address
  output. Existing non-interactive seed already requires CLIENT_SECRET in local
  login; no seed behavior change was needed.
- `Dockerfile`: both stages pinned to the real Docker Hub manifest digest
  `sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da`;
  PORT=3210, PGLITE_DATA_DIR=/data/pglite, OCI source/version/revision/MIT labels.
  Preserved USER 568:568, root-owned image /data, no VOLUME, entrypoint and
  effective-PORT healthcheck. VERSION and REVISION are build arguments.
- Deleted `docker-compose.yml`. Removed the retired build-context identifier
  everywhere. Replaced the old subnet in generic trusted-proxy test fixtures
  with documentation-range 192.0.2.0/29; these remain generic CIDR tests.
- Expanded container tests for redirected storage, all required failures,
  forbidden guidance, untouched file inputs and local-login CLIENT_SECRET.
- Replaced only container/compose guidance in `docs/DEVELOPMENT.md` with both
  profiles, all three easy-to-miss settings, first-boot removal, backup/deletion
  warnings and Cloudflare dashboard steps. Preserved TASK-032's Ingress modes.

### Validation performed

All Node/npm commands below used the exact prefix
`PATH=/home/patrick/.nvm/versions/node/v22.22.3/bin:$PATH`.

| Command | Result |
|---|---|
| `node --version` | Exit 0, v22.22.3. |
| `node node_modules/typescript/bin/tsc` | Exit 0; compiled before the narrow test. |
| `node scripts/test-container-deployment.js` (narrow runs) | First two runs exit 1 due to test-harness redirection gaps: child preload not inherited, then lock socket still targeted real /data. Fixed harness only. Third and final fourth runs exit 0. Final log `/tmp/task025-narrow-final.log`. |
| `npm run build` | Exit 0; tsc succeeded, copied 4 console files. Run after final narrow test. |
| `node scripts/test-admin-console.js` | Exit 0. |
| `node scripts/test-api-docs.js` | Exit 0. |
| `node scripts/test-console-sign-in.js` | Exit 0. |
| `node scripts/test-container-deployment.js` (full regression) | Exit 0, including its real HTTP offline verifier: AC1/AC2/AC3 and Overall PASS. |
| `node scripts/test-local-password-change.js` | Exit 0. |
| `node scripts/test-local-registration.js` | Exit 0. |
| `node scripts/test-proxy-only.js` | Exit 0 (TASK-032). |
| `node scripts/test-trusted-proxies.js` | Exit 0. |
| `sh -n scripts/container-entrypoint.sh` | Exit 0. |
| `node --check scripts/startup-check.js` | Exit 0. |
| `git diff --check` | Exit 0 on each validation run. |
| Python 3 urllib registry request | Exit 0: obtained pull token from auth.docker.io, fetched registry-1.docker.io/v2/library/node/manifests/22-bookworm-slim with OCI/Docker index Accept headers; Docker-Content-Digest exactly matched independently computed SHA-256 of response bytes (digest above). No Docker required. |
| Python 3 static assertions | Exit 0: two digest-pinned FROMs, defaults, user, labels, healthcheck references effective PORT, root-owned image directory construction, no VOLUME, deleted compose file, both form profiles/settings/backup/route guidance and ingress anchor present. |
| `rg` search for the retired build-context identifier | Exit 1, no matches. |
| Search supported docs/code for retired subnet and compose/YAML install instructions | No matches. Immutable contracts and historical task records intentionally excluded. |

Every test script was invoked individually and sequentially after the build,
using a Python subprocess runner; all eight exited 0. Logs are
`/tmp/task025-test-<name>.js.log`; summary is
`/tmp/task025-regression-results.txt`. No Docker command/build/run was attempted.
No failures attributable to TASK-032 were observed.

### Acceptance criteria evidence

All eight rewritten criteria checked for local implementation verification:
storage creation/ownership/mode and unchanged parent uid/gid/mode, all failure
messages, ignored file inputs, Dockerfile static requirements, removal of the
supported old install path, both walkthrough profiles, build and every test.
Container tests redirect the filesystem boundary to scratch directories and
inject mountinfo, UID/foreign-owner and denied-access cases. Real directory
creation/access, mode refusal and file preservation are exercised. This does
not claim an actual /data mount, Docker image execution, or NFSv4 ACL testing.
TASK-034 Phase 0's supplied evidence supports the TrueNAS ACL assumption.

### Assumptions and deviations

- No contracts edited. Under ADR-001 and the instruction to preserve history,
  superseded contracts and previous handoffs retain obsolete topology/install
  descriptions. “No doc describes a compose install” is applied to supported
  operator guidance, not immutable historical records.
- The access check uses filesystem access(W_OK | X_OK), rather than a temporary
  write, so it cannot leave a probe entry or modify parent metadata. As with
  any startup check, storage can fail after the check; creation also fails closed.
- No prescribed file-case wording exists in CONTRACT-014; supplied a Storage
  snapshot/new-empty-volume remedy consistent with its directory requirement.
- PGLITE_DATA_DIR errors state the required path without echoing arbitrary input.
- No changes to TASK-032-owned config parsing, request handling, client address,
  new ingress implementation/test, or Ingress modes section. Concurrent changes
  to those files are not part of this handoff.
- No commit, staging, or index/working-tree-mutating Git commands.

### Unmet items and unresolved risks

No unmet locally testable rewritten criterion. Docker is not installed, so
image build/run, actual container namespace/mount behavior and layer inspection
remain unverified (TASK-033). Full TrueNAS install, snapshots/recreation,
Cloudflare/Access and browser checks remain TASK-034. Publication is TASK-033;
no published tag is claimed. Runtime filesystem/ACL behavior beyond the supplied
Phase 0 evidence is not proven by host tests. Independent review and human
acceptance remain pending.

### Documentation updated

`docs/DEVELOPMENT.md` container walkthrough and obsolete container-topology
paragraph; this handoff. Task moved to review, not accepted.


### Rework (2026-10-29)

- Changes: resolved QA minor findings 2 and 4 only. Wrong-mode wording now
  matches CONTRACT-014 exactly, preserving the detected octal mode and removing
  "in Storage". Container mkdir keeps EEXIST's file error; only EACCES/EPERM
  get Enable ACL advice. Other failures abort with: "Could not create
  /data/pglite (error code: CODE). Check the app's storage for available space,
  quota limits and read-only status, then restart the app."
- Evidence: existing filesystem stubs now cover EACCES, EPERM, ENOSPC, EDQUOT,
  EROFS, EIO, missing/unrecognized codes, exit 1, no directory creation, no ACL
  advice for non-permission errors, no secret output, and exact wrong-mode text.
- Validation: all Node/npm commands used
  `export PATH=/home/patrick/.nvm/versions/node/v22.22.3/bin:$PATH`.
  `node --version` reported v22.22.3; `node node_modules/typescript/bin/tsc`
  passed to refresh dist before the first test. Then
  `node scripts/test-container-deployment.js` passed, followed by
  `npm run build` and every test below (each exit 0):
  `node scripts/test-admin-console.js`, `node scripts/test-api-docs.js`,
  `node scripts/test-console-sign-in.js`, `node scripts/test-container-deployment.js`,
  `node scripts/test-local-password-change.js`, `node scripts/test-local-registration.js`,
  `node scripts/test-proxy-only.js`, `node scripts/test-trusted-proxies.js`.
  `git diff --check` and a Python exact-text comparison against whitespace-normalized
  CONTRACT-014 passed. Logs: `/tmp/task025-rework-*.log`; per-test results:
  `/tmp/task025-rework-results.txt`. No TASK-032 test failure observed.
- Assumptions/deviations: no prescribed non-permission mkdir wording exists;
  use the short storage message above. Only recognized OS error codes are
  printed; absent/unrecognized codes become UNKNOWN to avoid echoing input.
  Non-container behavior, contracts, acceptance criteria and TASK-032 files
  are unchanged by this rework. Other QA findings remain accepted follow-ups.
- Remaining risks: injected errors prove handling, not real Docker/TrueNAS
  storage behavior; existing TASK-033/034 validation remains outstanding.
  Handoff updated after validation; moved to review, not accepted. No commit.


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

### QA review

Reviewer: QualityAssurance (independent), 2026-10-29. Reviewed the working
tree against 91add8e (`Dockerfile`, deleted `docker-compose.yml`,
`src/container.ts`, `src/database.ts`, `scripts/startup-check.js`,
`scripts/test-container-deployment.js`, `scripts/test-trusted-proxies.js`,
`docs/DEVELOPMENT.md`) against CONTRACT-014 (§7.1-§7.3, Failure behavior,
Validation) and CONTRACT-008 §5.

**Outcome: Pass** (no blocking or should-fix findings; minors below).

Validation run by the reviewer (Node v22.22.3): `npm run build` passed; all
eight `scripts/test-*.js` exited 0. Docker was not available, so no image
build was attempted. The base-image digest was not independently
re-resolved; the handoff's registry check is recorded evidence only.

Verified as conforming:

- **Storage checks.** The mountinfo `/data` check runs before anything is
  written. `/data` must be a directory with `access(W_OK|X_OK)`. No probe
  file is created, and there is no chmod or chown of `/data`.
  `/data/pglite` is created at 0700 (mkdir mode; umask cannot widen it).
  When it already exists, the owner is checked before the mode, and nothing
  is ever narrowed or chowned.
- **Failure cases.** A file at the path, a foreign owner, mode 0755, UID 0,
  and `PGLITE_DATA_DIR` set to `/data` or `/elsewhere` each fail closed.
- **Messages.** Container messages name Storage, Security Context or
  Environment Variables, use the numeric UID/GID, and contain no shell or
  host path except the wrong-mode message.
- **Inputs.** `*_FILE` variables supply nothing. CLIENT_SECRET is required
  in non-interactive seed whatever LOCAL_LOGIN is (`src/seed.ts:100-113`).
- **Dockerfile.** Both stages are digest-pinned. `PORT=3210`,
  `PGLITE_DATA_DIR=/data/pglite`, container mode, `USER 568:568`,
  root-owned image `/data`, no `VOLUME`, OCI source/version/revision/
  licenses (MIT matches LICENSE), and the healthcheck uses `$PORT` on
  127.0.0.1.
- **Docs.** No compose, YAML or `BT_BUILD_CONTEXT` remains outside
  historical records. The docs cover both profile tables, the three
  easy-to-miss settings, removing first-boot inputs, the exposure tradeoff,
  the ix-volume deletion warning, an off-box key copy, and the Cloudflare
  route and Access steps.

**`access()` assessment: adequate.** In a container, the real and effective
UID are the same. Linux `access()` goes through `inode_permission`, which
ZFS uses to evaluate NFSv4 ACLs, and it returns EROFS on read-only mounts. It
cannot leave anything behind, which a probe write could. Leftover gaps
(quota or full disk, a later ACL change) still fail closed at mkdir or
database open.

**Interaction with TASK-032.** The image healthcheck reaches the server as
`::ffff:127.0.0.1` GET `/health`, which the proxy-only gate admits. Seed and
startup-check load config, so a bad PROXY_ONLY fails at the seed step with
the Configuration error. The mode line is logged only by `dist/index.js`,
before listening. The fixture change in `test-trusted-proxies.js`
(192.0.2.0/29) does not affect behavior.

Findings (all minor):

1. **The PGLITE_DATA_DIR message does not say what was found.**
   `src/container.ts:26`. §7.3 says messages should state what was found,
   and the proposed wording echoes the value ("is set to /elsewhere"). This
   is a deliberate choice not to echo input. Failure scenario: an operator
   with a typo cannot see the bad value in the log. Recommended: echo the
   value (it is not secret) or record the deviation.
2. **The wrong-mode message adds an inaccurate location.**
   `src/container.ts:14` appends "in Storage" to "restore a snapshot of the
   app's volume". In TrueNAS, snapshots are restored from Datasets/Data
   Protection, not from the app's Storage settings, so the operator is sent
   to the wrong screen. Recommended: use the contract's wording exactly.
3. **An empty `PGLITE_DATA_DIR` gives the wrong hint.** If the operator adds
   `PGLITE_DATA_DIR` with an empty value in the form, it overrides the image
   default. The result is the generic "missing PGLITE_DATA_DIR"
   Configuration error, which suggests setting a value rather than removing
   the variable (§7.1 "Any other value fails startup closed ... remove").
   Recommended: in container mode, map empty to the "remove the variable"
   message.
4. **All non-EEXIST mkdir errors are reported as an ACL problem.**
   `src/database.ts:122-125`. ENOSPC or EDQUOT on a full volume would tell
   the operator to tick Enable ACL. Recommended: keep the ACL message for
   EACCES/EPERM/EROFS only, and give a generic storage message otherwise.
5. **Build-argument defaults can mislabel the image.** `Dockerfile:12-13`:
   `ARG VERSION=0.9.0` and an empty `REVISION` mean any build without build
   args is labelled 0.9.0 with no revision. Recommended: TASK-033 CI must
   pass both, or drop the default.
6. **Tests stub permission failures.** `scripts/test-container-deployment.js`
   simulates an unwritable `/data` by making the stubbed `access()` throw,
   and a foreign owner by patching `stat().uid`. Real ACL and ownership
   behavior is left to TASK-033 and TASK-034, which is acceptable given
   Phase 0 check A.

Residual risk: image build and run, real mount namespace and NFSv4 ACL
behavior are unverified locally (TASK-033 and TASK-034). Environment secret
exposure and ix-volume deletion are accepted risks.

Recommended next transition: human acceptance from `review/` to
`completed/`, with findings 1-5 as optional follow-ups.

### Returned to in-progress (Patrick, 2026-10-29)

Patrick accepted the QA recommendation to fix before acceptance. Rework
scope, limited to these items:

1. QA minor finding 2: the wrong-mode message in `src/container.ts` must
   match CONTRACT-014's text ("...Fix it from the TrueNAS Shell (chmod 700
   on the app's /data/pglite folder), or restore a snapshot of the app's
   volume.") without the added "in Storage".
2. QA minor finding 4: in `src/database.ts` (around lines 122-125), only
   permission errors (EACCES/EPERM) creating `/data/pglite` get the Enable
   ACL advice; other errors (e.g. ENOSPC, EDQUOT, EROFS) get an accurate
   message that still fails closed. Add or adjust tests.

Other QA minor findings stay as accepted follow-ups. Update the
implementation handoff and move the task to `review/` when done.
