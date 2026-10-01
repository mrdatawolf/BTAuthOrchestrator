#!/usr/bin/env bash
# Non-interactive systemd entrypoint. Prepare dependencies/build/seed manually.
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$APP_DIR"

fail() { echo "Startup check failed: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Install Node.js >=20.6.0 on the service user's PATH."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 6) ? 0 : 1)' \
  || fail "Node.js >=20.6.0 is required."
[[ -f .env && -r .env ]] || fail "Create a readable $APP_DIR/.env from .env.example and configure it."
[[ -d node_modules ]] || fail "Dependencies are missing. Run npm ci in $APP_DIR."
[[ -r dist/index.js ]] || fail "Compiled application is missing. Run npm run build in $APP_DIR."

node --env-file=.env scripts/startup-check.js

echo "Startup checks passed; starting BTAuthOrchestrator."
exec node --env-file=.env dist/index.js
