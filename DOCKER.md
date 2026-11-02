# Running BTAuthOrchestrator in a container

This guide gets the published container image running, first on TrueNAS
SCALE (the supported, tested target) and then on any Linux host with plain
Docker. It collects the steps and the pitfalls found while setting up the
first TrueNAS install. The full reference is
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#container-deployment-truenas-custom-app-task-025);
the binding rules are CONTRACT-013 (ingress) and CONTRACT-014 (TrueNAS
container profile).

## Contents

1. [What you need](#1-what-you-need)
2. [Choose your setup](#2-choose-your-setup)
3. [Prepare a settings file](#3-prepare-a-settings-file)
4. [TrueNAS SCALE](#4-truenas-scale)
5. [Plain Docker on Linux](#5-plain-docker-on-linux)
6. [Cloudflare Tunnel](#6-cloudflare-tunnel)
7. [After the first boot](#7-after-the-first-boot)
8. [Troubleshooting](#8-troubleshooting)

## 1. What you need

- **Image:** `ghcr.io/mrdatawolf/btauthorchestrator`, with a released version
  tag such as `v0.9.1`. There is no `latest` tag; you choose when to
  upgrade by changing the tag. Releases are listed under **Packages** on the
  GitHub repository page.
- **A host:** TrueNAS SCALE 25.10.0.1 (Goldeye) or newer, or a Linux host
  with Docker.
- **A static LAN IPv4 address** on that host.
- **For the tunnel setup:** a Cloudflare account with the domain, and a
  separate LAN machine running the Cloudflare connector (`cloudflared`) with
  its own reserved/static IPv4.
- **For Microsoft Entra sign-in:** the app registration's tenant ID, client
  ID and client secret. Not needed for local username/password login.

The container runs as UID/GID `568:568` (the TrueNAS `apps` user), listens
on port `3210`, and keeps all its data under `/data`, which you must mount.

## 2. Choose your setup

| | Tunnel (recommended) | Local-only |
|---|---|---|
| Reached at | `https://orca.biztechro.com` through Cloudflare | `http://<lan-address>:<port>` on the LAN only |
| Security | HTTPS to the browser; Cloudflare Access protects `/admin/*` | Plain HTTP: passwords and cookies are readable on the LAN |
| Direct LAN access | Refused (403) by default; everyone goes through the tunnel | Allowed |
| Login | Local login or Entra | Local login in practice (Entra needs HTTPS) |

**Login mode** is separate: `LOCAL_LOGIN=true` uses usernames and passwords
stored in the app; `LOCAL_LOGIN=false` uses Microsoft Entra.

## 3. Prepare a settings file

Neither TrueNAS nor Docker generates these values for you. Prepare them in
one file first, then copy them into the TrueNAS form or hand the file to
Docker. Keep this file **outside the repository**, readable only by you, and
delete it (or move it to your password manager) once the app is running.

Generate each secret separately, on any machine with OpenSSL (the TrueNAS
Shell has it):

```sh
openssl rand -hex 32
```

Example `btauth.env` for the **tunnel** setup with **local login**:

```ini
# ---- Every start: keep these configured ----
# 64 lowercase hex characters. BACK THIS UP OFF THE BOX. Losing it makes the
# database unreadable. Never change it for an existing database.
DB_ENCRYPTION_KEY=<openssl rand -hex 32>
# At least 32 characters each, and different from each other.
EMERGENCY_ROTATION_TOKEN=<openssl rand -hex 32>
LOCAL_USER_ADMIN_TOKEN=<openssl rand -hex 32>
# true = local usernames/passwords; false = Microsoft Entra.
LOCAL_LOGIN=true
# The public address. Must match the Cloudflare hostname exactly.
SERVICE_ISSUER=https://orca.biztechro.com
# true because browsers reach the app over HTTPS through Cloudflare.
COOKIE_SECURE=true
# The connector machine's LAN IPv4, NOT the TrueNAS/Docker host's address.
TRUSTED_PROXIES=192.168.1.40

# ---- Entra only (LOCAL_LOGIN=false) ----
# TENANT_ID=00000000-0000-0000-0000-000000000000
# CLIENT_ID=00000000-0000-0000-0000-000000000000

# ---- First boot only: remove after the app has started once ----
# Required even with LOCAL_LOGIN=true. With local login it is unused, so any
# long random value works (openssl rand -hex 32). With Entra, the real
# client secret.
CLIENT_SECRET=<value>
# The first admin user. Username: 3-64 characters of a-z 0-9 . _ -
# Password: at least 12 characters.
INITIAL_LOCAL_USER_USERNAME=admin
INITIAL_LOCAL_USER_EMAIL=you@example.com
INITIAL_LOCAL_USER_PASSWORD=<at least 12 characters>
```

For **local-only**, change three lines and drop `TRUSTED_PROXIES`:

```ini
SERVICE_ISSUER=http://<lan-address-or-name>:<host-port>
COOKIE_SECURE=false
# TRUSTED_PROXIES not set
```

**Do not set** `PGLITE_DATA_DIR`, `BT_CONTAINER_MODE` or `PROXY_ONLY` (the
image sets the first two; the third is derived from `TRUSTED_PROXIES`), and
do not use `*_FILE` variants such as `CLIENT_SECRET_FILE`: they are ignored.
`PORT` is optional; if you change it, change the container port to match.
Optional tuning variables (lockout and throttle limits, self-registration)
are described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

These values end up visible in the TrueNAS app configuration and in
`docker inspect`. That is an accepted tradeoff: protect access to the host,
its configuration exports and its backups. The app never logs secret values.

## 4. TrueNAS SCALE

### 4.1 Prepare storage

The app needs a `/data` mount it can write to as UID 568. Pick one:

**Option A: ix volume (simplest; the tested, documented setup).** TrueNAS
creates and manages the dataset inside its apps pool. Nothing to prepare;
you set it up in the form (step 4.2). Backups are ZFS snapshots of the
`ix-apps` dataset, which is less convenient to browse or copy from.

**Option B: your own dataset (for easy backup, copying and import).** This
is how the production install runs (verified on TrueNAS 2026-11-02). The
dataset is a normal folder you can snapshot, replicate and copy from.

1. **Create the dataset.** Datasets → select the parent → **Add Dataset**,
   name `btauth`, **Dataset Preset: Apps**.
   - If TrueNAS says permissions on the parent "prevent access for user
     apps", either create it directly under the pool (`pool1/btauth`), or
     give `apps` **Traverse** on the parent: Datasets → parent →
     Permissions → Edit → Add Item: User `apps`, Allow, Basic, **Traverse**.
     **Leave "Apply permissions recursively" unticked** so nothing else in
     the parent changes.
2. **Remove the inherited ACL (required).** The Apps preset adds inherited
   ACL entries that make the app's database folder show mode `0770`, and
   the app refuses to start with that (it requires `0700`). Datasets → `btauth` →
   Permissions → Edit → **Strip ACL**, then set Owner **apps**, Group
   **apps**, mode **755**, tick Apply User and Apply Group, Save.
3. **Check it from System → Shell** (adjust the path):

   ```sh
   sudo -u apps test -w /mnt/pool1/Data/btauth && echo writable
   ```

   It must print `writable`. If it prints nothing, step 1 or 2 did not
   apply.

### 4.2 Install the Custom App

Apps → Discover → **Custom App**. Fill in:

| Section | Setting | Value |
|---|---|---|
| Application name | Name | e.g. `bt-auth` |
| Application name | Version | Whatever is offered (this is TrueNAS's template version, not ours) |
| Image | Repository | `ghcr.io/mrdatawolf/btauthorchestrator` (no `https://`, not the github.com page) |
| Image | Tag | `v0.9.1` (with the `v`) |
| Container | Hostname | Leave empty (it does not affect the public address) |
| Container | Entrypoint / Command | **Leave empty.** The image's entrypoint seeds, checks, then starts the server |
| Container | Timezone | Any; affects only log timestamps |
| Container | Environment Variables | One **Add** per line of your settings file (no bulk paste; copy from your file) |
| Container | Restart Policy | **Unless Stopped** (the default "No" leaves it down after a reboot) |
| Container | Disable Builtin Healthcheck, TTY, Stdin | Unticked |
| Security Context | Custom user | **Ticked**, User ID `568`, Group ID `568`, not privileged |
| Network | Port | Container `3210`, host port of your choice, TCP |
| Network | Host IPs | **Only the TrueNAS static LAN IPv4.** Empty means every address, IPv6 included |
| Storage | Option A | Type **ixVolume**, Mount Path `/data`, **Enable ACL** ticked, entry: User, ID `568`, **Modify**. Name the dataset something recognizable, e.g. `bt-auth-data` |
| Storage | Option B | Type **Host Path**, Mount Path `/data`, Host Path your dataset (e.g. `/mnt/pool1/Data/btauth`), **Enable ACL unticked** (the dataset's own permissions already allow access) |

Save. TrueNAS pulls the image and starts the app.

### 4.3 Watch the first boot

Apps → `bt-auth` → Workloads → logs icon. A good first boot:

1. Seeds the database (stores `CLIENT_SECRET`, creates the signing key and
   the first user).
2. Runs the startup checks.
3. Logs the ingress mode and then
   `BTAuthOrchestrator listening on port 3210`.

The app then shows **Running** and, after the health check's start period,
healthy. If it stops and restarts instead, its log names the problem: see
[Troubleshooting](#8-troubleshooting). Then continue with
[After the first boot](#7-after-the-first-boot).

## 5. Plain Docker on Linux

This uses the same image and the same rules as TrueNAS. **The project has
not validated this setup:** CONTRACT-014 covers only the TrueNAS form, and
the CI tests the image itself, not a compose install. It is the natural
equivalent of the TrueNAS setup; please report problems.

### 5.1 Prepare the data folder

Use a bind mount to a folder owned by UID 568. A named Docker volume does
**not** work out of the box: Docker initializes it from the image's own
root-owned `/data`, so the app cannot write to it.

```sh
sudo mkdir -p /srv/btauth/data
sudo chown 568:568 /srv/btauth/data
sudo chmod 700 /srv/btauth/data
```

Put it on a local filesystem (not NFS/SMB) and do not give it default ACLs
(`setfacl -d ...`), for the same `0700` reason as on TrueNAS.

Save your settings file as `/srv/btauth/btauth.env` and protect it:

```sh
sudo chmod 600 /srv/btauth/btauth.env
```

### 5.2 Run with Docker Compose

`/srv/btauth/compose.yaml`:

```yaml
services:
  btauth:
    image: ghcr.io/mrdatawolf/btauthorchestrator:v0.9.1
    container_name: btauth
    user: "568:568"
    env_file: ./btauth.env
    ports:
      # Publish only on the host's static LAN IPv4.
      - "192.168.1.10:3210:3210"
    volumes:
      - ./data:/data
    restart: unless-stopped
```

No `entrypoint`, `command` or `healthcheck` override: the image provides
them. Then:

```sh
cd /srv/btauth
docker compose up -d
docker compose logs -f
```

### 5.3 Or with `docker run`

```sh
docker run -d --name btauth \
  --user 568:568 \
  --env-file /srv/btauth/btauth.env \
  -p 192.168.1.10:3210:3210 \
  -v /srv/btauth/data:/data \
  --restart unless-stopped \
  ghcr.io/mrdatawolf/btauthorchestrator:v0.9.1
docker logs -f btauth
```

**Client addresses:** in the tunnel setup the app only trusts requests
whose network peer is the connector's IP. With Docker's default port
publishing, LAN clients normally arrive with their real address. If the
log shows proxy-only refusals with `peer=172.x.x.x` (a Docker network
address), the host is hiding client addresses; fix the networking. Never
add the Docker gateway to `TRUSTED_PROXIES`.

## 6. Cloudflare Tunnel

Tunnel setup only. The connector runs on its own LAN machine with a
reserved IPv4; its tunnel token is configured there, never in this app.

1. **First**, in Cloudflare Zero Trust → Access, create a self-hosted
   application for `orca.biztechro.com/admin/*` with an Allow policy for
   your operators. Do this before the route goes live.
2. In the tunnel's public hostname routes, route `orca.biztechro.com` to
   `http://<host-LAN-IPv4>:<host-port>`.
3. Zone → SSL/TLS → Edge Certificates: turn on **Always Use HTTPS**.
4. Leave `/auth/*`, `/.well-known/jwks.json`, `/health`, `/api/*`, `/docs`
   and `/openapi.json` outside Access; client apps and browsers need them.
5. With Entra, the redirect URI is `https://orca.biztechro.com/auth/callback`.

`TRUSTED_PROXIES` in your settings must be the connector machine's IP.
Setting it turns on **proxy-only mode**: requests from any other address,
including your own browser on the LAN going straight to the host's IP and
port, get `403 Forbidden. This service only accepts requests through its
configured proxy.` That is expected; use `https://orca.biztechro.com`. To
also allow direct LAN access, set `PROXY_ONLY=false`; note that direct
`/admin/*` access then bypasses Cloudflare Access, and sign-in does not
stick over plain HTTP while `COOKIE_SECURE=true`.

## 7. After the first boot

1. **Check it:** `https://orca.biztechro.com/health` (tunnel) or
   `http://<lan-address>:<port>/health` (local-only) returns HTTP 200, and you can
   sign in as the initial user.
2. **Remove the first-boot secrets** from the TrueNAS form or `btauth.env`:
   `CLIENT_SECRET` and `INITIAL_LOCAL_USER_PASSWORD` (the username and email
   can go too), then restart. They are stored encrypted in the database;
   while they remain, each start logs a warning naming the variable (never
   its value). Changing them later does **not** change the stored values.
   Keep every-start variables configured.
3. **Back up `DB_ENCRYPTION_KEY`** off the box, separately from database
   backups. Without it, a backup is unreadable.
4. **Delete your settings file**, or keep it only in a password manager.

### Backups

- **Best:** ZFS snapshots of the data dataset (TrueNAS → Data Protection →
  Periodic Snapshot Tasks). They are consistent without stopping the app.
- **File copy:** stop the app first. Copying a running database can give a
  broken copy. Restored files must keep owner `568:568`, and the `pglite`
  folder must be mode `0700`.
- **Uninstalling the app with "remove ix volumes" deletes every key and
  user** (Option A). Snapshot first.

### Upgrades

Change the image tag (for example `v0.9.1` → `v0.9.2`) in the form or
`compose.yaml` and save, or run `docker compose up -d`. Data in `/data` is kept.
Keep the same `DB_ENCRYPTION_KEY`.

### Importing an existing database

The project has not defined or tested this; it should work if:

- the source database's folder is copied to `<data folder>/pglite` while
  both the source install and the app are stopped;
- that folder is then owned by `568:568` with mode `0700`
  (`sudo chown -R 568:568 .../pglite && sudo chmod 700 .../pglite`);
- the container uses the **same `DB_ENCRYPTION_KEY`** as the source;
- the first-boot variables are left out (the database is already seeded).

A native local-login demo seeded with a **generated placeholder**
`CLIENT_SECRET` (CONTRACT-015) cannot start in a container with
`LOCAL_LOGIN=false`. Run `node scripts/seed.js --replace-client-secret` on
the native install before copying.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| TrueNAS: `Version 1.4.7 not found in ix-app app` | TrueNAS's app catalog is stale | Apps → Discover → **Refresh Catalog**, wait for the job, reopen the form |
| `unable to get image 'https://github.com/...': invalid reference format` | Repository is the GitHub page | Repository `ghcr.io/mrdatawolf/btauthorchestrator`, Tag `v0.9.1` |
| `manifest unknown` / `not found` | Tag does not exist | Use a tag listed under the repo's Packages; there is no `latest` |
| `denied` / `unauthorized` on pull | Package is private | GitHub → Packages → btauthorchestrator → Package settings → Change visibility → Public |
| Pull fails with a certificate error | Something on the network intercepts HTTPS (for example firewall TLS inspection; TrueNAS's own update check failing with "self-signed certificate" is a sign) | Exempt the host from TLS inspection, or add the firewall's CA to the host |
| TrueNAS: `Invalid error type: 'path_not_file'` when saving a Host Path with Enable ACL | TrueNAS form bug; the real error is "path does not point to a directory" in `/var/log/middlewared.log` | Prepare the dataset's permissions as in 4.1 Option B and **untick Enable ACL** |
| `Failed 'up' action ... check /var/log/app_lifecycle.log` | Generic; the log has the reason | `sudo tail -n 60 /var/log/app_lifecycle.log` in System → Shell |
| `No storage is mounted at /data` | No `/data` mount | Add the storage entry (4.2) or the bind mount (5.x) |
| `cannot write to /data` | UID 568 lacks write access | Option A: Enable ACL + entry User 568 Modify. Option B / Docker: fix ownership; re-run the `writable` check |
| `/data/pglite has mode 0770 but must be 0700` | Inherited ACL entries on the data folder | Strip the ACL (4.1 Option B step 2), then `sudo rmdir <data>/pglite` if it is empty, or `sudo chmod 700 <data>/pglite`; restart |
| `/data/pglite belongs to UID ...` | The container's user changed, or data was copied with another owner | Set the custom user back to that UID, or `chown -R 568:568` the folder |
| `running as root (UID 0)` | Custom user not ticked | Security Context: tick custom user, 568/568 |
| `Missing seed input(s): ...` | First boot without a required first-boot variable | Add the named variables and restart |
| `PGLITE_DATA_DIR is not /data/pglite` | You set `PGLITE_DATA_DIR` | Remove it |
| Browser gets `403 Forbidden. This service only accepts requests through its configured proxy.` | Proxy-only mode; you went straight to the host's IP | Use the tunnel hostname, or see section 6 for `PROXY_ONLY=false` |
| Sign-in loops / does not stick | `COOKIE_SECURE=true` over plain HTTP | Use the HTTPS hostname; `false` only for local-only |
| `CLIENT_SECRET is a generated placeholder ...` | Imported native demo data in Entra mode | Replace it on the native install first (section 7) |

To see the container's own messages directly:

```sh
sudo docker ps -a --filter name=bt-auth
sudo docker logs --tail 80 <container-id>
```
