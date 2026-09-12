# Renderer UI architecture

## Current status

The renderer uses two sibling shells over one shared application and project
runtime. Mobile is not a responsive variation of the desktop shell, and shared
features do not choose a shell with scattered `isMobile` branches.

The [frontend architecture and performance plan](renderer-performance/optimization-plan.md)
records proposed work on subscriptions, editor effects, Agent projections,
graphs, workspace indexing, and loading. The [execution record](renderer-performance/README.md)
separates measured synthetic work from pending app/device acceptance. The
contracts below continue to describe current behavior.

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
├── editor / entity-create
├── entities/hover
└── graph (story graph and chapter-lane timeline models)
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
A tab switch may update route selection and entity-dependent panels, but it
must not restart `ProjectRuntimeProvider`, invalidate the surrounding shell, or
destroy the editor session owned by another still-open desktop tab.

### Desktop editor-session continuity

`EditorMainArea` is the desktop editor-session stage. It mounts Project Home
plus one absolute surface for every open top-level leaf, split, and create tab.
The URL remains the address/selection authority, but React Router no longer
owns the lifetime of desktop editor views: inactive surfaces stay mounted with
`visibility: hidden`, `inert`, and no pointer or command ownership. Their
TipTap instances, Yjs sessions, scroll positions, selections, and field drafts
therefore survive ordinary tab switches.

Each surface has a content revision key. A new entity, replaced preview slot,
or changed split mounts behind the currently committed surface. The incoming
view reports ready only after its canonical document is present in the exact
TipTap instance that will be shown. `EditorMainArea` keeps the outgoing surface
visible but inert until then and commits visibility in a layout effect, before
the next browser paint. Project Home and the create chooser are synchronously
ready; a split is ready only when both panes are ready. A removed active tab is
retained as the outgoing visual cover until its successor commits, which also
covers create completion and close transitions without a gray/empty frame.

`EditorSurfaceLifecycle` separates pixel visibility from command ownership.
Only the interactive committed surface can own Cmd+F/Cmd+S, Copilot, global
whole-book search, or a queued entity action. In a visible split, only its
focused pane owns commands. Hidden surfaces can continue receiving canonical
Yjs/store updates without consuming user-facing side effects. Tabs whose entity
projection has not materialized yet keep Yjs session retention disabled, so
persistence never receives a synthetic empty entity id.

The lifecycle also exposes `isPreparing` for the selected incoming surface,
including both panes of an incoming split. Review decorations have a separate
entity-scoped controller: unrelated entities and non-prose fields do not
rebuild them, and empty review state does not dispatch empty metadata on input.
Hidden, unselected editors mark affected decorations dirty while continuing to
receive canonical updates. A visible or preparing editor flushes that projection
synchronously; prose readiness requires both canonical content and current
decorations. A failed projection keeps readiness false and hides the editor DOM
until a successful retry. Disposal releases this controller's listeners without
destroying the editor, Y.Doc, or persistence session. This boundary does not
pause other plugins or change document retention.

The isolated browser evidence covers actual editors, remote Yjs updates,
masking, undo, listener disposal, and the lifecycle provider/hook handshake.
Full-app tab/split interaction, scroll/draft continuity, native IME and retained
document memory measurements remain separate acceptance work in the plan.

Automatic linking is also view-owned. Each editor retains its own immutable
target map and self/parent exclusions; live updates do not recreate its document.
The view owns and cancels its debounce timer, while a weak map caches compiled
matchers by target-map identity. Shared appearance/interaction preferences remain
separate. Agent prose writes and review inverses pass an explicit source/project
context to plain-text detection inside their existing Yjs transaction, so
opening or closing a hidden editor cannot change those targets.

