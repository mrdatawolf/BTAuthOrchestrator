# CONTRACT-014: TrueNAS Custom App container profile (storage, runtime user, inputs)

Status: Approved
Approved by: Patrick
Approved date: 2026-10-29
Related tasks: TASK-031 (this contract's drafting task), TASK-025 (container
image and code), TASK-033 (GHCR image publishing), TASK-034 (TrueNAS
validation)
Related ADRs: ADR-001
Supersedes: CONTRACT-008, only for the sections listed below. Section
numbers in this contract's "Required behavior" match CONTRACT-008's, so that
CONTRACT-008's remaining cross-references (for example §7.4's "§7.2
channels") resolve to the sections here.

1. Purpose: the paragraph headed "Container deployment (new in this
   contract)".
2. Actors: "Container operator" and "Container runtime".
3. Inputs and outputs: the input bullet beginning "In a container deployment
   (new)".
4. Preconditions: every bullet under "Container deployment only (new)",
   including "The Node service's listening port is not published on any host
   interface", which CONTRACT-012 had also superseded (see CONTRACT-013's
   header).
5. §7's introduction and §7.1 (data path).
6. §7.2 (input channels) in full, including the `*_FILE` rules and the
   exposure-tradeoff paragraph.
7. §7.3 (container user and data-directory ownership) in full, including its
   fix-message rule.
8. Postconditions and invariants: the "Container-mode qualification" sentence
   of the "no plaintext anywhere on the host" postcondition; all of
   "Postconditions (true after a successful non-interactive seed run, §7.4)";
   and both "(New, container mode)" invariants, including "The Node
   listening port is not published on any host interface (§8)", which is
   now false and is retired.
9. Failure behavior: every row marked "(New, container)".
10. Interfaces: the "Container deployment interface (new)" subsection,
    including its "Ingress" line, which CONTRACT-012 had also superseded.
11. UX expectations: the three bullets marked "(New, container)".
12. Validation requirements: the "(New)" bullets headed **First boot**,
    **`*_FILE` channel**, **Ownership**, **Data path** and **Ingress**.
13. Resolved decisions #18 and #19.

Everything else in CONTRACT-008 remains in force, in particular §1–§6,
§7.4, §7.5, Resolved decisions #1–#17 and #20–#22, Patrick's answers to its
OQ-1 to OQ-10, and the remaining validation bullets (**Stale lock**,
**Missing and invalid inputs**, **Secret leakage**, **Regression**).
CONTRACT-013 governs ingress and the client address.
Superseded by:

## Purpose

Patrick decided on 2026-10-28 (TASK-031) that BTAuthOrchestrator ("Orca")
runs on TrueNAS SCALE 25.10.0.1 (Goldeye) or newer as a single **Custom App
installed through the TrueNAS form**, from a published image, with no
prework on the TrueNAS host and no compose file.

CONTRACT-008's container profile assumed a compose install and needed host
prework: a pre-created host path owned by the container UID at exactly mode
`0700`, with no extended ACL entries. That clashes with TrueNAS NFSv4 ACLs,
and the operator has no shell step in a form install. This contract
replaces those container sections so that:

- `/data` is an ix volume that TrueNAS creates, made writable through the
  form's Storage → Enable ACL setting.
- The database lives in `/data/pglite`, which the app creates itself at mode
  `0700`. CONTRACT-008 §5's strict mode and owner check applies there, not
  to `/data`.
- The image supplies defaults for `PORT`, `PGLITE_DATA_DIR` and container
  mode, so the form holds only the operator's settings and secrets.
- The runtime user comes from the form's Security Context (default
  `568:568`), and root is refused.
- Every input is an environment variable (CONTRACT-008 OQ-1 answer), and
  seed inputs may be removed after first boot (OQ-2 answer).
- Every container-mode error message says which form setting to change, not
  which shell command to run.

The storage, encryption, schema, key lifecycle, seed CLI, permission check,
single-process and stale-lock rules of CONTRACT-008 §1–§6, and its
first-boot seeding (§7.4) and stop behavior (§7.5), are unchanged.

### Relationship to CONTRACT-008

The superseded sections are listed in the header. Compared with them, the
complete list of behavioral changes is:

1. **Install path.** Form only, from a published image. "Install via YAML",
   compose and building on the host are no longer part of the profile.
