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
