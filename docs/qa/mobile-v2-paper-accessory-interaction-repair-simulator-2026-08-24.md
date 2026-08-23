# Mobile V2 paper and keyboard-accessory interaction repair — iOS Simulator acceptance — 2026-08-24

Status: **listed Simulator interaction repair passed; physical-device touch remains open**

## Checkout and evidence boundary

- Baseline HEAD: `f0553f3f32ab2430f97aa9dc07e4c46661cd1386`
- Source under test: that baseline plus the paper/accessory interaction repair
- Build: local-only iOS debug; Xcode native build succeeded
- Visible input: Simulator UI through Computer Use
- Renderer setup/inspection and paper drags: DEV-only bridge, explicitly
  `inputPath=synthetic-dom` and `nativeInput=false`

The checkout also contained an unfinished, uncommitted M8 Google Drive change.
It was not treated as part of this repair or included in its commit scope. One
native generated-file change triggered an expected Tauri watcher rebuild and
normal process exit; the interaction observations below were taken before or
after that redeploy, never across it.

This evidence does not claim physical-device continuous touch, native multi-
touch, signed distribution, accessibility approval, performance approval, or
real Google account/Drive acceptance.

## Reused device and synthetic fixture

The run reused the existing `iPhone 16e / iOS 26.1` Simulator and existing
native build caches. It created no Simulator, runtime, device support image, or
duplicate DerivedData root.

One disposable local-only Project named `Mobile UI Repair Fixture` was created
through the visible product UI. It contained one synthetic empty chapter. No
account, credential, Drive state, private manuscript, or user Project content
was read or copied.

## Visible and renderer interaction matrix

1. The read workspace rendered one 56px floating pill at `x=10..380`, rather
   than a viewport-width footer. It showed the current entity, separate paper
   count, Search, and hamburger entrances; no structure/tool panel buttons were
   present.
2. Clicking the chapter identity opened the dedicated read-only status Sheet
   with title, paper position, writing status, word count, storyline, and
   update time. Clicking the numbered count separately opened paper Overview.
3. The read-state hamburger menu contained open papers, TOC, and comments. It
   did not expose formatting or enter editor accessory state.
4. Restoring the Project produced the ordinary paper order `Dashboard`, `All
   Chapters`, chapter. A synthetic paper drag from the Dashboard's visible
   `Continue Writing` button moved to All Chapters without activating the
   button. The settled route, active key, and controller all agreed.
5. Every tested paper settlement ended with `paperMode=read`,
   `keyboard=closed`, `paperSwipePhase=idle`, and `activeElement=BODY`; no
   caret-less edit projection survived the switch.
6. A real Simulator click in prose opened the iOS software keyboard, produced
   a visible caret, and entered `edit/accessory=formatting/keyboard=open`. The
   default accessory was a single horizontal format row directly above the
   keyboard, not a Sheet.
7. With the bottom tool panel still docked, the same real keyboard focus kept
   `panel=bottom-docked` and rendered the format accessory above the keyboard.
   The panel and keyboard accessory remained independently visible.
8. A real click on the Format label collapsed the format row and revealed the
   complete current-entity, count, Search, and hamburger entrances. The first
   run caught a pointerdown reflow ghost input (`Aa`); the repair deferred the
   layout switch until click completion. After deleting that synthetic text,
   repeated real expand/collapse left the editor selection offset at zero and
   inserted nothing.
9. Dismissing the keyboard blurred ProseMirror and atomically restored the
   complete read pill with `paperMode=read`, `keyboard=closed`, and
   `activeElement=BODY`. Connecting the Simulator hardware keyboard while
   editing also hid the software keyboard and removed the caret instead of
   leaving a focus/read hybrid.

## Deterministic checks

- focused mobile workspace and route suite: 20 files, 105 tests passed;
- `pnpm public:check`: passed, 1,496 source candidates audited;
- `pnpm lint`: passed with 0 errors and 41 existing repository warnings;
- `pnpm typecheck`: passed;
- `pnpm test`: 314 files passed, 1 skipped; 1,817 tests passed, 1
  skipped;
- `pnpm agent:capabilities:check`: passed, 3 files and 18 tests current;
- `pnpm exec vite build`: passed; only existing bundler/chunk-size warnings;
- `git diff --check`: passed;
- all repository gates above ran in a detached temporary worktree containing
  the exact staged repair patch, without the unfinished M8 Google Drive work.

The machine-checkable correction contract is
`src/renderer/shells/mobile/workspace/mobile-interaction-repair.acceptance.test.ts`.

## Storage and cleanup

- No runtime, Simulator, AVD, or native build cache was downloaded or created.
- The existing native caches are retained for later milestones.
- The disposable Project/app data, debug bundle, and booted Simulator are
  removed or shut down after the final repository gates.

## Remaining boundary

The repaired interaction model passes the listed iOS Simulator gate. Physical
iPhone acceptance must still cover continuous finger swipes, fast gesture
interruption, Chinese/English IME composition, selection handles, large-book
latency, safe-area ergonomics, VoiceOver, lifecycle, and memory pressure.
