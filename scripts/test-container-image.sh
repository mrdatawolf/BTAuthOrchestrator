#!/usr/bin/env bash
# Usage: bash scripts/test-container-image.sh IMAGE
# Requires Bash, Docker (local Linux engine or Docker Desktop), Python 3, curl.
# No repository .env is read. Never enable xtrace or print captured output.
set +x
set -euo pipefail
image=${1:?Supply the built image reference}
for tool in docker python3 curl; do command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }; done
scratch=$(mktemp -d)
containers=()
cleanup() {
  for container in "${containers[@]}"; do docker rm -f "$container" >/dev/null 2>&1 || true; done
  # Test-only root helper removes files owned by container UIDs on Linux hosts.
  docker run --rm --user 0:0 --entrypoint sh -v "$scratch:/scratch" "$image" -c 'rm -rf /scratch/*' >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'echo "FAIL: container check at line $LINENO (captured output withheld)" >&2' ERR
pass() { echo "PASS: $*"; }
# Generated fake values cannot already occur in the scripts copied into the image.
python3 - "$scratch" <<'PY'
import pathlib, secrets, sys
p = pathlib.Path(sys.argv[1])
values = dict(DB_ENCRYPTION_KEY=secrets.token_hex(32),
 EMERGENCY_ROTATION_TOKEN='FAKE-CI-rotation-'+secrets.token_hex(20),
 LOCAL_USER_ADMIN_TOKEN='FAKE-CI-admin-'+secrets.token_hex(20),
 CLIENT_SECRET='FAKE-CI-client-'+secrets.token_hex(20),
 INITIAL_LOCAL_USER_PASSWORD='FAKE-CI-password-'+secrets.token_hex(20))
(p/'secret-values').write_text('\n'.join(values.values())+'\n')
values.update(LOCAL_LOGIN='true', COOKIE_SECURE='true',
 SERVICE_ISSUER='https://orca.biztechro.com', TRUSTED_PROXIES='192.0.2.40',
 INITIAL_LOCAL_USER_USERNAME='ci.user', INITIAL_LOCAL_USER_EMAIL='ci@example.test')
(p/'inputs').write_text(''.join(f'{k}={v}\n' for k,v in values.items()))
PY
chmod 600 "$scratch/inputs" "$scratch/secret-values"
no_secrets() {
  python3 - "$scratch/secret-values" "$1" <<'PY'
import pathlib, sys
values = pathlib.Path(sys.argv[1]).read_bytes().splitlines()
assert not any(v in pathlib.Path(sys.argv[2]).read_bytes() for v in values), 'Secret leakage detected (value withheld)'
PY
}
logs() { docker logs "$1" > "$scratch/log" 2>&1; no_secrets "$scratch/log"; }
contains() { grep -Eq "$1" "$scratch/log"; }
new_container() {
  current="bt-ci-$(basename "$scratch")-${#containers[@]}"
  containers+=("$current")
  docker create --name "$current" --env-file "$scratch/inputs" "$@" "$image" > /dev/null
}
helper() { docker run --rm --user 0:0 --entrypoint sh -v "$scratch:/scratch" "$image" -c "$1" > "$scratch/helper-log" 2>&1; }
healthy() {
  local status
  for ((attempt=0; attempt<120; attempt++)); do
    status=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1")
    [[ $status != exited* ]] || { logs "$1"; return 1; }
    if [[ $status == 'running healthy' ]]; then logs "$1"; return; fi
    sleep 1
  done
  return 1
}
stop_clean() {
  docker stop --time 10 "$1" >/dev/null
  [[ $(docker inspect -f '{{.State.ExitCode}}' "$1") == 0 ]]
  logs "$1"
  helper 'test ! -e /scratch/data/pglite/.btauthorchestrator.lock'
}
fail_closed() {
  local pattern=$1; shift
  new_container "$@"
  docker start "$current" >/dev/null
  for ((attempt=0; attempt<30; attempt++)); do
    [[ $(docker inspect -f '{{.State.Running}}' "$current") == true ]] || break
    sleep 1
  done
  [[ $(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$current") == exited:1 ]]
  logs "$current"
  contains "$pattern"
  if contains 'Listening on'; then return 1; fi
}
[[ $(docker image inspect -f '{{.Config.User}}' "$image") == 568:568 ]]
[[ $(docker run --rm --entrypoint sh "$image" -c 'id -u; id -g') == $'568\n568' ]]
docker history --no-trunc "$image" > "$scratch/history"
no_secrets "$scratch/history"
# COPY scripts/ is expected; .env and repository data must never be copied.
if grep -Eq 'COPY .*([.]env|data/)' "$scratch/history"; then exit 1; fi
new_container --entrypoint sh
pristine=$current
docker export "$pristine" > "$scratch/image.tar"
python3 - "$scratch" <<'PY'
import pathlib, sys, tarfile
p = pathlib.Path(sys.argv[1]); values = (p/'secret-values').read_bytes().splitlines()
with tarfile.open(p/'image.tar') as archive:
 for item in archive:
  name = item.name.removeprefix('./').rstrip('/')
  parts = pathlib.PurePosixPath(name).parts
  assert not any(x == '.env' or x.startswith('.env.') for x in parts), 'Environment file baked into image'
  assert not (name == 'app/data' or name.startswith(('app/data/', 'data/'))), 'Data baked into image'
  if item.isfile():
   stream = archive.extractfile(item); tail = b''
   while chunk := stream.read(1024*1024):
    chunk = tail + chunk
    assert not any(v in chunk for v in values), 'Secret baked into image (value withheld)'
    tail = chunk[-256:]
PY
pass 'image identity, history and filesystem isolation'
helper 'mkdir /scratch/data; chown 568:568 /scratch/data; chmod 750 /scratch/data'
new_container -v "$scratch/data:/data" -p 127.0.0.1::3210
main=$current
docker start "$main" >/dev/null
healthy "$main"
contains 'CLIENT_SECRET stored'
contains 'Signing key'
contains 'Local user ci.user created'
contains 'Ingress mode: proxy-only'
docker exec "$main" node scripts/container-healthcheck.js > "$scratch/health" 2>&1
helper 'test "$(ls -A /scratch/data)" = pglite; test "$(stat -c %a:%u:%g /scratch/data/pglite)" = 700:568:568; test "$(stat -c %a:%u:%g /scratch/data)" = 750:568:568'
pass 'first boot, data layout and Docker HEALTHCHECK with proxy-only on'
stop_clean "$main"
# Only open the database while the server is stopped. Hash every public table,
# sorting rows to avoid ordering artifacts; no key, hash, password or row is logged.
snapshot() {
  docker run --rm -i --env-file "$scratch/inputs" -v "$scratch/data:/data" --entrypoint node "$image" > "$scratch/snapshot" 2> "$scratch/snapshot-errors" <<'JS'
const {openDatabase} = require('./dist/database.js');
const {createHash} = require('node:crypto');
(async () => {
 const h = await openDatabase('/data/pglite');
 try {
  const tables = (await h.database.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const all = {};
  for (const {tablename} of tables) all[tablename] = (await h.database.query('SELECT * FROM "'+tablename.replaceAll('"','""')+'"')).rows.map(r => JSON.stringify(r)).sort();
  for (const t of ['secrets','signing_keys','local_users']) if (all[t].length !== 1) throw Error('Seed row count');
  console.log(createHash('sha256').update(JSON.stringify(all)).digest('hex'));
 } finally { await h.close(); }
})().catch(() => { console.error('Snapshot failed (details withheld)'); process.exitCode=1; });
JS
  no_secrets "$scratch/snapshot"
}
snapshot
cp "$scratch/snapshot" "$scratch/before"
# Direct invocation makes the no-op seed's exit code observable.
docker run --rm --env-file "$scratch/inputs" -v "$scratch/data:/data" --entrypoint node "$image" scripts/seed.js --non-interactive > "$scratch/log" 2>&1
no_secrets "$scratch/log"
contains 'Database already seeded'
for variable in CLIENT_SECRET INITIAL_LOCAL_USER_USERNAME INITIAL_LOCAL_USER_EMAIL INITIAL_LOCAL_USER_PASSWORD; do contains "$variable ignored"; done
# Ignored username/email are inputs too, although not credentials.
if grep -Eq 'ci[.]user|ci@example[.]test' "$scratch/log"; then exit 1; fi
snapshot
cmp -s "$scratch/before" "$scratch/snapshot"
docker start "$main" >/dev/null
healthy "$main"
contains 'Database already seeded'
for variable in CLIENT_SECRET INITIAL_LOCAL_USER_USERNAME INITIAL_LOCAL_USER_EMAIL INITIAL_LOCAL_USER_PASSWORD; do contains "$variable ignored"; done
stop_clean "$main"
snapshot
cmp -s "$scratch/before" "$scratch/snapshot"
pass 'seed exit 0, ignored-input warnings and unchanged rows after restart'
docker rm "$main" >/dev/null
new_container -v "$scratch/data:/data" -p 127.0.0.1::3210
main=$current
docker start "$main" >/dev/null
healthy "$main"
stop_clean "$main"
snapshot
cmp -s "$scratch/before" "$scratch/snapshot"
pass 'data survives removal and recreation'
docker start "$main" >/dev/null
healthy "$main"
fail_closed 'Single-process error:.*still running' -v "$scratch/data:/data"
healthy "$main"
docker kill "$main" >/dev/null
docker start "$main" >/dev/null
healthy "$main"
contains 'Recovered stale lock'
stop_clean "$main"
snapshot
cmp -s "$scratch/before" "$scratch/snapshot"
pass 'second container refused, SIGKILL stale-lock recovery, clean stop and unchanged rows'
fail_closed 'No storage is mounted.*Storage.*Mount Path /data'
helper 'mkdir /scratch/unwritable; chown 0:0 /scratch/unwritable; chmod 555 /scratch/unwritable'
fail_closed 'UID 568, GID 568.*cannot write.*Storage.*Enable ACL.*Modify' -v "$scratch/unwritable:/data"
helper 'mkdir -p /scratch/wrong-owner/pglite; chmod 777 /scratch/wrong-owner; chown 1234:1234 /scratch/wrong-owner/pglite; chmod 700 /scratch/wrong-owner/pglite'
fail_closed 'belongs to UID 1234.*Security Context.*User ID back to 1234' -v "$scratch/wrong-owner:/data"
helper 'chmod 755 /scratch/data/pglite'
fail_closed 'mode 0755.*0700.*TrueNAS Shell.*chmod 700' -v "$scratch/data:/data"
helper 'test "$(stat -c %a /scratch/data/pglite)" = 755; chmod 700 /scratch/data/pglite'
fail_closed 'root \(UID 0\).*Security Context.*User ID and Group ID to 568' --user 0:0 -v "$scratch/data:/data"
for path in /elsewhere /data; do
  fail_closed 'Remove the PGLITE_DATA_DIR environment variable.*Environment Variables' -e "PGLITE_DATA_DIR=$path" -v "$scratch/data:/data"
done
pass 'all required fail-closed cases and contract fix messages'
new_container -v "$scratch/data:/data" -p 127.0.0.1::3210 -e TRUSTED_PROXIES= -e SERVICE_ISSUER=http://localhost:3210 -e COOKIE_SECURE=false
main=$current
docker start "$main" >/dev/null
healthy "$main"
contains 'Ingress mode: local-only'
address=$(docker port "$main" 3210/tcp)
curl --fail --silent --show-error --max-time 10 "http://$address/auth/local-login" > "$scratch/sign-in"
grep -q '<form' "$scratch/sign-in"
no_secrets "$scratch/sign-in"
stop_clean "$main"
pass 'local-only HTTP sign-in with empty TRUSTED_PROXIES and insecure cookie profile'
echo 'All container image checks passed.'
