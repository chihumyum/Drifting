# Renderer performance work and evidence

The [implementation plan](optimization-plan.md) remains the scope authority.
F0 is **in progress**: the first input-path baseline is available; app-wide,
Full Agent panels, graph, reference, multi-tab memory and native/device measurements remain
NOT RUN. This initial input baseline permits the bounded F1 input-path work;
it does not satisfy unrelated phases' baseline requirements.

## Isolated editor baseline

```bash
pnpm perf:renderer
pnpm perf:renderer:check
```

The runner builds an isolated harness with Vite production optimizations and
opens a fresh, disposable headless Chromium profile. Set `DRIFTING_PERF_CHROME`
if Chromium is not in a standard installation location. It does not load the
App, read author databases, import credentials, or touch an existing browser
profile. No harness import is added to the production application entry point.

The three deterministic fixtures contain 5k/20k/50k synthetic Chinese
characters, 0/100/500 entity links and 100/1,000/5,000 synthetic entities. Every
run records a fixture hash, checkout commit plus renderer source fingerprint,
dirty state, CPU/memory/system/browser identity, raw timing samples and explicit
limitations. No usernames, personal paths, browser profile data or author prose
are written into the report. Temporary builds and profiles are removed.

Each fixture warms up with 10 transactions, counts operations across 100
insertions, then samples 60 more transactions over animation frames. The
counter pass is separate from timing, although disabled instrumentation wrappers
remain in both builds for equivalent comparison. All insertions occur outside
the existing link marks. The end document must retain the exact link count and
expected synthetic text length.

`transactionMs` measures synchronous ProseMirror dispatch, not native input.
`transactionToAnimationFrameMs` ends at a requestAnimationFrame callback, not a
compositor paint. Neither metric proves the desktop RC input-to-paint target.
The `subscriptions` field counts direct store subscriptions; the later
`reactSubscriptions` scenarios count actual committed React consumer renders.

Output defaults to ignored `.local-data/renderer-performance/latest.json`.
For a reviewed milestone, use `--output=docs/renderer-performance/acceptance/<name>.json`
and run `pnpm perf:renderer:check --report=<same-path>`. Reports are runner output;
do not hand-edit measurements. A dirty checkout is identified by its source
fingerprint instead of claiming all source was already in its parent commit.

## Fixed first input-path budgets

Before changing production source, the initial baseline recorded the following
work across 100 insertions (see generated [baseline-editor.json](acceptance/baseline-editor.json)):

| Fixture | Full link queries | Color resolutions | Style writes |
| --- | ---: | ---: | ---: |
| 5k characters / no links | 100 | 0 | 0 |
| 20k characters / 100 links | 100 | 10,000 | 10,000 |
| 50k characters / 500 links | 100 | 50,000 | 50,000 |

F1's deterministic budget for this exact unchanged-mark input trace is **zero**
full link queries, target color resolutions and color style writes. New marks
and explicit appearance changes are separate correctness scenarios and must
still acquire the current color. F1 must preserve those behaviors before a
lower counter is considered a success.

For this isolated Chromium fixture on the recorded machine, the preliminary
timing guard is synchronous transaction p95 <=2 ms for the first two profiles
and <=5 ms for the 50k/500-link profile. These are local synthetic regression
budgets fixed before F1, not advertised device capacity or native latency.
Run baseline and candidate in the same environment; if timing fails, repeat
three times and retain every report. Deterministic counters must pass every
time. Other phase budgets remain uncalibrated until their F0 scenarios exist.

## Current verification boundary

The fixture's deterministic data/target integrity is covered by Vitest.
`perf:renderer:check` validates phase dependencies, criterion IDs, evidence
paths, report identity, metric summaries, and final document integrity. A
complete phase requires passed criteria with evidence; the checker never
converts a measured synthetic report into physical-device acceptance.

The initial F0 batch passed typecheck, lint, public/CI contract checks, capability
checks (19 tests), and the full Vitest suite (2,164 passed, 1 skipped). The three
browser scenarios completed with final document integrity validated. These
results cover the baseline harness, not subsequent optimization batches.

## F1 input-path implementation

The first production optimization is implemented. Tiptap already invokes the
mark serializer for new/replaced mark DOM, so ordinary document edits no longer
scan all existing links. External appearance revisions still refresh existing
marks, with no-op CSS writes skipped. Color resolution uses shared weakly held
indexes of immutable collections instead of per-link array searches. No new
transaction-range cache or prose mutation is needed.

Generated [f1-editor.json](acceptance/f1-editor.json) records 13 browser behavior
checks, including HTML paste, undo/redo, changed mark attrs, external appearance
changes and real two-Y.Doc convergence. All six deterministic/timing budget
checks passed. Across 100 unchanged-mark insertions, all three profiles now
produce zero full-link queries, color resolutions and color style writes.
The 50k/500-link fixture's sampled synchronous transaction p95 changed from
about 13.9 ms to 0.3 ms on the recorded machine. This is an isolated synthetic
result, not a native app speedup or input-to-paint measurement.

Validation: focused appearance tests (12 passed), typecheck, lint, full Vitest
(2,167 passed, 1 skipped), public/CI contract, Agent capabilities and conversation
sync checks, and the explicitly configured production renderer build. The
production assets were checked to exclude the harness. The pre-existing large
main chunk remains for F7. Physical IME, native latency and app-wide interaction
remain NOT RUN, so F1 stays `in_progress` with partial acceptance rather than
being declared fully complete.

Reproduce the guarded candidate run with:

```bash
pnpm perf:renderer --assert-input-budget
pnpm perf:renderer:check --report=.local-data/renderer-performance/latest.json
```

## F2a explicit field subscriptions

All 25 audited whole-workspace hook call sites now request only their existing
fields with `useDataStoreFields`. This covers editor views, sidebars, desktop
graphs/timelines, mobile papers/previews/stats and shared hover content. The
helper reads one snapshot and uses Zustand's shallow equality; it does not add
another store, copy domain records, or alter project publication. Model types
used by hover/stats are narrowed to the fields they actually consume.

Generated [f2-subscriptions.json](acceptance/f2-subscriptions.json) compares the
old whole-store hook and the production field helper in mounted React consumers:

| Mounted consumers per group | Whole-store commits / 100 unrelated updates | Field-selected commits | Commits for one relevant update |
| --- | ---: | ---: | ---: |
| 1 | 100 | 0 | 1 |
| 5 | 500 | 0 | 5 |
| 20 | 2,000 | 0 | 20 |

These are isolated consumer measurements, not full-app editor or tab counts.
Changing the requested field keys and reading an atomic multi-field update
also pass. The existing input counters/budgets and 13 link behavior checks
remain passing. A new architecture test prevents whole-workspace hook calls
from returning in product components, features, views, hooks or shells.

Validation: typecheck, six architecture tests, full Vitest (2,168 passed,
1 skipped), lint (no errors; existing warnings), public/CI contract, capabilities,
conversation-sync checks and a production renderer build. Shared name/color
invalidation, record reference reuse and app-wide measurements are still pending;
this completes the F2a batch, not all F2 acceptance.

## F2b shared editor name and appearance projections

`useEntityEditor` now subscribes to shared semantic results instead of six
complete entity/ownership collections. Name collection snapshots are cached
with weak keys; metric/body changes preserve the projected name object. Project
identity and generation invalidate it, and the project runtime releases its
last projection on disposal. Self/parent exclusion and chapter-last name
collision handling remain per-editor. Color signatures are computed once per
collection snapshot, and type-color signatures include chapter/drift kind.

The runtime's writing total subscription now filters unrelated collections and
other projects' readiness changes before scanning chapter counts. It retains
the existing canonical count readiness and no-op persistence behavior.

Generated [f2-semantic-indexes.json](acceptance/f2-semantic-indexes.json) mounts
20 consumers of each subscription kind with 100 synthetic chapters and 1,000
elements:

| Change | Collection consumer commits | Name consumer commits | Color consumer commits |
| --- | ---: | ---: | ---: |
| 100 metric updates | 2,000 | 0 | 0 |
| One chapter rename | 20 | 20 | 0 |
| One category color change | 0 | 0 | 20 |

Unit checks cover name/alias/deletion/generation invalidation, self and parent
exclusion before name collisions, stable semantic identity, weak collection
reuse, explicit release, and type-color invalidation. The browser input budgets,
link behavior checks and F2a subscription checks remain passing.

Validation: typecheck, full Vitest (2,173 passed, 1 skipped), lint (0 errors,
76 existing warnings), public/CI contract, capabilities, conversation-sync
checks and production renderer build. The next batch narrows editor Review
decoration subscriptions. Broader projection record reuse, graph read models,
native interaction and remaining app-wide phase acceptance remain pending.

## F3a entity-scoped Review decorations

Review selection, decoration application and React lifecycle wiring now have
separate owners under `features/editor`. A per-editor selector ignores unrelated
entities and non-prose fields; the shared weak guard index is rebuilt only when
the guard collection changes. Empty review state no longer creates an empty
metadata transaction on every keystroke. Hidden, unselected editors defer dirty
decorations while retaining their editor, Y.Doc and existing persistence path.

The lifecycle's new `isPreparing` flag lets the incoming surface flush deferred
decorations in a layout effect before reporting ready. Readiness combines the
existing canonical document check with decoration readiness. Both visible split
panes receive presentation work even when only one owns commands. Failed
projection application hides the editor DOM until a successful retry.

Generated [f3-editor-decorations.json](acceptance/f3-editor-decorations.json)
compares the previous effect with the production controller on 20 real Tiptap
instances per group. Across 100 unrelated Review updates, decoration metadata
transactions fall from 2,000 to zero; 100 ordinary insertions with empty Review
state also produce zero decoration metadata transactions. Browser checks cover
a hidden editor receiving a real remote Yjs edit, synchronous mask preparation,
guard-to-durable-review transition, projection failure and retry, unchanged prose
and selection, undo continuity, and zero remaining controller subscriptions after
disposal. A mounted React provider/hook scenario verifies preparation before
reveal and separates split visibility from command ownership.

Validation: selector tests, continuity wiring checks, full Vitest (2,177 passed,
1 skipped), typecheck, lint (0 errors, 76 existing warnings), public/CI contract,
Agent capabilities and conversation-sync checks, production renderer build,
and the guarded browser runner/report checker. Existing input and subscription
budgets remain passing. These are isolated controller/provider checks, not the
full App's 1/5/20-tab matrix or native masking/scroll/IME acceptance. Other editor
responsibilities and retained-document memory still require work; F3 remains
`in_progress`.

## F3b editor-owned automatic linking

Automatic-link targets and enabled state now belong to each ProseMirror view.
The extension no longer writes a process-wide automatic-link configuration on
creation. `useEntityLinkConfiguration` applies live per-view changes in a layout
effect and retains the existing shared appearance/interaction wiring. A changed
configuration updates pending typing work; disabling or destroying the view
cancels its timer. Compiled matchers use weak target-map keys, so alternating
editors reuse their own matcher instead of replacing a single shared cache.

Plain-string detection now requires an explicit context. Agent prose writes
and guarded review inverses derive targets from their source entity and current
project snapshot inside the existing Yjs transaction. They no longer depend on
which editor last mounted; an unrelated project's snapshot cannot supply link
targets. Persistence, journal acknowledgement and block-revert guards retain
their existing ordering.

Generated [f3-editor-link-ownership.json](acceptance/f3-editor-link-ownership.json)
tests groups of 1/5/20 real editors, with inactive hosts kept mounted. Every
editor preserves its self exclusion after creation callbacks; updating one
view's targets leaves other views unchanged. Element self/alias and patch parent
exclusions, runtime disable/re-enable, explicit flush and disposal of queued
timers pass. Unit tests additionally prove 20 alternating immutable target maps
are compiled once each across 2,000 detections, and real Yjs review reversion
restores the target mention while leaving the source name unlinked without an
editor mounted.

Validation: 18 focused tests; full Vitest (2,181 passed, 1 skipped), typecheck,
lint, public/CI contract, Agent capabilities and conversation-sync checks,
production renderer build, guarded browser runner and report checker. Earlier
input/Review/subscription checks remain passing. These editor-instance scenarios
do not establish full-app tab navigation, native input or memory budgets. F3's
remaining session/presentation work stays in progress.

## F4 event-consumer baseline and budgets

Before changing the chat store, the browser runner now measures its actual
journal subscriber with 1,000/3,000/6,000 synthetic text events, three repetitions
per size, then replays all event IDs to check deduplication. The disposable
fixture supplies a bound conversation and no-op history refresh; no model,
SQLite, terminal persistence or React chat view is involved. The store's current
immutable record spread is the baseline implementation.

The first F4a regression budgets are fixed before the implementation: the
per-size median synchronous event-consumer duration must be at most
20/60/120 ms respectively in this recorded local Chromium environment, with
exactly one text character per accepted event and zero notifications for the
duplicate replay. These synthetic ingestion budgets do not establish native
scrolling, streaming Markdown or durable recovery performance. F4b will add
separate notification batching and control-boundary scenarios.

## F4a private journal membership

The chat run now carries an opaque, frozen scope token. A private weak map owns
the scope's Set of accepted event IDs; no mutable membership collection is
exposed to React or persisted as a recovery cursor. Successful event projection
records membership before publishing the new immutable run/messages snapshot.
An exception before projection completion leaves the event retryable.

Continuations and transport replacement retain the scope. Conversation forks
start a new scope; recovery seeds one from the canonical projection's event IDs.
Deleting/invalidation removes the run reference, allowing its index to be
collected when retained snapshots also release the token. Durable and transient
event IDs remain distinct. There is no arbitrary eviction: retained conversations
still require O(events) membership memory, and a global memory cap remains open.

The generated [baseline](acceptance/f4-events-baseline.json) and
[candidate](acceptance/f4-event-dedup.json) measure the same actual chat-store
ingress trace. The baseline median was about 38/497/2,206 ms at 1k/3k/6k events;
the indexed candidate passes the predeclared 20/60/120 ms budgets. All text is
preserved and replaying every ID adds zero notifications. The scope unit tests
also retain the earliest ID after 20,000 insertions without truncation.

Five ingress integration tests use the real transport relay and store, with
mock persistence ports. They cover equivalence with the reference reducer for
transient/consolidated thinking, tools and text; terminal persistence exactly
once; immediate permission/cancellation; transport replacement; sibling
isolation; delete/recovery/new tail; and retry after a failed projection. These
port tests do not prove real SQLite restart or device sync acceptance.

Validation: full Vitest (2,188 passed, 1 skipped), typecheck, lint (0 errors,
76 existing warnings), public/CI contract, capabilities, renderer build, browser
runner and report checker. The conversation evidence generator reran 36 renderer
and 108 native tests. Its first native run exposed time-derived MCP fixture
filenames that could collide across parallel tests; each script now owns a
unique temporary directory. The subsequent native run passed. Conversation
evidence was regenerated by its tool, including fingerprints for the new dedup
module, integration checks and native fixture helper.

F4 stays in progress: this batch removes cumulative membership copying.
Per-event UI notifications are unchanged; frame batching, chat UI performance,
scroll continuity and remaining recovery/device measurements are next.

## F4b shared chat display scheduling

Desktop and mobile chat panels now consume `useAgentChatMessages`. The hook
shares one ref-counted display projection over the existing canonical store.
Text/thinking/tool-argument deltas are tagged by immutable message-array identity
and can coalesce until the next animation frame. A 50 ms timer provides a
fallback when no frame arrives; visibility changes flush pending content, and
events received while hidden flush synchronously. Timer timing still depends on
the JavaScript scheduler; this is not a native latency promise.

Permission, cancellation, terminal, author-state and conversation/project
boundaries flush the latest canonical array immediately. Ingestion, journal
handling, control state and terminal persistence remain synchronous as before;
only the visual subscriber notifications are delayed. Existing message objects
and `MessageView` memoization are preserved. The voice workflow continues to
read the canonical selector. Last-subscriber removal cancels both callbacks,
releases source/visibility listeners and drops cached run/transcript references;
remounting reads current canonical data.

Generated [f4-chat-display.json](acceptance/f4-chat-display.json) mounts 20
immediate consumers and 20 production-hook consumers, all rendering real
`MessageView` components. One synchronous 100-event burst produces 2,000
immediate commits, zero batched commits during ingestion, and 20 batched commits
at the next frame. The canonical text is already complete before that frame,
and rendered Markdown contains the full output afterwards. Permission,
cancellation and non-stream boundaries synchronously render their pending tail.
This is a controlled burst fixture, not a claim about provider event cadence.

Six scheduler tests cover coalescing, the 50 ms fallback, hidden delivery,
controls, switching, sibling isolation and teardown/remount. A real
transport/store/display integration test additionally proves that `turn_finished`
flushes the final assistant text before the persistence port receives that same
finalized transcript. The conversation generator now executes these ingress,
dedup and display suites along with its existing recovery checks.

Validation: full Vitest (2,194 passed, 1 skipped), the subsequent added terminal
integration case, typecheck, lint, public/CI contract, capabilities, production
renderer build, browser/report checks, and regenerated conversation evidence
(50 renderer tests, 108 native tests). Full desktop/mobile panel scrolling,
selection, long-history layout, actual restart and native interaction remain
pending. F4 stays `in_progress` until its remaining acceptance is proved.

## F5 graph projection baseline and budgets

The first graph fixture calls Super Element's actual world-edge projection,
extracted without changing its filtering/geometry behavior. It uses
100/1,000/5,000 elements, one fifth as many chapters and three times as many
relations. Entity ID getters count the first and repeated projection separately;
five timing samples follow with counting disabled and warm inputs. Synthetic
getter overhead is present in both implementations, so timing is a local
regression measure rather than native graph capacity.

Before optimization, the F5a budget is at most one ID read per input entity to
construct the shared index, zero entity ID reads on a repeated projection over
the same immutable arrays, unchanged edge count/content, and warm projection
median <=10/30/100 ms respectively on the recorded local Chromium environment.
DOM measurement and React commit budgets will be measured separately in F5b.

## F5a indexed world and viewport edge projections

Super Element now builds relation labels through the same weak, immutable-array
ID index used by editor link appearance. Duplicate IDs retain the first-match
behavior of `Array.find`; replacement arrays get new indexes without a global
project cache. The pure world model owns endpoint filtering, full-project drift
exclusion, names, color, direction and target insets. The viewport model reuses
that output and only transforms coordinates and applies the existing focus
filter. Pan/zoom no longer repeats relation label lookups.

The extraction also fixes focus-only mode clamping node endpoints to a sticky
position while the chapter band itself remains at its natural position. Sticky
top/bottom behavior, fractional zoom, band-local offsets and visibility boundary
semantics have explicit regression tests. Either drift endpoint is still
excluded from the ordinary world layer independently of panel visibility.

Generated [baseline](acceptance/f5-graph-baseline.json) and
[candidate](acceptance/f5-graph-projection.json) use matching fixture hashes:

| Elements / relations | Baseline ID reads per projection | Candidate first / repeated reads | Warm median before / after |
| --- | ---: | ---: | ---: |
| 100 / 300 | 26,300 | 120 / 0 | 0.4 / 0.1 ms |
| 1,000 / 3,000 | 2,603,000 | 1,200 / 0 | 27.9 / 0.4 ms |
| 5,000 / 15,000 | 65,015,000 | 6,000 / 0 | 725.3 / 2.5 ms |

All three viewport modes additionally read zero entity IDs. Every candidate
edge is checked against independently derived fixture labels, coordinates,
ordering and styles. The report checker enforces the predeclared F5a counts and
time budgets. This measures pure projection in the isolated Chromium harness,
including synthetic getter overhead; it is not full graph render or native
interaction latency.

Validation: full Vitest (2,205 passed, 1 skipped, including 10 new model/index
tests), typecheck, lint (0 errors, 76 existing warnings), public/CI contracts,
capabilities, conversation-sync checks, production renderer build and the
browser/report checks. F5 remains `in_progress`: geometry still commits to the
large parent view, DOM endpoints can still be measured repeatedly, and full
graph gestures, cards, overlays, mobile/native interaction and clipping
acceptance remain pending. F5b will address measurement scheduling and render
ownership separately, without changing the domain relation model.

## F5b geometry budgets (declared before the scheduling change)

