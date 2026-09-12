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
