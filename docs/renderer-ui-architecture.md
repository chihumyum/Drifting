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

### On-demand PDF and archive libraries

The platform adapter and library image/text previews remain available at app
startup. They import only the small PDF signature/loader entry. The loader
dynamically imports `lib/pdf-runtime.ts`, which loads the legacy PDF engine and
configures the Vite-managed local worker URL when a PDF operation starts. Native
thumbnail success and non-PDF fallback checks do not require the PDF engine.
The browser module cache shares successful/concurrent engine imports; the app
does not retain a second promise cache or a global PDF document.

`features/library/pdf-preview-document.ts` owns the preview's native read,
deferred engine load and document task. Disposal during a read/import prevents
document creation; disposal or a document error destroys an existing task once.
The preview leaf is keyed by file path, and locale changes translate its error
key without recreating the document. Page-render cancellation and the enclosing
preview's close/gesture behavior remain in the view. Thumbnail tasks also clean
up after parse/render/encode failures and reset their temporary canvas.

Relational Markdown export loads JSZip only when building an archive. The
existing open-Yjs flush, transactionally consistent source capture, authored
prose interpretation and native save/cancel flow remain the authority. Neither
library owns the project runtime, editor sessions or native lifecycle listeners.
PDF/ZIP module-fetch retry, offline native paths, other heavy features and app
startup budgets remain F7 acceptance work; document-error recovery alone does
not satisfy those gates.

### Deferred settings content

Desktop project settings, desktop standalone settings and mobile settings retain
ownership of their navigation, search/selection and Back/close handlers. Only
panel content waits for `useSettingsPanels`. The mobile settings index itself
loads no panel code. Project Trash uses the independent `TrashSettingsPanel`,
so it does not pull all preference controls into startup. Desktop modal rail
refs remain owned by the modal through a registration callback; when content
arrives it scrolls to the latest requested rail. Closing keeps the existing
modal selection/query lifetime and prevents late content from mounting.

The shared deferred module owner caches code and coalesces requests; it owns no
project, editor, credentials or document. Failure stays local until explicit
retry. Browser experiments showed that retrying an identical failed import URL
stayed rejected. `vite-plugins/deferred-settings.ts` uses the shared
`deferred-entry.ts` plugin to emit the typed settings
entry and appends a fresh `settings-attempt` query on each load attempt, retaining
the build's hashed file and local URL. Successful loads remain shared without
further requests. The production graph check requires this entry's static JS
dependencies to belong to the initial HTML entry closure, so this recovery path
has only one cold module request. A separate emitted entry is not an HTML startup
entry; loading evidence follows the HTML entry's static closure explicitly.

The plugin also supplies a Vite development URL; native local-resource protocols,
upgrade asset consistency and module evaluation failures still need acceptance.
The complete project settings panels and their editor/runtime surroundings are
not covered by standalone browser preference tests. No automatic app reload or
new Suspense boundary surrounds the workspace.

### Deferred graph views

Desktop's overlay host and the mobile compatibility entries mount
`DeferredSuperViews`. The wrapper immediately exposes the existing navigation,
Back/Escape handling and local loading/error state. It loads a shared graph UI
entry first, then the independently emitted story or element graph body. The
shared entry owns popovers, edge rendering and geometry helpers; it imports no
desktop shell. Both bodies receive the same successful module namespace. The
element transform hook receives stable geometry helpers, preserving its existing
imperative writes, observer and animation-frame scheduler.

Each of these three module requests uses the same build's hashed asset with a
fresh `graph-attempt` query on retry. Shared-load failure prevents the body
request; a later body failure does not discard successfully loaded shared code.
The production acceptance guard requires every emitted entry's static JS
dependencies and CSS to be present in the HTML startup closure. This is necessary
because retrying an entry URL alone cannot recover a cached failed cold child.
Graph styles and the small drift-panel animation hook remain in the immediate
shell. Animation state belongs to each wrapper mount; graph, project and editor
instances are never cached with code.

Closing or switching views unsubscribes that view without aborting a shared code
request. A late result only fills the code cache and cannot reopen the old view.
When focus was in a removed loading control, ready content restores it to Back;
focus moved to another control is respected. The wrapper does not suspend or
recreate the surrounding workspace. Mounted browser fixtures check continuity
with an actual synthetic Tiptap/Yjs editor, but do not mount ChapterEditor or
ProjectRuntimeProvider. Native resource loading, mobile platform gesture paths,
full project continuity and first-use latency budgets remain separate gates.

### Intent-based code preloading

`deferred-preloader.ts` owns one speculative request and one replaceable queued
intent for the renderer. It starts after 120 ms of entry dwell and an idle
callback (with a bounded timeout), or a timer fallback. The mounted entry hook
cancels pending intent on pointer/focus departure, touch cancellation, unmount,
window blur and page hiding. Data Saver, 2G, offline and hidden pages skip
speculation. Explicit feature opening remains independent of these policies.
An already started import cannot be canceled; completion only fills the code
cache and cannot navigate or instantiate the feature.