2. **Storage.** `/data` is an operator-provided mount (an ix volume with an
   ACL entry granting the runtime UID Modify). It is no longer required to be
   mode `0700`, owned by the runtime UID, or free of extended ACL entries.
3. **Data path.** `PGLITE_DATA_DIR` is `/data/pglite` in container mode
   (was `/data`), set by the image.
4. **Ownership check.** Applies to `/data/pglite`, which the app creates.
   `/data` must exist as a mount and be writable.
5. **Inputs.** Environment variables only; no `*_FILE` channels. The input
   table now lists required and optional status for the tunnel and
   local-only profiles.
6. **Runtime user.** Set through the form's Security Context rather than
   compose `user:`. Default and root refusal unchanged.
7. **Fix messages.** Name the TrueNAS form setting to change, not host-side
   `chown`/`chmod`.
8. **Ingress.** The "Node port is not published" precondition and invariant
   are retired. The port is published on the TrueNAS LAN IPv4 under
   CONTRACT-013.
9. **Image.** Image reference, image defaults and healthcheck are now part of
   the operator interface.

## Scope

### Included

- The TrueNAS Custom App profile: what the form must contain, and nothing
  else on the TrueNAS host (§7).
- The `/data` mount and the app-created `/data/pglite` database directory
  (§7.1, §7.3).
- Image-supplied defaults (§7.1).
- Every container input, with required and optional status per profile
  (§7.2).
- The runtime user and root refusal (§7.3).
- Container-mode startup failures and their form-oriented messages.
- Container postconditions, failure rows, interface, UX and validation for
  the above.

### Excluded

- Ingress, the published port, `TRUSTED_PROXIES`, `PROXY_ONLY` and the
  client address (CONTRACT-013). They appear in §7.2's table only so that
  every form input is listed in one place.
- How the image is built and published (TASK-025, TASK-033). This contract
  states the image reference and defaults the operator relies on.
- The Dockerfile, entrypoint and healthcheck script contents.
- A TrueNAS catalog app, compose file or "Install via YAML" path.
- Backups and snapshots of `/data` (CONTRACT-008 Resolved decision #15
  stands).
- Audit retention (TASK-030).
- Anything in CONTRACT-008 §1–§6, §7.4 and §7.5.

## Actors

These replace CONTRACT-008's "Container operator" and "Container runtime"
actors. CONTRACT-008's other actors are unchanged, except that its
"Reverse proxy" actor is superseded by CONTRACT-013.

- **Container operator**: a TrueNAS administrator who installs and edits
  the app only through the TrueNAS Custom App form: image, environment
  variables, Security Context, ports and storage. They need no shell on the
  TrueNAS host and no repository checkout. They generate secret values
  (for example `DB_ENCRYPTION_KEY`) on a machine of their choice and keep an
  off-box copy of `DB_ENCRYPTION_KEY`.
- **Container runtime**: Docker on TrueNAS SCALE 25.10.0.1 (Goldeye) or
  newer. It pulls the image, creates the ix volume, starts and stops the
  container (SIGTERM, then SIGKILL after the stop grace period), restarts it
  under its restart policy, and recreates it on image-tag changes or
  configuration edits. The ix volume persists across recreation.

## Inputs and outputs

This replaces CONTRACT-008's container input bullet:

- In a container deployment, every input arrives as an environment variable
  set in the TrueNAS form (§7.2), never through `.env`, a file, or an
  interactive prompt. `PGLITE_DATA_DIR` is `/data/pglite`, set by the image
  (§7.1).

## Preconditions

These replace CONTRACT-008's "Container deployment only" preconditions:

- The image `ghcr.io/mrdatawolf/btauthorchestrator:<version tag>` is
  published as a public package, so TrueNAS pulls it without registry
  credentials (TASK-033).
- The app's storage includes a mount at `/data`. In the TrueNAS profile it is
  an ix volume, created and managed by TrueNAS, with **Enable ACL** ticked
  and an ACL entry granting the runtime UID (default `568`) **Modify**.
- The storage backing `/data` is local to the TrueNAS host, not a network
  share (CONTRACT-008 §6, S7).
- The runtime UID is non-root (§7.3).
- Ingress preconditions are in CONTRACT-013.

No precondition requires a shell, a pre-created dataset or directory, a
`chmod`, a `chown` or a repository checkout on the TrueNAS host.

## Required behavior

### 7. Container deployment profile

