# TASK-033: Publish the container image to GHCR, with CI container checks

Owner role: Implementer
Assigned agent: TBD
Proposed by: Claude (TASK-031 follow-up)
Proposed date: 2026-10-29
Approved by: Patrick
Approved date: 2026-10-29
Related contracts: CONTRACT-014 (§7.1 image defaults, Interfaces, resolved
decision 3, Validation requirements); CONTRACT-013 (local-only container
profile)
Related ADRs: ADR-001
Dependencies: TASK-025 complete (the image it publishes). TASK-032 complete
before the first release tag, so `v0.9.0` contains proxy-only mode.

## Desired outcome

Pushing a version tag such as `v0.9.0` to `mrdatawolf/BTAuthOrchestrator`
builds the image, runs the container checks TASK-025 could never run
locally, and publishes `ghcr.io/mrdatawolf/btauthorchestrator:v0.9.0` as a
public package that TrueNAS pulls without credentials.

## Context

Decided by Patrick (TASK-031, 2026-10-28/29): image owner `mrdatawolf`,
public package, first tag `v0.9.0`, version tags only (no `latest`), base
image pinned by digest. Docker is not installed on the development machine,
so CI is the first Docker host. The repository has no `.github/` directory
yet.

## Scope

### Included

- `.github/workflows/` workflow:
  - **On pull requests and pushes to `master`:** `npm ci`, `npm run build`,
    every `scripts/test-*.js` on Node 22, `docker build`, and the container
    checks below. No push.
  - **On `v*.*.*` tags:** the same, then push
    `ghcr.io/mrdatawolf/btauthorchestrator:<tag>` using `GITHUB_TOKEN` with
    `packages: write`. No `latest` tag. Fails if the tag does not match
    `package.json`'s version.
  - Third-party actions pinned by commit SHA.
- **CI container checks** (CONTRACT-014 Validation requirements that need
  Docker), using a temporary directory as `/data` and a test-only port
  mapping:
  - image runs as `568:568`; `docker history --no-trunc` and the image
    filesystem contain no `.env`, `data/` or secret values;
  - first boot with every first-boot input seeds, `/health` is healthy,
    `/data/pglite` is `0700` owned by 568, nothing else created in `/data`;
  - restart: seed step exits 0, no rows changed, ignored-input warnings
    name variables but not values;
  - data survives container removal and recreation;
  - `docker kill` then start recovers the stale lock; a second container on
    the same `/data` is refused;
  - fail-closed cases: no mount at `/data`, unwritable `/data`,
    `/data/pglite` owned by another UID, `/data/pglite` mode `0755`, UID 0,
    `PGLITE_DATA_DIR` changed; each message names the form setting;
  - `docker stop` shuts down cleanly;
  - Docker's own `HEALTHCHECK` reports healthy with proxy-only on;
  - a local-only container (empty `TRUSTED_PROXIES`, `http://` issuer,
    `COOKIE_SECURE=false`) serves sign-in.
- Set the package visibility to public after the first push (one-time
  manual step in GitHub package settings, documented here; Patrick does it).
- Bump `package.json` to `0.9.0` if it is not already, and document the
  release steps in `docs/DEVELOPMENT.md`.

### Excluded

- Pushing the `v0.9.0` tag itself (Patrick decides when).
- Multi-architecture images (amd64 only unless Patrick asks).
- TrueNAS validation (TASK-034).

## Plan

1. Write the CI container-check script (for example
   `scripts/test-container-image.sh`) so it can also run on any Docker host.
2. Workflow for PR/`master` builds and checks.
3. Tag-triggered publish job.
4. Docs: release steps and the public-visibility step.

## Acceptance criteria

- [ ] A PR run builds, runs every test script and every container check,
      and pushes nothing.
- [ ] A test tag on a fork or a pre-release tag publishes an image that
      `docker pull` fetches anonymously once visibility is public.
- [ ] Tag/version mismatch fails the run before pushing.
- [ ] No secret is printed in logs or baked into the image.
- [ ] Release steps are documented.

## Validation requirements

Green workflow runs linked in the handoff, plus an anonymous `docker pull`
of the published test image.

