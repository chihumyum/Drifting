# Mobile prose wrapping — 2026-09-05

The apparent empty right column came from the shared manuscript's
`text-wrap: pretty`, not a rail occupying layout width. In the freshly built
iPhone 17 Pro Simulator app (iOS 26.5), the chapter's prose box was 352px wide
with equal 24px page padding. A measured paragraph nevertheless used only
about 269–281px on each of its three lines. Normal wrapping used 341–349px on
the full lines and left the natural short final line.

Only `.m-workspace .page__body .ProseMirror` overrides wrapping to `wrap`.
The shared desktop rule, page positioning, paragraph alignment and author
content remain unchanged. Both live prose and read-only chapter projections
use this same mobile selector.

## Acceptance

- The Simulator chapter was visually inspected before and after the CSS
  change. The final computed style was checked after removing the temporary
  diagnostic inline override.
- Toggling the in-paper outline and sticky notes through the `synthetic-dom`
  frontend bridge left the prose at x=25px and width=352px in all checked
  states. Both toggles were restored afterward.
- [`mobile-prose-wrapping-2026-09-05.json`](mobile-prose-wrapping-2026-09-05.json)
  contains generated WKWebView measurements for a synthetic paragraph using
  the loaded application CSS. Offscreen fixtures at 375/402/430px retain equal
  24px gutters and normal wrapping; a 1000px fixture outside `.m-workspace`
  retains desktop `pretty` wrapping and its centered 720px paper.
- The fixture probe measured line fragments with `Range.getClientRects()` and
  asserted symmetric mobile gutters, `wrap` on mobile, `pretty` on desktop,
  and at most 34px unused width on each full mobile line. The same sample was
  then measured with an inline `pretty` override for comparison, before the
  fixture was removed. The JSON contains only synthetic text and geometry.

The extra viewport widths are CSS fixture measurements in the same Simulator,
not separate physical-device or keyboard acceptance. No prose was edited.

The isolated commit candidate passed the CI contract, public-boundary,
typecheck, lint and Agent capability checks. The full `pnpm test --maxWorkers=2`
run passed 2,038 tests (343 files), with one existing skipped test/file. Lint
reported zero errors and 35 existing warnings outside this change.
