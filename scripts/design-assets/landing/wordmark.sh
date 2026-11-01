#!/bin/zsh
# Write the site's sand wordmark (wordmark.html) as a PNG mask:
#   scripts/design-assets/landing/wordmark.sh [out.png]
# Default out: src/assets/design/sand/wordmark-drifting.png. Serves the
# checkout on 127.0.0.1 so the page can import the sharing card's brush, and
# reads the PNG it leaves in the DOM with headless Chrome (CHROME overrides the
# browser, PORT the port). Needs Times New Roman from the system.
set -e
here=${0:A:h}
root=${here:h:h:h}
out=${1:-$root/src/assets/design/sand/wordmark-drifting.png}
port=${PORT:-8766}
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
profile=$(mktemp -d)
dom=$(mktemp)
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$root" >/dev/null 2>&1 &
server=$!
trap 'kill $server; rm -rf "$profile" "$dom"' EXIT
sleep 0.6
"$chrome" --headless=new --disable-gpu --virtual-time-budget=10000 --user-data-dir="$profile" \
  --dump-dom "http://127.0.0.1:$port/scripts/design-assets/landing/wordmark.html" > "$dom" 2>/dev/null
node -e '
const fs = require("node:fs");
const match = /data:image\/png;base64,([A-Za-z0-9+\/=]+)/.exec(fs.readFileSync(process.argv[1], "utf8"));
if (!match) { console.error("wordmark.sh: the page left no PNG"); process.exit(1); }
fs.writeFileSync(process.argv[2], Buffer.from(match[1], "base64"));
' "$dom" "$out"
echo "$out"