The isolated DOM fixture will use 100/1,000/5,000 edges over 20/100/500 unique
DOM endpoints. A necessary measurement must read each unique endpoint once;
100 scroll/resize notifications in one synchronous burst must schedule one
measurement frame. Identical geometry must cause zero React commits, and moved
geometry must update the line layer without re-rendering sibling cards. The
600 ms Super Element entry window remains bounded; pan-end must reveal only
fresh geometry, and teardown must release observers, listeners and frames.
These are count/behavior budgets; full graph/native gesture latency is separate.

## F5b Super Element Drift geometry ownership

`SuperElementDriftEdges` now owns the SVG and geometry state. The shell supplies
immutable relation descriptors, endpoint refs, selection callbacks and a
layout/filter revision. Classification remains based on the full drift ID set;
card visibility only determines whether both DOM endpoints can be measured.
Endpoint measurements are shared by DOM identity within each read phase,
including when different IDs resolve to the same element. Measurements are
never cached across frames.

One frame job coalesces scroll, resize and pan-end with the finite 600 ms entry
window. Equal output skips the state setter. The viewport resize observer and
layout/filter revision also invalidate geometry. The existing pan refs and
world transform remain in the shell; Drift measurement skips an active pan,
and pan-end leaves old lines hidden until a fresh result is committed (or the
already committed equal result is verified). Unmount releases the observer,
all listeners and pending frames.

The generated [baseline](acceptance/f5-geometry-baseline.json) measured the
extracted original helper and parent state ownership. The
[candidate](acceptance/f5-drift-geometry.json) mounts the production line
component next to synthetic, un-memoized sibling cards:

- 100/1,000/5,000 edges over 20/100/500 endpoints: layout reads drop from
  200/2,000/10,000 to 20/100/500 for each necessary measurement.
- A synchronous burst of 100 scroll/resize events over 1,000 edges drops from
  200,000 reads and 2,000 sibling-card commits to 100 reads and zero card commits.
- Unchanged output performs no line render. Moving an endpoint performs one
  line render and no sibling-card commit. Line renders are counted through the
  existing per-edge label resolver, with DOM path checks; this is not a
  production React Profiler commit measurement.
- The browser fixture verifies the entry window stops, panning does no reads,
  pan-end hides stale paths until replacement, labels/arrows and selection
  coordinates survive, filtered cards remove only dangling lines, and teardown
  leaves zero tracked listeners/observers and no later endpoint reads.

Seven new unit tests cover shared/aliased endpoints, movement across frames,
missing endpoints, equality invalidation, special drift classification and
scheduler coalescing/deadlines/disposal. Validation also includes full Vitest
(2,212 passed, 1 skipped), typecheck, lint (0 errors, 75 existing warnings),
public/CI contracts, capability checks, production renderer build and the
browser/report checker. The browser fixture is synthetic and does not mount
the full graph card tree or native shell. F5 remains `in_progress`: sticky/focus
viewport ownership, Story Graph/Timeline adoption and full desktop/mobile/native
gesture acceptance remain open.

## F5c viewport and Story Graph line ownership

The Super Element sticky/focus SVG now owns its geometry in
`SuperElementViewportEdges`. It reads current pan/zoom refs at the scheduled
frame and compares names and endpoint metadata alongside geometry. Pure band
top calculation is shared with `useSuperElementTransform`; that controller
updates world/band DOM transforms directly and observes container resize
without setting parent state. Dimension reads precede transform writes. Both
Super Element viewport line layers stay hidden at pan-end until fresh geometry
reaches the DOM.

Story Graph now builds immutable drift relation descriptors and renders them
through `StoryGraphDriftEdges`, using the shared unique-endpoint measurement
and frame scheduler with its original 500 ms entry window. The model preserves
direction, either-endpoint drift classification, hidden types and the existing
type override / source storyline / target storyline / accent color precedence.
Visible drift filtering, positioned-node changes and drag insertion changes
invalidate geometry. Native scroll remains active; desktop pointer and mobile
gesture controllers retain their existing ownership.

The first browser run caught a real observer registration gap: a child layout
effect can run before the parent viewport ref attaches. The line layer then
missed container-only resize while the band moved. The shared hook now attaches
the observer in its first scheduled frame, after all commit refs are available.
The container-resize regression subsequently passed. Generation checks continue
to prevent an older geometry commit from revealing stale lines.

Generated [f5-graph-overlays.json](acceptance/f5-graph-overlays.json) exercises
the production line components and transform hook with synthetic sibling cards:

- 100 unchanged viewport refresh events cause zero card commits and zero line
  renders. A container-height change, without a window event or React update,
  realigns the actual band DOM and SVG with one line render and zero card commits.
- Pan-ref updates preserve imperative transforms; the SVG remains hidden until
  the refreshed path is aligned. The test loads production visibility CSS and
  checks computed visibility, focus width, tooltip rename and edge selection.
- Story Graph's 1,000-edge / 100-endpoint fixture coalesces a 100-scroll-event
  burst into 100 reads and no renders. Moving a tile produces one line render
  and zero sibling-card commits. The fixture also checks direction markers,
  selected styling, click anchor coordinates, bound-card removal and teardown.

The earlier F5b browser scenarios rerun against the generalized hook. Three
additional unit tests cover metadata equality and Story Graph classification/
color precedence. Full Vitest passes 2,215 tests (1 skipped); typecheck, lint
(0 errors, 74 existing warnings), public/CI contracts, capability checks,
production renderer build and browser/report checks pass. The runner now also
fingerprints `src/styles` so production visibility CSS is covered by source
identity; earlier reports retain their original fingerprint scope.

These are component/DOM and synthetic-card measurements, not complete graph
shell or native gesture acceptance. Timeline review/adoption, end-to-end
relationship creation/navigation, large-graph card layout and desktop/mobile
device checks remain open; F5 stays `in_progress`.

## F5d Timeline budgets

Before changing Timeline hot paths, the mobile leader fixture will use
100/1,000/5,000 chapters with sparse entries. The indexed candidate must read
at most one chapter ID per input record on its first projection and zero on
repeated projections over the same immutable array. Warm projection median
budgets are 10/30/50 ms; chapter/cluster leader paths must remain equivalent.

The marker-drag fixture mounts the real shared `TimelinePin` with 20 synthetic
sibling cards and sends 100 pointer moves. Preview motion must not commit the
card tree, must coalesce guide notifications per frame, and must preserve the
continuous final coordinate at pointer-up even before the display frame.
Cancellation/unmount must remove previews and listeners without a write.

## F5d Timeline implementation and acceptance

Bottom Timeline and Story Graph now own separate, mounted-lifetime preview
instances. Only marker/act guide components subscribe. Motion coalesces into
one animation-frame publication; end/cancel clears synchronously. The pointer
handler keeps the exact last coordinate independently of the display snapshot.
`TimelinePin` owns its dragging class; `ActRail` keeps its existing rail-local
ghost. Layout cleanup removes active gesture listeners without committing a
write, and blur cancels the gesture. Project-keyed act rails prevent an old
gesture from surviving project navigation. Preview snapshots are immutable;
last-unsubscribe cancels pending frames and releases coordinates without
preventing a later StrictMode resubscription.

The mobile leader projection now shares `indexById` over immutable visible
chapter records. It preserves first-member track choice, crowded-cluster
brackets and the unplaced-preview fallback. The mobile dot/packing controller
retains its own coordinates and gestures. Desktop chapter dragging remains
imperative. Desktop cross-storyline links already use memoized world
coordinates, so this batch does not add DOM measurement to that path.

The generated [baseline](acceptance/f5-timeline-baseline.json) measures the
extracted original mobile lookup and parent-owned marker-preview state. The
[candidate](acceptance/f5-timeline.json) measures the production projection,
`TimelinePin`, `ActRail` and guide components beside synthetic un-memoized cards:

- At 100/1,000/5,000 chapters, first-projection ID reads drop from
  5,050/500,500/12,502,500 to 100/1,000/5,000; repeated projections read zero IDs
  from the same array. Independent expected paths verify coordinate output.
  The 5,000-chapter warm median changes from 301.9 ms to 0.8 ms in this isolated
  getter-based fixture; this is not a full mobile interaction latency.
- A 100-move marker burst beside 20 cards drops from 2,000 card commits to
  zero for both bottom and graph variants. Each variant publishes one preview
  notification at the display frame. The actual ActRail candidate also records
  zero card commits and one guide notification; no act baseline timing is claimed.
- Real guide DOM checks cover rail/lane alignment, graph offset and explicit
  height, dragging classes and production hit-testing CSS. Pointer-up preserves
  11.4 and 11.575 coordinates, including a commit before the display frame.
  Foreign-pointer cancellation is ignored; cancel, blur and unmount leave no
  tracked pointer/blur listeners or late marker writes. Act cancel/unmount
  likewise clear without a write.

Both reports pass `perf:renderer:check`. The candidate was regenerated after
the final renderer edits and its source fingerprint was compared with the
working tree; the recorded parent commit plus `dirty: true` describes that
pre-commit source truthfully. All earlier browser scenarios reran as part of
the candidate report.

Six additional unit tests cover frame publication, immutable snapshots,
multi-marker cleanup, surface isolation, cluster geometry and snapshot
invalidation. Full Vitest passes 2,221 tests (1 skipped); typecheck, lint
(0 errors, 74 existing warnings), public/CI contracts, capability checks and
the production renderer build pass. Build verification uses
`vite.renderer.config.ts` with the CI local-only environment; its main chunk
remains about 5.305 MB (the F7 loading work is still pending).

These synthetic component measurements do not mount the complete Timeline
shell or prove native touch, scrolling, SQLite durability or physical-device
performance. Timing includes getter-wrapper overhead even with counters
disabled; the algorithmic counts are the primary comparison. ActRail's own
rail render, mobile packing/entry rendering and full graph card layout remain
separate costs. F5 stays `in_progress`, and no device gate is marked complete.

## F6a1 snapshot-sharing budgets

Before changing workspace publication, synthetic captures will contain all 17
workspace slices, nested position/alias/block-hash values and 100/1,000/5,000
chapters with two storyline memberships each. Membership derivation must avoid
growing-array scans/copies and stay within 5/10/30 ms warm medians. Captures
containing only one changed comment must reuse every unchanged chapter record
and all 16 unaffected slices. Publication's comparison work must stay within
10/30/50 ms warm medians; it must not parse or stringify serialized body fields.

One hundred such captures beside 20 real field consumers and 20 per-record
consumers must commit neither group. A single chapter rename must update all
20 collection consumers and exactly one record consumer. Ordering, nested
values, deletions, same-project epochs, project switches, reverse memberships
and atomicity must remain correct. SQLite capture stays a full read transaction;
reference queue ownership and durable coverage/recovery are later F6 batches.

## F6a1 complete-capture sharing

`commitWorkspaceProjection` now accepts/rejects the project/epoch first and
then shares unchanged records and collections against the current same-project
state. The comparator covers every captured string/numeric/boolean field,
nested position, alias/kind/block-ID arrays and block-hash objects; it does not
trust `updatedAt` alone. Missing fields and sparse-array entries remain distinct,
and unknown non-plain objects remain new. It preserves row order and keyed/set
iteration order. Marker sorting happens before sharing. Reverse membership
updates publish atomically with forward membership, primary assignment and
entity rows, reusing unaffected per-node arrays. Loading or clearing a project
also clears the previously omitted reverse map; stale capture/error/clear
results return the current state without notifying subscribers.

Forward and reverse membership derivation use locally built sets and preserve
first-membership order, duplicate suppression and last-declared-primary behavior.
They no longer scan and copy the growing member array for every link. The
SQLite capture transaction and provider/epoch lifecycle remain unchanged.
There is no new schema, persisted cache, mutable author-state store or runtime
session owner in this batch.

The generated [baseline](acceptance/f6-workspace-baseline.json) and
[candidate](acceptance/f6-workspace-sharing.json) use matching fixture hashes:

- At 100/1,000/5,000 chapters with two memberships each, growing-array scan
  slots drop from 9,900/999,000/24,995,000 to zero. Membership input and ordered
  output are unchanged; one set insertion per link replaces the growing scans.
- A complete capture with one changed comment reuses all 100/1,000/5,000
  chapter records and the other 16 of 17 workspace slices. The baseline reused
  none. Per-record reuse remains valid across row insertion/reordering/deletion.
- For 100 such captures and 20 consumers in each group, real React field
  commits and record-selector commits both drop from 2,000 to zero. Renaming
  one chapter still commits all 20 chapter-collection consumers, while the
  per-record group commits only its one affected consumer (previously 20).

Comparison adds publication work; this is not claimed as a zero-cost change.
The report records that cost separately from membership derivation and React
commits. In the final 5,000-chapter run, membership derivation changes from
165.6 ms to 1.7 ms, while publication changes from 1.0 ms to 3.0 ms. All
predeclared per-size budgets pass. The synthetic capture includes serialized body strings but performs
no SQLite read, so it cannot establish database speed or total project-refresh
latency. Actual reference parsing and writes remain on their previous paths.

Unit coverage checks all 17 slices, timestamps that stay unchanged, nested
edits, sparse arrays, unknown value types, bounded comparison reads, ordering,
stale epochs, project reset, and atomic forward/primary/reverse updates. The
impact table in the implementation plan separates prose, metrics, metadata,
relations, lifecycle changes and restore/generation changes. Reference queue
ownership, source-version checks, durable recovery and partial reads remain
open; F6 stays `in_progress` and its reference/recovery gates are not passed.

Validation: 2,247 Vitest tests pass (1 skipped); typecheck, lint (0 errors,
74 existing warnings), CI/public contracts, capability checks and the CI-configured
local-only renderer build pass. The new comparator's final array correction
was followed by the full suite, typecheck, focused lint and production build.
The browser report is regenerated from the final renderer source; its source
fingerprint and both report contracts are checked before the batch is committed.

## F6a2 reference transaction boundary

This batch prepares `services/reference-index-repository.ts` for a project-owned
reference queue. The existing `ProjectRuntimeProvider` rebuild and editor
reference writes still use their original paths. Their migration will happen
together in the next batch; this evidence does not claim a runtime speedup or
that the original race is already removed from the app.

The new boundary binds all work to one database/project owner. It captures
active source rows and Yjs version metadata in a consistent SQLite transaction,
then prepares only requested sources from persisted Yjs snapshots/updates.
JSON is used only as a seed when no durable Yjs state exists, or as the body
of a JSON-only patch. Metadata, metrics and materialized-cache changes do not
change a Yjs source version. Revision-zero snapshots, missing state with a
positive revision, incomplete Yjs dependencies and invalid JSON have explicit
tests. It neither flushes live documents nor writes prose, revisions or
generations.

Before replacement, the transaction rechecks owner, project incarnation,
generation, source existence and source version. Old preparation/results are
rejected. Revocation while queued or during SQL, failed insertion and failed
commit cannot leave a half-replaced index. Cleanup rechecks live source
existence in its write transaction, respects trash and patch-parent lifecycle,
and preserves other projects and unsupported source formats. The existing
inline-mention repository also now scopes replacement deletion by project.

The generated [boundary report](acceptance/f6-reference-boundary.json) contains
28 passing test cases against temporary files using the complete product
migration journal, WAL, FULL synchronization and the existing renderer database
gateway adapter. Cases cover all five source kinds, out-of-order results,
database/generation switches, seed-to-Yjs promotion, compaction, consistency,
rollback/retry, deletion, restore and cross-project predicates. Reproduce it:

```bash
pnpm reference:index:acceptance
pnpm reference:index:acceptance --check
```

The generator runs the real tests, sanitizes the result to test names/statuses
and durations, and fingerprints renderer source, migrations and runner inputs.
It refuses source changes during a run. Test duration is diagnostic, not a
performance budget. Neither raw databases nor raw test output are committed.

This is **in-process transaction-boundary acceptance**. A project queue is not
connected, and no process has been killed at commit/queue/index boundaries.
Durable recovery, runtime parsing counters, full-app/native/physical-device
acceptance and partial reads remain open. F6 stays `in_progress`; its recovery
criterion remains without evidence. No schema or published migration changed.

Validation: 2,275 Vitest tests pass (1 skipped); typecheck, lint (0 errors,
74 existing warnings), CI/public contracts, capability checks and the CI-configured
local-only renderer production build pass. The generated 28-case boundary
report and its final source fingerprint are checked separately. The production
bundle remains approximately 5.31 MB; this batch makes no startup claim.

## F6a3 project reference queue

The project runtime now retains one queue per SQLite client/project after boot
is ready. Both previous projection writers have been removed: the provider no
longer launches unowned full rebuilds, and `useEntityEditor` no longer projects
its live document on save or mount. Ordinary durable commits, Agent-owned
commits and remote project events schedule this queue. The existing prose-only
sync branch, structural refresh barrier, workspace epoch publication and live
Yjs ownership remain unchanged.

Agent outer transactions previously bypassed the ordinary authored commit
listener. `afterDatabaseCommit` now bridges them only after the outer gateway
commit succeeds. Successful savepoints retain callbacks; failed savepoints,
outer rollback and failed commit discard them. A failed observer neither rejects
an already-committed write nor prevents the remaining observers from running.
Reference replacements participate in the lifecycle settlement drain, while
handled index failures remain in the queue rather than failing a concurrent
workspace-refresh barrier.

Queue behavior and ownership:

- A 250 ms window starts with the first notification and cannot be prolonged
  by a continuous notification burst. Work arriving during a pass becomes one
  following request. The worker yields every 16 attempted sources.
- Successful source versions and their projected row counts are acknowledged
  only after commit. Unchanged prose and matching coverage skip preparation and
  replacement. Coverage counts detect rows removed by lifecycle cleanup even
  when source prose is unchanged; unsupported source formats are preserved.
- A source failure leaves its old rows intact while other sources can progress.
  A single retry timer backs off through 1/2/4/8/16/30 seconds and caps there.
  New commits can advance a backed-off retry. No unbounded task list is retained.
- Explicit retry, restore and authority changes revoke in-flight work before
  replacing the repository owner. Last release cancels timers/yields/listeners.
  Database identity is checked even if the next database reuses the project ID.
  Immediate release/reattachment starts fresh coverage.
- JSON-only patch create/update/delete commands are covered through their real
  authored transaction path. Patch cards no longer run a separate late SQLite
  reference deletion after the command returns; the queue owns that cleanup.
- The reference area shows a retry action only on failure. Its status observer
  selects the error boolean and does not retain the queue. Reference reads also
  reject results from older requests or a replaced database.

The generated [queue report](acceptance/f6-reference-queue.json) combines 58
passing transaction/SQLite integration tests with an isolated Chromium run of
the actual status component, production styles and translations. The browser
uses a fixture status seam and React's production profiling renderer. The real
service/commit wiring is covered separately by SQLite integration tests.
Reproduce and validate the current evidence with:

```bash
pnpm reference:index:acceptance
pnpm reference:index:acceptance --check
```

The earlier F6a2 report remains a historical snapshot; the runner now writes
the F6a3 queue report. The generator records the source fingerprint before
tests, runs SQLite and browser work sequentially, then rejects source changes.
Only synthetic fixtures, sanitized results and code are committed; local
screenshots and temporary databases are excluded.

Observed operation counts: a 100-source project prepares/writes all 100 on
startup, 0 after metadata-only changes, and exactly 1 after a single body change.
One hundred coalesced notifications produce one subsequent catalog pass. A
failed source retry reuses the successfully committed sources. In the actual
status component, 100 healthy notifications produce 0 additional React commits;
failure/retry/recovery, project switch and unmount checks pass. Chinese/light
and English/dark layouts fit a 375 px viewport, and Chinese/light fits 1,280 px.
Screenshots wait for the real theme transition to finish before inspection.

**Read-cost limitation:** every pass still reads the full source catalog,
including JSON bodies, database-wide Yjs version metadata and project reference
coverage counts; orphan cleanup also re-reads source existence. Pure prose
commits now enter this catalog path, whereas the previous local editor writer
projected just its live document. This batch establishes one durable writer and
reduces parsing/replacement scope; it is not evidence of lower SQLite cost or
better end-to-end input latency. F6b must measure and narrow those reads after
the recovery gate. Test durations are diagnostic, not performance budgets.

