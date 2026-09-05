# Mobile toolbar stacking correction

Date: 2026-09-06. Fresh native debug build, iPhone 17 Pro, iOS 26.5 Simulator,
402 × 874 CSS pixels. This supersedes the navigation-above-toolbar layout
recorded in `mobile-paper-agent-2026-09-05.md`.

The toolbar sits above bottom navigation. Navigation reserves its 56px row plus
the 34px bottom safe area; the toolbar ends 8px above that row. Scrolling down
hides navigation and moves the still-visible toolbar down 64px. Scrolling up
restores the stack. Both slide transitions use the same 220ms easing; reduced
motion disables them. The stack rule applies only while navigation is present
and visible and the keyboard is closed.

`mobile-toolbar-stack-2026-09-06.json` contains measured rectangles and ten
assertions evaluated from those measurements. Scroll was driven through the
frontend debug bridge into the real scroll owner; native screenshots verified
both resting states. Timeline has no navigation reservation and keeps an 8px
gap above the toolbar. Native touch also opened and closed the Agent shortcut.
The simulator did not summon its software keyboard during this run, so this
record does not claim a new keyboard handoff or physical-device acceptance.

Validation uses an isolated candidate excluding unrelated worktree changes:
`ci:contract:check`, `public:check`, `lint`, `typecheck`, and
`agent:capabilities:check` passed. Lint reports 35 existing warnings and no errors.
The full test run passed 2048 tests with one skip and one 20-second timeout in
the Agent Runtime's 1000-fragment stress test, while another suite was running
on the same machine. An isolated retry of `runtime.test.ts` passed all 38 tests
in 3.51 seconds without changing code or timeouts.
