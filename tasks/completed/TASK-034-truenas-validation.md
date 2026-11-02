# TASK-034: TrueNAS validation (pre-check and go-live checks)

Owner role: Human (Patrick), with documentation drafted by the TASK-025
implementer
Assigned agent: Patrick Moon
Proposed by: Claude (TASK-031 follow-up)
Proposed date: 2026-10-29
Approved by: Patrick
Approved date: 2026-10-29
Related contracts: CONTRACT-013, CONTRACT-014
Related ADRs: ADR-001
Dependencies: Phase 0 has none and should run first. Phase 1 needs TASK-025,
TASK-032 and TASK-033 complete and `v0.9.0` published.

## Desired outcome

Evidence from Patrick's own TrueNAS SCALE 25.10.0.1 (or newer) that the
approved design works there:

- **Phase 0 (before any implementation):** the two TrueNAS behaviors the
  contracts rely on but only know from reading source.
- **Phase 1 (go-live):** every TrueNAS check in CONTRACT-013 and
  CONTRACT-014's Validation requirements, using the real image and tunnel.

## Context

CONTRACT-014 resolved question 2 and CONTRACT-013 §4 make two assumptions
that were never tested on Patrick's box. If either is wrong, TASK-025 or
TASK-032 would be built on a broken premise, so they are checked first with
a throwaway app that needs no project image:

1. A folder the app creates inside an ix volume with Enable ACL (User 568,
   Modify) reports mode `0700` and owner `568`. CONTRACT-008 §5's check
   fails every first boot otherwise.
2. A request from another LAN host to a published port reaches the container
   with that host's real IP, not the Docker gateway. Proxy-only mode refuses
   every tunnel request otherwise.

## Scope

### Included

- Phase 0 pre-check, below.
- Phase 1 go-live checks, below.
- Recording results in this file.

### Excluded

- Any code or contract change. A Phase 0 failure is reported to Patrick and
  goes back to contract (CONTRACT-014 resolved question 2, CONTRACT-013 §4).

## Plan

### Phase 0: pre-check with a throwaway app (about 10 minutes)

Form labels below are from TrueNAS 25.10's Custom App form and may differ
slightly between point releases.

**0.1 Host facts.** In System → Shell on TrueNAS, run and paste the output
under Implementation handoff:

```sh
sudo docker version --format '{{.Server.Version}}'
sudo cat /etc/docker/daemon.json
```

**0.2 Create the app.** Apps → Discover Apps → Custom App:

| Section | Field | Value |
|---|---|---|
| Application Name | Name | `orca-precheck` |
| Image | Repository / Tag | `python` / `3.12-alpine` |
| Container | Command | three entries: `sh`, `-c`, and the script below |
| Security Context | Run as custom user | on; User ID `568`, Group ID `568`; Privileged off |
| Network | Host Network | off |
| Network | Ports | Container port `3210`, Published/Host port `3210`, Protocol TCP, Host IPs = TrueNAS's static LAN IPv4 only |
| Storage | Type / Mount Path | ix Volume / `/data` |
| Storage | Enable ACL | on; one entry: ID Type User, ID `568`, Access Modify |

Script (the third Command entry, as one line):

```sh
id; ls -ld /data; mkdir -p -m 700 /data/pglite-test; stat -c 'PRECHECK MODE=%a OWNER=%u:%g' /data/pglite-test; touch /data/pglite-test/probe && echo PRECHECK WRITE_OK; exec python3 -u -m http.server 3210 --bind 0.0.0.0
```

Install, wait until it shows Running, then open its Logs.

**0.3 Check A: folder mode and owner.** In the app logs:

- `uid=568 gid=568` from `id`.
- `PRECHECK MODE=700 OWNER=568:568`.
- `PRECHECK WRITE_OK`.

Optional, in the TrueNAS Shell (the volume path includes the app name):

```sh
sudo ls -ld /mnt/.ix-apps/app_mounts/orca-precheck/*/ /mnt/.ix-apps/app_mounts/orca-precheck/*/pglite-test
```

**0.4 Check B: real client address.**

1. From the **cloudflared machine**: `curl -s -o /dev/null http://<truenas-ip>:3210/`
2. From **another LAN machine** (a laptop): the same command, or open the
   URL in a browser.
3. From the **TrueNAS Shell** itself: the same command.

Each request adds a log line starting with the client address, for example
`192.168.1.40 - - [...] "GET / HTTP/1.1" 200 -`. Expected:

- request 1 shows the cloudflared machine's LAN IP;
- request 2 shows the laptop's LAN IP;
- request 3 probably shows a Docker gateway address such as `172.16.0.1`.
  This is fine and expected; just record it (CONTRACT-013 §4 says the
  gateway is never trusted).

**0.5 Check C: IPv4-only publish.** In the TrueNAS Shell:

```sh
sudo ss -ltnp | grep 3210
```

Expected: listeners only on `<truenas-ip>:3210`, nothing on `0.0.0.0`,
`[::]` or `*`.

**0.6 Check D: persistence across recreation.** Edit the app, add any
environment variable (for example `PRECHECK=2`), save. After it restarts the
logs show the same `MODE=700` line, and
`/data/pglite-test/probe` still exists (the `mkdir -p` does not recreate it;
check with the optional `ls` above, adding `/probe`).

**0.7 Clean up.** Delete `orca-precheck`, ticking "remove ix volumes".

**Results.** Record pass/fail for A–D plus the outputs from 0.1 under
Implementation handoff.

- **A fails** (mode not `700`, owner not `568`, or write refused): stop.
  TASK-025 stays blocked; CONTRACT-014 needs a superseding change.
- **B fails** (requests 1 or 2 show a `172.x` address): stop. TASK-032
  stays blocked; CONTRACT-013 §4 says the tunnel profile is not deployable
  as specified.
- **C or D fails:** report; Patrick decides.

### Phase 1: go-live checks (after `v0.9.0` is published)

Install Orca through the Custom App form using CONTRACT-014 §7.2's tables,
following TASK-025's documentation. Then:

- [ ] Form-only install: no dataset creation, chmod, chown, shell or repo
      checkout made the install work. First boot seeds and the app shows
      healthy.
- [ ] Without Enable ACL on `/data`, the app fails with the ACL message;
      enabling it (User 568, Modify) and saving fixes it.
- [ ] `/data/pglite` is `0700`, owned by `568`. `/data` keeps TrueNAS's
      owner, mode and ACL.
- [ ] Startup log shows the expected ingress mode line.
- [ ] Port published on the TrueNAS static LAN IPv4 only.
- [ ] Cloudflare Access is required for `/admin/console`, not for
      `/auth/local-login` or `/.well-known/jwks.json`.
- [ ] Through the tunnel, two clients' sign-ins record their own public
      addresses.
- [ ] A client-supplied `CF-Connecting-IP` through the tunnel does not
      change the recorded address.
- [ ] With proxy-only on, a direct LAN request gets the `403` text and the
      refusal is logged.
- [ ] Healthcheck stays healthy with proxy-only on.
- [ ] After changing the image tag (or re-pulling it), the same users sign
      in, JWKS shows the same `kid`, and the seed step reports "already
      seeded".
- [ ] A local-only demo install (empty `TRUSTED_PROXIES`, `http://` issuer,
      `COOKIE_SECURE=false`, `LOCAL_LOGIN=true`) serves sign-in from a LAN
      browser and records the browser's LAN address.

## Acceptance criteria

- [ ] Phase 0 checks A and B pass, with outputs recorded.
- [ ] Every Phase 1 check passes, with notes recorded.

## Validation requirements

Recorded outputs and notes in this file. Screenshots are optional.

## Risks and assumptions

- Phase 0 uses a stock Python image, not Orca. It tests the TrueNAS and
  Docker behavior, not Orca's own checks; Phase 1 covers those.
- Uninstalling with "remove ix volumes" deletes the data. Phase 0 data is
  disposable; for Phase 1, snapshot before experiments.

## Blocker

None.

## Implementation handoff

### Phase 0 results (Patrick, 2026-10-29)

**0.1 Host facts.** The `admin` user needs `sudo` for `docker`.

- Docker server version: `28.3.1`.
- `/etc/docker/daemon.json`:

  ```json
  {"data-root": "/mnt/.ix-apps/docker", "exec-opts": ["native.cgroupdriver=cgroupfs"], "iptables": true, "ipv6": true, "default-network-opts": {"bridge": {"com.docker.network.enable_ipv6": "true"}}, "storage-driver": "overlay2", "fixed-cidr-v6": "fdd0::/64", "default-address-pools": [{"base": "172.17.0.0/12", "size": 24}, {"base": "fdd0::/48", "size": 64}], "registry-mirrors": [], "insecure-registries": []}
  ```

