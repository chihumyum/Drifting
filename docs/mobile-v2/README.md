# Mobile V2

Status: **target product contract frozen; staged implementation in progress**

Updated: 2026-08-23

Mobile V2 is Drifting's writing-first native mobile workspace. It keeps the
shared SQLite, Yjs, sync, Agent, asset, and domain core. M1-M6 now implement
the platform/shell foundation, controller-owned Back, stable paper viewport,
one unified bar, vertical panel rails, explicit read-paper swipe ownership,
keyboard-safe writing sheets, read-only search, one-live All Chapters, and the
complete shared Planning/Plot workspace with deterministic touch arbitration,
plus a mobile-owned answer-only Agent and portrait Library/TODO/Stats surfaces.

This directory defines the target. It does not claim that the current mobile
shell already implements or has physically accepted the target interactions.
Current shipped behavior remains documented by
[`../mobile-ui-foundation.md`](../mobile-ui-foundation.md), and checkout-specific
device results remain evidence rather than product truth.

## Read this set in order

1. [`product-contract.md`](product-contract.md) defines the final MVP surfaces,
   interaction ownership, product scope, device policy, and release gates.
2. [`delivery-and-acceptance.md`](delivery-and-acceptance.md) defines the M0-M9
   implementation sequence and the evidence required to complete each goal.
3. [`platform-and-appearance-foundation.md`](platform-and-appearance-foundation.md)
   records the current M1 native-target/UI-shell and theme boundary.
4. [`workspace-controller-and-back.md`](workspace-controller-and-back.md)
   records the current M2 workspace state and shared Back boundary.
5. [`unified-bar-rails-and-paper-swipe.md`](unified-bar-rails-and-paper-swipe.md)
   records the current M3 bar, rail, panel-crop, and paper-swipe boundary.
6. [`editing-comments-search-and-all-chapters.md`](editing-comments-search-and-all-chapters.md)
   records the current M4 writing, shared-sheet, search, and all-chapters
   boundary.
7. [`complete-planning-and-touch-drag.md`](complete-planning-and-touch-drag.md)
   records the current M5 Timeline, touch-drag, pinch, and Plot Grid boundary.
8. [`mobile-agent-library-todo-and-stats.md`](mobile-agent-library-todo-and-stats.md)
   records the current M6 Agent, Library/TODO, and Stats boundary.
9. [`../mobile-device-acceptance.md`](../mobile-device-acceptance.md) is the
   current native setup and physical-device runbook.

If these documents disagree, authority is ordered as follows:

1. repository data, sync, editing, and security contracts for authority and
   durability;
2. `product-contract.md` for final Mobile V2 behavior;
3. `delivery-and-acceptance.md` for sequencing and evidence;
4. this file for status and navigation.

## Machine-checked design markers

These markers distinguish a frozen target from shipped behavior:

- `design_status: frozen`
- `implementation_status: staged_in_progress`
- `release_status: not_ready`
- `product_priority: writing_first`
- `paper_scale: forbidden`
- `panel_navigation: vertical_rail`
- `timeline_touch_drag: required`
- `all_chapters_editing: required`
- `super_view_surface: independent_fullscreen`
- `google_drive_release_gate: required`
- `dark_mode: required`
- `mobile_orientation: portrait_only`
- `expanded_tablet_shell: desktop`
- `platform_foundation: simulator_accepted`
- `workspace_controller: simulator_accepted`
- `stable_paper_workspace: simulator_accepted`
- `editing_workspace: simulator_accepted`
- `planning_workspace: simulator_accepted`
- `tool_workspaces: simulator_accepted`

The design markers and phase graph are checked by
`src/renderer/shells/mobile/workspace/mobile-v2-design.acceptance.test.ts`.
