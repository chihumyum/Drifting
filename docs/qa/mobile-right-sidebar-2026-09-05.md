# Mobile right sidebar — 2026-09-05

The right sidebar now reaches the top, right and bottom of the viewport, with
an 8px paper reveal on the left. The paper background extends behind the system
bars. The header applies the top safe area once and the pane applies the bottom
safe area once; the Agent composer adds only its ordinary 8px content padding.
Agent subtabs use 12px text while retaining 44px touch targets.

The panel enters from above the top-right corner over 300ms and exits straight
up over 240ms. `AnimatePresence` retains it until the exit completes, including
when the workspace controller removes the tools overlay. Exiting content is
inert; the backdrop continues to block the underlying paper. Reduced motion
removes the travel and duration. Consumed child Escape events do not also close
the sidebar.

## Simulator acceptance

Verified on iPhone 17 Pro, iOS 26.5, with a freshly built native Debug app and
the current renderer. The project and chapter were existing synthetic QA data;
no provider call or manuscript write was needed. Screenshots and frame samples
remain in the ignored local frontend-debug evidence directory.

| Measurement | Observed CSS pixels |
| --- | --- |
| Viewport | 402 × 874 |
| Panel left / top / right / bottom | 8 / 0 / 402 / 874 |
| Top safe area / Tabs top | 62 / 62 |
| Tabs / Agent subheader height | 44 / 44 |
| Agent subheader font | 12 |
| Bottom safe area | 34 |
| Composer bottom / inner bottom padding | 840 / 8 |

Simulator clicks opened the tools workspace, switched to Agent and closed the
panel through both the close button and the left backdrop. Device pixels were
visually inspected. Frame sampling confirmed entry from `(36, -874)` to
`(8, 0)`; both click dismissal paths retained 15 intermediate closing frames,
kept the left edge at 8px, moved upward past -700px, then removed the panel.
The underlying chapter remained visible after dismissal.

Escape and the shared workspace Back event each retained 16 closing frames
before unmounting. Those two paths were dispatched through the iOS
`synthetic-dom` debug bridge; this does not claim Android hardware-button
acceptance. Reduced motion is covered by the source contract, not a Simulator
accessibility-settings run. Physical-device timing, IME and live Agent operation
are outside this layout acceptance.

## Machine checks

`review-sticky-note-rail.acceptance.test.ts` now checks the edge geometry,
single header inset, presence boundary, upward exit and inert closing state
instead of the retired 34px CSS entrance animation. Simulator geometry and
frame samples also passed explicit numeric assertions before publication.

The isolated publication candidate passed CI contract, public boundary,
typecheck, lint (existing warnings only), and Agent capability checks. The
full suite passed 2,034 tests with one skip; two timing-sensitive cases failed
under concurrent native-build/test load (a runtime timeout and a 21.67ms tool
search p95 against a 20ms limit). Both files passed on a serial rerun, 41/41.
The working checkout's unrelated local signing and sync changes were excluded
from the publication candidate.
