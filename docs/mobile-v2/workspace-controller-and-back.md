# Mobile V2 workspace controller and Back ownership

Status: **M2 implementation, iOS Simulator acceptance, and Android Emulator Back acceptance complete**

Updated: 2026-08-24

This document records the implemented M2 state and Back boundary. It remains
current implementation truth for navigation ownership. M3 now renders the
projection through the unified bar and vertical workspaces; M4 still owns the
complete author-visible Search controller and UI.

## One controller, five orthogonal axes

`MobileAppShell` owns one `useReducer(mobileWorkspaceReducer)` state. The state
has five axes:

```text
surface    = paper | overview | super-view(view)
paperMode  = read | edit(accessory: navigation | formatting)
panel      = none | top-docked | top-full | bottom-docked | bottom-full
transient  = none | search | agent-input | popover | bar-sheet
             | paper-stats | entity-preview | dialog
keyboard   = closed | open
```

Overview, Super View, and Project Trash are no longer independent shell
booleans. The current presentation and future unified bar are projections of
the reducer state. Paper-panel gesture progress remains local presentation
state only while the pointer is moving; pointer settlement commits one
canonical panel state.

The reducer normalizes transitions instead of allowing callers to construct
contradictory combinations. Examples include:

- a non-paper surface cannot edit, own a panel, or retain the keyboard;
- edit mode requires a focused live editor and a visibly open software
  keyboard; keyboard-less pseudo-edit is illegal;
- structure/tool panels are independent from the keyboard accessory and may
  retain their state while editing;
- Search and Agent input cannot coexist with a panel;
- an open keyboard requires edit, Search, or Agent-input ownership;
- Project Trash starts from a clean read root;
- an entity preview may sit above a docked panel so Back can reveal that panel
  again instead of destroying it.

Development builds call `assertLegalMobileWorkspaceState` at reducer and Back
boundaries. Pure tests exercise the same legality function without depending on
React or a native shell.

## Back is a one-layer state transition

`resolveMobileWorkspaceBack(state, source)` is pure. Every handled request
returns exactly one layer, one legal next state, and at most one effect. The
implemented order is:

1. destructive, native, or full-screen Project Trash dialog;
2. popover, current-paper Stats, entity preview, or bar sheet;
3. edit mode and its keyboard atomically return to read mode and blur the
   editor;
4. Search or Agent input, including its keyboard;
5. full panel to the corresponding docked panel;
6. docked panel to the read paper;
7. Super View child layers, then the Super View root;
8. Overview root, returning to the Project Home or paper that opened it;
9. paper read root returns to Project Home;
10. Project Home returns to the shelf.

Visible Back, keyboard Escape, and Android hardware Back share this hierarchy.
The unified bar exposes Back at the paper read root. Project Home is a separate
safe-area surface outside the paper deck and owns its own visible shelf Back.
Dashboard is therefore absent from paper ordering, swiping, closing, counts,
snapshots, and mobile session persistence.

## One request bridge across DOM and native input

Visible back controls, keyboard Escape, Super View layers, and Android
hardware Back share `MOBILE_WORKSPACE_BACK_EVENT`.

Before dispatching that request, the bridge sends a tagged synthetic Escape to
the active DOM owner. Existing dialogs and portaled popovers can therefore
consume their own topmost layer first. The workspace and Super View listeners
ignore that tagged preflight and then resolve the shared typed request exactly
once.

The mounted Super View escape stack receives the request before the workspace
root. While a Super View is active, the workspace hook refuses to close it;
the Super View stack first unwinds its inspector, relation, or other child
layer and closes the root only when no child remains. Closing the root restores
its recorded origin surface rather than inserting a paper.

On Android, Tauri's existing App plugin owns `OnBackPressedDispatcher` and
emits `back-button`. The renderer registers through `onBackButtonPress`; it
does not patch `MainActivity`, evaluate JavaScript from Kotlin, or use WebView
history. The listener is module-singleton and reference-counted so React
StrictMode setup/cleanup cannot leave two active native callbacks.

The mobile capability adds only the Tauri event register/remove permissions
needed by that existing plugin.

## Unified-bar projection boundary

`selectMobileUnifiedBarProjection` derives:

- whether the future bar is visible;
- read, edit, Search, or Agent-input mode;
- disabled, Back, or keyboard-dismiss action;
- safe-bottom or above-bottom-panel placement.

M3 renders that projection in one 56px `MobileUnifiedBar`; the 2026-08-24
interaction correction makes it a floating pill, removes panel buttons, and
keeps its keyboard accessory independent from panel ownership. The implemented
presentation and gesture boundary is documented in
[`unified-bar-rails-and-paper-swipe.md`](unified-bar-rails-and-paper-swipe.md).
M2 still owns Search state and Back semantics, while M4 owns the complete
author-visible Search controller and UI.

## Deterministic evidence

- `src/renderer/shells/mobile/workspace/mobile-workspace-controller.test.ts`
- `src/renderer/platform/mobile-workspace-controller.acceptance.test.ts`
- `src/renderer/hooks/useSuperViewEscapeStack.test.ts`
- `src/renderer/app/mobile-standalone-routes.acceptance.test.ts`

These checks cover legal transitions, impossible combinations, Back priority,
unified-bar projection, shell ownership, shared Super View requests, Android
event permissions, and the absence of a Kotlin/WebView-history workaround.

## Native evidence and remaining boundary

The dated
[`../qa/mobile-v2-m2-workspace-back-simulator-2026-08-23.md`](../qa/mobile-v2-m2-workspace-back-simulator-2026-08-23.md)
records visible iPhone paths and real Android Emulator hardware Back events on
already-existing devices.

The iOS renderer bridge's pinch, Escape, and evaluation inputs are synthetic.
The Android `adb keyevent` is a native system Back event, but neither path is a
physical finger/device acceptance. Physical touch, native IME, lifecycle,
accessibility, and release behavior remain open.
