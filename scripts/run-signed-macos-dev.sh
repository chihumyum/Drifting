#!/bin/sh

set -eu

DEV_CODE_IDENTIFIER=${DRIFTING_MACOS_DEV_CODE_IDENTIFIER:-cc.drifting.client.dev}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IDENTITY_SELECTOR="$SCRIPT_DIR/select-macos-dev-signing-identity.mjs"

resolve_signing_identity() {
  node "$IDENTITY_SELECTOR"
}

require_signing_identity() {
  identity=$(resolve_signing_identity)
  if [ -z "$identity" ]; then
    echo "No usable Apple Development code-signing identity was found." >&2
    echo "Install one with Xcode, or set DRIFTING_MACOS_DEV_SIGNING_IDENTITY." >&2
    exit 1
  fi
  printf '%s\n' "$identity"
}

if [ "${1:-}" = "--check" ]; then
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "macOS dev signing check skipped on $(uname -s)."
    exit 0
  fi
  identity=$(require_signing_identity)
  echo "macOS dev signing identity is available: $identity"
  exit 0
fi

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <executable> [arguments...]" >&2
  exit 2
fi

binary=$1
shift

if [ "$(uname -s)" != "Darwin" ]; then
  exec "$binary" "$@"
fi

if [ ! -f "$binary" ] || [ ! -x "$binary" ]; then
  echo "Cargo runner received a missing or non-executable binary: $binary" >&2
  exit 1
fi

identity=$(require_signing_identity)
codesign \
  --force \
  --sign "$identity" \
  --identifier "$DEV_CODE_IDENTIFIER" \
  --timestamp=none \
  "$binary"
codesign --verify --strict "$binary"

exec "$binary" "$@"
