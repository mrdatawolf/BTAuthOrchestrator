#!/bin/sh
set -eu
# Explicit image profile; do not read a host .env or invoke start.sh.
export BT_CONTAINER_MODE=1
node scripts/seed.js --non-interactive
node scripts/startup-check.js
# Node receives Docker's SIGTERM directly.
exec node dist/index.js