## Risks and assumptions

- GHCR packages are private on first push; until Patrick makes it public,
  TrueNAS cannot pull it.
- CI runners' Docker is not TrueNAS's Docker. ACL behavior and real client
  addresses are only proven by TASK-034.

## Blocker

None.

## Implementation handoff

Task: TASK-033  
Implementer: Codex  
Date: 2026-10-30  
Status: Implementation ready for review; acceptance evidence pending. Not accepted.

### Changes made

- Added `.github/workflows/container.yml`: PR/master checks on Node 22, `npm ci`,
  build, glob-discovered JavaScript tests, amd64 Docker build and container suite.
  The tag-only publish job depends on checks, verifies the exact package version
  before login/push, rebuilds and checks the release image, then pushes only its
  version tag. Default permission is `contents: read`; only publish receives
  `packages: write`. Both builds pass VERSION and REVISION explicitly.
- Added executable `scripts/test-container-image.sh`: isolated temporary bind
  mounts and loopback ephemeral ports; image identity/history/filesystem checks;
  first boot, Docker health, layout, direct no-op seed exit code and warnings;
  all-public-table row hashes before/after restart, recreation and crash recovery;
  concurrent-container refusal; every task-listed storage/user/path failure;
  clean stop with released lock; and local-only HTTP sign-in. Logs are captured,
  scanned for generated fake credentials, withheld on failure and removed.
- Documented local Docker checks, action pins, release procedure, manual public
  visibility and anonymous pull in `docs/DEVELOPMENT.md`.
- `package.json` was already `0.9.0`; no package metadata change was necessary.
- Moved this record from in-progress to review. Approved scope and acceptance
  criteria were not changed. No contracts or `src/seed.ts` were edited.

### Validation performed

All node/npm commands used
`export PATH=/home/patrick/.nvm/versions/node/v22.22.3/bin:$PATH` first.

| Command / check | Actual result |
|---|---|
| `npm run build` | PASS, exit 0; TypeScript and console asset copy |
| `node scripts/test-admin-console.js` | PASS, exit 0 |
| `node scripts/test-api-docs.js` | PASS, exit 0 |
| `node scripts/test-console-sign-in.js` | PASS, exit 0 |
| `node scripts/test-container-deployment.js` | PASS, exit 0 |
| `node scripts/test-local-password-change.js` | PASS, exit 0 |
| `node scripts/test-local-registration.js` | PASS, exit 0 |
| `node scripts/test-proxy-only.js` | PASS, exit 0 |
| `node scripts/test-trusted-proxies.js` | PASS, exit 0 |
| `bash -n scripts/test-container-image.sh` | PASS, exit 0 (including final revision) |
| Python 3 / PyYAML `yaml.load(..., Loader=yaml.BaseLoader)` | PASS; workflow parses; assertions verify triggers, default permissions, publish dependency, 40-character pins and referenced script existence |
| `bash -n` on every workflow `run` block via Python subprocess | PASS |
| `node --check /tmp/task033-snapshot.cjs` (extracted snapshot heredoc) | PASS |
| Exact version comparison with `RELEASE_TAG=v0.9.0` | PASS, exit 0 |
| Same comparison with `RELEASE_TAG=v0.9.1` | Expected exit 1, confirmed |
| `git diff --check` | PASS |
| `command -v shellcheck` | Unavailable; ShellCheck NOT run |
| `command -v docker` | Unavailable; Docker NOT installed locally |

Tests were discovered with `for test in scripts/test-*.js; do node "$test" ...;
done`; all eight results above were inspected. Build/test output is in local
`/tmp/task033-build.log` and `/tmp/task033-tests/` (not committed). `npm ci` is
configured in CI; it was not rerun locally against the existing dependencies.

**Docker is not installed locally. The image build and container checks were
NOT run here. No green workflow run or anonymous pull is claimed. Green workflow
runs and anonymous pull evidence remain to be produced by Patrick.**

