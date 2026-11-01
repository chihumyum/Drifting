#!/bin/zsh
# Draw the app icon and render what is made from it:
#   scripts/design-assets/app-icon/render.sh [out-dir]
# Writes the Icon Composer layers (src/assets/icon.icon/Assets), the master
# that `pnpm icons` reads (src/assets/icon-master.png, Icon Composer's macOS
# rendition), and in out-dir (out/app-icon by default) the flattened
# square.png and the site's favicon-32x32.png and apple-touch-icon.png. Then
# run `pnpm icons` and `pnpm icons:mobile`.
# Serves the checkout on 127.0.0.1 so the page can read the line art and the
# glass texture; CHROME, ICTOOL and PORT override the tools and the port.
set -e
here=${0:A:h}
root=${here:h:h:h}
out=${1:-$root/out/app-icon}
port=${PORT:-8766}
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
ictool=${ICTOOL:-"/Applications/Icon Composer.app/Contents/Executables/ictool"}
icon=$root/src/assets/icon.icon
mkdir -p "$out"
profile=$(mktemp -d)
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$root" >/dev/null 2>&1 &
server=$!
trap 'kill $server; rm -rf "$profile"' EXIT
sleep 0.6
"$chrome" --headless=new --disable-gpu --virtual-time-budget=120000 --user-data-dir="$profile" \
  --dump-dom "http://127.0.0.1:$port/scripts/design-assets/app-icon/layers.html" 2>/dev/null > "$out/layers.html"
node "$here/write-layers.mjs" "$out/layers.html" "$icon/Assets" "$out"

render() { "$ictool" "$icon" --export-image --output-file "$1" --platform macOS --rendition Default --width "$2" --height "$2" --scale 1 >/dev/null; echo "$1"; }
render "$root/src/assets/icon-master.png" 1024
render "$out/favicon-32x32.png" 32
# A touch icon has its corners rounded by iOS: it is the opaque square.
sips -z 180 180 "$out/square.png" --out "$out/apple-touch-icon.png" >/dev/null
echo "$out/apple-touch-icon.png"
