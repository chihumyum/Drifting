# Mobile full-screen prose flow — 2026-09-06

A fresh iPhone 17 Pro / iOS 26.5 Simulator Debug build was used, with the final
stylesheet loaded through the development server. The existing synthetic harbour
paragraphs were read without modifying prose or calling an Agent provider.

Before the change, the 402 × 874 screen clipped the active scroll viewport to
`y=63…715` with navigation visible and `y=63…771` with it hidden. Outer safe-area
and toolbar padding left opaque bands above and below the prose.

The viewport now remains `y=0…874` in both reading states. Device screenshots show
prose behind the native status bar and below the floating accessory. DOM hit tests
in the top safe area, bottom safe area, and accessory side gap all resolve inside
the paper after navigation hides. The accessory still moves 64px down when the
bottom navigation hides. Visible top and bottom navigation use opaque backgrounds so prose cannot show
through their labels. Each background travels with its bar; hidden navigation
leaves no backdrop behind. The accessory retains its own background.

The document-start safe-area spacer scrolls with the content. Chapter and
whole-book end-of-document checks leave the final line above the accessory;
adjacent frozen chapter snapshots also fill the screen. Native taps verified
editing → Search → Back retains the keyboard, focus and caret, with the scroll
viewport ending above the input toolbar.

`mobile-fullscreen-flow-2026-09-06.json` contains captured geometry and 20 computed
acceptance assertions. Scroll actions use the frontend bridge; keyboard actions
use native Simulator input. This record covers Simulator acceptance, not a new
physical-device run. Repository checks run against the isolated commit candidate.

Validation passed: CI contract, public boundary, lint (35 existing warnings,
zero errors), typecheck, Agent capabilities, and the full test suite
(2,054 passed; one skipped).