Owner restart and fault injection are tested in-process. Process kills at
commit/queue/index boundaries, full-app/native/physical-device performance and
partial reads remain unverified. F6 stays `in_progress`, and F6-04 remains without
recovery evidence. No migration or authoritative prose format changed.

Final validation: 2,301 Vitest tests pass (1 skipped); typecheck, lint (0 errors,
74 existing warnings), CI/public contracts, capability checks and the configured
local-only renderer production build pass. The 58-case SQLite/transaction report
and browser checks are regenerated after those checks, in isolation, and their
source fingerprint is verified before commit. The renderer main bundle is
approximately 5.32 MB; native startup performance remains unmeasured.

## F6b1 — Reference index process recovery

The new `f6-reference-recovery.json` report records 46 real SIGKILL cases and
92 independent restart processes. The matrix uses two synthetic inputs for
each Yjs edit, JSON patch edit and patch deletion at these boundaries:

- Before the authored outer commit, and after commit before notification.
- While the initial project queue is waiting, and after its catalog read.
- After the affected source's index DELETE or INSERT, with the transaction open.
- After the affected index transaction commits but before the queue acknowledges it.
- After the project queue completes and acknowledges the pass.

Deletion has no corresponding source INSERT, so that matrix cell is excluded.
Boundary hooks wrap the real database adapter calls, execute the underlying
operation first where appropriate, and hold the child alive until its parent
receives the boundary message and confirms a SIGKILL exit. No worker shutdown,
database close or checkpoint runs on the kill path. Each child has a timeout;
temporary databases are removed after all owned child processes have exited.

Each fixture starts with all five source kinds, two marked blocks per source,
a deliberately stale node JSON cache and a second project's reference sentinel.
The native installation identity is replaced with a synthetic identity; actual
authored commands, production journal validation, database transaction adapter,
reference repositories and project service run unchanged. SQLite files use WAL,
FULL synchronization and the complete product migration chain.

Recovery opens the same file in a new process, retains the actual project service
and waits for its startup reconciliation. It compares every reference target and
span against an independent fixture oracle, then against an uncached full rebuild.
Hashes of every non-reference application table prove authoritative prose,
revisions, sync journal and receipts survive the expected commit boundary and
are unchanged by both rebuilds. Uncommitted replacement rows must roll back;
the second project's full rows, foreign keys and SQLite integrity are checked.
A second new process repeats recovery and must produce the same semantic result.
Derived row IDs/timestamps may be regenerated; they are not author authority.

Reproduce and check the generated report with:

```bash
pnpm reference:index:recovery
pnpm reference:index:recovery --check
```

The report fingerprints renderer sources, schema, reference acceptance scripts,
configuration and dependency manifests before execution and rejects changes
during the run. No local database, synthetic body dump or personal path is
committed. This is a correctness check, with no performance timing claim.

This closes the renderer/file-backed-adapter process-recovery step needed before
narrowing reads. F6-04 remains partial for native Rust gateway/device acceptance;
SIGKILL does not simulate disk failure, OS crash or power loss. The current full
catalog read cost on prose commits remains unresolved. No migration, durable
progress table, author write behavior or product UI changed in this batch.

The regular suite passes 2,301 tests with 1 skipped. Typecheck, lint (0 errors,
74 existing warnings), CI/public contracts, capability checks and the configured
local-only renderer production build pass. The reference queue/UI report is
regenerated separately against the shared source fingerprint after the process
matrix finishes. No browser performance measurement runs alongside the matrix.

## F6b2 — Scoped reads for durable Yjs commits

Ordinary authors, Agent outer transactions and remote materialized prose commits
now provide renderer-only `proseDocIds` hints. Only non-empty, entirely Yjs prose
scopes are eligible. Unknown document formats, mixed/structural mutations and
more than 128 unique IDs use full capture; the wire protocol and persisted
journal format are unchanged. Agent scopes are captured before commit and only
delivered after the owning outer transaction succeeds.

After an initial complete pass, the project queue merges up to 128 pending source
identities. A full invalidation wins over narrow hints. Hints arriving during a
pass remain pending. Missing sources, generation changes, stale versions and
failed replacements require complete capture again; failures retain bounded
backoff. Narrow passes preserve unrelated acknowledgements and do not prune
against incomplete catalogs. Startup, repair, restore, JSON patch/structural
changes and unknown impact keep the full path.

The repository batches source-ID predicates, Yjs revision/existence metadata
and reference coverage counts inside one capture transaction. It uses the same
source-version checks and atomic replacements as full capture. Existence checks
read IDs rather than snapshot blobs. An empty metadata filter returns no rows;
an empty source capture is rejected rather than silently selecting everything.

The remote runtime now retries a post-commit project notification if live Yjs
reconciliation or notification delivery failed: a durable receipt cannot replay
that change-set to regenerate its event. A recreated sync runtime separately
invalidates reference coverage once on its first apply. This covers discarded
in-memory notifications while preserving pure-prose continuity and the existing
structural workspace barrier. It does not add reference work to the prose write
transaction or change provider contracts.

The current generator writes `f6-reference-reads.json`; the F6a3 queue report is
retained as historical evidence. It runs behavioral tests first, then the SQLite
read matrix in its own process, then isolated Chromium. The 97 cases cover scope
classification, SQL filtering, source coalescing/overflow, stale results, project
and generation isolation, retry, remote notification repair and existing index
transaction guarantees. In the read matrix, a source has 8,200 synthetic text
characters; 64- and 1,024-source projects alternate the current full fallback and
selected capture after changing one durable Yjs body. Each mode warms once and
then supplies five samples. Both modes must parse/replace exactly one source and
publish one reference change. Returned rows/bytes, query counts, query time and
observed pass time are recorded separately.

Measured medians of five samples (full capture → selected capture):

| Sources | Queries | Returned rows | Serialized bytes | Gateway query time |
| --- | --- | --- | --- | --- |
| 64 | 33 → 21 | 276 → 22 | 1,205,443 → 127,463 | 0.64 → 0.25 ms |
| 1,024 | 33 → 21 | 4,116 → 22 | 17,533,075 → 127,463 | 5.34 → 0.28 ms |

The selected path stays at 22 returned rows in both project sizes. Observed pass
medians are 3.81 → 2.11 ms and 20.21 → 2.37 ms respectively, including the
measurement overhead described below; these are not native interaction budgets.

This compares two paths in the current checkout, not historical renderer builds.
Returned bytes count serialized query results, not disk pages. SQL time measures
the Node SQLite gateway; observed pass time also includes result serialization
for the counters. These timings do not establish native IPC or input latency.
The browser report separately preserves zero additional status-component React
commits for 100 healthy notifications; no complete app render-cost claim is made.

The recovery matrix now includes a warmed runtime processing a scoped Yjs hint,
expanding to 62 SIGKILL cases and 124 independent restart processes. Boundary
markers freeze the child JS thread synchronously with `Atomics.wait` so a queued
zero-delay timer cannot run between readiness and the parent's SIGKILL. Scoped
catalog SQL is observed at the relevant boundaries. Recovery always uses the
complete startup path and compares it to the independent span oracle and full
rebuild. Native Rust/device and power-loss recovery remain unverified.

```bash
pnpm reference:index:acceptance
pnpm reference:index:acceptance --check
pnpm reference:index:recovery
pnpm reference:index:recovery --check
```

Regular validation passes 2,323 tests with 1 skipped, typecheck, lint (0 errors,
74 existing warnings), CI/public contracts, Agent capability checks and the
configured local-only renderer production build. No schema migration, author
data format or visible UI changed. Structural workspace partial reads, native
acceptance and full-app performance remain open; F6 stays `in_progress`.

## F6b3 — Bounded structural refresh ownership

`workspace-projection-refresh.ts` now owns one project/database refresh queue.
The ready project provider retains the event routing, metric reconciliation and
project/tab publication callbacks. Structural events immediately request the
existing interaction barrier; the first arrival starts a fixed 250 ms capture
window. Later arrivals share the pending epoch instead of extending the timer
indefinitely. There is at most one in-flight capture and one pending request.
Arrivals during a read supersede it and schedule a later full capture.

The queue waits for pending author durability, captures a complete SQLite
snapshot, then checks project, database, epoch and the data references observed
before the read. Immutable local reducers and metric reconciliation can advance
these references without advancing the epoch. Such changes now reject the old
snapshot and schedule another read, with 500 ms to 4 s bounded backoff during
repeated conflicts. Project metadata has its own identity check so an in-flight
rename is not overwritten. Missing-project results use the same data guard;
stale missing/error results cannot clear or fail the newer request. Disposal
revokes both scheduled and in-flight work. Restore and authority changes request
a complete refresh. Pure-prose notifications still only schedule background
metrics; reference-only coverage invalidation does not acquire this barrier.

Bootstrap also checks database ownership before publication and only reports a
missing/error boot state when the corresponding store epoch accepts it.
`workspace-projection-sharing.ts` has a type-checked list covering every workspace
slice, so adding a slice requires extending the capture guard.

The generated `acceptance/f6-workspace-refresh.json` records 28 passing cases,
including 19 file-backed SQLite queue cases and the existing store/wiring guards.
It covers atomic node/membership publication, continuous arrivals, author flush,
local title/word-count/project-name races, newer full projections, stale missing
and error results, retry backoff, project/database revocation and replacement
owners. Fixture writes and delayed results exercise these boundaries without
claiming to run the full React provider or native shell. Timers are virtual;
this report makes no performance or physical-device claim.

```bash
pnpm workspace:refresh:acceptance
pnpm workspace:refresh:acceptance --check
```

**At the end of F6b3, partial workspace reads remained unimplemented.** Inspection found that
`reduceSyncChangeSet` produces the canonical historical effect set, and the
remote production kernel rematerializes its enabled effects. Therefore the
current change-set's mutation IDs alone are not a sufficient dependency closure.
A narrow read must account for the complete actual materialization impact and
prove notification coverage against durable receipts, or use an independently
verified change in materialization semantics. Unknown, oversized, restored or
untrusted coverage must continue through full capture. This prerequisite was
not bypassed by assuming that an event names every changed row; F6 remains
`in_progress`.

Validation for this batch: 2,342 tests pass with 1 skipped; typecheck, CI/public
contracts, Agent capability checks and the local-only renderer production build
pass. Lint reports 0 errors and the same 74 existing warnings. The production
main chunk remains about 5.32 MB before gzip; F7 loading work is still pending.
The reference read/UI and SIGKILL reports are regenerated against this source,
separately from the new workspace correctness report. Earlier F6b2 timings above
remain that batch's historical measurements, not a new workspace speed claim.

## F6b4 — Covered workspace collection and node reads

Ordinary structural refreshes now use a durable SQLite invalidation cursor.
The remote reducer continues to rematerialize its canonical historical winners;
no wire hint is treated as the complete set of changed entities. New migration
`0002_workspace_projection_journal.sql` observes actual changes to all columns
of 17 domain/dependency tables with triggers in the same transaction. The two
metadata tables are excluded from authored sync/checkpoints and generic CLI
CRUD. Published migrations 0000 and 0001 and their schema snapshots are unchanged.

Each project clock has an epoch, revision and retention floor. Change identities
coalesce, and triggers compact when the retained revision range exceeds 4,096.
Readers behind that floor, with a missing/reset clock, after generation changes,
or with unknown collections capture the complete workspace. Capture does not
consume or acknowledge journal rows. A lost notification is repaired on the
next capture; without another event there is no immediate-refresh guarantee.
Startup, restore, explicit repair and a new queue's first refresh remain full.

The queue reuses only its last accepted **authoritative capture**, bound to the
same database by a private weak ownership map. Current optimistic store rows
cannot serve as an authoritative base; the store still uses the separate
pre-read reference guard to reject concurrent edits. Metadata-only changes to
up to 128 nodes fetch those rows. Identity replacement, visibility/kind/order
changes and larger batches read the complete node collection. The journal's
replacement revision distinguishes a delete/reinsert even with identical IDs,
timestamps and book order. Other affected collections still read completely.
Full nodes/storylines include the ordered membership dependency. Trash iteration
order, mappings and all dependent slices remain part of one atomic publication.

`acceptance/f6-workspace-reads.json` records 84 passing behavior/measurement
cases and 18 native database tests. Coverage exercises all collections, no-op
writes, timestamp-independent invalidation, rollback, project/ID moves, cascade
closures, retention compaction, reset/generation/database ownership, historical
remote winners and delayed partial captures racing local edits. The native
upgrade test covers both published prefixes (0000 and 0000+0001), success and
injected failure, using the actual shadow migration and verified same-version
safety snapshots. The native migration SIGKILL matrix also runs; it is distinct
from renderer queue process recovery.

`acceptance/f6-workspace-recovery.json` records 20 actual SIGKILL cases and 40
independent restarts: node metadata and an element collection change, two seeds,
interrupted before/after the authored commit, while queued, after capture before
publication, and after publication. It executes the real authored transaction
runner, canonical journal/validation, capture and store queue on disposable
WAL/FULL files. The parent observes the exact boundary before killing the frozen
child. Each fresh process takes the full path, checks a fixture field oracle and
an independent full capture, and verifies all persistent rows—including journal,
coverage metadata and the other project—remain unchanged by recovery.

```bash
pnpm workspace:refresh:acceptance
pnpm workspace:refresh:acceptance --check
pnpm workspace:projection:recovery
pnpm workspace:projection:recovery --check
```

These commands generate the current F6b4 evidence; `f6-workspace-refresh.json`
remains the historical F6b3 report. Source fingerprints cover renderer/migrations,
the workspace runners, native Rust dependencies and CLI schema accountability.
The broader reference read/recovery evidence is regenerated separately for this
checkout. None of these reports proves full Tauri renderer restart, physical
input, power-loss recovery or end-to-end app latency. F6 stays `in_progress`.

The isolated read experiment uses one warm pair, then five alternating
full/covered pairs. Each synthetic project has the listed number of nodes and
prose-bearing elements, with 8,200 body characters per added element. Only one
node title changes before each capture. Both paths publish exactly one node
collection update and match the same authoritative full projection.

| Added entities per kind | Queries full → covered | Returned rows | Serialized result bytes | Median capture | Median store publication |
| --- | --- | --- | --- | --- | --- |
| 64 | 22 → 4 | 149 → 4 | 554,792 → 384 | 2.11 → 0.47 ms | 0.128 → 0.025 ms |
| 1,024 | 22 → 4 | 2,069 → 4 | 8,839,537 → 385 | 23.94 → 0.69 ms | 1.274 → 0.058 ms |

Trigger writes have a measurable cost. A separate disposable-fixture control
saves, drops and restores exactly the three node triggers; it does not add a
product disable switch. Five alternating pairs each run 200 title updates in
one transaction after warmup:

| Added entities per kind | Median transaction without tracking | With tracking | Additional time per update in this batched control |
| --- | --- | --- | --- |
| 64 | 3.22 ms | 15.90 ms | 0.063 ms |
| 1,024 | 3.12 ms | 23.04 ms | 0.100 ms |

These compare paths in the same checkout and Node SQLite gateway, not native
builds. Returned bytes are serialized query results rather than disk pages;
capture time includes counter serialization. `queryAwaitMs` is a sum of
potentially overlapping asynchronous gateway calls, so it is neither SQL CPU
time nor an additive wall-clock phase. Store timing excludes the full React
render tree. Batched writes do not model a separate fsync or native IPC per
keystroke. Raw samples are preserved; no native latency budget is asserted.

The completed batch passes 2,382 regular tests with 1 existing skip, typecheck,
lint (0 errors, 74 existing warnings), CI/public contracts, Agent capability
checks, CLI inventory generation checks and the configured local-only renderer
production build. Reference recovery also passes 62 SIGKILL cases and 124
independent restarts against the updated schema. No author database was opened
or migrated for these checks.

## F7a baseline — Libraries loaded before feature use

The production renderer graph eagerly imported the PDF engine from both the
platform thumbnail fallback and the library preview, and JSZip from relational
Markdown export. `acceptance/f7-libraries-baseline.json` records an actual build
of that source before changing the imports. The runner uses the product Vite
config/entry, adds two module evaluation counters plus a synthetic invocation
API only in the acceptance build, and observes parsed scripts and local resource
requests through an isolated Chromium profile. Both libraries evaluate and are
parsed before either feature is used. The static entry dependency closure is
5,777,492 bytes of JavaScript (uncompressed, including observation code).

The same run renders a generated red-rectangle PDF to JPEG once and then twice
concurrently, verifies dimensions and pixel color, and independently validates
the synthetic Markdown ZIP with Python zipfile. The plain browser has no native
bridge, author database or account. This proves module loading and these library
operations, not App readiness, native resource recovery, UI continuity or startup
latency. The fixture, runner and baseline are committed before the deferred
implementation so the original build remains reproducible.

```bash
node scripts/run-renderer-deferred-libraries.mjs --baseline
node scripts/run-renderer-deferred-libraries.mjs --baseline --check
```

`--baseline` must run on this baseline checkout. Later checkouts use the default
deferred-mode runner; baseline checking validates the historical report without
claiming its source fingerprint matches a modified implementation. Other F7
feature loading boundaries and all F7 native/app performance gates remain open.

## F7a — Deferred PDF/ZIP loading and document ownership

The shared PDF loader now imports the legacy engine and its Vite-managed local
worker URL only for a PDF operation. Both preview and thumbnail use that runtime;
the native platform object, non-PDF signature checks and image/text previews no
longer import the engine eagerly. JSZip loads when an archive is actually built.
No route, editor session, project provider or native event listener is deferred
in this batch.

The preview's native read → module load → PDF task sequence has one explicit
owner in `pdf-preview-document.ts`. Closing before either await resolves prevents
a late task. Closing a ready/loading document or handling its parse failure
releases the task once. File-path replacement resets the PDF leaf, while changing
language translates an error key without restarting the document. Thumbnail
cleanup now includes parse failures before the first page and resets temporary
canvas memory after rendering/encoding failures. The export durability, local
source capture, Yjs authority and native save/cancel contracts are unchanged.

The baseline is reproducible at commit `83afe28`; its source fingerprint was
verified in a clean detached checkout. The deferred report is generated by:

```bash
pnpm perf:renderer:libraries
pnpm perf:renderer:libraries --check
```

| Recorded browser build | Static entry JS dependency bytes | PDF evaluated/parsed before use | ZIP evaluated/parsed before use |
| --- | --- | --- | --- |
| F7a baseline | 5,777,492 | Yes | Yes |
| F7a deferred | 5,188,855 | No | No |

The recorded entry footprint decreases by 588,637 bytes (about 10.2%). The PDF
runtime chunk is 489,751 bytes and the ZIP chunk 96,793 bytes. Build ownership,
static import closure, actual browser parsing and module evaluation are checked
separately; adding a dynamic import while retaining an eager path would fail.
These footprints include observation code. The current diagnostic API also adds
failure/resource checks after the baseline; the counts describe the two recorded
test builds. Dependency exclusion is verified directly. The normal production
build was separately checked to contain none of the acceptance observers.

The browser renders the same synthetic 457-byte PDF into a 120×60 JPEG and checks
red pixels; concurrent repeated calls evaluate the engine only once. A corrupt
PDF rejects, then a fresh valid request succeeds. Five real Worker constructions
and five terminate calls are observed, all using the emitted local worker asset.
Page-level CDP reported zero dedicated-worker targets in this environment, so
native Worker calls are recorded by an acceptance-only subclass that preserves
construction, message delivery and termination. Zero remaining means every
observed PDF worker received terminate; it is not an OS memory measurement.
ZIP bytes are independently decompressed and CRC-checked with Python zipfile.

First PDF invocation diagnostics are 76.6 ms in the baseline and 90.8 ms after
loading is deferred; repeated concurrent invocations are about 32 ms and 33 ms.
This is one first invocation in each run, includes JPEG decode and observations,
and is not a statistical startup or interaction budget. The load cost moves to
first use; full-app readiness and first-feature budgets still require measurement.

`acceptance/f7-libraries-deferred.json` includes 43 passing focused tests covering
native transport contracts, local relational export, caller-buffer preservation,
parse/render/encode failure cleanup, closure during native/module/document waits,
replacement previews and a new request after a controlled loader failure.
A controlled rejected loader is distinct from retrying a browser-cached failed
module fetch; failed chunk retrieval, native offline paths and physical input
remain untested. Full React preview interaction is not mounted by these tests.

