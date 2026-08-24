# Mobile V2 delivery and acceptance

Status: **normative staged plan; M0-M7 complete, M8 not started**

Updated: 2026-08-23

Each milestone is an independently completed Goal. A Goal is complete only
when implementation, deterministic tests, durable documentation, machine
evidence, and an iOS Simulator acceptance record land together. Android-specific
behavior additionally requires Android Emulator evidence in that Goal.

Simulator and Emulator evidence never closes physical-device touch, native
IME, secure storage, Google account, background, low-memory, or release gates.

## Delivery rules

1. Preserve shared domain/runtime authority and the one-live-editor invariant.
2. Replace interaction ownership without duplicating domain use cases.
3. Do not keep old and new mobile chrome as long-lived public alternatives.
4. Every milestone updates the current/target boundary; future target prose is
   never reported as shipped behavior.
5. Machine tests prove deterministic state and wiring. Simulator proves only
   the exact visible/input path recorded for that checkout.
6. Physical iOS and Android acceptance remains mandatory for touch, IME,
   lifecycle, credentials, Google Drive, performance, and final release.
7. Google Drive cannot be waived from the final Mobile V2 release.

## Milestone graph

```text
M0 Product contract freeze
 |
 v
M1 Platform, shell mode, portrait, and theme foundation
 |
 v
M2 Workspace controller and back ownership
 |
 v
M3 Unified bar, vertical rails, and stable paper deck
 |
 v
M4 Editing, comments, search, and all-chapters
 |
 v
M5 Complete Planning and touch drag
 |
 v
M6 Mobile Agent, Library/TODO, and Stats
 |
 v
M7 Independent Super Views
 |
 v
M8 Google Drive release gate
 |
 v
M9 Native RC and final MVP acceptance
```

Later internal work may be prepared in parallel, but author-visible activation
and completion claims follow the dependency graph.

## M0 — Product contract freeze

### Scope

- Freeze the final product surfaces and explicit exclusions.
- Freeze state topology, Back priority, paper/panel/Super View ownership,
  vertical rails, all-chapters editing, complete Timeline touch behavior,
  theme, orientation/tablet policy, and Google Drive hard gate.
- Add repository navigation and a machine check that distinguishes target from
  current implementation.
- Record one iOS Simulator baseline without claiming V2 behavior.

### Exit evidence

- `docs/mobile-v2/README.md`
- `docs/mobile-v2/product-contract.md`
- this delivery document
- documentation-index/current-boundary links
- `mobile-v2-design.acceptance.test.ts`
- dated M0 Simulator baseline record

Current evidence:

- [`../qa/mobile-v2-m0-simulator-baseline-2026-08-23.md`](../qa/mobile-v2-m0-simulator-baseline-2026-08-23.md)

### Shipped behavior

None. M0 authorizes and constrains implementation; it does not claim that the
current pinch/cluster shell implements V2.

## M1 — Platform, shell mode, portrait, and theme foundation

### Required behavior

- Add a shell-mode/device-class contract separate from native platform target.
- Resolve Mobile Shell for phones/compact tablets and Desktop Shell for an
  expanded portrait tablet at least 1000 CSS px wide.
- Lock supported mobile native targets to portrait.
- Route shelf, settings, and Project consistently through the resolved shell.
- Add Mobile V2 semantic theme tokens for light/dark/follow-system.

### Exit gates

- Pure device-class threshold and immutable shell-resolution tests.
- Architecture tests prove Desktop Shell on iOS/Android cannot advertise
  desktop-only capabilities.
- iPhone and compact iPad Simulator show Mobile Shell in portrait.
- Expanded iPad Simulator shows Desktop Shell in portrait.
- Rotation cannot expose a landscape Mobile Shell.
- Light/dark/follow-system foundation switches without white flashes or
  unreadable root surfaces.

Current implementation evidence:

- [`platform-and-appearance-foundation.md`](platform-and-appearance-foundation.md)
- `ui-shell-mode.test.ts`
- `initial-theme.test.ts`
- `mobile-ui-platform-foundation.acceptance.test.ts`
- [`../qa/mobile-v2-m1-platform-simulator-2026-08-23.md`](../qa/mobile-v2-m1-platform-simulator-2026-08-23.md)

## M2 — Workspace controller and Back ownership

### Required behavior