Action pins were looked up read-only using `git ls-remote https://github.com/actions/checkout
refs/tags/v4.3.1 'refs/tags/v4.3.1^{}'` and `git ls-remote
https://github.com/actions/setup-node refs/tags/v4.4.0 'refs/tags/v4.4.0^{}'`.
Both returned the direct tag SHA and no peeled ref (lightweight tags).

| Action | Release tag | SHA |
|---|---|---|
| actions/checkout | v4.3.1 | 34e114876b0b11c390a56381ad16ebd13914f8d5 |
| actions/setup-node | v4.4.0 | 49933ea5288caeca8642d1e84afbd3f7d6820020 |

### Acceptance criteria evidence

1. **PR builds/tests/container checks, no push:** check job contains the build,
   discovery loop and shell suite; publish requires a push tag and successful
   check job. Static checks pass. Actual PR/master green run URL: pending.
2. **Tag publication and anonymous pull:** publish uses only
   `ghcr.io/mrdatawolf/btauthorchestrator:$RELEASE_TAG`, amd64, no latest.
   Public visibility procedure is documented. Tag run URL and anonymous pull
   digest/output: pending; no tag or publication performed in this run.
3. **Mismatch fails before pushing:** version comparison tested with matching
   and mismatching values; verification precedes build, login and push in publish.
   Full workflow mismatch demonstration: pending.
4. **No secret logs/image:** no registry credential enters build args; only
   VERSION/REVISION do. Runtime tests generate fake credentials, privately scan
   container logs, history and exported filesystem, reject .env/data payloads,
   and never dump captured output. Registry token uses password-stdin and a
   temporary Docker configuration. Docker leakage assertions: pending execution.
5. **Release documentation:** DEVELOPMENT includes commands, version gate,
   permissions, pinned actions, first push, visibility and anonymous pull steps.

Additional requested evidence: all actions have full SHA pins and release-tag
comments; version is already 0.9.0; handoff completed and task moved to review.

### Assumptions and deviations

- The task was already in-progress and explicitly assigned by Patrick; no
  additional approval transition was needed.
- Wrong mode intentionally tests the contract's TrueNAS Shell/snapshot exception,
  rather than inventing a form-only correction for mode 0755.
- Docker host means a local Linux engine or Docker Desktop sharing the temporary
  directory; remote Docker daemons cannot bind-mount client-local scratch paths.
  Root helper containers prepare/clean test fixtures only, never start the app.
- Release image is rebuilt and rechecked in the publish job to keep package write
  permissions out of PR checks without adding artifact-transfer actions.
- No implementation scope deviation. No commits, pushes, tags, release creation,
  or state-changing GitHub requests were made. Existing unrelated task moves
  were preserved.

### Unresolved risks

- The shell suite is syntax-checked but unexecuted on Docker; real image/runtime
  issues can only be resolved after a Docker run. CI is the first Docker host.
- GHCR token/package policy and public visibility still need live verification.
- Docker CI does not prove TrueNAS ACL behavior, tunnel ingress or real client
  addresses; those remain TASK-034 responsibilities.
- Independent review and human acceptance remain outstanding.

### Documentation updated and Patrick's exact first-release steps

`docs/DEVELOPMENT.md`, section "Container CI and GHCR releases (TASK-033)".

1. Review/merge this implementation and include TASK-032 in the intended release
   commit. Confirm package version `0.9.0` and a green master check run.
2. From that release commit: `git tag v0.9.0`, then `git push origin v0.9.0`.
3. Watch Actions → Container checks and release for `v0.9.0`; require both jobs
   green and record the run URL here. Do not proceed past a failing check.
4. After the first push, GitHub profile mrdatawolf → Packages →
   btauthorchestrator → Package settings → Change visibility → Public → confirm.
   This is Patrick's one-time manual step; the workflow does not do it.
5. On a Docker host, run:

   ```sh
   anonymous_config=$(mktemp -d)
   DOCKER_CONFIG="$anonymous_config" docker pull --platform linux/amd64 \
     ghcr.io/mrdatawolf/btauthorchestrator:v0.9.0
   rm -rf "$anonymous_config"
   ```

   Record successful anonymous pull output/digest here alongside the run URL.
   No saved registry credentials are used with that empty configuration.