Desktop SUPER uses the last chosen graph; graph headers and mobile structure
entries request only their corresponding graph. User-menu settings/shortcuts,
mobile right-sidebar Settings and the mobile settings index share the settings
resource. Graph module ownership is now in `features/graph/deferred-graph-modules`
so mobile entries do not import the desktop shell. Pure entry imports still
leave all heavy bodies unloaded until intent or demand.

`createDeferredModule.preload` leaves the public snapshot idle until code is
ready. A failed unused preload leaves it idle, allowing first demand to retry
normally. Demand joining a pending preload promotes that same request: success
is shared, while failure becomes a visible local error requiring explicit retry.
Each resource is attempted speculatively at most once per renderer lifetime;
failed demand is never retried merely by hover. Foreground loads bypass the
speculative queue, so a slow unrelated background import cannot block a click.
Only code is shared, with no added project/provider/document owner.

The browser acceptance exercises the actual desktop SUPER and mobile settings
entry controls with synthetic workspace navigation and a Tiptap/Yjs draft.
Pointer/focus/touch cancellation, a queued settings intent behind a held graph
request, promotion/retry and editing during preload are covered. Visibility and
connection inputs are synthetic; native lifecycle, physical touch and full
ChapterEditor/ProjectRuntime continuity and latency remain separate gates.

### Desktop editor-session continuity

`EditorMainArea` is the desktop editor-session stage. It mounts Project Home
plus one absolute surface for every open top-level leaf, split, and create tab.
The URL remains the address/selection authority, but React Router no longer
owns the lifetime of desktop editor views: inactive surfaces stay mounted with
`visibility: hidden`, `inert`, and no pointer or command ownership. Their
TipTap instances, Yjs sessions, scroll positions, selections, and field drafts
therefore survive ordinary tab switches.

Within each canonical Tiptap instance, `EntityEditorSession` owns the immutable
project/kind/entity binding, 400 ms trailing projection-save task, selection
initialization and outline snapshot. `useEntityEditorSession` attaches it in a
layout effect and updates that owner's callback without restarting its pending
task. A retiring owner flushes with its own last callback before the next source
is attached. The shared `YjsDocumentSession` continues to own CRDT durability;
this editor binding does not create another Y.Doc or undo manager.

Persistence stays active for hidden editors. Outline derivation needed by a
save is cached against the immutable ProseMirror document. For ordinary edits,
its React snapshot publishes only for visible/preparing surfaces and only when
the outline actually changes. Incoming surfaces synchronously prepare the latest
outline before reporting ready. Initial readiness also waits for Tiptap's
construction-time block-ID microtask, so outline anchors use canonical IDs.
Detach flushes pending work, cancels the owned debounce/selection-init frame,
invalidates queued preparation and removes the four editor event listeners.

`TypewriterScrollController` separately owns caret alignment, its repaint frame
and viewport ResizeObserver. `useTypewriterScrolling` passes pixel visibility
and preparation state, independently of command ownership. Hidden surfaces
detach focus/selection/update listeners, disconnect the observer and cancel both
alignment and caret-restoration work. They retain their tail CSS so browser
scroll clamping does not lose the stored reading position. The destruction
listener remains until final teardown, which also removes that retained CSS.
Position preferences and hidden resizes are applied in layout when the surface
prepares. Preparation never focuses the editor or moves its caret. Both visible
split viewports receive tail geometry; only a focused, collapsed selection can
schedule alignment, coalesced into one pending frame. This display controller
does not mutate selection, ProseMirror content or Yjs.

The semantic outline rail owns one `OutlineViewportController` for its native
scroll viewport. The four single-entity views supply their existing flat reading
order and canonical jump handlers instead of mounting a second scrollspy. One
geometry snapshot supplies offsets, viewport ranges, rail density and primary
reading location. Whole-book view keeps its controlled primary chapter and
existing jump handler. A clicked single-entity heading remains pinned while its
own bounds intersect the viewport; otherwise the existing 80 px reading threshold
and 24 px look-ahead rule choose the primary entry.

The controller coalesces scroll, mutation and resize work into one pending frame.
Ordinary scrolling reuses content-relative anchor bounds; content/size changes
invalidate them. Each resolved anchor DOM node is measured once in a full pass,
including aliases, and unchanged snapshots do not notify React. Only visible or
preparing rails attach observers/listeners. Hiding disconnects them and cancels
the frame while retaining scalar geometry/pin state; returning synchronously
prepares current geometry in layout. Removed direct content children are
unobserved, and disposal releases all observed targets. Body-portal omission
reveals and their closing timer are discarded on hide; mobile portal content
also follows actual surface visibility. The native scrollbar and document
session remain independent from this display owner.

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
synchronously; prose readiness requires canonical content, prepared outline and
current decorations. A failed projection keeps readiness false and hides the editor DOM
until a successful retry. Disposal releases this controller's listeners without
destroying the editor, Y.Doc, or persistence session. This boundary does not
pause other plugins or change document retention.

