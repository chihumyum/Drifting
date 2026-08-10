# Mobile UI foundation

## Current verdict

Drifting has a distinct mobile product path. Authentication, project shelf,
global settings, and the paper workspace are composed by mobile-owned routes
and shell components over the shared project runtime, domain model, use cases,
Yjs, sync, authentication, and Agent runtime.

This is an implemented foundation with static, build, state-machine, and an
older Simulator main-path record. It is not a claim that current interactions
have passed complete iOS and Android physical-device acceptance.

## Shell and dependency model

```text
AppRoutes
├── DesktopAppShell
└── MobileAppShell
    ├── mobile paper session and URL adapter
    ├── single active full editor
    ├── paper overview and reorder
    ├── top structure workspace
    ├── bottom tool workspace
    └── mobile Super View navigation

ProjectRuntimeProvider
└── SQLite / Yjs / sync / Agent / repositories / use cases
```

The shells may compose shared features and domain controllers. Shared features
must navigate through `WorkspaceNavigator` and must not import desktop or mobile
stores. Pointer-heavy desktop controllers remain under `shells/desktop`; mobile
owns its gesture arbitration, paper state, sheets, safe-area layout, and
navigation stack.

The complete dependency rules are in
[`renderer-ui-architecture.md`](renderer-ui-architecture.md).

## Current mobile product contract

- `/login` and `/register` use the mobile authentication presentation while
  retaining existing session, OTP, reset, OAuth callback, and adoption logic.
- `/` uses the mobile project shelf and global settings path without mounting a
  project runtime merely to show settings.
- Opening a project mounts `MobileAppShell` and the shared
  `ProjectRuntimeProvider`; it does not enter `DesktopAppShell` or the former
  deferred workspace page.
- A mobile paper session owns open targets, activation, close, reorder,
  adjacent switching, URL synchronization, and per-paper scroll restoration.
- Only the active paper mounts a full editor. Other papers use light summaries;
  the horizontal row uses native scrolling and `scroll-snap`.
- Top structure and bottom tool workspaces reuse shared feature content but use
  mobile-owned panels, sheets, reveal state, and safe-area geometry.
- Entity cells open a read-only preview sheet first; only an explicit action
  inserts a new paper. Backdrop events are consumed and cannot click through.
- Paper overview owns activation, close, close-all, grid reorder, Super View,
  settings, shelf, and all-chapters navigation.
- Host page zoom is disabled in the mobile WebView. Canvas-based Super Views own
  their own pointer/pinch transforms.

## Reused product core

| Layer         | Shared contract                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| Runtime       | Project lifecycle, SQLite, Yjs, sync, Agent, auth, and repositories                                          |
| Navigation    | `WorkspaceTarget` and `WorkspaceNavigator` ports                                                             |
| Features      | Settings panels, Agent content, library/TODO, comments, stats, entity panels, and pure graph/timeline models |
| UI primitives | Modal, menu, popover, buttons, tabs, icons, tokens, and semantic labels                                      |
| Domain truth  | The same project, prose, relations, storylines, `plotGridJson`, snapshots, and sync contracts as desktop     |

Reuse does not require identical presentation. Hover, right-click, keyboard
shortcuts, multi-column hosts, and desktop canvas controllers are not mobile UI
contracts.

## Remaining device acceptance

1. Pinch, cluster long-press/drag, panel handles, paper scrolling/snap, and
   canvas gestures need current iOS and Android manual validation.
2. IME, selection/caret scrolling, `visualViewport`, password managers, OTP
   autofill, deep links, and keyboard avoidance need physical-device coverage.
3. Rotation, safe areas, system bars, background/foreground, offline recovery,
   low-memory behavior, and representative device performance remain open.
4. Story Graph, Timeline, Plot Grid, Agent, entity editing, TSV paste, and other
   dense workflows require device-specific interaction checks.

Use [`mobile-device-acceptance.md`](mobile-device-acceptance.md) for setup and
the current checklist. Build or Simulator success must not be reported as
mobile-ready, touch-ready, or complete native UX acceptance.

## Machine gates

```bash
pnpm --dir client typecheck
pnpm --dir client lint
pnpm --dir client test:renderer-architecture
pnpm --dir client exec vite build
pnpm --dir client agent:capabilities:check
```

Focused mobile reducer, route, gesture-state, overlay, paper-session, and import
boundary tests supplement this baseline. They prove deterministic contracts,
not physical-device appearance or feel.