- Replace independent shell booleans with orthogonal surface, paper mode,
  panel, transient, and keyboard state.
- Derive unified-bar presentation from controller state.
- Resolve one Back layer per action, including Android hardware Back.
- Keep Overview and independent Super Views outside paper navigation.

### Exit gates

- Exhaustive reducer tests cover legal transitions and reject impossible
  combinations.
- Back-priority table has deterministic tests.
- iOS Simulator exercises read, panel, search, sheet, overview, and Super View
  unwind without closing two layers.
- Android Emulator exercises hardware Back through the same resolver.

Current implementation evidence:

- [`workspace-controller-and-back.md`](workspace-controller-and-back.md)
- `mobile-workspace-controller.test.ts`
- `mobile-workspace-controller.acceptance.test.ts`
- `useSuperViewEscapeStack.test.ts`
- [`../qa/mobile-v2-m2-workspace-back-simulator-2026-08-23.md`](../qa/mobile-v2-m2-workspace-back-simulator-2026-08-23.md)

The M2 iOS run visibly covered read root, a docked structure panel, entity
preview, Overview, and a separate Story Graph Super View. The running renderer
also exercised Search resolver semantics; the author-visible Search UI remains
M4 scope. Android used real Emulator hardware Back events through the same
resolver.

## M3 — Unified bar, vertical rails, and stable paper deck

### Required behavior

- Remove paper pinch, paper scaling, cluster quick switch, and floating paper
  rail control.
- Add one controlled 56px floating pill with separate entity-Stats,
  paper-count, Search, and hamburger entrances.
- Open panels only through the safe-top pull handle, floating-pill pull handle,
  and settled resize handles; do not add panel buttons to the pill.
- Enforce one visible handle owner: hide the pill while a panel moves, replace
  an entry grabber with the panel boundary grabber, and hide opposite chrome
  while a panel is full.
- Preserve arbitrary settled panel height; full-screen commitment requires the
  physical edge or a deliberate fling, never a fixed percentage crossing.
- Add 56px one-level vertical rails to top and bottom workspaces.
- Add read-state paper swipe with nested-interaction exclusions.
- Preserve ordered session, active-only live editor, static snapshots, URL
  synchronization, and scroll restoration.
- Ensure Dashboard participates in the ordinary rail and horizontal swipe.
- Panels crop the paper viewport and never scale prose.

### Exit gates

- No live editor ancestor uses `transform: scale`.
- Focused editing, selection, search, Timeline, Plot Grid, and Super View block
  paper swipe.
- Open-new, activate-existing, close-neighbor, reorder, and restart restoration
  pass deterministic tests.
- iOS Simulator verifies bar geometry, both rails, paper activation, overview,
  panel dock/full/collapse, and reduced motion.

Current implementation evidence:

- [`unified-bar-rails-and-paper-swipe.md`](unified-bar-rails-and-paper-swipe.md)
- [`../qa/mobile-v2-paper-accessory-interaction-repair-simulator-2026-08-24.md`](../qa/mobile-v2-paper-accessory-interaction-repair-simulator-2026-08-24.md)
- `mobile-paper-swipe.test.ts`
- `mobile-interaction-repair.acceptance.test.ts`
- `mobile-workspace-session.test.ts`
- `mobile-workspace-session-storage.test.ts`
- `mobile-standalone-routes.acceptance.test.ts`
- [`../qa/mobile-v2-m3-unified-workspace-simulator-2026-08-23.md`](../qa/mobile-v2-m3-unified-workspace-simulator-2026-08-23.md)

The M3 iPhone run visibly covered the safe-bottom unified bar, both 56px
vertical rails, dock/full/close cycles, 1:1 cropped paper, and Overview. The
iOS renderer bridge additionally exercised bidirectional paper activation and
interactive-target exclusion with `inputPath=synthetic-dom`; native Reduce
Motion was temporarily enabled and observed in the running WKWebView. Physical
touch remains open.

## M4 — Editing, comments, search, and all-chapters

### Required behavior

- Keep the keyboard accessory independent from the top and bottom panels.
- Require a focused editor plus visible software keyboard for edit mode; paper
  switching must settle in read mode.
- Show formatting as the default horizontally scrollable accessory row, with a
  Format label that collapses back to the complete navigation entrances.