Yjs-backed prose declares `documentMode: 'yjs'`. Its surface cannot become
ready merely because a temporary TipTap object exists: readiness requires the
Collaboration extension on that exact instance to reference the replayed
`Y.Doc`. JSON-backed Patch content is parsed into TipTap's constructor instead
of being installed from a post-paint effect. Category/storyline templates use
the same constructor-time rule and apply later external projection changes in
a layout transaction. Placeholder decoration is omitted from the temporary
pre-Yjs shell, so loading is never presented as a genuinely empty document.
Read-only material previews follow the constructor-time JSON rule as well.
Canonical replay or content-row failures commit an explicit read-only error
surface; they never reveal an editable empty fallback and never leave the
outgoing surface covering the workspace indefinitely.

Chapter and inspiration routes keep `NodeEditorView` and its `EditorTopBar`
mounted while the target node's `NodeContent` row is materialized. Loaded
content is keyed by `nodeId`, so a previous node can never seed the next one;
only the keyed prose body and plot-planner dock wait for the matching row. This
keeps editor chrome continuous across node-to-node switches while still giving
each node its own `ChapterEditor`/Yjs lifetime and resetting the native prose
scroll surface at the body boundary. `ChapterEditor` reports ready only from
the final collaboration-bound TipTap instance. In 通览全书, the already-rendered
static chapter remains as a grid-aligned visual cover until the promoted live
chapter reports the same readiness, so title, summary, placeholder, and prose
swap atomically. On first activation, the whole-book surface also waits until a
current chapter row has loaded its canonical static prose instead of presenting
the estimated-height spacer as finished content.

`src/renderer/architecture/renderer-boundaries.test.ts` and restricted-import
lint rules enforce these directions.

## Shell ownership

Agent journal ingestion remains synchronous and lossless in `agent-chat-store`.
Each live conversation owns an opaque deduplication scope whose private weakly
held Set is reused across continuations and transport changes. Recovery creates
a fresh scope seeded from canonical event IDs; forks start empty. React receives
immutable message/run snapshots and cannot observe or mutate the membership
collection. Removing the last run/snapshot reference permits its index to be
collected. Retained conversations still have O(events) membership storage.

Desktop/mobile chat panels read a shared `useAgentChatMessages` display
projection. It coalesces text/thinking/tool-argument notifications by frame,
with a 50 ms timer fallback and immediate delivery while hidden. Control,
terminal, author-state and navigation boundaries flush the canonical message
array immediately. The projection owns only scheduling and a cached array
reference; ingestion, persistence and voice logic continue reading canonical
state. Last-view disposal releases timers, listeners and retained run/message
references. History message identities and `MessageView` memoization remain
unchanged.

Workspace consumers subscribe to explicit fields through `useDataStoreFields`
or a narrower `useDataStore(selector)`. The field helper selects from one
snapshot and preserves its result identity with shallow comparison; unrelated
collection updates do not trigger React commits in those consumers. It owns no data or project
lifecycle. The architecture check rejects unqualified whole-workspace hook
subscriptions in product views. Per-field arrays can still change after a
relevant update. Editor name and appearance selectors now return stable semantic
results across metrics-only updates. Complete workspace captures now also reuse
equal records and collections at the guarded store publication boundary, as
described below; partial reads and reference-index recovery remain in the
performance plan.


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

Super Element's `features/graph/super-element-edge-model.ts` owns the pure world
edge projection: supported endpoint kinds, hidden relation types, full-project
drift exclusion, labels, orientation and insets. Both world and viewport SVG
layers consume it. The viewport projection only transforms coordinates and
applies the existing focus filter; when the band is not sticky, node endpoints
retain their natural world position even if focus is enabled.

`lib/immutable-id-index.ts` shares first-match ID indexes by immutable collection
identity with entity-link appearance and relation labels. New array snapshots
receive new indexes; weak keys do not keep retired project arrays alive. These
are rebuildable read models, not persistence or mutable author state. World
projection is O(entities + relations) on a cold snapshot and O(relations) on a
warm one.

