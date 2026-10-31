#!/bin/zsh
# Render the repository's sharing card in all four variants at 2560×1280:
#   scripts/design-assets/social-preview/render.sh [out-dir]
# Serves the checkout on 127.0.0.1 so the page can read the glass texture and
# the Newsreader files in node_modules, and captures it with headless Chrome
# (CHROME overrides the browser, PORT the port).
set -e
here=${0:A:h}
root=${here:h:h:h}
out=${1:-$root/out/social-preview}
port=${PORT:-8765}
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
mkdir -p "$out"
profile=$(mktemp -d)
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$root" >/dev/null 2>&1 &
server=$!
trap 'kill $server; rm -rf "$profile"' EXIT
sleep 0.6
for theme in dark light; do
  for frame in 0 1; do
    name=$theme
    [[ $frame == 1 ]] && name=$theme-frame
    "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
      --window-size=1280,640 --virtual-time-budget=10000 --user-data-dir="$profile" \
      --screenshot="$out/$name.png" \
      "http://127.0.0.1:$port/scripts/design-assets/social-preview/preview.html?theme=$theme&frame=$frame" >/dev/null 2>&1
    echo "$out/$name.png"
  done
done
