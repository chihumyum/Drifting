#!/usr/bin/env bash
# Launch a second Electron instance against the running `pnpm dev` dev server,
# pointing to a different userData dir so it has independent localStorage
# (deviceId), sqlite, and auth cookie.
#
# Usage:
#   # Terminal 1
#   pnpm dev
#
#   # Terminal 2 (after the first electron window is up)
#   ./scripts/launch-peer.sh
#
# Optional env:
#   PEER_USERDATA   Where to put the peer's profile.
#                   Default: /tmp/drifting-peer
#   PEER_DB_DIR     Where to put the peer's sqlite. Default: $PEER_USERDATA/databases
#                   (auto-derived; only override if you want to share/decouple it)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PEER_USERDATA="${PEER_USERDATA:-/tmp/drifting-peer}"
PEER_DB_DIR_DEFAULT="$PEER_USERDATA/databases"
PEER_DB_DIR="${PEER_DB_DIR:-$PEER_DB_DIR_DEFAULT}"

mkdir -p "$PEER_USERDATA" "$PEER_DB_DIR"

if [ ! -f .vite/build/main.js ]; then
  echo "ERROR: .vite/build/main.js not found."
  echo "Run 'pnpm dev' in another terminal first, wait for the dev server"
  echo "and the first Electron window to come up, then re-run this script."
  exit 1
fi

# Explicitly override DRIFTING_DB_DIR so .env.local doesn't drag the peer
# into the same sqlite directory as the main instance. Also clear API_BASE_URL
# in case it points at something we don't want — but we DO want both peers to
# hit the same backend, so leave VITE_API_BASE_URL alone.
export DRIFTING_DB_DIR="$PEER_DB_DIR"

# The single-instance lock is scoped to userData dir, so passing
# --user-data-dir to a different path lets a second Electron start alongside.
ELECTRON_BIN="./node_modules/.bin/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "ERROR: electron not found at $ELECTRON_BIN"
  exit 1
fi

echo "Launching peer Electron"
echo "  userData : $PEER_USERDATA"
echo "  sqlite   : $PEER_DB_DIR"
echo "  (Ctrl+C here to quit the peer; main instance keeps running)"
echo ""

exec "$ELECTRON_BIN" .vite/build/main.js --user-data-dir="$PEER_USERDATA"