The isolated browser evidence covers actual editors, remote Yjs updates,
masking, undo, listener disposal, and the lifecycle provider/hook handshake.
The native control scenario now covers 20 full-App tabs, editor/Y.Doc identity,
undo/redo, split, hidden authored Yjs updates and SQLite materialization, outline
preparation, binding cleanup, project switches and process restart. Broader
scroll/field-draft continuity, native IME and retained-document memory budgets
remain separate acceptance work in the plan. Selection capture, review-marker
geometry and other interaction owners still need their own visibility audit;
pausing typewriter/outline work does not pause those owners.

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
described below; partial reads and native reference-index recovery remain in
the performance plan.


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

`workspace-projection-refresh.ts` owns one project/database queue with one
in-flight capture and one pending epoch. Structural events retain the interaction
barrier and start a fixed 250 ms first-arrival window; subsequent events cannot
postpone that window indefinitely. It flushes author durability before reading.
Publication checks database/project/epoch ownership and the immutable data
references observed before the read, including a separate project metadata
identity guard. Concurrent local edits or derived metrics trigger a bounded
backoff and full recapture. Stale missing/error results cannot affect a newer
request, and dispose revokes scheduled and in-flight work. The project provider
routes restore/authority changes through complete capture; pure-prose events
continue directly to background metrics.

`captureWorkspaceProjection` produces a complete workspace projection in one
SQLite transaction. Ordinary structural refreshes can reuse covered collections
from the queue's last accepted authoritative capture. A private weak ownership
map binds that capture to the exact database client; copied/serialized captures
and optimistic store rows cannot authorize reuse. Startup, explicit repair,
restore, reset, expired coverage and unknown collections use full capture.

Migration `0002_workspace_projection_journal.sql` adds a local, rebuildable
invalidation clock and bounded change journal. Triggers cover all columns of
the 17 queried domain/dependency tables and record actual row changes in the
author/materializer transaction, including historical remote winners, cascades
and derived metrics. No-op updates do not invalidate. Each project has an epoch,
revision and retention floor; after 4,096 revisions the triggers compact older
identities and readers behind the floor fall back to full capture. Generation
changes reset coverage; project deletion cascades the metadata. Neither table
is a sync/checkpoint authority or generic CLI CRUD surface. Future queried
columns must extend trigger coverage in a new migration, never rewrite a
published migration. Deleting only a damaged clock is an internal metadata
repair: its changes cascade away, reads fall back to full, and the next domain
write initializes a fresh epoch. There is no user-facing repair toggle here.

Covered metadata-only changes to up to 128 nodes read those rows. Node identity
replacement, visibility/kind/order changes or larger sets promote the node
collection to a complete read. A replacement revision catches delete/reinsert
even with identical timestamps. Other affected collections still read their
complete repository projection; full nodes/storylines include ordered membership
dependencies. Every selected result and reused slice publishes atomically.
Missing notifications are covered on the next capture; no event means no
immediate refresh promise. The first refresh owned by a new queue is full.

The store accepts only the latest requested project/epoch. After
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
sync path remain intact. The reference queue below owns derived indexing.
Renderer process recovery is checked through the file-backed SQLite adapter.
Native migration compatibility/safety snapshots are checked independently;
full Tauri renderer recovery, app performance and physical-device acceptance
remain pending F6 work. Pure Yjs commits scope reference reads as described below.

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
Pure Yjs mutation batches additionally carry a bounded, immutable `proseDocIds`
hint. Remote hints come from materialized effects after durable commit and live
Yjs reconciliation. Empty/unknown/mixed scopes use full capture. A failed remote
merge or notification remains pending for the next cycle after session recovery;
each recreated sync runtime also invalidates reference coverage once on first
apply, compensating for lost in-memory notifications without replaying receipts.
That invalidation is reference-only and does not add a workspace barrier.

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
After complete coverage, the queue merges up to 128 source identities for the
next pass. Overflow or a full invalidation clears the narrow scope. A source
request arriving during a pass stays pending; full invalidation always wins.
Missing sources, generation changes, stale results and failures return to full
capture. A narrow pass preserves other sources' acknowledged versions and never
prunes them using an incomplete catalog.

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

Pure Yjs scopes now use source-ID-filtered SQL, batched Yjs metadata and filtered
reference coverage in one capture transaction. Existence probes do not load
snapshot blobs. Startup, repair, structural/JSON patch changes and unknown
impact retain the complete path; workspace projection captures remain complete.
The read matrix records query counts, returned rows/bytes, gateway timings,
parser/replacement counts and reference publications independently. Node SQLite
timings do not establish native IPC or app-wide input performance. F6b1 adds SIGKILL and
independent-process restart checks through the file-backed product-schema
SQLite adapter. An uncached startup pass restores references after a committed
write loses its notification, or after an interrupted replacement rolls back.
The fixture checks Yjs changes, JSON patch edits and patch deletion, including
two restarts, a separate full rebuild, authoritative-table hashes and project
isolation. Only native installation identity is substituted. This proves the
renderer recovery path without a new durable progress table; it does not prove
native Rust gateway, physical-device or power-loss recovery. F6b2 extends the
matrix to interrupt the warmed runtime's scoped capture as well; every restart
still uses complete startup reconstruction.

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