- Keep TOC/comments and entity preview in their mobile Sheet boundaries;
  formatting itself must never open a Sheet.
- Extract headless current-paper and Project search controllers.
- Add Overview grouped Project results.
- Complete touch promotion, one-live-row editing, search, TOC, focus, and
  restoration for all-chapters.

### Exit gates

- Yjs selection/IME survives inline formatting and accessory-level transitions.
- Search never mutates prose and restores the current match.
- All-chapters keeps one live chapter for 100- and 300-chapter fixtures.
- iOS Simulator verifies English and Chinese keyboard paths, all-chapters
  promotion, find navigation, TOC, comment creation, and restart restoration.
- Android Emulator repeats IME, Back, and selection-critical paths.

Current implementation evidence:

- [`editing-comments-search-and-all-chapters.md`](editing-comments-search-and-all-chapters.md)
- `mobile-v2-editing.acceptance.test.ts`
- `mobile-paper-search.test.ts`
- `mobile-project-search.test.ts`
- `mobile-all-chapters.test.ts`
- `mobile-keyboard-geometry.test.ts`
- [`../qa/mobile-v2-m4-editing-simulator-2026-08-23.md`](../qa/mobile-v2-m4-editing-simulator-2026-08-23.md)

The M4 iPhone run visibly covered English and Chinese input, native selection
formatting, current-paper and grouped Project search, All Chapters promotion,
search/TOC, comment creation, and restart restoration. The Android run exposed
and then accepted a native IME-inset bridge, native selection, one-layer Back,
one-live All Chapters, and empty-Project chapter creation. The exact
non-collapsed selection range after restart and all physical-device behavior
remain open.

## M5 — Complete Planning and touch drag

### Required behavior

- Preserve complete Timeline book/narrative, Act, marker, lane, link, scale,
  locate, spread, creation, and context actions.
- Add touch drag arming, ghost, edge autoscroll, cross-lane drops, cancellation,
  rollback, and exactly-once atomic commit.
- Preserve Timeline pan/pinch without leaking gestures to paper navigation.
- Preserve mobile Plot Grid input, row/column operations, drag, and TSV paste.

### Exit gates

- Pure gesture-arbitration tests cover tap, arm, drag, menu, pan, pinch,
  cancel, invalid target, and edge autoscroll.
- Integration tests prove one valid drop performs one domain write and all
  cancellation paths perform zero writes.
- iOS Simulator verifies reachable full Planning UI and ordinary controls;
  manual Simulator touch limitations remain explicit.
- Physical-device completion remains open until real continuous touch, pinch,
  autoscroll, and long-press are accepted on both platforms.

Current implementation evidence:

- [`complete-planning-and-touch-drag.md`](complete-planning-and-touch-drag.md)
- `mobile-planning-gesture.test.ts`
- `chapter-lane-drag.pointer.test.ts`
- `useTimelineExpandedScale.test.ts`
- `mobile-v2-planning.acceptance.test.ts`
- [`../qa/mobile-v2-m5-planning-simulator-2026-08-23.md`](../qa/mobile-v2-m5-planning-simulator-2026-08-23.md)

The M5 iPhone run visibly covered the complete full-panel Timeline and Plot
surfaces with a synthetic four-chapter/two-storyline fixture. Explicitly
synthetic DOM input exercised delayed drag, long press, TSV paste, and
normalized persistence; Android device pixels covered the same compact Mobile
Shell presentation over an app-created chapter, and real hardware Back reduced
full Planning to docked Planning. Physical continuous touch and multi-touch
remain open.

## M6 — Mobile Agent, Library/TODO, and Stats

### Required behavior

- Replace the desktop Agent presentation export with a mobile-owned view over
  shared runtime/use cases.
- Show explicit context chips, durable conversations, streaming/cancel/retry,
  stable evidence links, and author-controlled output actions.
- Reflow Library/TODO to the vertical-rail workspace without domain capability
  loss. Present current-entity Stats from the floating pill by reusing the
  desktop-right-sidebar `EntityStatsContent`; do not duplicate Stats in the
  bottom rail.

### Exit gates

- Agent answers never auto-write prose.
- Evidence target plus stable block id round-trips and jumps correctly.
- Copy, inspiration, TODO, and approved review/write paths have deterministic
  tests.
