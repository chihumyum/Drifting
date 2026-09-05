# Accessory Back hierarchy and Agent prose scrolling — 2026-09-06

This corrects the earlier acceptance assumption that Agent Back should dismiss
its keyboard before leaving Agent. The author-visible accessory level takes
priority. Current behavior is specified by the destination table in
`../mobile-ui-foundation.md`; prior keyboard-first observations are historical.

A fresh iOS Debug build was launched on iPhone 17 Pro / iOS 26.5 Simulator.
The renderer was explicitly reloaded after changing the Back controller, so
acceptance did not use an old effect closure retained by hot module replacement.

Native taps verified Format → entry list, and the complete editing-origin paths
through Agent (unselected and selected), Search with input, Plot with a focused
tool field, and Timeline. One Back restored the editor's same caret and entry
list with the software keyboard still open. Only Back from that entry list
ended editing and closed its keyboard. Reading-origin versions returned to
reading; a selected Agent session reopened without summoning the keyboard.
Session/draft restoration and the history picker's own Back layer were also
verified with native taps and native software-keyboard input.

Agent dock geometry exposed a missing WebKit viewport-pan compensation of
335px in the reading-origin input case. The top compensation now belongs to
scrolling content. Measured bottom overlap supplies enough scrolling travel to
bring the final prose block above the dock. The prose scroll viewport remained
874px tall: no extra opaque clipping band was introduced.

Live WKWebView scroll and hit tests reached the first and last prose blocks in
both reading-origin and editing-origin Agent input states, retaining composer
focus and keyboard. The selected conversation log traversed its full 1,841px
range with its keyboard open. Scroll positions were driven by the renderer
bridge; this is not a claim of native finger-pan automation.

The synthetic document hash was unchanged. The single synthetic conversation
was deleted, the local availability stub restored, and the renderer reloaded
to discard test drafts. No provider request or microphone recording occurred.
The adjacent generated JSON contains 21 computed assertions over the measured
observations. Controller tests separately cover each tool, reading/editing
origins, keyboard open/closed, and all three application Back sources. Source
string assertions are wiring checks only, not evidence of interaction quality.

All six repository checks passed on the isolated commit candidate. The full
suite passed 2,108 tests with one skip; lint reported 35 existing warnings and
no errors. These checks supplement the native Back observations above.