- Reading: `iptables: true` and no `userland-proxy` key (Docker's default
  applies), as the contracts assumed. Remote traffic to a published port
  goes through iptables DNAT and should keep its source IP; check B
  confirms. App networks get IPv6 by default (`enable_ipv6`), so publishing
  only on the TrueNAS IPv4 address (CONTRACT-013 §1) still matters; check C
  confirms. Container gateways come from `172.16.0.0/12`, so a Docker
  gateway address in check B looks like `172.16.x.1` to `172.31.x.1`.

**0.2 Create the app.** The first attempt ran as root with no storage at
`/data` (`uid=0`, `ls: /data: No such file or directory`, and `mkdir -p`
quietly created `/data` in the container's writable layer). Fixed by
ticking the custom-user setting in Security Context (568/568) and adding
the ix volume at `/data` with Enable ACL (User 568, Modify). Note for the
TASK-025 docs: both settings are easy to miss, which is why CONTRACT-014's
root refusal and missing-mount check matter.

**0.3 Check A: PASS.** Second run's logs:

```
uid=568 gid=568 groups=568
drwxrwxr-x    2 root     root             2 Oct 29 11:18 /data
PRECHECK MODE=700 OWNER=568:568
PRECHECK WRITE_OK
Serving HTTP on 0.0.0.0 port 3210 (http://0.0.0.0:3210/) ...
```

The ix volume root is `root:root`, mode `775`, and writable by 568 through
the ACL. The app-created folder reports exactly `700`, owner `568:568`, so
inherited ACLs do not disturb CONTRACT-008 §5's check. TASK-025's Phase 0
blocker is cleared.

**0.4 Check B: PASS.**

```
192.168.203.180 - - [29/Oct/2026 11:20:35] "GET / HTTP/1.1" 200 -   (TrueNAS Shell)
192.168.203.117 - - [29/Oct/2026 11:20:46] "GET / HTTP/1.1" 200 -   (LAN computer)
192.168.203.101 - - [29/Oct/2026 11:22:24] "GET / HTTP/1.1" 200 -   (cloudflared machine)
```

Requests from other hosts arrive with their real LAN addresses, so
`TRUSTED_PROXIES=192.168.203.101` works. A request from TrueNAS itself to
its own LAN IP shows TrueNAS's address (`192.168.203.180`), not a Docker
gateway as predicted. CONTRACT-013 §4 already forbids trusting the TrueNAS
host's own addresses, so this needs no contract change. TASK-032's Phase 0
blocker is cleared.

**0.5 Check C: PASS after a fix.** With Host IPs left empty, the port was
published on every address:

```
LISTEN 0 4096   0.0.0.0:3210  0.0.0.0:*  users:(("docker-proxy",...))
LISTEN 0 4096      [::]:3210     [::]:*  users:(("docker-proxy",...))
```

After setting Host IPs to `192.168.203.180` only, Patrick reports a single
listener on that address. An empty Host IPs field means "all addresses,
IPv4 and IPv6". The TASK-025 docs must call this out (CONTRACT-013 §1).
TrueNAS offered `192.168.203.180` in the list, which confirms its address
is configured as static.

**0.6 Check D: PASS.** The Host IPs edit recreated the container. Logs:

```
uid=568 gid=568 groups=568
drwxrwxr-x    3 root     root             3 Oct 29 11:18 /data
PRECHECK MODE=700 OWNER=568:568
PRECHECK WRITE_OK
192.168.203.101 - - [29/Oct/2026 11:29:28] "GET / HTTP/1.1" 200 -
192.168.203.117 - - [29/Oct/2026 11:29:38] "GET / HTTP/1.1" 200 -
192.168.203.180 - - [29/Oct/2026 11:29:46] "GET / HTTP/1.1" 200 -
```

`ls -ld /data` runs before `mkdir`, and it now shows link count 3 (it was
2 on the first run). So `pglite-test` was already there and survived the
recreation. Check B gives the same result after the Host IPs change.

**0.7 Clean up:** pending (delete `orca-precheck` with "remove ix volumes").

**Phase 0 result:** A, B, C and D pass. Neither contract needs to change.
For the docs: tick the custom-user setting, add the ix volume at `/data`
with Enable ACL, and set Host IPs to the TrueNAS IPv4 only. Leaving any of
these unset is easy to miss.

## Review

Not applicable (human-owned validation task).