- iOS Simulator verifies local fixture conversations, context, outputs,
  Library/TODO CRUD, draggable shared Stats, empty/loading/error states, and
  dark mode.
- Live provider/device acceptance remains separately identified.

Current implementation evidence:

- [`mobile-agent-library-todo-and-stats.md`](mobile-agent-library-todo-and-stats.md)
- `turn-context.test.ts`
- `mobile-agent-model.test.ts`
- `runtime-tool-search.test.ts`
- `mobile-v2-tool-workspaces.acceptance.test.ts`
- [`../qa/mobile-v2-m6-agent-library-stats-simulator-2026-08-23.md`](../qa/mobile-v2-m6-agent-library-stats-simulator-2026-08-23.md)

The M6 iPhone run visibly covered a persisted synthetic answer, explicit
Project/entity/block context, evidence jump, author-tapped inspiration/TODO
results, Library/TODO CRUD, current/whole-book Stats, touch targets, empty/error
states, and dark mode. Android device pixels covered the same compact portrait
information architecture; real Android hardware Back unwound full → docked →
closed. Both WebView transports report `nativeInput=false`, and no live provider
or account behavior is inferred from the synthetic fixture.

## M7 — Independent Super Views

### Required behavior

- Keep all three Super Views outside the paper session as full-screen surfaces.
- Preserve header switching and restore the underlying paper workspace exactly.
- Provide mobile canvas pan, pinch-around-midpoint, card/node drag, relation
  actions, and nested Back behavior.

### Exit gates

- Paper count/order/URL remain unchanged across every Super View lifecycle.
- Gesture tests prove canvas ownership blocks page zoom, paper swipe, and panel
  drag.
- iOS Simulator verifies entry, switching, nested layers, close restoration,
  safe areas, and representative canvas state.
- Physical iOS/Android devices remain required for real multi-touch acceptance.

Current implementation evidence:

- [`independent-super-views.md`](independent-super-views.md)
- `mobile-super-view-state.test.ts`
- `super-view-canvas-gesture.test.ts`
- `mobile-v2-super-views.acceptance.test.ts`
- [`../qa/mobile-v2-m7-independent-super-views-simulator-2026-08-23.md`](../qa/mobile-v2-m7-independent-super-views-simulator-2026-08-23.md)

The M7 iPhone run visibly switched all three views in one independent host,
exercised simulated midpoint-preserving pinch without page zoom, unwound
relation mode, and restored the exact paper key, active item, scroll position,
and route. Android device pixels covered the compact Story Graph and real
hardware Back cleared relation mode before closing the host. Both WebView
transports report `nativeInput=false`; real multi-touch, continuous populated
node/card drag, and physical accessibility remain open.

## M8 — Google Drive release gate

### Required behavior

- Install production iOS/Android/Desktop OAuth configuration without committing
  credentials or signing material.
- Complete real-account connect, refresh, reauthorize, revoke, mismatch, SDK
  state loss, and automatic discovery.
- Prove Desktop/iOS/Android Project convergence, assets, outbox, deletion,
  recovery, concurrency, and multi-project isolation.

### Exit gates

- Existing deterministic native/sync/credential gates pass.
- iOS Simulator and Android Emulator verify configuration/status/error UI only;
  neither counts as real Google acceptance.
- Signed physical iOS and Android devices pass the real-account lifecycle
  matrix.
- A Desktop/iOS/Android report identifies exact build SHAs and uses only
  synthetic or authorized project data.
- No secret, token, account identifier, or private Project data enters the
  repository evidence.

## M9 — Native RC and final MVP acceptance

### Required behavior

- Close light/dark/follow-system, Chinese/English, text scaling, reduced motion,
  VoiceOver/TalkBack, safe-area, background, low-memory, large-project, phone,
  compact-tablet, and expanded-tablet gates.
- Produce signed release candidates and complete the final cross-platform
  matrix.

### Exit gates

```bash
pnpm public:check
pnpm lint
pnpm typecheck
pnpm test
pnpm agent:capabilities:check
pnpm exec vite build
```

- Signed iOS and Android artifacts correspond to the accepted source SHA.
- Physical-device evidence closes every non-automatable touch, IME, lifecycle,
  accessibility, performance, and Google Drive row.
- Known limitations are documented without calling deferred or failed behavior
  complete.
