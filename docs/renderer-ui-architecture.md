# Renderer UI architecture

## Current status

The renderer uses two sibling shells over one shared application and project
runtime. Mobile is not a responsive variation of the desktop shell, and shared
features do not choose a shell with scattered `isMobile` branches.

```text
App.tsx
├── app/effects
├── app/AppRoutes.tsx
├── shells/desktop/DesktopAppShell
└── shells/mobile/MobileAppShell

app/providers/ProjectRuntimeProvider
└── SQLite / Yjs / sync / Agent / repositories / use cases

features
├── workspace/navigation
├── settings / agent / library / comments / stats
├── entities/hover
└── graph and timeline models
```

## Dependency rules

Dependencies flow toward shared contracts:

1. `App.tsx` composes global effects, routes, and full-screen application state;
   it does not own workspace interaction details.
2. `ProjectRuntimeProvider` owns project startup, SQLite, Yjs, sync, Agent, and
   use-case lifetimes. Both shells consume that runtime.
3. `shells/desktop` owns desktop keyboard, pointer, dock, multi-column layout,
   UI-store navigation adapter, and desktop overlays.
4. `shells/mobile` owns paper sessions, mobile navigation, safe-area layout,
   gesture arbitration, preview sheets, overview, and mobile workspace panels.
5. Shared `features` must not import either shell, `store/ui-store`, or a
   shell-specific navigation implementation. They consume
   `WorkspaceNavigator` when navigation is required.
6. `components/ui` contains presentation primitives without business stores.
   Domain-aware components belong in the narrow feature that owns their data.
7. Compatibility re-exports may remain temporarily but cannot regain
   implementation or state ownership.

`src/renderer/architecture/renderer-boundaries.test.ts` and restricted-import
lint rules enforce these directions.

## Shell ownership

Desktop-only surfaces include `DesktopWorkspace`, `DesktopOverlayHost`, desktop
global shortcuts, desktop settings/Agent/comment hosts, `DesktopBottomTimeline`,
and the pointer-heavy desktop Graph and Super View controllers.

Mobile-only surfaces include `MobileAppShell`, the mobile paper-session reducer
and persistence, mobile workspace reveal/gesture state, paper overview, entity
preview sheet, standalone mobile authentication/shelf/settings hosts, and the
mobile navigation adapter.

Pure layout, projection, relation, editor, graph, timeline, and domain logic
should move downward when both shells need it. Shell interaction state should
not be generalized merely to make it importable.

## Shared interaction contracts

- Menus and anchored popovers portal to `body`, use fixed viewport
  coordinates, and clamp to the available viewport.
- `RelationKindField` owns shared relation-kind entry and suggestions; shells
  provide the appropriate modal or sheet host.
- `EntityHoverCard` is a desktop hover presentation over a shared content and
  positioning model. Mobile uses explicit preview sheets instead of emulating
  hover.
- Chapter-lane drag semantics are shared pure policy; desktop Timeline and
  Story Graph own their drag presentations.
- Shared Super View headers remain store-free. Each shell supplies its own
  navigation adapter and presentation. The desktop adapter supplies the three
  Super View destinations through the shared `navigationSlot`, which renders
  immediately after Back. The active destination tab is the header title;
  optional meta and view-specific `leftSlot` controls follow it.

## Super View navigation and Escape

Desktop Super Views overlay the current editor route. Closing one clears the
active Super View without rewriting router history, revealing the previous
editor surface intact.

`Escape` unwinds one layer per key press:

1. a focused editor or transient modal/popover/context menu consumes it first;
2. otherwise the most recently opened view-local layer closes;
3. when no child layer is open, the Super View closes.

`useSuperViewEscapeStack` owns steps 2 and 3. A child that handles `Escape`
must call `preventDefault()` and `stopPropagation()` so one press cannot close
two layers. Mobile does not inherit this desktop keyboard stack; it supplies
its own back/navigation behavior through the same view-level close actions.

## CSS ownership

| File                             | Ownership                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `src/styles/index.css`           | tokens, reset, shared primitives, and editor base                               |
| `src/styles/comments-review.css` | comments, outline rail, inline review, and review cards                         |
| `src/styles/entity-editors.css`  | entity editors, relations, metadata, and domain surfaces                        |
| `src/styles/desktop-shell.css`   | desktop geometry, columns, overlays, and full-screen states                     |
| `src/styles/mobile-*.css`        | mobile standalone routes, workspace, safe-area, paper, and gesture presentation |

Mobile must not override `desktop-shell.css` to simulate a separate layout.
New rules belong to the narrowest owner while preserving the established
cascade order.

## Machine acceptance

```bash
pnpm typecheck
pnpm lint
pnpm test:renderer-architecture
pnpm exec vitest run \
  src/renderer/hooks/useSuperViewEscapeStack.test.ts \
  src/renderer/components/ui/EntityCardPopoverShell.test.ts
pnpm exec vite build
```

Architecture and state tests do not establish desktop visual regression,
physical-device gestures, native IME behavior, or mobile visual quality.