`SuperElementDriftEdges` owns its measured geometry and SVG rendering.
`super-element-drift-model.ts` classifies relations once per input snapshot;
`graph-edge-geometry.ts` reads each unique DOM endpoint once per measurement.
`useMeasuredGraphEdges` owns the frame scheduler, listeners and viewport resize
observer. Scroll/resize/pan-end events coalesce with the bounded 600 ms entry
animation. Equal geometry does not call the state setter, and changed geometry
does not render the parent card tree. Layout/filter revisions invalidate
measurement even when the relation array is unchanged.

The shell still moves the world via refs and DOM transforms during pan. Drift
measurement pauses while that ref is active, and the SVG remains hidden at
pan-end until fresh geometry has committed (or an equal already-committed
result is verified). Unmount cancels frames and releases listeners/observers.
`SuperElementViewportEdges` also owns its geometry. It reads the live pan/zoom
refs at the scheduled frame and compares labels/endpoint metadata as well as
coordinates, so a rename cannot leave a stale tooltip. Both line layers remain
hidden after a pan until their fresh output is committed. `useSuperElementTransform`
owns imperative world/band transforms and a viewport resize observer; it shares
the pure band-top function with edge projection and performs dimension reads
before transform writes. Container resize updates alignment without setting
parent React state.

`StoryGraphDriftEdges` uses the same geometry scheduler with its existing 500 ms
entry window and native scroll behavior. Its pure relation model preserves
either-endpoint drift classification, direction and the type override → source
storyline → target storyline → accent color precedence. Visible-card filtering,
layout changes and drag insertion changes invalidate measurement. Measurement
resolves drift-card refs before storyline tile refs, as before.

The shared measurement hook binds its viewport observer on the first frame,
after child and parent refs have attached. A child layout effect alone cannot
assume its parent DOM ref already exists. Full graph/native interaction
acceptance remains open in F5.

Bottom Timeline and Story Graph each own one `createTimelineDragPreview`
instance for their mounted lifetime. Only `TimelineMarkerLines` and
`TimelineActDragLine` subscribe to it; pointer motion does not set state on the
chapter/card parent. Pending preview coordinates coalesce per animation frame,
while end/cancel clears synchronously. The final continuous coordinate belongs
to the pointer handler and is committed independently of display publication.
`TimelinePin` owns its dragging class locally. `ActRail` retains its rail-local
ghost state. Both remove active pointer listeners during layout cleanup and
cancel without a write on unmount or window blur. The act rail is keyed by
project so an old project's gesture cannot survive a project switch. The last
guide subscriber releases preview coordinates and pending frames; the preview
can resubscribe during React StrictMode without a permanently disposed instance.

Mobile Timeline keeps its own dot gestures and vertical packing projection.
`vertical-timeline-leaders.ts` uses the shared immutable ID index to connect
chapter/cluster entries to their first dot, including the existing unplaced
preview fallback. Packing, clustering, track coordinates, and authored writes
remain in their existing owners. Desktop chapter dragging continues through
the imperative `chapter-lane-drag` controller; desktop cross-storyline links
already derive memoized world coordinates and do not need DOM measurement.

## Workspace snapshot publication

`captureWorkspaceProjection` still reads the complete workspace in one SQLite
transaction. The store accepts only the latest requested project/epoch. After
that guard, `workspace-projection-sharing.ts` compares the incoming capture
with the current same-project projection and reuses equal rows by ID and equal
collections. It compares every captured field, including nested positions,
aliases, relation endpoint kinds and block hashes. Timestamps alone cannot
prove equality. Serialized body/KV/anchor JSON remains opaque; sharing neither
parses nor serializes it. Unknown non-plain object values remain the incoming
value. Array, keyed-map and trash-set iteration order are preserved.

The normalized marker order and forward/primary/reverse storyline maps publish
in the same store update as entity rows. Unchanged forward membership reuses
the reverse map; changed membership reuses unaffected per-node lists. Forward
and reverse derivation build membership sets once instead of repeatedly
scanning and copying growing arrays. Duplicate links keep their original
first-membership order and last-declared-primary behavior.

