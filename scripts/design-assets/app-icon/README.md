# App icon

The iceberg, filled with sand under a glass outline. The canonical icon is the
Icon Composer document `src/assets/icon.icon`; this directory draws its layer
images and renders everything else from it.

```sh
scripts/design-assets/app-icon/render.sh            # layers, master, out/app-icon/
pnpm icons                                          # icns, ico, png, icon-mac.png
pnpm icons:mobile && pnpm icons:mobile:check        # Android layers
```

`render.sh` needs Google Chrome and Icon Composer (it uses the `ictool` inside
it). It writes:

- `src/assets/icon.icon/Assets/` — `sand.png`, `glass-bleed.png`,
  `glass-line.png`: white masks on the 1024-point canvas. `icon.json` gives each
  layer its colour, light and dark, so the dark icon needs no second set.
- `src/assets/icon-master.png` — Icon Composer's macOS rendition, which
  `pnpm icons` turns into the static desktop icons, including the legacy macOS
  `.icns` fallback. macOS packaging separately compiles the layered `.icon`
  into `Assets.car` for system light/dark/clear/tinted appearances; see
  `docs/qa/macos-app-icon.md`.
- `out/app-icon/` — `square.png` (the icon flattened onto an opaque square in
  `icon.json`'s light colours), `favicon-32x32.png` (the macOS rendition) and
  `apple-touch-icon.png` (the square, since iOS rounds the corners itself). The
  last two are the site's `/legal/` icons (Drifting-Showcase `site/legal/`).

`icon.json` is edited by hand or in Icon Composer and is not rewritten here;
rerunning replaces only the layer images. The Android foreground
(`src/assets/icon-android-foreground.svg`) stacks the same three masks, tinted
with the light blue.

What is on the icon, and why:

- **The iceberg** (`iceberg-lines.png`, the original icon's line art) is traced
  with the social preview's skeleton (`../social-preview/sand-letters.js`): its
  silhouette, and the strokes that run well inside it as crevices. It fills
  about 82% of the canvas's height.
- **Sand** fills the whole berg, a third covered at the top and denser with
  depth, evenly with no banding; the crevices are left clear and a few grains
  are thrown off the edge. It is dense enough that the berg and its crevices
  still read at the Dock's 64–128px. Seeds are fixed, so a rerun reproduces
  the same pixels.
- **Glass** is the outline only: a line whose width follows the interface's
  glass texture (`src/assets/design/glass-thick.png`), a narrow bleed inward
  (lifted toward white in the dark icon, like `--glass-bleed-lift`), and the
  sand under the rim drawn in a little, as through thicker glass. Both groups
  have Icon Composer's specular, shadow and translucency off: glass in Drifting
  has no highlight and no shadow.
- **Colours** are the app's tokens: the light and dark `--paper-deep` behind,
  the author blue (`--c-blue`, lighter in the dark icon) for sand and glass,
  written in Display P3.

Tried and set aside: a letter or monogram; a waterline (glass above, sand
below); the glass on the icon's own edge instead of the berg's; a wide bleed,
which read as a bevel; the berg at two thirds of the height, which left the
icon empty; and faint strata in the sand, which the grains hid at full size but
which survived downscaling as contour rings in the Dock, while the sparse sand
they came with left the icon pale.
