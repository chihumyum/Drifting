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

Child editor URLs are observed only by each shell's route adapter. On desktop,
`DesktopWorkspaceNavigationBoundary` owns URL/tab synchronization and provides
a `WorkspaceNavigator` whose identity is stable for the lifetime of one
project. The boundary must pass the route `projectId` into the desktop adapter;
an unscoped navigator is invalid because child write use cases deliberately
fail closed without project authority. Shared and desktop workspace consumers
must not subscribe to `useLocation()` through compatibility navigation helpers.
A tab switch may update the editor outlet, tab selection, and entity-dependent
panels, but it must not restart `ProjectRuntimeProvider` or invalidate the
surrounding shell.

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

## Desktop universal create

The desktop tab model has one shell-owned `create` variant in addition to real
entity leaves and splits. It is a project-local, session-only transient draft,
not a `WorkspaceTarget` or `WorkspaceEntityType`: shared navigation and the
mobile paper session therefore never need to recognize a synthetic entity.
Each project may hold at most one draft, kept at the end of its open-tab list.
The `+` command sits immediately after the rendered tabs inside the horizontal
tab strip, including when the list is empty, rather than occupying a detached
right-edge command slot.

Opening the draft navigates the desktop shell to `/project/:projectId/new` and makes
`focusedLeafOf` return `null`, so URL mirroring, the right sidebar, status
consumers, and split actions behave as though no entity is focused. A later
entity/deep-link navigation leaves the draft in the list but moves focus away.
The draft cannot be previewed, reordered, or fused into a split. Inventory
pruning preserves it during the current session, but it does not enter
`ui-storage`, SQLite, Yjs, sync, or restart restoration.

The draft also records a session-only return owner when it is activated. A
draft opened from Project Home closes directly back to Home even when dormant
content tabs remain; a draft opened from a content tab or split restores that
exact tab and focused leaf. Reopening an existing background draft refreshes
the return owner to the current context. If that content owner disappeared,
close falls back to the nearest surviving tab. Store selection and the `/new`
route transition must resolve the same destination so no intermediate content
tab or Project Home frame can flash. Closing an active draft is route-first:
the desktop navigation boundary keeps the draft surface mounted until
`HashRouter` has committed the return route, then removes the draft in a layout
effect so the already-matched destination replaces it before paint. Mouse close
and the global close-tab shortcut share this transition owner; the intentionally
empty `/new` child route is therefore never exposed as the rendered workspace.

`DesktopUniversalCreateView` collects the entity kind and only the required
existing parent/group context. It then delegates to `createNode`,
`createStoryline`, `createElement`, or `createCategory`; those authored use cases
remain responsible for unique defaults, templates, Yjs seeding, SQLite atomic
transactions, optimistic rollback, and sync journal entries. Success replaces
the transient slot in place with a dedicated leaf. The URL changes only when
the draft is still active, so an async completion cannot steal focus from a tab
the user selected meanwhile. Failure leaves the same draft and error available
for retry. This surface is desktop-only; mobile creation design remains
independent and unchanged.

## Project Home authority

`/project/:projectId` is the cross-platform Project Home. Home is shell state,
not a `WorkspaceTarget`: it never enters desktop tabs, splits, previews, or the
mobile paper session. Shared features return through
`WorkspaceNavigator.showProjectHome()`; content navigation remains expressed as
a typed `WorkspaceTarget`. The legacy `/project/:projectId/home` URL redirects
to the project root.

Desktop represents Home as `activeTabKey === null` while retaining background
tabs and `lastActiveContentTabKey`. Opening an existing project from the desktop
shelf may consume a one-shot `resume-last-content` history marker after runtime
projection pruning; direct root navigation remains authoritative Home. Mobile
always enters a project at Home. Its controller owns a distinct
`project-home` surface, while its persisted `papers` contain only real content.
Mobile Back unwinds paper to Home and Home to the shelf. UI-storage v4 and
mobile-session v2 remove the former `dashboard:self` tab/paper without touching
SQLite, Yjs, or sync state.

## Shared interaction contracts

- Menus and anchored popovers portal to `body`, use fixed viewport
  coordinates, and clamp to the available viewport.
- `RelationTypeField` owns the shared first-class relation-type selector.
  Relation filters, colors, and menus key presentation state by
  `relationTypeId`; labels are resolved from the current type definition.
- `EntityHoverCard` is a desktop hover presentation over a shared content and
  positioning model. Mobile uses explicit preview sheets instead of emulating
  hover.
- Chapter-lane drag semantics are shared pure policy; desktop Timeline and
  Story Graph own their drag presentations.
- `SuperViewHeader` remains store-free. The desktop adapter supplies the three
  Super View destinations through the shared `navigationSlot`, which renders
  immediately after Back. The active destination tab is the header title;
  optional meta and view-specific controls follow it. Element and Story Graph
  also receive one trailing relation control, so switching those canvases does
  not move or duplicate the entry; TODO & Material does not render it.
- `SuperViewRelationUiProvider` shares project relation colors while retaining
  separate Element/Story Graph visibility filters. The menu ranks types whose
  two endpoints can render on the active canvas: current-canvas instances
  first, compatible types with no current-canvas instance second, and all
  other types in one collapsed group. Within the first two groups,
  primary↔primary precedes primary↔inspiration. Element owns
  element↔element and element↔node; Story Graph owns node↔node. Persisted
  `node` covers both chapters and inspirations, so unused type definitions
  cannot distinguish those subtypes; inspiration styling on existing
  instances remains endpoint-derived.

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
| `src/styles/desktop-universal-create.css` | desktop transient-create chooser and context form                   |
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
  src/renderer/components/ui/EntityCardPopoverShell.test.ts \
  src/renderer/store/ui-store.workspace-tabs.test.ts \
  src/renderer/shells/desktop/entity-create/desktop-universal-create.test.ts \
  src/renderer/shells/desktop/entity-create/desktop-universal-create.acceptance.test.ts \
  src/renderer/app/project-home.acceptance.test.ts
pnpm exec vite build
```

Architecture and state tests do not establish desktop visual regression,
physical-device gestures, native IME behavior, or mobile visual quality.
