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

# Override DRIFTING_DB_DIR. We explicitly UNSET first so any value from
# parent shell / .env / global rc files can't sneak through. Then set fresh.
unset DRIFTING_DB_DIR
export DRIFTING_DB_DIR="$PEER_DB_DIR"

ELECTRON_BIN="./node_modules/.bin/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "ERROR: electron not found at $ELECTRON_BIN"
  exit 1
fi

echo "Launching peer Electron"
echo "  userData         : $PEER_USERDATA"
echo "  DRIFTING_DB_DIR  : $DRIFTING_DB_DIR"
echo "  electron binary  : $ELECTRON_BIN"
echo "  (Ctrl+C here to quit the peer; main instance keeps running)"
echo ""

# `env -i` would nuke too much. Instead leave parent env mostly intact but
# pass DRIFTING_DB_DIR explicitly via `env`. The exec inherits the export
# anyway; this is belt-and-suspenders.
exec env DRIFTING_DB_DIR="$PEER_DB_DIR" "$ELECTRON_BIN" .vite/build/main.js --user-data-dir="$PEER_USERDATA"