The batch also passes 2,396 regular tests with 1 existing skip, typecheck, lint
(0 errors, 74 existing warnings), CI/public contracts, Agent capability and
renderer architecture checks, and the configured production renderer build.
Only this F7 acceptance report is regenerated here; earlier phase reports remain
historical evidence of their recorded source, not fresh native or performance
claims. F7 remains `in_progress`, with settings/routes/graphs, robust chunk
failure recovery and native/app startup gates still open.

## F7b — Shared deferred settings with local recovery

Three settings surfaces previously imported the same heavy panels statically.
Deferring only the project modal would leave standalone desktop/mobile imports
in the startup graph. The six panel groups now share `settings-panels.ts`, loaded
when an actual panel is requested. Existing headers, navigation, search/selection,
Back/close handlers and the project runtime stay in their original owners.
Mobile's settings index loads no panel code. `TrashSettingsPanel` is independent
so the project's mobile Trash entry does not import the entire preference module.

`createDeferredModule` coalesces requests, retains successful code and exposes a
local failure with explicit retry. It stores no feature instance or document.
The first browser experiment demonstrated that clearing a rejected application
Promise did not recover a cached failed import URL. The Vite plugin now emits a
settings entry and uses a new query for each attempt to import that same hashed
file. This avoids forcing a workspace reload. The production graph check verifies
that all static dependencies of that entry already belong to startup's HTML
entry closure; it does not claim recovery for another untested cold dependency,
module evaluation error, missing upgrade asset or native resource protocol.

The reports are generated with:

```bash
pnpm perf:renderer:settings --baseline
pnpm perf:renderer:settings
pnpm perf:renderer:settings --baseline --check
pnpm perf:renderer:settings --check
```

The baseline command builds an isolated detached checkout of `4a6734d` using its
actual production configuration and source. Both graph measurements add the same
six evaluation counters; neither injects the UI fixture into `main.tsx`. The
separate emitted settings entry is excluded from startup unless it belongs to the
HTML entry's static closure. The earlier PDF/ZIP runner now uses this same HTML
entry distinction for future measurements; its existing reports remain historical.

| Production entry observation | Before settings deferral | After |
| --- | ---: | ---: |
| Initial static JS dependency bytes | 5,187,486 | 5,012,890 |
| Settings panel groups evaluated before use | 6 | 0 |
| Settings panel groups in parsed startup scripts | 6 | 0 |

The observed initial JS footprint falls by 174,596 bytes (about 3.4%). The emitted
settings entry is 173,262 bytes. This describes JS dependency bytes and actual
browser parsing/evaluation, not startup latency, gzip transfer savings or an F0
budget result. Source fingerprints and exact baseline commit are recorded.

A separate production build mounts the real desktop/mobile standalone settings
in a synthetic MemoryRouter, with real preference panels and localStorage. It
fails an actual module request, retries the same file with a fresh query, holds
the retry during user navigation, then releases it. Both surfaces pass:

- Local error and retry, with header/Back still available.
- Selection through real navigation buttons while content is loading.
- Return to the shelf during the held request, without late settings mounting.
- Real Language and Appearance panels after retry; language changes persisted.
- Reopening from the module cache without a loading-status subtree appearing.
- The same synthetic draft textarea and its owner surviving all transitions.

The desktop project modal is additionally opened while its module request is
held and closed with a browser keyboard Escape event. Its actual project panels
are not mounted in this fixture. The sentinel is not a prose editor or a project
runtime. The mobile run uses a 390×844 browser viewport and route Back buttons;
it is not an Android hardware-Back, WebView or physical-device test. Error-state
screenshots were inspected locally and contain only synthetic fixture UI.

The report includes 77 focused tests for module request ownership and existing
settings/routing contracts. A new ordinary architecture test rejects static
imports that bypass the deferred settings entry, including the Trash path that
caused the original indirect dependency. The Vite development URL also opens the
real Language panel in a browser. The normal production build contains neither
the fixture API nor panel evaluation observers.

The batch passes 2,401 regular tests with 1 existing skip, typecheck, lint
(0 errors, 74 existing warnings), CI/public contracts, Agent capabilities,
7 renderer architecture tests and the configured production renderer build.
Earlier phase artifacts are historical; only
the settings reports are regenerated here. F7 remains `in_progress`: full project
settings, graphs/other overlays, native loading/upgrade paths, first-use budgets
and complete editor/runtime continuity still need acceptance.


## F7c — Independent graph entries and recoverable shared UI

Desktop overlays and mobile compatibility entries now defer the story and
element graph bodies separately. The immediate wrapper retains navigation,
Back/Escape and a local loading/error state. It first requests the shared graph
UI (popovers, edges and geometry helpers), then the selected body. Each entry
has an independent fresh-query retry, while successful shared code is reused.
The wrapper owns only its drift-panel animation and loading focus. Project,
editor and graph instances are not retained in the code cache.

An initial split exposed cold shared dependencies: retrying the failed root URL
would leave a failed canonical child import cached. Shared graph UI therefore
has its own explicit loading owner. The production guard verifies that all
remaining static JS and CSS dependencies are already in the HTML startup
closure. Moving ElementCardPopover to the shared feature changes its import
paths only. The element transform hook receives stable geometry helpers, so
its observer and frame scheduler retain their existing lifecycle.

```bash
pnpm perf:renderer:graphs --baseline
pnpm perf:renderer:graphs
pnpm perf:renderer:graphs --baseline --check
pnpm perf:renderer:graphs --check
pnpm perf:renderer:settings --report=docs/renderer-performance/acceptance/f7-settings-after-graphs.json
pnpm perf:renderer:settings --report=docs/renderer-performance/acceptance/f7-settings-after-graphs.json --check
pnpm perf:renderer --output=docs/renderer-performance/acceptance/f7-graphs-regression.json
pnpm perf:renderer:check --report=docs/renderer-performance/acceptance/f7-graphs-regression.json
```

The graph baseline builds clean detached `d7e8c9a`; both production measurements
use the actual main entry/config with the same three module-evaluation counters.
A separate build mounts the synthetic interaction fixture. Historical F7a/F7b
reports remain unchanged; the explicit settings report above records the current
shared-plugin regression instead of overwriting F7b evidence.

| Production entry observation | Before graph deferral | After |
| --- | ---: | ---: |
| Initial static JS dependency bytes | 5,013,055 | 4,923,305 |
| Story, element and shared UI evaluated before use | 3 | 0 |
| Those modules in parsed startup scripts | 3 | 0 |

Initial JS dependencies fall by 89,750 bytes (about 1.8%). The separately emitted
shared UI/story/element entries are 23,747 / 29,414 / 37,565 bytes. These are
minified JS bytes before compression, not startup-time or first-use budget
results. Styles remain immediately available. The main startup closure is still
large; this batch does not claim that startup performance is solved.

The report contains 56 focused tests and real desktop/mobile-host browser
sequences. All three entry requests are individually failed and retried. Story
loading is held while the author edits a real synthetic Tiptap/Yjs draft and
switches to element view. The same draft document and mount survive the view
transitions. After switching to a new synthetic project/document, releasing old
story code cannot reopen it or show the old project. Actual graph tiles, mode
changes, typed Back events and reopening from cache are checked. Opening the
drift panel and pressing Back closes it after its animation while keeping the
graph active, exercising the extracted animation owner. Focus transfer
first asserts that the active browser has actually focused Retry; ready content
then focuses Back. A background tab had initially made that precondition false.
Screenshots of the synthetic loading/error and graph surfaces were inspected.

The settings regression separately passes 77 focused tests, real preference
changes, fetch retry and development loading. The general renderer regression
reruns the production graph geometry/transform fixtures, including container
resize, frame coalescing and teardown; it is not a complete App run.

The mobile fixture uses a 390×844 browser viewport and MobileSuperViewHost without
native platform metadata. The real draft is not ChapterEditor and the fixture
does not mount ProjectRuntimeProvider. Native local protocols, upgrades/offline
resources, physical IME/gestures, SQLite graph edits and complete project
continuity remain untested here. Intent preloading, other heavy entries and
F0 first-use/startup budgets remain F7 work. F7 stays `in_progress`.

Repository validation passes 2,402 tests with 1 existing skip, 8 architecture
tests, typecheck, lint (0 errors, 74 existing warnings), CI/public contracts,
Agent capabilities and the configured production renderer build. The normal
production JS excludes graph/settings fixture APIs and evaluation observers.


## F7d — Bounded entry-intent preloading

The existing deferred module owners now expose separate preload and demand
operations. A successful preload is reusable code; an unused failure remains
idle and does not display an error on first visit. A click joining a pending
preload shares its request and promotes any later failure to the normal local
retry UI. Hover never retries a failed demand load.

The renderer has one speculative task and one latest queued intent. Entries
wait for 120 ms of hover, keyboard focus or touch hold, then an idle callback
(with a 1,000 ms timeout and a timer fallback). Leaving the entry, canceling a
touch, unmounting, window blur or page hiding cancels work that has not started.
Started imports can finish into the code cache but cannot navigate or mount a
feature. Each resource gets at most one speculative attempt per renderer.
Foreground demand bypasses an unrelated background task. Data Saver, 2G,
offline and hidden-page policies suppress only speculative work.

Wiring covers desktop SUPER's last graph, both graph-header selectors, mobile
structure graph entries, user-menu Settings/shortcuts, mobile right-sidebar
Settings and mobile settings-index choices. Graph module ownership moved to
`features/graph/deferred-graph-modules.ts`; these entry hooks do not introduce a
mobile-to-desktop shell import or instantiate a project/runtime while warming
code. No automatic startup preload is added.

```bash
pnpm perf:renderer:preload
pnpm perf:renderer:preload --check
pnpm perf:renderer:settings --report=docs/renderer-performance/acceptance/f7-settings-after-preload.json
pnpm perf:renderer:settings --report=docs/renderer-performance/acceptance/f7-settings-after-preload.json --check
```

`acceptance/f7-intent-preloading.json` retains production main-entry module
observation and the F7c desktop/mobile graph retry sequences, adds 65 focused
tests, and mounts actual desktop SUPER and mobile settings controls in six
isolated browser scenarios:

- Idle, brief hover, focus departure, canceled touch and a synthetic hide/show
  sequence make no graph/settings entry request.
- A held graph preload permits editing the real synthetic Tiptap/Yjs draft;
  after it finishes, the first graph open uses cached code with no loading-status
  subtree. No graph instance mounts merely from hovering.
- A failed shared-UI preload remains invisible; the first actual click fetches
  it again with a fresh query and opens the graph without a Retry click.
- Settings intent waits behind a held graph import. Leaving Settings cancels
  that queued request; finishing the graph import does not navigate or open it.
- Actually opening a settings panel bypasses the held graph import and fetches
  panel code once. The late graph result does not replace Settings.
- A synthetic Data Saver connection skips preloading while explicit opening
  remains functional.

All six scenarios preserve the draft's Y.Doc identity and single mount. The
separate settings report includes 80 passing focused tests and reruns both standalone surfaces' panel fetching,
retry/navigation, preference persistence and Vite development loading against
the modified module owner. Earlier F7 reports remain historical snapshots;
these commands generate the current reports instead of replacing those files.

Initial static JS dependencies are 4,925,903 bytes, versus the historical F7c
observation of 4,923,305: the queue and entry wiring add 2,598 bytes (about 0.05%).
The story, element and shared UI bodies still have zero initial evaluation or
parsing before intent. This is a small startup-code cost for preparing the
selected feature before a click, not another bundle-size reduction. The warm
click timing in the report is one automation observation, not an F0 p95 result.

The fixture does not mount ChapterEditor or ProjectRuntimeProvider. Browser
pointer/focus/touch inputs are synthetic interactions; visibility/connection
policy values are explicitly injected. Physical touch/IME, native backgrounding,
offline/upgrade asset protocols, complete app continuity and latency budgets
remain unverified. Other heavy entry boundaries and F8 composition/native
acceptance still remain; F7 stays `in_progress`.


This batch passes 2,411 regular tests with 1 existing skip, 8 architecture tests,
typecheck, lint (0 errors, 74 existing warnings), CI/public contracts, Agent
capabilities and the generated-report checks. The normal renderer production
build is checked separately from the instrumented browser fixture.

## F8a — Complete native App control scenario

The first native composition report now uses the complete desktop App,
ProjectRuntimeProvider and ChapterEditor in a freshly built Tauri application.
The [attended runner](native-composition.md) creates two independent synthetic
SQLite fixtures through the offline Dev CLI domain runtime and checks their
semantic hashes. The main project contains 50 chapters, 100 elements and 500
relations; the isolation project contains 3 chapters and 3 elements. All 53
chapters contain 5,000 synthetic Chinese characters, verified by independent
read-only replay of Yjs snapshots and updates.

```bash
pnpm perf:renderer:native
pnpm perf:renderer:native --check
```

`acceptance/f8-native-composition.json` records a packaged Debug native build
with a production Vite renderer on Apple M3 Pro / 36 GiB. The runner validates
the new bundle's identifier, version, modification time and binary hash before
launching it. Database directories, app/WebKit storage, Keychain service and
deep links are isolated. Only the temporary worktree receives the acceptance
entry and lifecycle observer; normal product sources/configuration do not.

The accepted first process checks:

- Twenty actual target chapter surfaces open, with the first editor and live
  Y.Doc preserved when returning. Its inserted marker can be undone and redone.
- The real lazy story graph and fully loaded settings panels open and close
  without replacing the active editor or restarting the project runtime.
- A two-editor split preserves its shared document. Closing the tabs releases
  all 20 live document registrations.
- Project A → B → A restores each project's expected workspace counts, removes
  the departed project's live document registrations, and reloads saved prose.
  Runtime lifecycle events contain only those project transitions.

The second native process restores the saved chapter. Both processes were
ended with the app's real Cmd+Q command through Computer Use and exited with
code zero. Afterwards, independent SQLite/Yjs inspection finds exactly one
changed chapter containing the saved marker, 52 unchanged chapter hashes,
unchanged element/relation counts, and passing integrity/foreign-key checks.
The renderer reports no uncaught errors in either sequence.

The report's 34 ms command-to-two-frame sample is synthetic and is not an input
p95. Its first-process editor-ready observation includes waiting for the
operator to bring the window forward; it must not be read as cold-start time.
The second process's 470 ms observation is likewise a single instrumented
renderer observation. Parent-process RSS excludes WebKit children. WebKit did
not provide JS heap or long-task measurements; these are unavailable, not zero.

This adds native control-scenario evidence to F0/F2/F3/F7 and starts F8. It does
not complete F3's session/effect decomposition, comparative performance budgets,
larger/combined stress workloads, graph geometry stress, pending-review masks,
sync/crash scenarios, physical IME/touch, offline upgrade or device/account
acceptance. F8 remains `in_progress`; historical browser reports retain their
original scope and fingerprints.

Three new tests cover refusal to adopt an existing database directory,
read-only authoritative Yjs replay despite a stale prose cache, and absence of
acceptance entry/credential changes in normal product sources. This batch
passes 2,414 regular tests with 1 existing skip, 8 architecture tests, typecheck,
lint (0 errors, 74 existing warnings), CI/public contracts and Agent capability
checks. The ordinary production renderer build is verified separately from
the native acceptance build; all 32 emitted JS chunks exclude the acceptance
entry, synthetic marker/project identity and native credential namespace.

## F3c — Canonical editor sessions and outline presentation

`useEntityEditor` now delegates projection-save scheduling, selection memory and
outline publication to one `EntityEditorSession` per canonical Tiptap instance
and project/kind/entity identity. The React adapter attaches the owner in a
layout effect. Callback refreshes retain pending work, while retiring an owner
flushes through that owner's callback before a new source attaches. The shared
Yjs document session still owns authoritative CRDT durability and undo; this
extraction creates no replacement editor or document.

The existing 400 ms trailing save remains active for hidden sessions, including
blur, close and explicit-save flushes. Outline derivation required by persistence
is cached against the immutable ProseMirror document. Its React snapshot only
publishes while visible/preparing; ordinary edits with unchanged outlines
retain snapshot identity. Returning to a hidden editor prepares the current outline before
readiness permits the surface to appear. Initial preparation waits for the
BlockId plugin's construction-time microtask, avoiding temporary heading anchors.
Detach cancels owned timers/frames and removes all four editor event listeners.

Ten focused controller cases use real ProseMirror documents with explicit event
and clock doubles. They cover trailing saves, callback identity, effect replay,
destruction, canceled selection initialization, stable outlines and canonical
initial heading IDs. With 1, 5 or 20 sessions, all persist while only the visible
session publishes an outline change. Preparing a pending hidden outline does
not force an extra save. These counts measure the scoped notification behavior,
not whole-React commit counts or an input-latency budget.

```bash
pnpm perf:renderer:native --sessions
pnpm perf:renderer:native --sessions --check
```

