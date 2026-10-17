# Element overview and Summary

The element title and aliases stay on the left, with only 12 px between the
aliases and the full-width Summary. Summary uses ChapterEditor's `page__sub`
class: the selected content font, editor font size minus 2 px and 1.5 line
height. The shared textarea autosizing hook handles wrapping and shrinking.

Portraits are decorative backgrounds anchored to the overview's upper-right
region, extending above the title. They use absolute positioning within the
overview, scroll with the document and contribute no layout height. The image
never intercepts pointer events. The image area keeps a fixed 4:5 aspect ratio:
its width is 32% of the content column, clamped to 160–280 px, and its height
scales proportionally. The image fills that area with `object-fit: cover` and
`object-position: center 25%`, preserving the same source crop at every width.
A page-colour wash (white in the light theme)
runs only from bottom to top: fully opaque at the bottom and transparent at
the top, protecting Summary text. There is no horizontal gradient or side mask. Adding or removing an image does not move
the title, aliases or Summary.

An element without an image shows a muted 16 px Lucide `ImagePlus` icon to
the right of the title, with no visible label or coloured placeholder. Its
accessible name and tooltip identify the add-image action. With an image, the
preview/replace/remove controls stay hidden until the overview is hovered or
the controls receive keyboard focus. Active import progress stays visible. Loading and
inline failures remain visible. These controls use the existing local asset
import/removal and fullscreen preview paths. Summary save, Escape and Agent
field-review callbacks remain intact.

The left TOC retains **概述** (`el-overview`), covering the header and Summary.

## Acceptance

```bash
pnpm exec node scripts/run-element-summary-acceptance.mjs
pnpm exec node scripts/run-element-summary-acceptance.mjs --check
```

`acceptance/element-summary.json` records source hashes and 12 Chromium samples:
780/380 px widths, editor font sizes 12/17.5/28 px, with and without an image.
The probe renders extracted production overview/chapter Summary JSX, real CSS
and the shared autosizing hook with synthetic text, images, state and callbacks.
It verifies compact spacing, unchanged image/no-image geometry, background
pointer transparency, icon-only add, hidden idle image controls, real-pointer
hover and keyboard-focus reveal, matching chapter typography,
unclipped text, edit shrinking and the blur callback. It exercises add,
preview, replace, remove, busy/loading/error states and measures screenshot
pixels to confirm the white wash is stronger at the bottom and equal across
the left, centre and right at the same height (within 2/255 raster rounding). TOC wiring is
checked from source.

Three additional content widths (380/600/1000 px) cover the minimum, flexible
and maximum image sizes. Measured geometry and image fit/position derive a
normalized source window; its bounds must stay equal across all three sizes.

Local previews are `.qa/element-summary-empty.png` and
`.qa/element-summary-image.png`; `.qa/element-summary-image-hover.png` shows
the revealed controls. This isolated renderer evidence does not
establish full Tauri/WebView, native file-picker, database persistence, account
or native IME acceptance.