Loading/project-switch/missing-project boundaries clear both forward and
reverse memberships. A rejected stale result neither compares data nor emits
a store notification. Sharing owns no asynchronous task, author state or
project cache; the existing weak ID index follows the source array lifetime.
Full capture, the structural refresh barrier and the non-blocking prose-only
sync path remain intact. The reference queue below now owns derived indexing; durable hard-kill recovery
and partial SQLite reads remain pending F6 work.

### Project reference-index queue

The ready `ProjectRuntimeProvider` retains one reference queue per captured
SQLite client/project. It is independent of child routes and editor tabs;
explicit boot retry, project/user replacement and last release end the owner.
`useEntityEditor` now persists prose/outline only. It no longer walks the live
document into inline-mention rows, including on initial mount. Copilot's live
document context remains separate and unchanged.
Patch cards also leave reference cleanup to the queue after the authored patch
deletion; they cannot reacquire a different database for a late cleanup.

Ordinary authored transactions already emit after commit. Agent-owned outer
transactions now register the same notification with `afterDatabaseCommit`.
The database adapter retains callbacks across successful savepoints, discards
rolled-back callbacks, and invokes them only after the outer gateway commit.
An observer exception cannot turn a committed author write into an apparent
failure or prevent other observers from running. This changes renderer event
wiring, not the Agent/network protocol or journal authority.

`reference-index-queue.ts` coalesces ordinary commits in a 250 ms window fixed
by the first request, keeps at most one following request during a pass, and
yields after every 16 attempted sources. Each acknowledged entry contains the
source version and projected reference count. Metadata and materialized-cache
updates reuse unchanged versions; known lifecycle deletions of projected rows
invalidate coverage even if prose did not change. A failed source retains old
rows while other sources proceed. One retry timer backs off from 1 to 30 seconds;
a new durable change can advance the retry. Explicit repair, restored projects
and authority changes revoke the in-flight repository owner and clear coverage.
New owners always start with a complete pass, never a persisted dirty-set claim.

`reference-index-repository.ts` binds every read/write to the captured database
and checks owner, project incarnation, active sync generation, source existence
and source version. Catalog rows, Yjs version metadata and inline coverage counts
are captured consistently. Durable Yjs snapshots plus updates supply prose;
JSON is used only when no Yjs state or positive revision exists, or for patches.
Revision-zero snapshots are Yjs-owned. Missing state with a positive revision,
invalid JSON and unresolved Yjs dependencies fail before replacement. Temporary
Y.Docs are destroyed, and live documents are never flushed or edited by indexing.

Replacement validates again inside the delete/insert transaction. Revocation
observed before commit rolls back; a commit already handed to the gateway stays
bound to that database. Only acknowledged commits enter the queue's cache.
Cleanup rechecks current existence inside its transaction, so an older catalog
cannot prune a newly created/restored source. Trashed sources and patches with
trashed/missing parents are excluded. Target marks/dangling semantics remain
unchanged, and unknown source formats are preserved. Derived writes participate
in the lifecycle settlement drain, but their handled rejection stays with the
reference queue and cannot fail a concurrent author-state refresh barrier.

`ReferenceIndexNotice` observes only the project's error boolean. Healthy
queue transitions do not cause React commits or add chrome. A failed projection
shows a retry action in panels that display inline references; observation does
not retain the worker. `ReferencesPanel` binds each query to its database and
advances its request generation on every reload, rejecting late older reads.