The [native session scenario](native-composition.md#editor-session-refactor-scenario)
extends the full-App control fixture with temporary session observations. It
checks an authored synthetic Yjs heading update in a hidden chapter, native
SQLite materialization without an outline notification, and the actual outline
rail after returning to the same live document. A plain paragraph edit must
leave the outline notification count unchanged. All bindings for the 20 closed
chapter tabs must detach before project switching and process restart.

`acceptance/f3-editor-sessions-native.json` passes those checks against the final
source fingerprint in a fresh isolated native build. The composition process
records 24 attaches, 23 detaches, 28 outline publications and 7 save callbacks;
the final open editor is still attached when that report is sent. Both processes
then pass the actual native Quit/shutdown path and exit with code zero, with no
uncaught renderer errors. Independent SQLite/Yjs inspection confirms one saved
chapter, 52 unchanged chapters and passing integrity/foreign-key checks.
One earlier attempt failed because the occluded WebKit window stalled animation
frames; the passing rerun kept the window foreground. Its timings are attended
control observations, not cold-start or input p95 measurements.

Other visible interaction owners, broader scroll/selection/field-draft
continuity, pending-review masks in the full App, real remote sync, physical
IME/touch and comparative device/memory/input budgets remain open. The scoped
notification reduction does not establish lower total CPU or retained heap.
F3 and F8 remain `in_progress`; earlier acceptance reports remain historical.

This batch passes 2,424 regular tests with 1 existing skip, including the 8
renderer architecture tests, plus typecheck, lint (0 errors, 74 existing
warnings), CI/public contracts, Agent capabilities and the renderer performance
contract. The native session evidence checker matches the final product/harness
fingerprint. A separate normal production renderer build succeeds; all 32 JS
chunks exclude native acceptance observers, fixture identity and the credential
namespace.

## F3d — Visibility-owned typewriter scrolling

`useTypewriterScrolling` is now a small React adapter to an editor-owned
`TypewriterScrollController`. The controller persists across visibility and
position preference changes. Hidden chapters remove their three display-event
listeners, disconnect ResizeObserver and cancel pending alignment/caret repaint
frames. The one destruction listener remains so closing a retained editor still
cleans up. Hidden Yjs updates and position/viewport changes perform no typewriter
measurement or frame scheduling.

Tail CSS deliberately stays on a hidden viewport: removing virtual space can
clamp its saved scroll position. In the incoming surface's layout preparation,
the controller recomputes that tail from the current viewport and preference.
Preparation does not focus, select or align a hidden caret. Visible split panes
both retain their tail and observer, independently of command ownership; only a
focused, collapsed selection schedules alignment. A burst of editor events
shares one pending frame. Final destruction or disabling typewriter mode removes
the tail CSS as well. No document content, Yjs update or selection transaction is
created by this display controller.

Nine new controller cases, together with the seven existing geometry/repaint
cases, cover hidden updates and stale observer deliveries, canceled frames,
retained scroll/tail, deferred size/position preparation, focus changes in split,
effect replay and final cleanup. For 1, 5 and 20 retained editors, only the visible
editor owns the three display listeners and an active observer; every hidden
owner performs zero measured display work during the synthetic event burst.
The test event/DOM/clock doubles are explicit; they do not represent native layout.

```bash
pnpm perf:renderer:native --typewriter
pnpm perf:renderer:native --typewriter --check
```

`acceptance/f3-typewriter-native.json` runs the actual full desktop App and all
F3c native scenarios with typewriter mode enabled. Its additional checks pass:
one display owner for 20 tabs, no typewriter work during a hidden authored Yjs
update, unchanged hidden tail after a synthetic viewport resize and real position
preference change, retained reading scroll on return before focus, prepared tail
geometry, aligned focused caret, and cleared one-frame repaint state. Both split
panes have active typewriter bindings; closing the tabs disposes every owner.

The composition process records 24 controllers and 23 disposals before its final
open editor quits normally. Both native processes exit with code zero and report
no uncaught renderer errors. Independent SQLite/Yjs replay again finds exactly
one saved chapter, 52 unchanged chapter hashes and passing integrity/foreign-key
checks. The report includes temporary per-controller counters and a product/harness
fingerprint; the earlier native reports remain historical snapshots.

This removes the identified hidden typewriter work, not all hidden display
work. Outline-rail/scrollspy geometry, selection capture, other interaction
owners, full-App review masks, physical IME/caret appearance and comparative
input/memory/device budgets remain open. F3 and F8 remain `in_progress`.

Validation passes 2,433 regular tests with 1 existing skip, including the 8
renderer architecture checks, typecheck, lint (0 errors, 74 existing warnings),
CI/public contracts, Agent capabilities and the renderer performance contract.
The native typewriter report checker matches the final source fingerprint.
The separate normal renderer production build passes, and all 32 JS chunks
exclude acceptance observers, synthetic fixture identities and the isolated
credential namespace.

## F3e — Shared outline geometry and reading location

The semantic rail now owns one `OutlineViewportController`. The four
single-entity views pass their existing flat reading order and canonical jump
handler to that rail; their separate `useOutlineScrollspy` has been removed.
Whole-book view retains its controlled primary chapter. Rail density, viewport
range styling and single-entity reading location share one scoped geometry
snapshot. The original 80 px threshold, 24 px look-ahead, heading pin intersection
rule and five-level semantics remain in place.

Scroll, mutation and resize requests share one pending frame. Ordinary scroll
uses content-relative anchor bounds without querying or measuring headings
again. Content/size invalidation performs a full pass, measuring each resolved
DOM anchor once even when multiple entries refer to it. Unchanged snapshots do
not notify React. Resize observation releases direct content children when they
are removed, instead of retaining every child ever seen by the viewport.

Hidden rails disconnect their resize/mutation observers and scroll/window
listeners, cancel pending frames and retain scalar geometry/pin state. Layout
preparation refreshes the current geometry when a surface returns. This does
not move the native scrollbar or recreate the document. A hidden rail discards
its omission reveal and closing timer, and its mobile portal content follows
surface visibility, so a body portal cannot escape the hidden surface.

Ten new controller tests cover frame coalescing, unchanged publication, aliases
and framework selectors, heading pinning/removal, hidden mutation/resize,
synchronous return preparation, child observation replacement and effect replay.
With 1, 5 and 20 retained viewports, only one observes display changes; hidden
viewports perform zero anchor reads during the synthetic burst and all owned
listeners/targets/frames release on disposal. These are explicit DOM/event/clock
doubles; the existing semantic/model tests remain separate.

```bash
pnpm perf:renderer:native --outline
pnpm perf:renderer:native --outline --check
```

`acceptance/f3-outline-native.json` includes all native session/typewriter
scenarios. It passes the one-active-viewport check for 20 actual chapter tabs and
native SQLite persistence of a hidden Yjs heading without any outline work.
Sixty temporary headings exercise the real windowed-density rail, body-portal
omissions, canonical scroll jumps, visible-heading pinning and portal dismissal
on hide. A hidden resize, authored heading edit and dispatched scroll/resize
events leave the controller counters unchanged. Returning prepares geometry and
the actual rail shows the updated label; the stale portal stays closed.

Both visible split rails retain their bindings. Closing all tabs disposes every
outline viewport; the composition run records 24 owners, with its final open
editor still alive when the report is sent. Both processes then exit through the
real native Quit path with code zero and no uncaught renderer errors. Independent
SQLite/Yjs inspection confirms the heading fixture was removed: only the expected
saved chapter changed, 52 chapter hashes are unchanged, and integrity/foreign-key
checks pass. Previous native snapshots keep their original fingerprints.

The native scenario validates chapter rails. Other full-App entity/whole-book
sequences, mobile portal interactions, physical input, selection capture,
review-marker geometry and comparative layout/input/memory/device budgets remain
separate acceptance work. These scoped counters do not establish total CPU or
input p95 improvement. F3 and F8 remain `in_progress`.

Validation passes 2,443 regular tests with 1 existing skip, including the 8
renderer architecture checks, typecheck, CI/public contracts, Agent capabilities
and the renderer performance contract. Lint reports 0 errors and 73 existing
warnings, one fewer after removing the standalone scrollspy. The native outline
checker matches the final source fingerprint. A separate normal renderer
production build passes; all 32 JS chunks exclude acceptance observers, fixture
identities and the isolated credential namespace.

## F3f — Scoped review markers and visible geometry

`EditorScrollMarkers` now composes a semantic marker projection and one
`ScrollMarkerViewportController`. Comment projections require explicit sticky
rail membership and the current project/entity. They share a weakly keyed lookup
for each immutable comments collection, preserve collection ordering and ignore
body/priority/timestamp updates that do not change a tick. Agent projections read
only the current entity's changes and ignore text, mode and provenance changes
that leave marker semantics unchanged. Field changes never receive prose ticks.

Marker equality includes the complete click range, lane and translation key.
Previously, a range edit that retained its first anchor could leave the old
click targets in React state; translated titles could also remain stale. Titles
now translate at render time. Existing comment families, resolved styling,
three Agent operation lanes, deletion-predecessor/top anchoring and native
scrollbar placement remain intact.

A visible or preparing, nonempty viewport owns its resize/mutation/load/window
listeners and one pending frame. Hidden and empty viewports release those
resources. Incoming geometry is prepared in layout without recreating the editor
or Y.Doc. Each pass stops at the first present comment anchor and shares queries
and rectangle reads across markers. It releases removed observed nodes. Ordinary
scroll requires no measurement; root style/typewriter-tail changes do invalidate
content-relative fractions. Descendant animation styles do not schedule work.

The locale scenario also exposed a canonical-session lifetime bug:
`useEntityEditor` included the translation function in Tiptap reconstruction
inputs, even though it was only used by the context menu. The menu now reads a
latest-value translation ref when invoked. Locale changes update presentation
without destroying the prose editor or its undo manager. Other constructor
inputs retain their existing behavior.

Six projection tests and ten viewport tests cover semantic notifications, scope,
field exclusion, anchor aliases, stale click ranges, coalescing, unchanged
snapshots, virtual tails, orphan restoration and effect replay. With 1, 5 and 20
retained DOM/event doubles, only the visible marker viewport observes layout;
hidden viewports perform zero reads and all resources release on disposal.

```bash
pnpm perf:renderer:native --markers
pnpm perf:renderer:native --markers --check
```

`acceptance/f3-markers-native.json` contains the earlier native session,
typewriter and outline scenarios plus twenty real authored comments. With twenty
retained chapter tabs, empty marker owners perform no geometry work; after
explicit membership is populated, only the visible marker viewport listens.
Actual DOM clicks verify the full updated range, translated title and TODO
family. Hidden comment-range and authored Yjs edits, root size/load/resize
changes leave that viewport's counters unchanged. Returning prepares the new
anchor and its smooth jump centers the target. The check uses the paragraph's
center rather than requiring the whole paragraph to fit. Buttons receive focus
before programmatic clicks, matching the
focus transfer needed for this interaction.

The native locale check retains the exact editor/Y.Doc, opens a context menu in
the new language, restores the original locale and later undoes/redoes the
original saved prose edit. Both visible split marker owners remain active;
closing all tabs disposes their controllers. The composition report records 24
owners, 23 disposed before reporting (the final reopened editor is still alive),
with 5 resumes/pauses, 25 geometry passes and 19 anchor rectangle reads. These
scoped observations do not establish total CPU or input-latency improvement.

Both native processes exit through the real Quit path with code zero and no
uncaught renderer errors. Independent read-only SQLite/Yjs inspection finds
zero remaining synthetic comments, exactly one saved chapter and 52 unchanged
chapter hashes, with passing integrity/foreign-key checks. Generated evidence
matches the final product/harness fingerprint; earlier reports keep their
historical fingerprints.

Validation passes 2,459 regular tests with 1 existing skip, including the 8
renderer architecture checks, typecheck, lint (0 errors, 73 existing warnings),
CI/public contracts, Agent capabilities and the renderer performance contract.
The normal production build passes; all 32 JS chunks exclude acceptance imports,
fixture identities and the isolated credential namespace. The final harness
click adjustment also passes targeted lint and the complete native rerun.

F3 and F8 remain `in_progress`. Marker presentation does not own durable review
decisions, reveal masks or activity seen state. Full Agent review/masking,
other entity/mobile flows, physical input and comparative device/input/memory
budgets remain separate acceptance work.

## F3g — Position-only selection memory and owned restoration

A repository-wide caller audit found that selection memory only serves position
restoration. Its selected text, block ordinals/text, nearby context and revision
subscription API had no production consumers. `captureEditorSelectionSnapshot`
now records only `anchor`, `head` and `focusOnRestore`, without traversing the
ProseMirror document or copying prose. The memory remains session-only and keyed
by the existing project/entity tab identity. Repeated saves with identical
positions/direction/preference reuse the stored object. Hidden live updates still
save the positions already mapped by ProseMirror; this capture is not suspended.

Keeping anchor/head preserves backward text selections on restoration. Stale
positions are clamped into the current document. The restoration helper only
dispatches a selection transaction excluded from undo history; it does not scroll,
focus or schedule a frame. `EntityEditorSession` owns the one pending restoration
focus frame. It waits for presentation and command ownership, cancels when either
is lost or the session detaches, and fences stale callbacks across effect replay.
A user-focused editor receives no extra focus/scroll. The owned callback uses
ProseMirror's synchronous view focus, avoiding Tiptap's nested delayed-focus frame.
This is initial restoration, not a caret repaint workaround or repeated tab-focus
policy. Existing first-open and active-editor registration behavior is retained.

Closing the committed tab also exposed a handoff cleanup race: its outgoing
surface can remain mounted after `openTabs` changes, then save on its later
detach after the first prune. `EditorMainArea` now prunes on committed-surface
changes as well as tab changes, so the replacement's completed handoff removes
those late closed-tab snapshots without changing the ready barrier or save order.

Nine memory tests and fourteen session tests cover scalar-only capture, no
prose reads at 5k/20k/50k, stable duplicates, backward/clamped restoration,
project/split pruning, hidden mapped positions and restoration frame ownership.
They use real immutable ProseMirror documents with explicit event/clock/view
doubles; native interaction remains a separate check.

The native scenario exposed a separate dependency defect in locked
`@tiptap/y-tiptap@3.0.8`: a hidden insertion of 35 characters updated prose but
left both live PM and memory endpoints at 300/210 instead of 335/245. Its
content-based structural recovery overwrote valid Yjs relative positions with
old paragraph offsets. A version-specific pnpm patch now bypasses that recovery
when every observed event targets an existing `Y.XmlText`; non-text events retain
the original structural recovery. Both ESM and CommonJS builds are patched,
and the lockfile records the patch hash without upgrading dependencies.
Seven additional tests exercise the real sync plugin with a view double:
forward/backward/collapsed ranges, authored and peer insert/delete updates,
mark-only changes, range deletion, block insertion/moves and deleted blocks.
Native provenance now includes workspace dependency configuration and patches.

```bash
pnpm perf:renderer:selection
pnpm perf:renderer:selection --check
```

The generated `acceptance/f3-selection-capture.json` compares the exact capture
function from `e0c7a8c` with current source on the same 5k/20k/50k synthetic
ProseMirror documents. At 200 mixed caret/range captures, the baseline performs
200 document walks and 10,000 / 40,000 / 100,000 block text reads. The current
capture performs zero walks, visited-node reads, block-text reads or range-text
reads at each size. Both implementations preserve the same ordered endpoints;
the new snapshot also retains direction. Seven warmed batch timings exclude
the counter wrappers, consume every result through equal endpoint checksums,
and are raw Node microbenchmark samples, not native input
or input-to-paint measurements. The report records source/baseline hashes,
fixture hashes, runtime, CPU/memory and explicit measurement limitations.

The native `--selection` composition and restart pass on the final source and
harness fingerprint. The 200-move burst captures/writes exactly once per move;
backward ranges survive tab navigation and hidden authored prefix insert/delete.
The new split's command-active editor automatically receives focus without a
late takeover by the other pane. Closing all 20 tabs removes their selection
records, live documents and bindings. Project A → B → A restores both backward
positions and session-owned focus before the harness supplies explicit focus.
The whole composition records 297 captures, 242 changed writes and 21 prunes;
these are scoped counters, not total editor work or performance budgets.

Both native Quit paths exit with code zero and no uncaught renderer errors.
Independent SQLite/Yjs replay confirms one saved chapter, 52 unchanged chapter
hashes, zero remaining synthetic comments and passing integrity/foreign-key
checks. Position memory is intentionally process-local; restart validates prose.
The report is `acceptance/f3-selection-native.json`; earlier native reports keep
their historical fingerprints.

Validation passes 2,478 regular tests with 1 existing skip, typecheck, lint
(0 errors, 73 existing warnings), CI/public contracts and Agent capabilities.
The normal production renderer build passes and its 32 JS chunks exclude native
acceptance instrumentation and fixture identities. Final harness/benchmark
changes also pass targeted lint and their generated-evidence checks.

F3/F8 remain `in_progress`; full Agent review/masking, other interaction owners,
physical IME/touch and comparative device/input/memory budgets remain open.

## F3h — Editor-owned context menus

`useEntityEditor` previously removed every `.editor-comment-menu` DOM node when
any editor retired. Menu removal did not release its delayed document-mousedown
registration or the flyout's pending hide timer. An action close or replacement
could therefore retain detached menu/editor closures until a later outside click;
a retained hidden editor could also leave its body-portal menu active.

`EditorContextMenu` now owns one canonical editor's transient menu. The hook
creates/disposes it in layout effects and enables it only for an editable,
visible, command-active surface. Incoming replacement closes the previous owner;
retiring another owner cannot remove the current menu. All close paths remove the
exact document and editor listeners, cancel the hover timer and remove only the
owned DOM. The outside listener is registered synchronously: opening is a
`contextmenu` event, so no deferred mousedown-registration task is necessary.
Escape, document/selection changes and editor destruction also invalidate the
menu. Stale buttons from detached/replaced menus cannot invoke their callbacks.
The format actions, comment/patch anchor construction and manual Copilot request
remain the existing product operations; no new durable prose or review state is
introduced. Root/flyout positioning remains fixed with the menu portaled to body.

The isolated Chromium report `acceptance/f3-context-menus.json` exercises real
Tiptap editors and DOM with 1/5/20 retained owners. Each group runs 100 action
open/close cycles and tries each detached action again. Inactive owners add no
menu listeners; at most two tracked document listeners exist while a menu is
open (outside-mousedown and Escape), and zero remain after closing. The 1-editor
group records 214 adds/removes; 5/20 record 218 each. Pending hover timers return
to zero. Outside click, Escape, hiding, selection/document invalidation,
read-only rejection, editor destruction, replacement-owner isolation, fresh
labels and format/undo continuity pass. These are scoped lifecycle counters,
not whole-App retained-memory or input-latency measurements. Existing isolated
renderer scenarios also run in that report.

```bash
pnpm perf:renderer --output=docs/renderer-performance/acceptance/f3-context-menus.json
pnpm perf:renderer:check --report=docs/renderer-performance/acceptance/f3-context-menus.json
```

Native menu acceptance exposed a pre-existing Yjs undo defect: setting a final
paragraph to a heading causes StarterKit to append a trailing paragraph, and
`BlockId` assigns that new block an ID. Its appended transaction unconditionally
set `addToHistory: false`; the Yjs binding reads the final transaction's flag for
the complete view update, so the heading change never entered the undo stack.
`BlockId` now inherits the originating edit's history policy; mount repair stays
excluded, and explicitly excluded edits stay excluded even when another plugin
appends a block. The browser regression first failed on the old implementation
and now passes using real Collaboration/Yjs, StarterKit and BlockId to cover heading/trailing-node and split-block undo/redo with exact block identity,
as well as explicitly excluded writes. This is a correctness gate discovered
by the ownership refactor, not a measured performance improvement.

The extended native scenario also required an explicit painted-initialization
precondition before synthetic user focus/selection. A real-browser regression
then reproduced the separate unowned initialization blur: Tiptap's blur command
queued a frame that could remove a subsequently focused editor's caret, including
another visible split's DOM selection. Session initialization now blurs only its
own DOM synchronously. Both immediate subsequent user focus and other-editor
selection survive later frames. The initialization save-suppression frame remains
owned and cancellable; no new cross-session focus manager is introduced.

The final freshly packaged macOS Debug app with the production renderer passes
39 composition checks and the restart check in
`acceptance/f3-context-menus-native.json`. It observes 25 menu-owner lifetimes;
the closed-tab checkpoint balances all open/close and bind/unbind pairs and
retires those owners once. The actual 20-tab shell passes repeated menu cycles,
hiding/stale actions, unrelated-owner cleanup, locale/format undo, both split
command owners, project A→B→A and automatic selection/focus restoration. Both
native Quit operations exit successfully. Read-only SQLite/Yjs inspection finds
exactly one intentionally changed chapter, 52 unchanged chapters, zero remaining
synthetic marker comments and passing integrity/foreign-key checks.

All 2,480 regular tests pass (1 existing skip), as do typecheck, lint (0 errors,
73 existing warnings), CI/public contracts and Agent capabilities. The normal
production build passes; its 32 JS chunks exclude native acceptance instrumentation
and fixture identities. The generated browser and native evidence checks pass.

```bash
pnpm perf:renderer:native --context-menus
pnpm perf:renderer:native --context-menus --check
```

F3/F8 remain `in_progress`; slash/mention/inline-Copilot interactions, full Agent review masks,
physical input and the comparative device/latency/memory budgets retain their
separate acceptance requirements.

## F3i — Owned slash and mention suggestions

Real Tiptap/Chromium reproduction showed a slash suggestion remaining in its
body portal after editor blur. Slash/mention renderers also retained their last
props/items after exit, and detached buttons could invoke a refreshed row through
mutable renderer state. The asynchronous create-element command unconditionally
used its old range after the creation promise resolved.

`createOwnedSuggestion` now binds interaction work to the actual ProseMirror
plugin view. `useEntityEditor` supplies one `EditorSuggestionGate` for its
canonical, editable, visible command editor; the category-template slash menu
uses its own actual DOM focus without a shell gate. Unavailable views skip the
text matcher and item builder. Losing visibility/command ownership or DOM focus
exits the suggestion without changing prose. Plugin-view destruction removes its
blur listener and gate subscription, and view recreation establishes a fresh
lifecycle. Each renderer owns/removes only its portal, clears retained props/items
on exit, and rejects events from detached rows. Slash selection is clamped when
its query results shrink. Existing menu labels, actions and fixed body-portal
positioning remain in place.

A command claims its invocation once and dismisses the UI before running. A
pending create-element insertion retains only trigger text, scalar positions and
block identity, with an invalidation generation. Cursor/query/block changes,
readonly transitions, hiding, blur, Escape and destruction invalidate it;
returning to identical text does not revive it. Transaction step maps invalidate
replacements touching the trigger, including same-text replacements in appended
transactions; a final text comparison alone cannot detect those edits.
Link-mark updates caused by the
new element's retroactive linking are allowed when trigger text and positions
remain unchanged. An already-created element remains durable if insertion is
canceled; the guard never deletes that element or writes to a replacement
editor. A canceled creation in the still-current context retains the previous
trigger-removal behavior.

`acceptance/f3-suggestions.json` runs real plugins with 1/5/20 editors and 100
hide/return cycles for each menu. It verifies inactive builders stay idle, stale
rows, current actions, blur/Escape/readonly, plugin-view recreation, hidden
transactions and unrelated-owner cleanup. Gate subscriptions peak at 2/10/40 and
all return to zero after destruction; these are owner counts, not total retained
memory. Thirteen asynchronous creation cases include current success, intervening
link marks, hidden return, blur, selection/query changes, restored query text,
same-text and appended replacements, readonly return, destruction, Escape and
cancellation. The ungated template menu
also closes on blur and rejects its stale row.

The isolated browser runner now brings its target page to the foreground before
DOM scenarios, and records `environment.documentFocused`. Background targets can
have `document.activeElement` without delivering focus/blur events, so they are
not adequate for these lifecycle checks. Timing comparisons require matching
focus/environment conditions; this report does not claim a device latency or
memory budget.

```bash
pnpm perf:renderer --output=docs/renderer-performance/acceptance/f3-suggestions.json
pnpm perf:renderer:check --report=docs/renderer-performance/acceptance/f3-suggestions.json
pnpm perf:renderer:native --suggestions
pnpm perf:renderer:native --suggestions --check
```

All 2,480 regular tests pass (1 existing skip), together with typecheck, lint
(0 errors, 73 existing warnings), CI/public contracts and Agent capabilities.
The normal production build passes and its 32 JS chunks exclude native acceptance
instrumentation and fixture identities. Browser evidence validation passes.

Early attempts on the locked or occluded desktop stopped at
`opening-native-project` without passed evidence. An attended native run then
found a real return-path defect: hidden metadata transactions cleared Tiptap's
dismissed suggestion range, allowing the old menu to reopen on restored focus.
The owned wrapper now preserves only that mapped range while unavailable; it
still skips hidden prose matching and item construction. The browser cycle now
includes blur, a hidden transaction, focus and selection restoration. It failed
before the fix and passes in the regenerated `f3-inline-targets.json`.

The combined `--inline-copilot` run subsequently passed on a fresh native build,
including suggestion creation, split ownership and actual Quit/restart; its
evidence and boundaries are recorded below. The earlier browser reports remain
historical snapshots. F3/F8 remain `in_progress`; full Agent-review interactions,
physical input and comparative device/latency/memory budgets remain separate.

## F3j — Inline Copilot invocation ownership

The real React popover reproduced an invocation remaining in the global store
after its chapter unmounted. Returning to that chapter could reopen the captured
context, while `useCopilot`'s automatic-run guard continued to see a nonempty
inline context. Closed but still-mounted popovers also retained their last
context and preview in component state.

`useInlineCopilotInvocation` now owns the transient context and request lifetime.
The popover selects only its project/node context. Chapter composition mounts it
only on a ready, visible, editable command surface, and the keyboard entry checks
the existing canonical context-menu owner before building prose context. A stale
owner can close only its own context identity. Replacement, unmount, readonly and
editor destruction abort the owned request; closed component state and mirrors
are cleared. Unmount invalidates actions and aborts requests synchronously, with
store release in a microtask so immediate React effect reacquisition can retain
the same invocation. This does not retain a second live document or add a global
focus controller.

Async edit/ask responses check their invocation before publishing. An aborted
stream's `finally` cannot clear a newer stream's busy state. An already-authored
chapter-summary operation retains its existing durable completion semantics,
while its late UI response cannot update another invocation. The actual fixed
panel/overlay now portal to `document.body`, outside transformed/clipped editor
ancestors. Current local-edit application and undo continue through the live
editor.

`acceptance/f3-inline-copilot.json` contains 31 checks, including 100 hide/return
cycles, cross-project node isolation, unrelated-owner cleanup, readonly return,
destruction, Escape, obsolete edit/stream/summary completions and current edit
application with one undo. The popover's window key listener peaks at one;
115 registrations have matching releases and none remain. These are measured
owner counts, not a heap or device performance budget. The production React
build does not exercise development StrictMode effect replay.

Only this isolated browser runner redirects the popover's three service imports
to deferred synthetic responses. It exercises the actual component, store,
ownership hook and Tiptap apply path without model requests or SQLite writes.
The normal production build has 32 JS chunks and excludes native instrumentation
and synthetic service identities. The regular suite passes 2,480 tests with one
existing skip; typecheck, full lint (zero errors, 73 existing warnings), CI/public
contracts and 19 Agent-capability tests pass. The native UI harness also passes
a separate TypeScript check after correcting its truthy-wait return type and
the declaration boundary for synthetic numeric Yjs heading attributes.

```bash
pnpm perf:renderer --output=docs/renderer-performance/acceptance/f3-inline-copilot.json
pnpm perf:renderer:check --report=docs/renderer-performance/acceptance/f3-inline-copilot.json
pnpm perf:renderer:native --inline-copilot
pnpm perf:renderer:native --inline-copilot --check
```

`--inline-copilot` adds native canonical command gates, repeated hide/return,
unrelated-close, split transfer, closed-owner and transient-after-restart checks
on top of all suggestion scenarios. It does not redirect services or trigger
model requests. The combined native run passed, including the proposal checks
and persistence evidence described below. F3/F8 remain `in_progress`; full
Agent-review interactions and device/latency/memory budgets are not closed by
these lifecycle checks.

## F3k — Inline proposal preconditions and undo boundaries

The next real-editor reproduction found an existing write hazard: span apply
checked only numeric bounds, while block apply silently skipped missing targets.
A late proposal could overwrite intervening author text/formatting or apply only
the surviving part of its original region. A separate rapid-input reproduction
also showed the proposal merging with a preceding keystroke in undo history.

`inline-edit-apply.ts` now owns local application independently of model routing.
Each span proposal carries its original block identity/type and exact selected
fragment; each block proposal carries exact original node JSON. These bounded,
transient preconditions include whitespace and formatting and are captured only
for authored targets. The model receives the existing text/context input, never
these local snapshots. Before writing, apply validates every original target,
including unchanged model rows. Missing, duplicate or changed targets reject the
entire proposal without a prose transaction. Stable block IDs allow unrelated
prefix insertion. While its popover is owned, a span follows untouched ranges
through ProseMirror transactions, including appended transactions. Canonical
Yjs ranges use relative positions associated with the selected content, so an
identical peer-inserted prefix cannot steal the target. Target Y.Text observation
also catches interior replacements with identical final text. Lost tracking,
changed target content/formatting and affected replacements invalidate the
source; undo cannot revive it. Weak document keys and scalar revision IDs avoid
retaining old document trees. Tracking is detached with its invocation, with no
new work for closed/hidden popovers.

Successful span output is inserted as literal prose, including angle brackets,
with target marks. Block changes retain their original node identities and
structure. A successful proposal dispatches one prose transaction and separates
it from surrounding author input using the applicable ProseMirror/Yjs history
boundary. The non-Yjs path also uses a metadata-only history-closing transaction;
this does not alter prose. A target conflict displays guidance to close and
select again, with no retry action using the invalid captured target.

`acceptance/f3-inline-targets.json` adds 26 direct apply checks plus actual Yjs
verification that preceding input, proposal and following input form three
separate undo items and restore exact original JSON. The actual React popover
suite now has 39 checks, including concurrent-edit conflict feedback, dismissal
and preserved author undo. Its 119 keyboard-listener registrations all release,
with peak one and none remaining. Span transaction trackers also peak at one
and release after success, conflict and destruction. Actual `Y.applyUpdate`
checks an identical peer prefix and an identical interior replacement; both
target Y.Text observers release. Three regular tests verify proposal source
metadata survives model-output mapping without entering model input, and retain
the existing no-request local refusal behavior.

All 2,483 regular tests pass (one existing skip), together with renderer and
native-harness TypeScript checks, full lint (zero errors, 73 existing warnings),
CI/public contracts, 19 Agent-capability tests and the normal production build.
The generated browser report has no native/device performance claim. The
prepared `--inline-copilot` native scenario now includes exact shortcut-captured
span conflicts, literal application, surrounding-input Yjs undo, missing-block
atomic rejection and successful multi-block undo, restoring fixture prose before
the existing SQLite/save/restart checks.

`acceptance/f3-inline-copilot-native.json` now records 53 passing composition
checks and three restart checks on a freshly packaged Debug native build with
the production renderer, on Apple M3 Pro / 36 GiB. The runner verified its
bundle identity, binary modification time and SHA-256 before launching against
isolated synthetic data. Both processes exited successfully through real Cmd+Q.
The created suggestion element survived restart with the same ID/name; the
inline context and popover did not. Read-only SQLite/Yjs inspection found the
one expected saved chapter, 52 unchanged chapter bodies, one intentional new
element, zero marker comments, and passing integrity/foreign-key checks. Both
renderer processes reported zero uncaught errors. The exact-source native
evidence check passes.

These results close the F3i/F3j/F3k interaction batch. Synthetic native commands
do not establish physical IME/gestures, compositor paint, total WebKit memory or
the M1/8 GiB device budgets. Full Agent-review interactions and the F0–F8 goal
remain incomplete.

```bash
pnpm perf:renderer --output=docs/renderer-performance/acceptance/f3-inline-targets.json
pnpm perf:renderer:check --report=docs/renderer-performance/acceptance/f3-inline-targets.json
pnpm perf:renderer:native --inline-copilot
pnpm perf:renderer:native --inline-copilot --check
```

## F8b — Deterministic renderer contracts in ordinary CI

Ordinary CI now generates a fresh production-renderer browser report in its own
`client-renderer` job, and the existing required `client` job also requires this
job to succeed. It runs the following command rather than accepting a committed
historical report:

```bash
pnpm perf:renderer --ci --output=.local-data/renderer-performance/ci.json
```

This mode checks all current scenario sections, fixed fixture sizes and input
operation counts, zero full-link queries/color resolutions/style writes on the
unchanged-mark input trace, current index implementations, scoped notifications,
graph geometry/card commits, invocation ownership and released listeners. The
existing editor, Agent, graph and workspace behavior checks still apply. Regular
Vitest shards retain the reference-queue/recovery and dependency-boundary tests.
Missing browser sections cannot pass through the historical optional-field path.

The checker validates the report's commit and source fingerprint against the
checkout. Fingerprint version 2 includes JSON, shared source, package/lock files,
the browser runner/checker and newly added source files, and is recomputed after
the run. Reports now retain both host and browser environment fields; the former
object-spread order accidentally replaced the host fields with browser fields.
The exact browser version/revision and hosted runner image/version are recorded.
The job uses the preinstalled browser from the
[Ubuntu 24.04 runner image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md).

Ordinary CI validates metric shape and arithmetic but does not enforce noisy
elapsed-time thresholds. Existing measurement-mode time budgets and
`--assert-input-budget` remain available; combining that flag with `--ci` is an
error. This does not turn the shared runner into the fixed performance device.
On a completed measurement the raw report remains available even if validation
fails; a failed browser scenario writes a separately typed failure diagnostic.
CI attempts artifact upload even after failure, retains only this explicit JSON
path for 14 days, and does not retry assertions until one happens to pass.

`acceptance/f8-ci-contracts.json` was generated by the complete `--ci` command on
the local M3 Pro checkout. Six regular contract tests exercise omitted coverage,
work-count regression, old implementations, listener leaks, failed behavior,
invalid metric summaries and stale source/commit rejection. A high-latency report
still passes deterministic validation and fails the unchanged measurement budget.
Fingerprint tests cover tracked JSON, newly added code and unrelated reports.
The workflow passes `actionlint`; all 2,489 regular tests pass (one existing
skip), as do typecheck, full lint (zero errors, 73 existing warnings), CI/public
contracts and the 19 Agent-capability tests. Hosted Linux execution remains
**NOT RUN** until this change is pushed; this batch does not push.

The committed report records the candidate's source hash and its parent commit;
it is historical evidence after committing. A new `--ci` run checks the current
commit. F8-02 is **partial**: the deterministic gate is implemented and locally
validated, while hosted execution, fixed-device tolerance/rerun calibration and
the broader combined stress/device matrix remain open. No F0–F8 phase is marked
complete by this CI wiring.

## F3l — Owned Copilot capability preparation and summaries

An actual React/Tiptap reproduction found that unmounting during asynchronous
context preparation still allowed the old hook to start detection afterward.
The controller was previously created only after the awaited context returned.
Summary work also outlived its detector's controller slot, and old effect
finalizers shared refs with new settings/project effects.

`CopilotInvocationOwner` now belongs to one layout-effect lifetime. It reserves
and cancels each capability before context preparation, checks identity after
awaits and before each new persistence operation, and releases only the matching
invocation. Independent capability slots do not cancel each other. Summaries
have a separate chapter slot that remains abortable after detection finishes;
an old summary finalizer cannot release a new owner's lock. Unmount, settings
rebind, readonly transition and editor destruction stop the owner. Cleared/fired
debounce handles are removed, and disposed owners cannot schedule new work.

Already-started context cleanup and durable writes may finish; closing a surface
does not roll them back. Late detector results cannot begin new writes, and
closure during a write prevents the remaining result rows from starting. Manual
task IDs are unique across remounts, and each announced task receives one terminal
event, including synchronous `stopped` on cancellation. Current suggestions retain
their anchor enrichment and persistence behavior. The shared renderer Agent
protocol, capability registry, model routing and acceptance of durable suggestions
remain unchanged.

`acceptance/f3-copilot-runs.json` is generated by the complete `--ci` command. Its
21 actual-hook checks cover out-of-order preparation, unmount, readonly, settings
and project replacement, late detection, normal and interrupted persistence,
summary ownership and terminal task identities. Eleven synthetic detector calls,
two synthetic writes and three synthetic summaries have controlled completion;
100 mount/unmount cycles leave no additional manual command listener. Only the
isolated runner redirects this hook's context, comment and summary services.
Four regular owner tests additionally cover independent slots and reentrant abort
cleanup. CI requires the new scenario section so omission cannot pass.

All 2,493 regular tests pass (one existing skip), alongside typecheck, full lint
(zero errors, 73 existing warnings), CI/public contracts, 19 Agent-capability
tests and the normal 32-chunk production build without synthetic services.
`acceptance/f3-copilot-runs-native.json` refreshes the 53 composition and three
restart checks on a verified fresh native bundle. Both processes exited through
real Cmd+Q. SQLite/Yjs inspection again found one expected saved chapter, 52
unchanged chapter bodies, one intentionally created element, no marker comments,
and passing integrity/foreign-key checks; both renderer processes had zero
uncaught errors. Exact-source native evidence validation passes.

The native control scenario exercises mounting alongside the full editor and
its existing interactions; its commands do not start a detector/model request.
The deferred request races remain browser evidence. This batch does not establish
real-provider cancellation, physical input, total retained memory or a device
performance budget, and F3/F8 remain `in_progress`.

```bash
pnpm perf:renderer --ci --output=docs/renderer-performance/acceptance/f3-copilot-runs.json
pnpm perf:renderer:native --inline-copilot --report=docs/renderer-performance/acceptance/f3-copilot-runs-native.json
pnpm perf:renderer:native --inline-copilot --report=docs/renderer-performance/acceptance/f3-copilot-runs-native.json --check
```

## F4c：桌面消息区域拥有独立显示订阅

完整 `DesktopAgentPanel` 的生产 React 浏览器场景揭示了显示合并之后的
第二层传播：300 条历史消息、400 个增量、20 个显示批次，旧面板执行
40 次 render，输入配置组件执行 20 次 render。历史 `MessageView` 的 memo
已经有效，最新消息只执行 20 次；这次没有重写 Markdown 或引入消息窗口化。
首次异步鉴权后，旧面板的滚动 effect 在列表 DOM 出现前执行，长历史留在顶部。
原始观测保存在 `acceptance/f4-desktop-panel-baseline.json`，包含原始源码指纹。
这些是隔离构建中注入计数器得到的函数 render 次数，不是 React commit 或绘制耗时。

`DesktopAgentTranscript` 现在独立持有共享显示订阅、消息/控制卡片、用量与
本轮改动链接以及滚动状态；父面板只订阅输入和标题/控制所需字段。消息区域
按项目/会话标识挂载，memo 阻止输入草稿使整段历史参与 reconciliation。
发送及显式选择历史通过一个组件 ref 恢复底部跟随。滚动在真实列表挂载后的
layout effect 中定位；底部状态没有改变时不再安排 React 状态更新。
会话变化也会重置详情展开状态，避免同一消息下标沿用另一会话的局部 UI 状态。
canonical journal、终态持久化、恢复和 provider-neutral transport 均未修改。

`acceptance/f4-desktop-panel.json` 是生成的完整浏览器报告。相同 400 个增量下：
父面板及输入配置 render 均为 0，消息区域与最新消息各为 20；20 次输入草稿
更新时，消息区域和消息 render 均为 0。实际桌面组件还覆盖首次/重开底部定位、
草稿/焦点/选区、读历史时不抢滚动、跳到最新、历史 portal、重复选择当前会话、
工具详情与用量显示、权限/取消立即显示、后台会话隔离、会话切换和 100 次挂载清理。
计数器仅由隔离浏览器构建注入，普通 renderer 构建不包含它们。

边界：合成鉴权和 journal，无模型或 SQLite 调用。这里的桌面 Chromium
滚动/选区检查不替代原生 WebKit、移动端触摸、完整恢复或设备性能预算。
消息区域内的历史元素遍历与用量汇总仍随历史长度增长；本批减少的是更新传播，
不声称长历史的全部算法成本已消除。F4-04 继续保留 partial。

同一批源码另外生成了 `acceptance/f4-desktop-composition-native.json`：新构建的
隔离 Tauri 应用通过 53 项既有组合检查及 3 项重启检查，两次真实 Cmd+Q 正常退出，
0 个未捕获错误；SQLite 核对 1 章保存、52 章不变、1 个预期建议元素、无残留标记便笺，
完整性和外键检查均为 `ok`。该控制组覆盖编辑器/分栏/图谱/设置/恢复组合；
它没有调用本批合成 Agent 流式场景，不能据此声称原生聊天性能已验收。
本批常规 2493 项测试通过，1 项既有跳过；typecheck、lint（0 错误，73 项既有警告）、
CI 契约、公开边界、19 项 Agent 能力检查及普通生产构建通过。

## F4d：移动消息区域与输出操作归属

`MobileAgentPanel` 的侧栏和 paper dock 在同一个 390 px 浏览器场景中都复现了
三项问题（`acceptance/f4-mobile-panel-baseline.json`）：300 条历史、400 个增量、
20 个显示批次让面板 render 40 次、输入配置 render 20 次；保存灵感后切换会话，
迟到结果把完成提示写入新会话并触发一次旧目标导航；同一按钮连续点击会启动两次写入。
这是函数 render 计数和受控异步结果观测，不是设备耗时预算。

现在 `MobileAgentTranscript` 独立持有消息订阅、移动输出操作、证据和滚动状态。
消息行也有 memo 边界；草稿更新不再遍历历史输出按钮和上下文 chip。
父面板保留 paper/session 绑定、输入与历史导航、焦点和触摸滚动边界。
重试按钮只订阅布尔结果：immutable 消息数组通过 WeakMap 缓存错误判定，
后台会话的每个事件不会重扫活动空闲会话的历史；重试时从 canonical store 读取原始提问。
上下文 chip 是独立的移动组件，未引入 desktop shell 依赖。

输出操作按项目、会话、用户与消息身份归属：每条消息只允许一个待完成操作，
按钮在处理中禁用，回调本身也拒绝重复请求。完成、失败和导航前都检查 owner
仍然有效，且消息仍在原会话的原位置。关闭视图、切换会话或身份使旧 owner
失效；同一会话下替换消息不会把旧结果标注到新消息。已经开始的复制或本地写入
可以完成，已创建的灵感/待办不会撤销；退休 owner 不再发布提示或改变导航。
正文创建继续使用现有 use case 的初始化路径，Agent Runtime 与 journal 未修改。

`acceptance/f4-mobile-panel.json` 通过普通 CI 的 52 项移动组件检查。
两种入口各 400 个增量下，面板及输入配置 render 均为 0，消息区域、最新消息
和最新移动消息行各为 20；20 次草稿更新不 render 消息区域或消息行。
覆盖正文及草稿完整性、滚动、迟到成功/失败、重复点击、复制原文、待办原始块锚点、
错误后重试、消息替换、关闭/重开、会话返回、项目与身份边界、后台会话隔离，
以及每种入口 100 次挂载释放监听器。只有隔离构建替换创建节点/便笺与剪贴板接口；
普通产品构建沿用真实 use case，计数器及合成接口不进入产品入口。

原生入口新增 `pnpm perf:renderer:native --mobile-agent-panel`。它先运行既有完整
桌面控制组，再在隔离 Tauri/WebKit 中显示相同的 390 px 移动组件场景。
原生场景不注入 React render 计数器，相关字段为 null；身份切换只在浏览器检查，
避免改变原生控制组的项目/用户生命周期。手机整套 shell、实体写入的真实持久化、
物理触摸、软键盘 viewport、实际 IME、整 App 内存和 M1/8GB 预算仍须另外验收。
本批没有消除消息列表本身的全历史遍历或证据汇总；F4-04 继续为 partial。

`acceptance/f4-mobile-panel-native.json` 已生成并通过源码指纹校验：原生 WebKit
44 项移动组件检查通过，含这些检查的组合汇总 54 项及重启 3 项通过；两次真实
Cmd+Q 退出成功，0 未捕获错误。数据库仍为 1 章保存、52 章不变、1 个预期建议元素，
完整性/外键检查为 `ok`。普通构建为 32 个 JS chunk，没有验收计数器或合成写入接口。
常规测试 2493 通过、1 项既有跳过；typecheck、CI 契约、公开边界及 19 项 Agent
能力检查通过。Lint 为 0 错误、74 警告；其中移动面板既有的不可用鉴权分支在拆分后
被 effect 静态检查识别，其同步状态回退尚未调整。

## F4e：长历史消息分组复用

`acceptance/f4-history-baseline.json` 补充了实际桌面/移动 Transcript 的 300 和
3,000 条历史场景。每个场景执行 20 次完整同步显示提交，保留全部 DOM；消息数组在
计时区间外准备，以便把 React 显示成本与 canonical 事件消费区分开。固定合成消息
包含位于分组边界的工具卡，报告记录 fixture hash、原始时间样本和源码指纹。

此前 `MessageView` 的 memo 已使流式消息体只渲染尾部，但父组件仍每帧为全部历史
创建 JSX 并执行列表协调。新的 `useAgentMessageBlocks` 为每个已挂载 Transcript
保留一个最新快照缓存，以 64 条消息分组；逐项身份比较后，未变化分组保持引用，
其 memo 组件不再创建历史行元素。缓存不使用全局注册表或旧快照链，卸载后随所属
视图释放。任意历史工具更新、恢复后的替换、跨边界追加及截断均按实际内容重新投影。
分组使用 Fragment，不增加布局容器，完整历史、选区和工具展开 DOM 继续存在。

`acceptance/f4-history.json` 通过当前浏览器 CI 合同。桌面和移动端的行元素创建量
均从 300 条历史的 6,020 降至 900，从 3,000 条历史的 60,020 降至 1,140
（减少约 98.1%）。这是 **元素创建数量**，并非消息体渲染次数或整体耗时下降比例。
3,000 条历史的本机同步更新时间中位数：桌面 1.6 → 1.5 ms、移动 1.5 → 1.0 ms；
桌面 p95 从 2.4 升至 3.9 ms，因此没有证据声称桌面尾延迟改善。这些时间仅作诊断，
包含布局和测试包装，不能代替固定设备预算。普通 CI 检查确定性工作量及行为，不检查
这些时间阈值。

四个场景各检查全部历史仍挂载、历史 DOM/选区保留、工具 DOM/展开状态保留以及
最终输出完整，共 16 项。此前的 24 项桌面面板和 52 项移动面板检查继续通过，覆盖
滚动跟随/阅读历史、权限与取消、输出操作索引和失效 owner、会话切换与 100 次卸载。
3 项新增单元测试覆盖不可变快照、边界/中部修改、截断和非单调快照调用。

本批仍需 O(history) 身份比较，桌面 usage 与移动 evidence 汇总仍可能遍历历史；
canonical 投影仍逐事件复制消息数组，完整 DOM 的布局/内存成本也未消除。没有引入
窗口化或更换 Agent 协议/持久化格式，F4-04 保持 partial。

`pnpm perf:renderer:native --agent-history` 增加新构建隔离应用的历史验收，并包含此前
mobile-panel / inline-Copilot 的组合链。`acceptance/f4-history-native.json` 通过
55 项组合检查及 3 项重启检查，其中新增长历史的四个场景共 16 项，移动面板仍为
44 项。两轮均使用真实 Cmd+Q 退出，未捕获错误为 0，SQLite integrity/foreign-key
检查通过，1 章按预期保存、52 章未改变。此处移动组件运行于 macOS WebKit 的窄宽度
容器；未执行真实 iOS、触摸/软键盘或 Agent 输出的实际数据库写入。原生报告将本场景
的时间和渲染计数标记为 null，不把未插桩的数据当作性能证明。

本批全套检查：2,496 tests passed，1 项既有 skip；typecheck、CI contract（388
测试文件）、public boundary、19 项 Agent capability 检查通过；lint 为 0 errors、
74 warnings，与上一批相同。正常产品构建为 32 个 JS chunk，未包含长历史/移动输出
验收入口或计数器。托管 CI 仍未运行，本目标不推送。

## F4f：实时消息快照共享树分支

此前 canonical 文本事件虽已使用私有去重索引和共享显示调度，仍会逐事件复制全部
历史消息引用。`AgentChatTranscript` 将 live run 的消息表示改为分支宽度 32 的
不可变树：追加和替换只复制受影响的路径，未变化消息及分支保留身份。索引读取按树
深度访问；历史工具查找直接逆序遍历叶节点，最坏仍为 O(history)。快照不持有旧快照
链，也没有全局历史缓存，失去引用的分支可被回收。

事件语义仍由同一 journal fold 定义，分别适配数组和实时树。会话仓库、恢复投影及
网络协议继续使用既有数组格式。`toArray()` 只在显示、显式数组读取和持久化边界
生成数组，同一快照只生成一次；调用方延续消息和数组不可变的约定。共享显示订阅
先观察树身份，在 frame/timer/control 边界生成显示数组；移动语音界面也接入该订阅。
移动输出操作仍按原消息索引和对象身份检查 owner，避免提交到已切换的会话。

`acceptance/f4-transcript.json` 使用 300 / 3,000 / 30,000 条历史，每组追加 6,000
个合成文本事件，各执行三轮数组/树投影，并单独运行真实 store、去重与显示调度。
数组参考路径分别复制 1,806,000 / 18,006,000 / 180,006,000 个历史数组槽位；
树路径复制 138,000 / 348,000 / 342,000 个树槽位，事件期间没有完整数组生成。
真实 ingress 在 frame 前已能按索引读取完整文本，随后只生成一次显示数组；重复
重放全部事件不再复制或发布。旧快照及历史身份保持，所有行为检查通过。

本机三轮纯投影时间中位数为数组 0.6 / 3.6 / 20.1 ms、树 0.8 / 0.8 / 0.8 ms；
真实 store 的 6,000 事件耗时为 19.0 / 16.5 / 16.2 ms。这些带计数器的合成时间
仅用于诊断，不能解释为整个 APP 的加速比例。普通 CI 检查确定性复制工作、显示
次数和语义，新增反例确保逐事件生成数组会失败；不增加固定设备时间阈值。

仍未消除隐藏窗口逐事件立即 flush 时的数组生成、主动数组消费者的 O(history)
读取、显示分组身份比较、usage/evidence 汇总、完整 DOM 布局及内存成本。canonical
恢复仍使用数组 fold，长会话恢复预算和安全 checkpoint 前的事件去重内存也待后续
处理。F4-01、F4-04 保持 partial，真实移动设备、物理 IME 和固定设备预算继续开放。

`pnpm perf:renderer:native --agent-transcript` 已在新构建的隔离 macOS 应用执行。
`acceptance/f4-transcript-native.json` 记录真实 SQLite journal/checkpoint、会话仓库
写入及 canonical 恢复：第一进程新增 8 项消息检查，正常退出后的第二进程新增
4 项恢复检查，均通过。9 条合成事件包含完整 model/commit 生命周期；测试先通过
严格 journal replay 校验，再送入原生仓库，没有放宽生产恢复规则。两进程都重放
实际持久化事件，恢复后快照不变；保存格式仍是 user/assistant/usage 三条数组消息。
该场景是文本终态的正常退出恢复，不覆盖工具混合轨迹或崩溃中的恢复。

包含此前 editor/mobile/history 场景的组合汇总为 56 项及重启 4 项通过，长历史
16 项、移动面板 44 项继续通过；两次真实 Cmd+Q 均退出码 0，未捕获错误 0。
SQLite 完整性和外键检查通过，1 章按预期保存、52 章不变。窗口曾因未保持前台而
暂停动画帧，失败运行不作为验收证据；最终报告来自两轮完整成功的进程。

本批全量测试 2,514 通过、1 项既有跳过，typecheck、CI contract（390 测试文件）、
public boundary 和 19 项 Agent capability 检查通过。Lint 为 0 错误、74 警告；
正常产品构建为 32 个 JS chunk，不含原生验收入口、合成移动输出或性能计数器。
浏览器与原生报告均校验了候选源码指纹。托管 CI 和真实手机验收未执行，本目标不推送。

## F4g：恢复投影避免重复扫描历史

`acceptance/f4-recovery-baseline.json` 在产品改动前记录了完整严格恢复及聊天显示
投影的合成基线：100 / 500 / 1,500 回合，每回合 20 个文本片段及一条合并 thinking，
每 50 回合包含一次与后续重试同文本的 preflight 失败。缓存同时放入失效 assistant
文本，要求只保留合法用户输入和相邻错误。每组三次，记录 fixture hash、原始时间和
工作量；独立预期由 fixture 规格构建，没有调用生产 fold 来推导正确答案。

严格恢复的 `buildTranscript` 按已验证、已排序的消息一次分组，`replayTurns` 使用
局部 prompt ID 索引；显示恢复使用局部回合索引，并从尚未消费的缓存用户游标开始
匹配。重复文本仍优先匹配后续无错误的重试，保留此前失败输入及错误的位置。
这些索引只属于一次恢复调用，没有跨会话缓存或额外数据库读写；原有序列、身份、
协议、终态/提交、checkpoint 和工具配对校验仍在相同位置执行。

显示重放采用 F4f 的不可变树和同一 journal fold，完成后一次输出既有数组格式。
中断工具只在当前回合范围内替换为失败；此前已完成历史继续保留。导入显示和无事件
回退仍沿用现有来源规则。新增测试覆盖输入行乱序的长历史、导入显示、已完成历史
后的中断工具，和现有严格拒绝错误快照的测试共同验收。

`acceptance/f4-recovery.json` 与基线的三个 fixture hash 一致，所有独立显示、事件
身份、终态/上下文、输入不变和单次仓库快照读取检查通过。1,500 回合、40,500 事件、
6,060 条显示消息时，显示 fold 的历史数组复制从 104,599,500 个槽位降为 0，树路径
复制 1,279,380 个槽位，最终只生成一次数组。消息分组访问从 4,500,000 降为 3,000；
prompt 查询从 2,250,000 次候选检查变为 1,500 次索引查询；回合查询从 1,125,750
变为 1,500；可见输入候选检查从 1,149,000 降为 1,530。索引构建仍需线性遍历和
临时内存，计数器并不表示所有分配或数据库成本。

100 / 500 / 1,500 回合本机三轮时间中位数为 4.9 / 29.1 / 117.5 ms，优化后为
4.7 / 21.8 / 55.7 ms。这是完整严格恢复加显示投影、带验收计数器的内存 fixture
诊断；不含 SQLite I/O、checkpoint、工具混合长轨迹或崩溃注入，不视为固定设备
预算已达标。当前 CI 对复制量和扫描量设确定性约束，并验证历史分组扫描回归会失败。

F4-01 和 F4-04 仍为 partial。大量不匹配缓存输入的搜索、checkpoint 校验、工具
查找、SQLite 读取/解析、主线程让出及完整显示/设备成本仍需继续测量，不能把这些
场景的线性工作量推广为任意恢复轨迹的总复杂度。

本批另外生成 `acceptance/f4-recovery-native.json`，使用新构建隔离 macOS 应用执行
`--agent-transcript` 全组合链：56 项组合检查及 4 项重启检查通过，其中真实 SQLite
消息保存/恢复为首轮 8 项和重启 4 项。两次 Cmd+Q 均正常退出，未捕获错误 0，
数据库完整性及外键检查通过，1 章按预期保存、52 章未变。该原生场景只有一个文本
回合，证明改动接入实际仓库后仍能恢复；长历史性能数字来自上述浏览器内存场景。

全量测试 2,517 通过、1 项既有跳过，typecheck、CI contract（390 测试文件）、
public boundary 及 19 项 Agent capability 检查通过；lint 0 错误、74 警告。
正常产品构建仍为 32 个 JS chunk，未混入恢复/消息性能计数器或原生验收入口。
浏览器候选与原生候选的源码指纹均通过检查，托管 CI 和真实手机验收未执行。

## F4h：应用级 journal 消费者与纯运行投影

`agent-chat-store.ts` 从 1,451 行降至 1,295 行。`chat-run-projection.ts` 拥有单个
会话的控制状态及消息投影；`chat-journal-consumer.ts` 拥有 turn→conversation
路由、去重提交顺序、journal/会话变更订阅及终态副作用调度。store 在一处创建消费者，
通过同步 run 更新、持久化、计划刷新、活动提示及终态清理端口接线。消费者不导入
React store 或 SQLite 仓库，不在每个面板挂载时重新创建。

同一消费者重复连接只建立一组订阅。连接失败可以重试，失败连接的迟到回调不能
进入新连接；第二个订阅失败会释放第一个。销毁会清空路由、解除两条订阅并作废后续
回调，但已经接受的终态继续完成计划刷新请求、活动清理、运行指针清理和最终数组
持久化。模块的 HMR dispose 接入该释放边界，同时取消自动续接 timer、作废加载和
启动 token；迟到计划读取不能再授权续接。HMR 整体更新尚未单独做交互验收。

拆分前新增的 store 集成测试复现了项目路由缺口：事件的 project ID 与 run 不一致，
仍会因 conversation ID 相同而修改消息。消费者现在先检查 chat 路由、项目归属及
显式会话与已注册 turn 的一致性，再接收事件；被拒绝的投递不会占用去重身份。
后台同项目会话仍由自己的 run 接收，另一项目的合法末尾事件仍按原规则完成持久化，
不会触发当前项目的工具活动提示。会话切换不会释放应用级订阅。

`acceptance/f4-journal-owner.json` 增加真实消费者工厂的 15 项确定性检查，包含
100 次生命周期、每次 20 次重复连接，以及无效路由、重复投递、订阅失败重试、同步
连接期间销毁、发布终态期间销毁等边界。端口使用合成同步状态和副作用记录；该部分
不代表 SQLite、模型执行或堆内存回收已验收。普通 CI 要求全部检查存在且通过，
并验证生命周期失败的报告会被拒绝。现有 store 混合 thinking/tool/terminal、
transport 重绑、恢复去重、失败重试和显示 flush 集成检查继续通过。

本批不声称新的速度提升。浏览器回归继续满足 F4f 的逐事件完整数组生成为 0、每次
burst 只生成一次显示数组，以及 F4g 的历史分组线性访问约束。自动续接策略、发送
准备和会话命令仍有 store 内部职责待整理；混合轨迹的实际崩溃恢复、设备预算和
整体堆内存证明仍开放，F4 保持 in_progress。

`acceptance/f4-journal-owner-native.json` 从新构建的隔离 macOS 应用生成，既有完整
editor/mobile/history 链的 56 项组合检查及 4 项重启检查通过。真实 SQLite 消息
路径的首轮 8 项、重启 4 项检查继续通过，两次 Cmd+Q 正常退出、未捕获错误 0；
数据库完整性/外键为 ok，1 章按预期保存、52 章不变。该原生回归仍是合成文本回合，
不代表上述 15 项生命周期场景已在真实设备或 SQLite 故障条件下全部重跑。

全量测试 2,519 通过、1 项既有跳过；typecheck、CI contract（391 测试文件）、
public boundary、19 项 Agent capability 检查通过。Lint 为 0 错误、74 警告；
正常产品构建仍为 32 个 JS chunk，未混入原生验收入口或性能计数器。浏览器与原生
报告均校验候选源码指纹；托管 CI、真实手机和物理输入未执行，本目标不推送。

## F4i：混合聊天的真实 SQLite 进程崩溃恢复

本批补齐前述 F4h 的一部分恢复证据，产品消费者、投影、去重和持久化实现不变。
新增 `pnpm agent:chat:recovery`，用完整产品迁移、文件 SQLite WAL/FULL 和现有
renderer gateway adapter 执行真实 repository / transport persistence / journal consumer
组合；父进程在子进程报告精确边界后发送 SIGKILL，再启动两个独立恢复进程。
子进程在边界同步冻结，避免待执行缓存写入或 SQLite close/checkpoint 抢先完成。

每组使用一个已提交的旧回合，以及一个两轮模型迭代的合成混合回合：thinking、文本、
流式参数、成功与失败各一次的工具结果、最终文本、usage 和终态。工具与模型只提供
合成事件，不执行真实工具或外部请求；预期显示消息单独逐项定义，不由被测折叠器生成。

| 中断位置 | 重启时必须满足 |
| --- | --- |
| 参数流、工具执行、结果 journal 已落盘但工具行未更新、两个工具结果完成、最后文本 | 保留已持久输出；未完成工具显示中断；没有假流式光标；旧回合和 provider history 不变 |
| 终态 journal 已落盘、完成消息已插入但未提交、checkpoint 已插入但未提交、事务提交前 | 提示完成上下文未能持久采用；完成消息/checkpoint/终态不能部分落盘或误报成功 |
| 完成事务提交后、消费者收到终态但缓存尚未写入、缓存写入后 | 从权威 journal 和已提交行恢复完整显示，忽略旧缓存中的过期 assistant；完整 provider history 和 checkpoint 一致 |

事务钩子绑定实际插入本轮完成消息的 transaction ID，并记录消息数、checkpoint、
终态行和实际提交状态。生成报告验证这些见证，防止误把 `loadRecoverySnapshot`
读取事务的提交当作完成事务。每次恢复还检查完整 event ID、工具行状态、另一个
项目的 sentinel、两轮重复 replay 不发布或触发副作用、dispose 后迟到回调无效，
以及数据库全表哈希不变、integrity 和外键通过。

`acceptance/f4-chat-crash-recovery.json` 记录 24 次实际 SIGKILL 和 48 次独立重启；
两次重启的数据库、显示及 provider history 哈希必须完全一致。
`pnpm agent:chat:recovery --check` 同时校验完整矩阵和候选源码指纹；`--smoke`
只运行每个边界的一组种子，不生成完整验收报告。普通 Vitest 使用已生成报告验证
缺失场景、假 SIGKILL、缺少事务见证、缺少重启、假完成、缺少检查、结果分叉和重复
消息均会被拒绝；当前性由单独的 `--check` 门槛负责。

边界仍然明确：这里是 Node 进程和真实 SQLite，状态/活动端口为同步合成组合，
没有重跑完整 Zustand store、transport relay、React 或原生 Rust 进程。此处恢复
为只读；恢复后的工具续跑、写入收据、权限/用户等待、checkpoint 压缩、大历史耗时、
原生崩溃和断电仍需独立验收。F4-01/04 保持 partial，不把正确性矩阵记作性能提升。

本批验收：24 次 SIGKILL / 48 次独立重启全部通过；全量 Vitest 2,531 通过、
1 项既有跳过（393 个测试文件）。Typecheck、CI contract、public boundary 和
19 项 Agent capability 检查通过；Lint 0 错误、74 项既有警告。正常构建仍为
32 个 JS chunk，没有混入崩溃 fixture 或性能计数器。本批未重跑浏览器或原生 UI；
生成报告保留执行时的父提交 `b779065c` 和完整候选源码指纹，不手改提交身份。

## F4j：后台流式显示合并与失效回调隔离

F4f 已消除前台逐事件的完整数组生成，但 `chat-display-projection` 在 hidden 状态
仍为每个文本事件立即 flush。新 `agentBackground` 浏览器场景使用真实 store、
journal consumer 和显示投影，注入受控 visibility/timer 端口；不会真的把浏览器
移入后台，也不把受控计时器当作实际 WebView 或操作系统的后台延迟。

`acceptance/f4-background-baseline.json` 在修改产品代码之前生成，记录 300 / 3,000 /
30,000 条历史和 6,000 个文本事件。三个规模都产生 6,000 次通知和完整数组生成，
累计写入 1,806,000 / 18,006,000 / 180,006,000 个消息引用。消息对象本身仍被复用；
该数字是数组槽位工作量，不是深拷贝的对象数或峰值堆内存。

现在隐藏窗口只保留一个 50 ms 显示计时器，不申请 rAF。进入隐藏状态先刷新已有尾部，
后续文本合并；返回前台无须等旧计时器，立即读取最新 canonical transcript。权限、
取消、终态、作者操作和会话归属变化仍同步刷新，底层事件接收与持久化规则不变。
宿主可以节流后台计时器，因此 50 ms 是调度请求值，不是未测设备上的延迟上限。

已取消的帧或计时器可能已经进入宿主回调队列。新增调度代次使旧回调无法提前刷新
新 burst 或新订阅；visibility 回调独立绑定连接代次，卸载前的通知不影响 remount。
回归测试在修改前实际为 7 失败、6 通过，修改后 13 项全部通过；覆盖后台文本、
前后台切换、权限/取消/终态/作者操作，以及 remount 后的旧帧、计时器和 visibility。

`acceptance/f4-background.json` 使用相同输入指纹：每个规模的 6,000 次 ingress
均不生成完整显示数组，共用一个计时器，刷新后只生成一次数组并通知一次。旧历史
对象身份与旧快照不变，重复 replay 无额外工作，返回前台没有滞留尾部，最后订阅
释放后没有帧、计时器或 visibility 监听器。普通 CI 必须包含该场景，并拒绝逐事件
数组生成、多计时器或返回前台不完整的报告。这里没有声明新的整体性能预算已通过。

`acceptance/f4-background-native.json` 来自新构建的隔离 macOS 应用，56 项组合检查
和 4 项重启检查通过，真实 SQLite 文本回合的首轮 8 项、重启 4 项检查继续通过。
两次 Cmd+Q 正常退出、未捕获错误 0；1 章保存、52 章不变，数据库完整性与外键为 ok。
该原生回归保持窗口在前台；没有证明真实后台计时器节流、手机或物理 IME 性能。

全量测试 2,538 通过、1 项既有跳过；typecheck、CI contract（393 测试文件）、
public boundary 和 19 项 Agent capability 检查通过。Lint 0 错误、74 项既有警告。
正常构建仍有 32 个 JS chunk，没有混入验收 fixture 或分配计数器。浏览器与原生
报告保留实际执行时的父提交 `718867d8`，并校验完整候选源码指纹；F4 保持进行中。

## F5e：完整 Super Element 卡片树的验收预算

在拆分与 memo 改动前，新增完整 `DesktopSuperElementView` 浏览器场景：100 /
1,000 / 5,000 张元素卡片、8 个类别和 20 张章节卡片。数据与导航端口为合成输入，
卡片、章节带、连线模式与 wheel 处理器使用产品实现。用构建时插桩记录组件调用及
元素卡片 JSX 创建次数，计数器不进入正常产品构建。

预算预先固定：20 次连线聚焦模式切换和 100 个 wheel 事件合并提交后的卡片树
调用数均应为 0；几何变化继续由已有独立连线层处理。完整 DOM 卡片保留，Shift
选择/取消来源、元素改名显示和类别导航正确。初次渲染、相关选择/数据变化仍允许
刷新；本批不把 memo 当作初次大图布局加速，也不声明物理手势或设备延迟预算通过。

实现将类别卡片树和章节带分别移到 `SuperElementCategoryBox` 和
`SuperElementChapterBand`，通过默认浅比较 memo 保留未变化的树。主视图向它们传递
稳定的元素/章节点击、类别导航与上下文菜单回调；连线来源或移动关系模式变化时，
点击处理器仍随真实依赖更新。世界坐标尺寸与样式常量按原值移到共享 metrics 模块，
不引入第二套几何值；主视图从 2,646 行缩减至约 1,900 行。卡片正文、DOM、ref 注册、
悬停和事件处理保持原有行为，选择/数据变化仍允许重新执行相关树。

`acceptance/f5-cards-baseline.json` 与 `acceptance/f5-cards.json` 使用相同输入指纹。
20 次模式切换原本触发 160 次类别渲染、20 次章节带渲染，及 2,000 / 20,000 /
100,000 次元素卡片 JSX 创建；现在三个规模的这些计数均为 0。100 个 wheel 事件
原本合并成一次父提交，仍会重跑 8 个类别、1 个章节带及全部卡片；现在这些计数也为 0，
既有直接 DOM transform 与交互结束提交方式不变。

完整视图场景检查卡片 DOM 持续保留、模式返回原态、Shift 选择与取消、改名后刷新、
类别导航，以及元素→元素和章节→元素的最新来源配对。配对弹窗必须 portal 到 body，
显示正确双方名称，并可用 Escape 关闭；此处没有点击确认，不证明关系持久写入。
普通 CI 必须包含完整卡片树场景，并拒绝卡片/章节带重复渲染或来源过期的报告。
当前验收入口通过产品 `superViewModules.element` 加载视图和共享 graph UI，继续遵守
图谱按需加载边界；基线直接导入实现。双方在挂载和动画稳定后才开始计数，输入指纹
一致，因此此比较仅覆盖后续交互，不比较入口加载或首开时间。

测量的是产品函数调用和 JSX 创建次数，不是 React commit 时间、用户输入到绘制
延迟或峰值内存。标题和分组数据变化仍会重建类别读模型；本批没有实现逐卡片订阅、
初次布局增量化或视口裁剪。Story Graph 卡片树、移动物理触摸和总体预算继续开放。

当前源码另生成 `acceptance/f5-cards-native.json`：在 M3 Pro / 36 GiB 上新构建
隔离 Tauri Debug 应用，完整组合 56 项及重启 4 项检查通过，Agent 文本序列的真实
SQLite 写入/恢复检查也通过；两次 Cmd+Q 均正常退出（exit 0），无未捕获错误，
SQLite 完整性及外键检查通过。这是产品组合回归，不是原生 5,000 卡片计数或手机验收。
首次尝试在等待人工式正常退出时超时，未生成通过报告；当前证据来自完整重跑。
全量测试 2,538 项通过、1 项跳过，类型检查和六项仓库必检通过；Lint 保持原有
74 条警告。正常产品构建为 32 个 JS chunk，无验收计数器/入口标记。

## F5f：Story Graph 行内卡片与分组预算

在产品拆分前固定完整视图场景：100 / 1,000 / 5,000 个已放置章节，8 / 24 / 50 条
真实故事线，加一个未归属行和一个叙事时未放置章节。使用产品按需加载器、完整行内
卡片、浮层与 pointer 生命周期；数据及导航为合成输入，拖动和关系配对均在写入前取消。
预算为 20 次未放置浮层切换、10 次卡片浮层打开/关闭，不重建未变化的行和卡片，也不
重新按行分组；首次按行分组只遍历每个已放置章节一次。100 次 pointermove 取消路径
继续保留现有直接 DOM 拖影方式。挂载计数必须非零，防止未插桩被误认为优化成功。
本批不把卡片刷新计数换算成原生延迟，也不宣称持久拖放、关系写入或移动触摸已验收。

`StoryGraphLaneRow` 现在独立持有故事线行和章节卡片 JSX，以默认浅比较 memo 隔离
无关浮层状态。shell 保留点击、连线来源、菜单、导航和拖动提交的状态归属，传入依赖
完整的稳定回调。几何配置原值移到 `story-graph-layout`，其中按主视觉行一次分组并
保留原节点引用与顺序；副故事线的章节统计和跨故事线邻接仍采用原有独立读模型。
相关数据、主故事线或连线来源变化仍允许刷新；没有新增逐卡片订阅或可见区域裁剪。

基线 `acceptance/f5-story-cards-baseline.json` 在 5,000 章节 / 51 行下，首次分组
判断 255,000 次；20 次未放置浮层切换或 10 次卡片浮层打开/关闭分别再判断 510 万次，
各创建 100,000 次卡片 JSX。`acceptance/f5-story-cards.json` 以相同输入指纹记录
首次分组 5,000 次，三种规模的后续行、卡片和分组计数均为 0。100 次 pointermove
原有拖影保持直接 DOM 更新，拖动开始/取消导致的那次父刷新也不再重建整棵卡片树。

场景另外验证全部卡片保留、原主故事线归属、浮层返回关闭状态、取消拖影清理、Shift
选择/取消、最新来源配对、改名，以及主故事线切换后卡片恰好出现于新行、位置不变。
移动后的右键菜单须包含当前标题和故事线，固定定位并 portal 到 body；双击导航仍
打开正确章节。普通 CI 必须执行这些检查，拒绝重复分组、卡片重建或归属变更失败。
旧 pointer 结构测试已同步验证行组件 → shell 稳定回调 → 共享 pointer 控制器的接线，
没有移除拖影、连续坐标、移动连线模式防误拖和未放置入口的现有要求。
主视图从 2,182 行降至 2,055 行，仍集中持有未放置/Drift 卡片、关系弹窗和命令协调；
这些边界和逐卡片数据更新、持久拖放/关系创建组合、移动物理触摸与固定设备预算继续开放。

本批全量测试 2,538 项通过、1 项跳过，类型检查、CI 契约和公开边界检查通过，
Agent 能力检查 19 项通过；Lint 仍为原有 74 条警告，没有新增警告。正常产品构建
保留 32 个 JS chunk，未包含 Story Graph / Super Element 验收计数器或夹具入口。

最终源码生成 `acceptance/f5-story-cards-native.json`：M3 Pro / 36 GiB 上新构建的
隔离 Tauri Debug 应用通过组合 56 项、重启 4 项检查及 Agent 文本序列的真实 SQLite
写入/恢复；两次 Cmd+Q 均以 exit 0 正常退出，未捕获错误为 0，数据库完整性和外键
检查通过。该控制组证明本批改动没有破坏既有原生组合流程，不覆盖原生 5,000 章节
计数、物理 IME/手势或固定设备延迟预算。

## F5g：Drift 卡片树与拖动临时状态预算

先固定双图谱完整场景：100 / 1,000 / 5,000 个合成 drift、20 个章节和一个元素，
覆盖 drift 作为关系任一端点以及 drift↔drift。关闭面板时进行 20 次父视图模式/浮层
切换，打开后执行 10 次卡片弹窗开关；Story Graph 再执行 20 次插入位置 hover 和
拖动取消。闭合面板不应执行卡片树，打开后的无关浮层也不应重建卡片内容；hover
不应刷新主图谱，卡片正文只随实际视觉状态变化执行。另计包装元素的遍历次数，避免
把 memo 省去正文执行误称为整个拖动过程已经是常数复杂度。
保留当前视觉排序行为，不新增 drift 持久排序字段；标记和关系写入另行验收。本批
检查真实卡片、特殊边、最新来源、菜单、改名和关开清理，不据此声明物理拖动通过。
保持既有关系展示范围：Story Graph 绘制纯节点关系，Super Element 只绘制涉及元素的
关系。夹具里的三条关系在 Story Graph 显示三条特殊边，在 Super Element 显示两条；
两种方向都必须保留，关闭面板不改变底层关系记录。每次合成 dragover 后等待两个帧
回调，让 React 连续事件队列完成提交，再记录下一次 hover；这些帧间隔不作为绘制延迟。

实现将两种 drift 卡片树放入面板的实际挂载内容，关闭时不再提前求值所有卡片。
Story Graph 的 `story-graph-drift-drag` 仅保存临时来源和插入位置；卡片与特殊边层订阅，
shell 在叙事轴 drop 事件中读取最新来源并沿用原标记写入命令，不为 hover 订阅状态。
项目边界、关闭/卸载及来源不再位于原位置时清理临时状态。稳定回调保留点击、连线、
右键菜单和双击导航的原命令内容。卡片正文用默认 memo，仅随真实视觉或数据变化执行。
当前 drift 不持久保存手牌顺序，视觉放下仍回原位；移除了只有未来节点列表变化才会
触发的迟到 FLIP 状态，回位使用原有 CSS transition，不新增排序写入或后台任务。

`acceptance/f5-drift-cards-baseline.json` 与 `acceptance/f5-drift-cards.json` 的六组
输入指纹相同。5,000 drift 下，关闭面板的 20 次父操作、打开后 10 次卡片弹窗开关，
原来各执行 100,000 次卡片内容，现在双视图均为 0。Story Graph 的 20 次连续 hover
原来刷新 shell 20 次并执行 100,000 次卡片内容，现在 shell 为 0、内容为 19 次，
对应跨过的 19 张卡片。包装元素列表仍遍历 100,000 次，尚未成为常数成本；这项计数
显式保留在报告和门槛中。首次大面板挂载、逐卡片数据订阅与视口裁剪仍待继续。

完整场景保留双向特殊边、resting 样式、卡片和最新来源、菜单当前标题、改名、关开恢复；
Story Graph 另验证所有跨过槽位的位移、取消及视觉放下不改节点记录、拖动中关闭后
重开不残留状态。Super Element 没有手牌排序交互，当前报告将相关检查记为 null，
不将其当作已执行的拖动验收。单元测试覆盖不可变快照、双向槽位移动、即时取消、迟到
hover、重复清理和订阅退出；普通 CI 拒绝闭合树求值、hover 刷新 shell、无关卡片内容
执行或未清理状态。Story Graph 主视图 2,055 → 1,898 行，Super Element 1,915 →
1,893 行，未放置区域、更多浮层和命令协调仍在主视图中。

本批全量测试 2,540 项通过、1 项跳过，类型检查、CI 契约、公开边界和 Agent 能力
检查通过；Lint 为原有 74 条警告。正常产品构建保留 32 个 JS chunk，无验收入口或
图谱计数器标记。浏览器计数不是物理拖动、输入到绘制延迟或原生大图预算。

同一份源码新构建 `Drifting Acceptance b50cc1a525eb.app`，生成
`acceptance/f5-drift-cards-native.json`：原生组合 56 项、重启恢复 4 项检查通过；
Agent SQLite transcript 的首次写入 8 项、重启 4 项检查通过。两次 Cmd+Q 正常退出，
未捕获错误为 0，SQLite 完整性和外键检查通过。产物 SHA-256 为
`bdaf1a811b9123ea60109bc4fe7753096094879906f52b90b6b70a8f9060db24`。
这份控制组覆盖既有编辑器、图谱/设置、项目切换和 Yjs/Agent SQLite 恢复组合，
未执行原生 5,000 Drift 卡片计数或物理拖动，固定设备预算仍待验收。

## F5h：未放置章节列表和浮层边界

先以 100 / 1,000 / 5,000 未放置章节、一个已放置章节的真实 Story Graph 场景固定预算。
关闭未放置浮层时不应提前构建章节内容；打开浮层后，10 次已放置卡片弹窗开关不应
重建无关列表。独立记录主视图和章节内容执行次数，保留完整 DOM、原书序、主故事线
颜色和未归属回退色。验收还覆盖改名、主故事线及颜色变化、最新标题的拖动影子、
取消拖动清理、Escape、空列表及重新打开后的最新数据。此处先验证取消，不声称完成
持久拖放、物理手势或原生大图预算。

`StoryGraphUnplacedChapters` 负责按钮锚点、计数、body/fixed 浮层和章节内容；默认 memo
阻止无关主视图状态重新执行这块界面。章节内容作为独立子组件传给 `AnchoredPopover`，
只有浮层挂载时才求值。主视图仍拥有开关状态、共享 Escape 顺序和持久拖放命令，
通过稳定回调传入当前章节；章节列表不复制数据、不建立第二套 store 或拖动控制器。
主故事线解析和颜色 map 沿用原有读模型，更新数据后会重新显示当前标题及颜色。
Story Graph 主视图 1,898 → 1,844 行，新增组件 89 行。首次打开与相关数据变化仍遍历
全部未放置章节，未实现逐卡片订阅或窗口化；当前改动不声明解决首开大列表成本。

`acceptance/f5-unplaced-baseline.json` 记录优化前的真实结果：三档数据首次主视图挂载
即提前执行 100 / 1,000 / 5,000 次列表内容；关闭列表和打开列表后的各 10 次章节弹窗
开关，均执行 2,000 / 20,000 / 100,000 次列表内容。每组的主视图执行次数均为 20。

`acceptance/f5-unplaced.json` 与基线三档输入指纹一致：首次关闭状态的列表内容执行为 0；
关闭/打开状态下，各 10 次章节弹窗开关的列表内容执行均为 0，主视图仍执行 20 次。
首次打开保留全部 100 / 1,000 / 5,000 个章节，计数恰好等于章节数，证明测量入口有效。
每档 12 项行为检查均通过，包括改名和主故事线/颜色更新后的原 DOM 保留、当前标题
拖动影子、取消后关闭列表且节点数组不变、Escape、空列表以及重新打开的当前数据。
普通 CI 强制这些计数和行为；负向测试拒绝提前求值、无关重复构建、旧标题/主故事线
和取消未清理的报告。拖动接线守卫同步检查章节组件 → shell 回调 → 原共享拖动控制器。

全量测试 2,540 项通过、1 项跳过；类型检查、CI 契约、公开边界和 Agent 能力检查通过，
Lint 为原有 74 条警告。菜单样式守卫已随浮层的实际归属迁移到新组件，保留原样式要求。
正常构建输出 32 个 JS chunk，不含未放置夹具、计数器或验收入口标记。

同源码的新构建 `Drifting Acceptance f3113fe8245f.app` 生成
`acceptance/f5-unplaced-native.json`：组合 56 项、重启恢复 4 项检查通过，Agent SQLite
transcript 的首次写入 8 项及重启 4 项检查通过。两次 Cmd+Q 均以 exit 0 正常退出，
未捕获错误为 0，SQLite 完整性及外键检查通过。产物 SHA-256 为
`1d2c1040e97cb9e925a042775c3e88226ed51c999b02a7d6367b83fa8a4fde35`。
该控制组覆盖既有编辑器、图谱/设置、项目切换和 Yjs/Agent SQLite 恢复；不覆盖
原生 5,000 未放置章节、完成拖放后的持久写入、物理手势或固定设备延迟预算。

## F5j：按卡片槽位发布 Drift 拖动变化

Story Graph 的拖动状态继续由视图拥有，特殊边层读取完整快照，叙事轴 drop 仍读取
当前来源并执行原标记命令。卡片现在各自订阅所占槽位的显示值，列表不再订阅每次
hover。发布器比较前后来源和插入边界，只通知显示值改变的区间；返回稳定的原始值，
不生成整列表快照或重新创建所有包装 JSX。取消仍即时恢复受影响卡片，不增加定时器。

对照已保存的 `acceptance/f5-unplaced.json`，相同 100 / 1,000 / 5,000 Drift
夹具中的 20 次连续 hover，包装 JSX 创建分别从 2,000 / 20,000 / 100,000 次降为
0；shell 更新仍为 0，实际位移变化的卡片内容仍为 19 次。闭合面板和弹窗操作的卡片
创建保持为 0。首次挂载仍保留全部 N 张卡片，并建立 N 个槽位订阅；取消或跨越很长
区间仍须更新实际改变的卡片。该优化不代表首次大列表挂载或整体内存成本已经下降。

`acceptance/f5-drift-slots.json` 增加反向拖动、跨过来源位置、前方节点删除导致
来源槽位变化时取消、重新插入后连线恢复的浏览器检查；原有双向特殊边、视觉放下、
关闭/重开、当前标题/菜单/来源配对继续检查。单元测试遍历来源及双向插入位置，
验证准确的受影响通知集合；5,000 个订阅的 20 次邻近 hover 共通知 19 次，远端目标
按已订阅槽位范围处理，释放后不再通知。普通 CI 拒绝整列表包装工作回退、旧订阅模式
和失败的反向/槽位失效行为。

本批证据来自隔离浏览器、合成数据及 DOM 事件，未执行原生组合复测、物理手势或
固定设备性能预算。真实关系/标记持久化与正常退出/重启属于另一个待原生验收批次。
F5-01–04 继续保持 partial。

该独立批次完整测试 2,542 项通过、1 项原有跳过；类型、Lint、CI 契约、公开边界、
Agent 能力和当前源码浏览器确定性检查通过。Lint 为 0 错误、74 条原有警告。
正常本地模式构建输出 32 个 JS chunk，不含本批夹具、计数器或原生验收入口标记。
