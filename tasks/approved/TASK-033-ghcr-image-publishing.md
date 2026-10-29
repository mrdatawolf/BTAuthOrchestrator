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

Not started.