This replaces CONTRACT-008 §7's introduction.

This section applies only when the service runs from the published container
image. That image establishes **container mode** explicitly, not through
heuristics such as probing for `/.dockerenv`. How it does so is not
prescribed. An operator who edits the form could turn it off; that is
accepted, and the documentation says not to (resolved question 5). Everything in CONTRACT-008 §1–§6 continues
to apply in container mode unless this section says otherwise. CONTRACT-008
§7.4 and §7.5 continue to apply unchanged.

#### 7.1 Data path and image defaults

**Image defaults.** The image supplies these values, so the operator does
not enter them in the form:

| Setting | Image value | Operator may change it? |
|---|---|---|
| `PORT` | `3210` | Yes. The container port in the form's port mapping must then match. The healthcheck uses the effective `PORT`. |
| `PGLITE_DATA_DIR` | `/data/pglite` | No. Any other value fails startup closed (resolved question 3). |
| Container mode | on | Not a form setting. Documented as "do not set" (resolved question 5). |
| Runtime UID:GID | `568:568` | Yes, through the Security Context (§7.3). |
| Healthcheck | `GET /health` on loopback at the effective `PORT`, opening no database lock | Not required. |

**`/data`.**

- `/data` is an operator-provided mount. In the TrueNAS profile it is an ix
  volume (Patrick's decision 8). The image never chooses the host-side
  storage, and never causes an anonymous Docker volume or the container's
  writable layer to stand in for a missing mount.
- If no operator storage is mounted at `/data`, startup fails closed. The
  detection mechanism is not prescribed.
- At every container start, `/data` must be a directory that the runtime UID
  can write to and enter. If not, startup fails closed. The check must not
  leave anything behind in `/data`.
- The service never changes the owner, group, mode or ACL of `/data`. No
  minimum or maximum mode is required for `/data`. Its access control is
  TrueNAS's ACL.
- The only entry the service creates directly in `/data` is `pglite`.

**`/data/pglite`.**

- This is `PGLITE_DATA_DIR`. CONTRACT-008 §5's POSIX rule applies to it
  unchanged: if it does not exist, the service creates it with mode `0700`,
  owned by the runtime UID; if it exists, it must be a directory with mode
  `0700` owned by the runtime UID, or startup fails closed. The database and
  CONTRACT-008 §6's lock live inside it.
- The service never changes ownership of anything, and never changes the
  mode of anything it did not create. An existing `/data/pglite` owned by
  the runtime UID with a mode other than `0700` is refused, never narrowed
  (resolved question 1; message in §7.3).
- The service checks POSIX mode bits only. ACL entries that `/data/pglite`
  inherits from `/data` are outside what it can see. The TrueNAS profile
  relies on the ACL the operator set on `/data` granting only the runtime UID
  (accepted under CONTRACT-008 OQ-5's answer: "there are many safeguards in
  truenas to deal with this"). If TASK-034 finds that inherited ACLs make
  the app-created folder report a mode other than `0700`, that blocks
  TASK-025 and comes back as a contract change. This contract does not
  weaken §5 in advance (resolved question 2).

#### 7.2 Input channels

Every input is an environment variable (CONTRACT-008 OQ-1 answer:
environment only). No `NAME_FILE` variant is read in container mode.
Validation of each value is unchanged from the contract that defines it.

"Every start" inputs are read on every start. "First boot" inputs are read
only by CONTRACT-008 §7.4's non-interactive seed while the matching piece is
unseeded. Once seeded, they are ignored with §7.4's per-start warning, and
the operator may remove them (CONTRACT-008 OQ-2 answer: may).

The **tunnel** profile is CONTRACT-013's TrueNAS tunnel profile (proxy-only,
or tunnel plus direct LAN). The **local-only** profile is CONTRACT-013 §8.

| Variable | Class | Tunnel profile | Local-only profile | Notes |
|---|---|---|---|---|
| `DB_ENCRYPTION_KEY` | Every start | Required | Required | 64 lowercase hex characters. Never generated by the container. Keep an off-box copy. |
| `EMERGENCY_ROTATION_TOKEN` | Every start | Required | Required | At least 32 characters. |
| `LOCAL_USER_ADMIN_TOKEN` | Every start | Required | Required | At least 32 characters. |
| `LOCAL_LOGIN` | Every start | Required: `true` or `false` | Required: `true` | Entra cannot use a plain-HTTP LAN redirect (CONTRACT-013 §8). |
| `TENANT_ID`, `CLIENT_ID` | Every start | Required when `LOCAL_LOGIN=false` | Required when `LOCAL_LOGIN=false` | CONTRACT-005 §10. |
| `SERVICE_ISSUER` | Every start | Required: `https://orca.biztechro.com` | Required: an `http://` LAN address or name, with port | CONTRACT-013 Preconditions and §8. |
| `COOKIE_SECURE` | Every start | Required: `true` | Required: `false` | |
| `TRUSTED_PROXIES` | Every start | Required: the connector machine's LAN IPv4 | Must be empty or absent | CONTRACT-013 §3. |
| `PROXY_ONLY` | Every start | Optional. Unset means on; `false` means tunnel plus direct LAN | Optional; leave unset. `true` fails startup | CONTRACT-013 §6. |
| `PORT` | Every start | Optional (image default `3210`) | Optional (image default `3210`) | §7.1. |
| `PGLITE_DATA_DIR` | — | Do not set | Do not set | Image default `/data/pglite`; §7.1. |
| `ALLOW_NEW_LOCAL_LOGIN_CREATION` | Every start | Optional | Optional | |
| `LOCAL_LOGIN_MAX_FAILED_ATTEMPTS`, `LOCAL_LOGIN_LOCKOUT_MINUTES`, `LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS`, `LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES` | Every start | Optional | Optional | CONTRACT-005 §3 defaults. |
| `CLIENT_SECRET` | First boot (while unseeded) | Required at first boot | Required at first boot | Container installs always require the operator to supply it, whatever `LOCAL_LOGIN` is, local-login demos included (CONTRACT-008 §7.4; Patrick, 2026-10-29). The container never generates one. Remove after first boot. |
| `INITIAL_LOCAL_USER_USERNAME`, `INITIAL_LOCAL_USER_EMAIL`, `INITIAL_LOCAL_USER_PASSWORD` | First boot (while `local_users` is empty) | Required at first boot | Required at first boot | CONTRACT-005 rules. Remove the password after first boot. |

**Form settings other than environment variables:**

| Form area | Setting | Value |
|---|---|---|
| Image | Repository and tag | `ghcr.io/mrdatawolf/btauthorchestrator`, a version tag `vX.Y.Z` (first release `v0.9.0`). No registry credentials. |
| Security Context | User ID / Group ID | `568` / `568` by default, or another non-root pair matching the ACL on `/data` (§7.3). Not privileged. |
| Ports | Container port, host port, Host IP, protocol | Container port = effective `PORT` (`3210` by default); host port of the operator's choice; Host IP = the TrueNAS static LAN IPv4 only; TCP. Never `0.0.0.0`, `::` or empty (CONTRACT-013 §1). |
| Storage | `/data` | Type ix volume, Mount Path `/data`, **Enable ACL** ticked, ACL entry: User, ID = the runtime UID, **Modify**. |

The tunnel token is configured on the connector machine, not in this form.

**Exposure (recorded tradeoff, CONTRACT-008 OQ-1 answer).** Every value
above, including `DB_ENCRYPTION_KEY` and the two tokens, is visible in
`docker inspect`, in the TrueNAS app configuration screens and possibly in
TrueNAS configuration exports and debug bundles, for as long as it stays in
the app configuration. Patrick accepted this. Values never appear in the
service's own logs, audit rows or responses.

#### 7.3 Container user and data-directory ownership

- The container process never runs as UID 0. In container mode, starting as
  UID 0 fails closed. This rule does not apply to non-container POSIX hosts.
- The image's default runtime UID:GID is `568:568`, the TrueNAS `apps`
  convention. The operator may choose another non-root UID:GID through the
  form's Security Context, provided the ACL on `/data` grants that UID
  Modify. The image does not require any file outside `/data` to be owned
  by, or writable by, a particular UID.
- The service never changes ownership of any path, and the container never
  starts as root in order to `chown` and then drop privileges.
- **Fix messages.** Because the operator works only in the TrueNAS form, every
  container-mode startup error about storage, ownership, mode, runtime user
  or data path must:
  - state what was found, using the actual numeric UID and GID, the mode
    found, and the owning UID found, where relevant;
  - name the form area and setting to change (Storage, Security Context, or
    Environment Variables) and the value to set;
  - not present a shell command (`chown`, `chmod`, `setfacl`), `.env`,
    `npm run seed`, `start.sh` or a host path as the fix, except the
    wrong-mode message below (resolved question 1);
  - never include a secret value.

  Native installs keep CONTRACT-008 §5's `chmod`/`chown` messages. Proposed
  wording, which TASK-025 adapts to the exact TrueNAS 25.10 field labels:

  - No mount: "No storage is mounted at /data. In the app's Storage settings,
    add an ix volume with Mount Path /data, then save the app."
  - `/data` not writable: "The app (UID 568, GID 568) cannot write to /data.
    In the app's Storage settings for /data, tick Enable ACL and add an
    entry: User, ID 568, Modify. Then save the app."
  - Root: "The container is running as root (UID 0). In the app's Security
    Context, set User ID and Group ID to 568, or another non-root ID that has
    Modify access to /data."
  - `/data/pglite` owned by another UID: "/data/pglite belongs to UID 1000,
    but the app runs as UID 568. In the app's Security Context, set User ID
    back to 1000, or give the app a new, empty /data volume."
  - `PGLITE_DATA_DIR` changed: "PGLITE_DATA_DIR is set to /elsewhere. Remove
    the PGLITE_DATA_DIR environment variable from the app configuration;
    the image sets it to /data/pglite."
  - `/data/pglite` mode wrong (the one exception to the no-shell rule):
    "/data/pglite has mode 0755 but must be 0700. Something outside the app
    changed it. Fix it from the TrueNAS Shell (chmod 700 on the app's
    /data/pglite folder), or restore a snapshot of the app's volume."

## Postconditions and invariants

These replace the CONTRACT-008 container postconditions and invariants
listed in the header.

**Container-mode qualification of the "no plaintext anywhere on the host"
postcondition:** plaintext seed inputs may remain in the app configuration
until the operator removes them (§7.2). The service itself never creates any
other copy of them.

**After the first successful container start:**

- `/data/pglite` exists as a directory with mode `0700`, owned by the runtime
  UID.
- The owner, group, mode and ACL of `/data` are as TrueNAS left them.
- The service has created no entry in `/data` other than `pglite`.

**After a successful non-interactive seed run (CONTRACT-008 §7.4):**

- Everything CONTRACT-008's bootstrap postconditions require, plus
  CONTRACT-005's `scripts/seed.js` postconditions for `local_users`.
- Exit status 0. On a re-run against a fully seeded database, no row in
  `secrets`, `signing_keys` or `local_users` was added, changed or removed.

**After an image-tag change or configuration edit that recreates the
container:** the ix volume, and with it every user, signing key and the
stored `CLIENT_SECRET`, is unchanged. The seed step reports "already
seeded".

**Invariants (container mode):**

- The process runs as a non-root UID.
- `PGLITE_DATA_DIR` is `/data/pglite`, and `/data` is operator-provided
  storage.
- The service never changes ownership of any path, and never changes the mode
  or ACL of `/data`.
- In the TrueNAS profile, the Node port is published only on the TrueNAS
  static LAN IPv4 (CONTRACT-013 §1). Which peers may use it is governed by
  CONTRACT-013 §2.0. This replaces the retired invariant that the Node port
  is not published on any host interface.

## Failure behavior

These replace every "(New, container)" row of CONTRACT-008's table. Rows
for stale locks are not container-only and remain in CONTRACT-008.

| Condition | Required behavior |
|---|---|
| Running as UID 0 | Fail closed at startup. Message names the Security Context fix (§7.3). |
| `PGLITE_DATA_DIR` set to anything other than `/data/pglite` | Fail closed at startup. Message says to remove the variable (§7.1). |
| No operator storage mounted at `/data` | Fail closed at startup. Message names the Storage fix. Nothing is written anywhere (§7.1). |
| `/data` not writable or not enterable by the runtime UID | Fail closed at startup. Message names Enable ACL and the UID needing Modify (§7.1, §7.3). |
| `/data/pglite` exists and is not a directory | Fail closed at startup, naming the path inside the container. |
| `/data/pglite` exists, owned by a different UID | Fail closed at startup. No `chown`. Message names the owning UID and the Security Context fix (§7.3). |
| `/data/pglite` exists, owned by the runtime UID, mode not `0700` | Fail closed at startup (CONTRACT-008 §5). Never narrowed automatically. Message gives the TrueNAS Shell or snapshot fix (§7.3). |
| Non-interactive seed: input for a missing piece absent or invalid | Exit non-zero before any write, naming the variables. The service does not start. Under the restart policy this repeats with the same message until the operator fixes the form (unchanged from CONTRACT-008). |
| Non-interactive seed: database already fully seeded | Exit 0, no writes, one warning per ignored seed input still set (unchanged from CONTRACT-008). |
| Image cannot be pulled | TrueNAS reports the pull failure. The service never starts. No data effect. |
| App uninstalled with "remove ix volumes" ticked | All signing keys, users and `CLIENT_SECRET` are deleted (Patrick's decision 8, accepted risk). Recovery is a snapshot restore, or a fresh install with a new seed. |

## Interfaces

This replaces CONTRACT-008's "Container deployment interface". It is
operator-facing and normative.

- Image: `ghcr.io/mrdatawolf/btauthorchestrator:vX.Y.Z`, public, pulled
  without credentials. First release `v0.9.0` (TASK-033).
- Storage: a mount at `/data`; the database at `/data/pglite`, created by the
  app.
- Inputs: environment variables only; see §7.2's tables.
- Image defaults: §7.1's table.
- Non-interactive seed mode: `node scripts/seed.js --non-interactive`
  (CONTRACT-008 OQ-4 answer). Exit 0 means seeded or already seeded;
  non-zero means failure. It reads only §7.2's inputs, and never prompts or
  unlinks anything.
- Runtime identity: non-root; default `568:568`; set through the form's
  Security Context.
- Ingress: the port is published on the TrueNAS static LAN IPv4, and
  admission and client address follow CONTRACT-013.
- Health: the existing `GET /health` endpoint is unchanged and opens no
  database lock. The image's healthcheck calls it over loopback, which
  CONTRACT-013 §2.0 admits in proxy-only mode.

## UX expectations

These replace CONTRACT-008's three "(New, container)" UX bullets.

- All container output goes to stdout and stderr, so it appears in the
  TrueNAS app logs. An operator reading only those logs can tell apart at
  least: first-boot seeding performed (naming each piece); already seeded;
  seed input missing or invalid (naming variables); no storage at `/data`;
  `/data` not writable, with the ACL fix; `/data/pglite` owned by another
  UID; `/data/pglite` mode wrong; running as root; `PGLITE_DATA_DIR`
  changed; stale lock recovered; another instance running; and the ingress
  mode line from CONTRACT-013 §7.
- The ignored-seed-input warning (CONTRACT-008 §7.4) names the variables and
  says that changing them has no effect after seeding, and that they may be
  removed from the app configuration.
- Container-mode guidance names TrueNAS form concepts: the app's
  environment variables, Storage, Security Context, and saving or
  restarting the app. It does not name `.env`, `npm run seed`, `start.sh`,
  the service user, a host path, or a shell command (§7.3).
- Startup output does not present container-internal network addresses as
  addresses clients should use.

## Validation requirements

These replace CONTRACT-008's container validation bullets listed in the
header. Isolated tests in the style of the existing `scripts/test-*.js`
files, plus local Docker checks, cover:

- **Data layout.** With an empty, writable `/data`, first start creates
  `/data/pglite` at mode `0700`, owned by the runtime UID, and creates
  nothing else in `/data`. The mode, owner and ACL of `/data` are unchanged
  afterwards.
- **First boot and restart.** With every first-boot input set, the container
  seeds `CLIENT_SECRET`, the signing key and the first local user, then
  `/health` is healthy. A restart exits the seed step 0, changes no row, and
  logs ignored-input warnings that name variables but not values.
- **Storage failures.** No mount at `/data`; a `/data` the runtime UID cannot
  write; `/data/pglite` owned by another UID; `/data/pglite` with mode
  `0755`; `/data/pglite` as a file. Each fails closed with the matching
  message, which names the form setting and contains no `chown`, `chmod`,
  `.env` or host path (except the wrong-mode message, §7.3).
- **Runtime user.** UID 0 is refused with the Security Context message. A
  non-default non-root UID works when `/data` grants it write access.
- **Data path.** `PGLITE_DATA_DIR=/elsewhere` and `PGLITE_DATA_DIR=/data`
  each fail closed.
- **Environment only.** Setting `DB_ENCRYPTION_KEY_FILE` or
  `CLIENT_SECRET_FILE` in container mode supplies nothing: the matching
  "missing input" error appears.
- **Local-only container profile.** A container with empty
  `TRUSTED_PROXIES`, an `http://` issuer and `COOKIE_SECURE=false` starts
  and serves sign-in (cross-check with CONTRACT-013).
- Every existing test script still passes.

**TrueNAS checks, recorded in TASK-034:**

- **Form-only install.** A fresh install on TrueNAS SCALE 25.10.0.1 or newer
  uses only the Custom App form and the Cloudflare dashboard: no dataset
  creation, `chmod`, `chown`, shell or repository checkout on TrueNAS. The
  first boot seeds and the app shows healthy. (A shell may be used afterwards
  to inspect results, never to make the install work.)
- **ACL path.** Without Enable ACL on `/data`, the app fails with the ACL
  message. Ticking Enable ACL with User 568 Modify and saving fixes it with no
  shell.
- **Ownership on TrueNAS.** `/data/pglite` is `0700`, owned by `568`. `/data`
  keeps the owner, mode and ACL TrueNAS gave it.
- **Data kept across an image-tag update.** After changing the tag (for
  example `v0.9.0` to a later tag, or re-pulling the same tag), the same
  users can sign in, `/.well-known/jwks.json` publishes the same `kid`, and
  the seed step reports "already seeded".
- **Healthcheck** is healthy in the TrueNAS UI with proxy-only on.

## Resolved questions

Patrick accepted every drafted recommendation on 2026-10-29, with the
`CLIENT_SECRET` answer below. The body above already reflects each answer.

1. **Existing `/data/pglite` with the wrong mode:** refuse, as CONTRACT-008
   §5 says. The message is the one allowed exception to the no-shell rule
   (§7.3).
2. **Inherited ACLs on `/data/pglite`:** if TASK-034 finds the app-created
   folder does not report `0700`, that blocks TASK-025 and returns as a
   contract change. No speculative fallback (§7.1).
3. **Fixed `PGLITE_DATA_DIR`:** confirmed. Any value other than
   `/data/pglite` fails closed.
4. **Pre-TASK-031 data layout:** nothing to handle. Patrick confirmed the
   compose build was never deployed, so no volume holds that layout.
5. **Container mode switched off through the form:** accepted and
   documented as "do not set".
6. **Supersession of CONTRACT-008:** section-level, as listed in the header.
   TASK-030 is sequenced after this contract is approved.
7. **`CLIENT_SECRET` at first boot:** container installs always require the
   operator to supply it, local-login demos included (§7.2). For native
   local-login demos, Patrick decided the seed may generate a random value;
   that changes CONTRACT-008's seed interface and is specified separately
   (TASK-035).
8. **Mount type:** documentation covers the ix volume only. The contract
   stays neutral about the mount type.

## Resolved decisions

These replace CONTRACT-008's Resolved decisions #18 and #19. Numbering is
this contract's own.

1. **Container target platform** (replaces CONTRACT-008 #18). Decided by
   Patrick (2026-10-28). The container target is TrueNAS SCALE 25.10.0.1
   (Goldeye) or newer, as a single Custom App installed through the form
   from a published image. No compose file, "Install via YAML", building on
   the host, or catalog app.
2. **Data storage** (replaces CONTRACT-008 #19). Decided by Patrick
   (2026-10-28, decision 8). `/data` is an ix volume created and managed by
   TrueNAS, made writable through Enable ACL. The database lives in the
   app-created `/data/pglite` (`PGLITE_DATA_DIR`). Accepted risk:
   uninstalling with "remove ix volumes" ticked deletes signing keys and
   users. Snapshots and an off-box copy of `DB_ENCRYPTION_KEY` are the
   operator's responsibility.
3. **Image** (new). Decided by Patrick (2026-10-28, decisions 6 and 7).
   `ghcr.io/mrdatawolf/btauthorchestrator:vX.Y.Z`, published as a public
   package. First release tag `v0.9.0`.
4. **Inputs** (restated). CONTRACT-008 OQ-1 (environment only) and OQ-2
   (seed inputs may be removed) stand.
5. **Runtime user** (restated). CONTRACT-008 OQ-5 stands: default `568:568`,
   another non-root ID allowed, root refused, never auto-`chown`. The override
   is now made through the form's Security Context.