Full source-catalog reads (including JSON bodies), database-wide Yjs version
metadata and project inline coverage counts still occur on every pass, including
pure prose commits. Source parsing/write locality is proven; database read
latency and app-wide input performance are not. Forced process termination and
restart coverage must be proven before F6b narrows those reads. Current owner
restart/rollback tests are in-process and are not substitutes for that gate.

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
tab or Project Home frame can flash. Every outbound transition from an active
draft is route-first: close, content-tab activation, Project Home navigation,
and successful creation all use the same ordering. The desktop navigation
boundary still commits route/store ownership in layout effects, while the
editor-session stage keeps the draft surface mounted until the prepared
destination surface reports ready, then swaps before paint. Mouse and keyboard activation/close paths
share these transition owners; the intentionally empty `/new` child route is
therefore never exposed as the rendered workspace.

`DesktopUniversalCreateView` collects the entity kind and only the required
existing parent/group context. It then delegates to `createNode`,
`createStoryline`, `createElement`, or `createCategory`; those authored use cases
remain responsible for unique defaults, templates, Yjs seeding, SQLite atomic
transactions, optimistic rollback, and sync journal entries. Success replaces
the transient slot in place with a dedicated leaf after its editor route has
matched. The URL changes only when the draft is still active, so an async
completion cannot steal focus from a tab the user selected meanwhile. Failure
leaves the same draft and error available for retry. This surface is
desktop-only; mobile creation design remains independent and unchanged.

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

| File                                      | Ownership                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `src/styles/index.css`                    | tokens, reset, shared primitives, and editor base                               |
| `src/styles/ui-controls.css`              | shared interactive primitives: geometry, states, and theme behavior             |
| `src/styles/comments-review.css`          | comments, outline rail, inline review, and review cards                         |
| `src/styles/entity-editors.css`           | entity editors, relations, metadata, and domain surfaces                        |
| `src/styles/desktop-shell.css`            | desktop geometry, columns, overlays, and full-screen states                     |
| `src/styles/workspace-navigation.css`     | topbar project name and workspace navigation triggers                           |
| `src/styles/desktop-universal-create.css` | desktop transient-create chooser and context form                               |
| `src/styles/bottom-status-bar.css`        | full-width footer status line                                                   |
| `src/styles/bottom-timeline.css`          | bottom timeline dock                                                            |
| `src/styles/act-rail.css`                 | ActRail act strip in track coordinate space                                     |
| `src/styles/timeline-pin-menu.css`        | timeline pin context menu (Bottom Timeline and Story Graph)                     |
| `src/styles/super-view-header.css`        | shared fullscreen Super View header                                             |
| `src/styles/graph-view.css`               | Story Graph narrative-structure overlay                                         |
| `src/styles/relation-edge-popover.css`    | relation edge popover                                                           |
| `src/styles/drift-panel.css`              | bottom-anchored drift panel shared by Graph and Element views                   |
| `src/styles/plot-planner.css`             | in-chapter Plot Planner dock                                                    |
| `src/styles/dashboard.css`                | Project Home dashboard                                                          |
| `src/styles/search.css`                   | global search modal and editor find panel                                       |
| `src/styles/settings.css`                 | full-screen Settings overlay                                                    |
| `src/styles/agent-panel.css`              | Agent panel composer and conversation surface                                   |
| `src/styles/agent-activity.css`           | Agent activity perception on entity glyphs                                      |
| `src/styles/copilot-surface.css`          | Copilot inline popover and account-dropdown settings page                       |
| `src/styles/signin.css`                   | authentication surface                                                          |
| `src/styles/project-picker.css`           | Bookshelf project picker                                                        |
| `src/styles/mobile-*.css`                 | mobile standalone routes, workspace, safe-area, paper, and gesture presentation |

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
  src/renderer/shells/desktop/navigation/desktop-editor-continuity.acceptance.test.ts \
  src/renderer/shells/desktop/navigation/desktop-tab-close-transition.acceptance.test.ts \
  src/renderer/app/project-home.acceptance.test.ts
pnpm exec vite build
```

Architecture and state tests do not establish desktop visual regression,
physical-device gestures, native IME behavior, or mobile visual quality.
