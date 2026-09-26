# Milestones and acceptance

The complete P0–P7 migration is authorized for continuous, staged execution.
Use **make it work, make it right, make it fast** within each functional batch.
Finish its agreed scenarios, repair demonstrated data errors and then advance
the main writing workflow. Do not grow an open-ended edge-case matrix or require
another start instruction between batches.

Each completed batch updates durable documentation and generates its machine
acceptance evidence, then is committed before the next batch accumulates.
Audit the staged scope and preserve unrelated changes. Commit authorization does
not include pushing or publishing. Keep physical-device, account and signing
prerequisites explicit when they cannot be exercised locally.

Implementation priority: clean, maintainable code and a usable writing flow.
Keep compatibility work to the supported public database contract; do not add
retired-format adapters, speculative historical backfills or duplicate write
paths. Performance work is deferred until functional integration except for an
unusable stall or a demonstrated risk that would require redesigning the
architecture. Existing correctness fixes and their evidence remain in place.

| Milestone | Deliverable | Exit gate | Current state |
| --- | --- | --- | --- |
| P0 | Inventory, ADR, scope, native design and synthetic corpus | Every inventoried surface has sources, dependencies, disposition, target, tests and unresolved decision task | Complete for initial migration scope |
| P1 | Two buildable native hosts, Swift–Rust ABI, extracted core reused by Tauri | Create/read/rename synthetic project, close/reopen; existing migration/snapshot tests; old client regression | Initial lab acceptance passed; latest desktop XCTest needs input-synthesis repair (see acceptance notes) |
| P2a | Headless Yjs/Yrs harness | Incremental, concurrent, reordered and duplicate updates converge without schema/metadata loss | Complete for declared headless scope, including redone-offset, sparse-replay and undo deletion-filter fixes; see source-matched generated evidence |
| P2b | AppKit/UITextView document binding | Local operations, stable IDs, comments, marks, multi-view ownership, IME and semantic undo | In progress: shared owner/queue/history, disjoint composition, exact TextKit edit ranges, CRDT selection epochs/history, copied/redone sibling-text lineage and atomic prose/comment fixture checkpoints; remote-owned subtree text survives undo; authored input branches pass programmatic AppKit overlapping/remote composition and continued-input queues; hosted UIKit marked input, exact repeated-item edits, Unicode deletion and responder changes tested; system history routes, disjoint structural drafts and scoped quote boundaries implemented; Mac incremental styling passes full-reference checks; strict-prefix same-paragraph Enter passes cross-implementation history/reopen checks; physical IME, general same-block concurrency and subtree relocation gates open |
| P2c | Durability and measured writing behavior | Crash/reopen/tail replay/compaction pass; compare native and current editor on declared corpus | In progress: exact authored bytes, scoped native command records, atomic SQLite revision/journal/anchor writes, ordered tail replay, bounded stored-dependency recovery and covered snapshot/prune implemented; harness covers 9 original recovery, 3 unapplied styled-update retention, 3 derived-repair, 3 stored-dependency and 5 native deletion SIGKILL boundaries with two independent restarts each; see current generated report; performance comparison open |
| P3 | Shared domain commands and queries | Semantic differential tests preserve journal/transaction/asset effects | In progress: local project/chapter creation, rename and chapter before-ID move accepted through shared commands and canonical journals; remaining domain commands open |
| P4 | Sync and Agent over native prose | Minimal in-process runtime, guarded writes/reviews, offline/reconnect/restart; accounts separately tested | Not started |
| P5a | Daily desktop writing loop | Project/chapter, editor/outline, required split/tabs, search, sync and recovery usable together | In progress: creation, rename, chapter up/down, editing and save/reopen accepted; outline, tabs/split, search and sync remain open |
| P5b | Required desktop feature parity | Elements/materials, graph/timeline, comments/review, Agent, import/export/settings/diagnostics | Not started |
| P6 | iPhone/iPad auxiliary client | Read/edit, quick capture, search, comments and sync status; interruptions and keyboard on devices | Initial project/chapter/editor slice passes iPhone/iPad simulator workflows; auxiliary scope and physical-device acceptance remain open |
| P7 | Upgrade and distribution | Supported published-version upgrades, rollback/recovery, signing/notarization/update and exact-source artifact evidence | Not started |

## Bounded editor gates and functional integration

The current execution order supersedes the earlier blanket requirement to close
all P2 investigations before integrating any workflow. The accepted local editor,
undo, atomic persistence and reopen subset supports the next bounded vertical
slice: project creation, chapter creation, editing, save and reopen. Shared domain
commands (P3) and the minimal native host needed to exercise them may advance
together. This does not mark full P2, remote synchronization or desktop parity as
complete, and does not authorize unrelated broad UI construction.

Known remote structural/deletion failures must be resolved before enabling the
affected synchronization path. Physical IME and device evidence remain separate
gates. A demonstrated data-loss or undo defect in the current slice blocks that
slice; speculative new cases do not indefinitely block the next one. Mobile
omission of a UI must never erase underlying desktop information. The P6
first-release scope above cannot shrink silently.

The first P2 durability cases include a remote update committed before live
replay, a lost replay callback, remote N+1 before local N+2, compaction and
process termination. Preserve ordinary prose-only interactivity and the
separate structural refresh barrier described in the existing
[remote merge contract](../sync-engine/phase1-remote-yjs-live-merge.md).

## Measurements and evidence

After the main writing flow is usable, compare it with the current editor on
the synthetic corpus and the same machine. Retain the following initial target
budgets: input-to-paint p95 at most 50 ms after committed input,
no ordinary edit/scroll main-thread stall above 100 ms, interactive warm chapter
switch at most 200 ms, and no memory growth after repeated open/close once
caches settle. These are target budgets, not measured results. Record cold
startup, peak memory, document-load and multi-view costs without claiming a
universal hardware-independent limit. Investigate regressions before exit.

Evidence dimensions are independent: source tests, file-backed integration,
macOS native UI, iPhone simulator, iPad simulator, physical device, real account,
minimum OS, Intel build and distribution package. A skipped dimension is
`not-run`, never inferred from another. Failure logs and xcresult bundles stay
in ignored local output; checked-in reports contain relative paths and hashes,
not personal paths, machine IDs, manuscripts, accounts or signing identities.

## Current functional slice and next batch

The [local writing slice](workspace.md) covers creation, independent prose, local
history, save, switch and cold reopen, accepted in `15e298ba`; rename was accepted
in `5a604200`. The current extension adds shared chapter moves before an ID or to
the end, exposed as AppKit up/down buttons and a UIKit editor menu. The core writes
only the moved chapter's scalar `bookOrder` mutation, timestamp and field clock.
It preserves fixed act boundaries, refuses an unrepresentable strict finite gap
atomically, and makes already-positioned requests no-ops. Rename and reorder
retain the current prose owner, selection and history.

Shared-core, bridge and production renderer comparison pass; exact counts and
source identity belong to the [workspace report](acceptance/p3a-workspace.json).
Both iPhone and iPad pass 13 hosted binding cases and the two UI scenarios,
including movement, continued history and cold order recovery. Mac, simulator
and unsigned device builds pass. Rebuilt-Mac CUA confirms up/down and restart
recovery separately from desktop XCTest. Completed batches are committed after
their checks, without pushing.

Next expose native editor actions for bold/italic selections and paragraph/heading
formatting through the existing Rust document transactions and history, then
connect the outline. Preserve act/chapter/scene/beat/note semantics. Delete, the
complete outline, sync and Agent are outside this ordering batch. No performance
measurement or extra historical migration matrix is a prerequisite.

The six known old-peer alias-delete failures stay explicitly open; the accepted
local workflow does not certify full P2 or general remote synchronization.

## Completed editor foundation and remaining investigations

The plain original-left quote-prefix batch now implements durable item aliases,
causal insertion routing, two-receiver deduplication, grouped structural history
and relative-anchor routing. Both separator join and partial deletion retain
late original `b` text through repeated undo/redo and restart. New formatting,
deletes, unknown dependencies and broader subtree moves remain unsupported by
this scoped route. The stored-unapplied barrier and native draft preservation
remain for those cases. Derived repair bytes, System journal, snapshot and comment
CAS commit together before the live owner advances. The process harness now
includes three repair interruption boundaries alongside the original recovery
and styled-update retention cases. Generated reports remain the authority for
which source revision passed each gate.

Mixed packets now preserve safe suffix text at its original item identities while
routing threatened prefix text. Independent writers and same-writer prefix then
suffix pass cross-implementation and file-backed recovery tests; native binding
coverage is recorded separately. Interleaved same-writer clocks now require
exact immutable proof of safe text outside the alias graph. Source Skip and
canonical GC have separate checked encoding paths. History preflights the full
rematerialization before touching text or the undo stack; remote receipt conflicts
and unsupported multiple-alias gap cases refuse atomically. The file-backed
tests cover genuinely pending bytes across checkpoint/prune and cold reopen,
dependency completion, two-comment CAS rollback and retry.

The owner can now recover an already-blocked oldest prose tail row when later
persisted dependencies supply a complete supported alias repair. It validates
each row before merging the remaining tail, preserves raw bytes and actual IDs,
and commits repair, comments and snapshot before publishing the result once.
Unrelated invalid later rows and valid explicit cancellation without a repair
remain conservative refusals, and need further recovery work. This is distinct
from an update that was accepted as genuinely pending.
The shared native queue delivers later remote dependencies even while local
jobs are held. Queued events resume in their original order after recovery;
marked text keeps its branch until native commit, and its status no longer
claims the resolved remote block is active. AppKit and UIKit cases cover these
paths separately from the process-termination harness.
General same-block/cross-container structural reconciliation and
unselected-subtree relocation remain open for the affected remote path. Preserve the causal source graph and extend the
existing shared history path; do not replace them with offset-based copies.
Physical native IME/keyboard/interruption behavior, P2c performance measurement
and production ownership integration remain open. The full-document guard and
alias/history costs have no current performance certification; the earlier
timing results retain their source fingerprints. Measurement is deferred until
the writing slice is integrated, under the execution order above.
The first P2c slice now has a [durability contract](durability.md) and generated
[process recovery evidence](acceptance/p2c-durability.json). It exercises real
SIGKILL before/after authored COMMIT, remote commit before notification, replay
before coverage acknowledgement, all atomic snapshot/prune phases, and an actual
remote N+1/local N+2 gap followed by a later retained tail row. These are scoped
storage and owner guarantees, not full P3/P4 domain/reducer acceptance.
The [visible performance experiment](performance.md) now measures the Release
prototype on the 5k/50k/200k corpus. Exact UTF-16 equality and eligibility-first
selection capture reduced 200k synchronous-dispatch p95; the prefix-deletion regression
sample records 15.3 ms, with two-display-callback p95 of 38.5 ms. Its paired production Tauri baseline
has 132 samples and independent post-exit SQLite/Yjs verification; its 200k
dispatch-to-two-callback p95 is 42.0 ms. Durable native settling is 91.1 ms in
this run. Callback, persistence, navigation and process-memory boundaries differ;
these samples do not certify physical input or the complete workspace budget.
They precede the later partial quote-deletion and retention-preflight changes and
retain their original source fingerprints; those changes have correctness, not
new timing evidence.
The first binding slice is described
in [the document contract](document-core.md), with a separate generated
[Swift/AppKit binding report](acceptance/p2b-binding.json).
Its multi-view cases cover interleaved queued edits, selection shifts, shared
undo/redo, overlapping marked-text commits, cancel, explicit structural recovery,
view detach and last-view queue/draft lifetime, injected save failure and retry.
Remote-before-local input and input arriving during merged-projection refresh
retain their original CRDT basis; committed composition can be followed by
immediate typing without waiting for its merged reply.
Registered selections are tested against Yjs relative positions under remote
edits, and in AppKit across repeated-character replacement/undo, fast manual
caret changes, structural history, reopen and detach. View positions remain
session-local; capture is not a prose transaction or a checkpoint write.
New selections after sibling split/join now follow item lineage through undo/redo,
including redone IDs and AppKit callbacks. The former remote-subtree loss diagnostic is now repaired and replaced by twelve
positive native/Yjs filter comparisons with repeated history and checkpoints.
Retained remote text keeps stable IDs, marks, unknown metadata, comments and
selection endpoints; heading protection and retained-parent attributes extend
the default old-plugin policy explicitly. Changes to locally copied items follow
the old plugin's copy/undo semantics rather than being transferred to originals.
See the document contract for this exact acceptance boundary.
Snapshot-authored inline drafts and sequential input branches have Rust, Yjs,
C ABI and serial Swift checks, including overlapping edits and an authored caret.
The shared queue now passes actual programmatic AppKit marked-text callbacks
with overlapping remote updates and immediate continued input. Native branches
reuse an author within a burst and are released after publication; generation
growth and snapshot cost still need P2c measurements. Disjoint-block structural
drafts now merge using exact item/context checks and live anchor maps. The new
same-paragraph extension permits interior Enter with pure remote insertions or
pure deletions strictly before the cut. Deleting the whole prefix is supported;
the copied tail, surviving item order/marks and raw block/text metadata must stay
unchanged. Mixed changes and changes to the tail still retain the draft. Queued
typing keeps its authored offsets while history and anchors use the live range.
The generated document report records the current Rust/Yjs counts, including six
Yjs insertion and eight deletion scenarios. Deletion checks include repeated
history without resurrecting remote deletions, original comments, fragmented
item clocks, old-client tail edits and reopen. Two actual AppKit queue cases also
deliver a remote partial or complete prefix deletion immediately before Enter
and continued typing, without a run-loop yield. Both native views and comments
remain exact through two-command undo/redo, duplicate updates and SQLite reopen;
the active caret is checked after the merge and each undo.
Other same-block and cross-container
structural conflicts remain unfinished requirements.
Nine hosted UIKit cases exercise programmatic native input entry points on iPhone/iPad:
composition commit/cancel, overlapping remote edits and continued input, exact
repeated-character identity, Unicode deletion, responder resignation and native
history routes/guards, plus exact NFC/NFD replacement, composition, passive-view
refresh and reopen. The ninth case routes late original-left Unicode text after partial quote deletion through two views, passive selection, repeated history, duplicate delivery and SQLite reopen. AppKit standard responder actions and menu availability
are tested with shared history, including disjoint remote input during a split
and immediate continued typing. This
found and fixed missing delegate-range capture and uncommitted focus-loss drafts.
The native runner records this evidence separately from simulator UI smoke flows;
`--binding-only` supports focused iteration without repeating unrelated checks.
The Mac second-window entry uses this same owner. Desktop keyboard synthesis
and physical IME are separate, unaccepted gates.
The [system input-method observer](system-ime.md) now has a generated failed
CUA attempt: correct keycodes and focus did not produce marked composition under
both selected Doubao and Apple Pinyin sources. Input contexts and TIS matched;
the standard application loop also reproduced direct Latin input. A separate
empty stock NSTextView reproduced it with matching focus and input contexts, so
the symptom is not specific to the Rust-backed view. CUA/macOS routing remains
unresolved; physical keyboard behavior has not been established.
A forwarding-only single-key probe further observed `keyDown` →
`interpretKeyEvents` → direct `insertText`, without `setMarkedText`, under both
helper-menu selection and the macOS input-source shortcut. Both runs restored
the original source. They diagnose the input route; they do not pass system IME.
The [physical-iPhone diagnostic](device-acceptance.md) separately records a missing
Xcode account session and ineligible development profile; no device installation
or runtime test is inferred from the completed device Rust build.
[P2a evidence](acceptance/p2a-document.json) covers the pinned Yjs 13.6.32 /
Yrs 0.28.0 headless matrix, including 576 seeded concurrent edits, 36 sparse replay
and restart scenarios, plus the expanded structural corpus against the actual
old editor: 37 accepted operations and three atomic
rejections for unselected-subtree relocation. These rejections prevent duplicate
public block IDs when remote text would protect a relocated copy during undo;
they remain an unfinished P2b requirement. Structural text copies and inherited
marks now retain raw CRDT value types; dedicated tests cover binary and undefined
metadata in memory instead of relying on JSON semantic comparisons alone.
Non-JSON format/embed values cannot be represented losslessly in v1 and are
rejected before integration/export; Yjs v1-canonical marks and typed binary XML
attributes retain edit/history/reopen coverage. Comment history additionally covers remote
Yjs prose, canonical post-redo positions, checkpoint reload and legacy comment
parsers. Seventeen bridge tests cover atomic prose/comment checkpoint rollback,
retry, external-anchor conflict, retained body/status, the ephemeral selection ABI, draft/input-branch lifecycle, remote merge/reopen, duplicate-sequence rejection and persistence-only retry. These scoped checks
do not certify production comment lifecycle or physical native IME. SQLite-tail
acknowledgement and recovery now have the separate P2c owner evidence. Safe adjacent
quote joining retains the right physical container and suffix while adopting left
public IDs; production-plugin history stages, independent checkpoint reopens
and the AppKit binding suite verify that limited shape. The partial-deletion
extension preserves nonempty text on both sides and the original right suffix;
two production-plugin cases cover 14 history stages and independent reopens.
The original empty-right separator case and three complex rejections remain.
Its generated binding cases also verify immediate continued input, two views,
the passive selection on the original right tail, three persisted comments,
redo across remote history stages and SQLite reopen. They include eight Mac
style checks: one-block updates and unchanged-reply
skips must match full styling at every UTF-16 position, including format/comment
boundaries, Unicode, structural fallback, remote formatting and composition
commit/cancel. Comment-only refresh is a projection-level check, not production
sync. Four additional exact-text cases prevent canonical Unicode equality from
dropping NFC/NFD edits or leaving passive views with incorrect UTF-16 ranges;
they include composition history, remote refresh and reopen. The latest 200k
prototype sample reaches a 38.5 ms p95 for two display callbacks, below the
50 ms target for that metric, while full workspace and physical-input budgets
remain unverified. Real OS input-method acceptance is separate.
The hosted UIKit regression also found and fixed initial responder callbacks
from a second empty text view being treated as prose deletion. It now verifies
passive-view construction before native input and history operations.
More general subtree relocation remains open. See the
[relocation design experiment](relocation-design.md) for measured copy/history
behavior and the unresolved multiwriter, duplicate-checkpoint and anchor gates;
its ignored JavaScript probes are not native acceptance. See the
[upstream diagnostic](acceptance/yrs-random-array-diagnostic.json) for the original
array failure and 100 passing runs with the replay fix; deterministic native and
Yjs regressions establish the replay contract separately from that sample.

The separate [alias deletion diagnostic](acceptance/alias-delete-diagnostic.json)
records six current failures after a successful late-text repair: old-author
deletions arrive successfully but do not remove the corresponding visible copy.
Three real Yjs controls show that merging such a deletion into the repaired
checkpoint can erase the distinction from a harmless replay at the byte level.
The next dependency is verifiable authored-delete provenance and durable logical
deletion coverage through history. A packet-only guard would also reject ordinary
state-vector differentials, so no compatibility downgrade is silently enabled.
The no-repair owner cancellation prototype remains unmerged. These findings keep
P2 open; neither insertion convergence nor a passed recovery matrix certifies
the missing deletion behavior.
As a prerequisite for trustworthy provenance lookup, checkpoint restore now
cross-checks all mutation rows against the verified encoded change-set and
requires complete index coverage. Thirteen re-sealed tamper cases fail before
domain or asset activation, and valid rows still restore exactly; the
[generated integrity report](acceptance/checkpoint-mutation-integrity.json)
records that separate file-backed boundary.
The [transaction evidence foundation](acceptance/yjs-transaction-provenance.json)
now validates an optional versioned supplement, captures the preceding Yjs
snapshot and transaction deletions, and preserves them through journal, wire,
remote materialization and checkpoint restore. It guards against earlier
listener/predicate writes contaminating the basis and keeps capture errors out
of Yjs cleanup. Legacy payload bytes remain unchanged; production editor
capture is still opt-in. Observer-generated events can contain later structs,
and structural retirement is not authored deletion. Operation classification,
causal reconstruction, required capability rollout and native logical deletion
routing remain open; this batch does not resolve the six deletion failures or
unlock broad UI construction.

Mutation construction now snapshots the canonical payload and target before
asynchronous hashing, preserving integrity when the caller changes nested
evidence or binary buffers during the hash or after return. The transaction
evidence report includes both wire regressions. Isolated command/source-basis/
deletion-routing composition passes its synthetic history and restart cases,
but replicated deletion records still require independent original-operation
authorization and atomic owner integration before this becomes a product path.
The independent authority prototype now also preserves grants through input
forks and captured IME drafts, and its isolated composition passes 147 Rust
cases. The native original-envelope/SQLite lookup is now shared-core code with
[57 core cases](acceptance/original-operation.json),
requiring a matching application receipt and every materialized mutation in
one read snapshot and portable synthetic fixtures. Its bounded original-body
archive now also accepts ordinary seed/insertion events, discovers targets from
canonical originals, and checks the generation/project catalog. It proves the
retained collection, not historical completeness or recovery of lost bodies.
A later isolated authority
bridge uses the real verifier and SQLite cold lookup, but independent concurrent
join review exposed an ambiguous-mapping deletion gap. The follow-up isolated
155-case guard atomically refuses both problematic packet orders and preserves
normal single-graph history; it does not implement multiple-graph deletion.
The subsequent 160-case document composition uses those actual database originals
for six deletion/history/cold-reopen scenarios. Independent review caught and
verified a fix for borrowing an applied archive with a different same-scope
original; exact original-reference and byte membership are now required.
An isolated owner now commits original verification, repair, comment projection
and checkpoint before live publication, using the existing journal/repository.
Six owner groups plus the existing 18 prose, 160 document and 51 core cases pass.
An independently reviewed process harness passes six real SIGKILL cases and
twelve cold restarts across precommit and postcommit/prepublication boundaries.
It checks exact rollback, persisted reference discovery, explicit retry and
no-write duplicates; this is WAL/NORMAL process recovery, not power-loss evidence.
See the [bounded owner and recovery evidence](relocation-design.md).
The next isolated composition persists actual public native deletion commands,
including supported queued/draft input, as exact events with bound evidence.
Three native originals pass the full journal/store/archive/receiver/history/cold
chain and actual Yjs cross-checks. The combined 176 document, 57 core, 9
authority-owner and 27 prose integration cases pass. A legal multi-client event
ordering mismatch and three document-incarnation ownership defects were fixed;
scope is now bound when opening and rechecked within the persistence/replay
transaction. Failed writes retain complete command records for retry.
That frozen semantic composition remains isolated and requires an already-applied
original with a fully covered checkpoint. Production host integration, general
incoming/tail recovery, relocation semantics and the required capability rollout
remain open. Earlier process-kill evidence applies only to its frozen source.
This progress does not advance P2 to passed or unlock broad interface work.

The command-capture and durable-authoring subset is now in the formal shared
crates and NativeLab bridge, without the isolated semantic authority owner.
The [authoring report](acceptance/native-authoring.json) passes 132 document,
61 core, 27 prose and 18 bridge tests (238 total), plus 80 renderer checks,
three journal and four actual native wire cases. The current process harness passes all 23 SIGKILL
boundaries and 46 cold restarts, including five real native deletion cases.
Failed transactions retain whole command records; opening and writing validate
the same document incarnation. See [the authoring contract](native-authoring.md)
for supported input and the remaining receiver/capability boundaries. This
promotion does not enable semantic deletion or resolve P2's outstanding gates.

The subsequent isolated receiver now explicitly recovers one already-applied
original whose exact event is the sole uncovered row for that document. Three
file databases prepared by the actual renderer materializer pass native cold
recovery, duplicate and independent Yjs checks; recovery adds one System repair
without another Remote revision or selected-original receipt. The combined
candidate passes 176 document, 57 core, 27 prose and 21 owner tests (20 assertion
groups and one fixture-export hook). Its independent process copy passes six
real SIGKILL boundaries and twelve cold restarts on those renderer databases.
Callback-induced source quarantine and a mutating duplicate-path comment loader
were reproduced, fixed and independently rechecked. This is an explicit
single-row cold path: arbitrary tails, automatic selector discovery, hot local
input/history and production receiver integration remain open. The existing
formal platform reports apply to the authoring subset; these receiver results
do not certify native UI or advance P2 to passed.

The next isolated read-boundary fix makes ordinary cold-open comment loaders
read-only and bounds checkpoint/tail storage before allocation. Two actual
mutating-loader failures now roll back; four focused groups and all 25 owner
functions pass (including one fixture-export hook). Separately, an actual
renderer-to-Rust counterexample exposed an admission defect:
`applied` can mean that a missing-owner command was processed without writing
prose. A later valid owner and equal-byte state-transfer row let the old receiver
incorrectly authorize that suppressed command. The replacement now passes this
actual negative database and three positive renderer databases with independent
Yjs checks; the existing positive consumer also passes unchanged. Positive
materialization is persisted independently of processing receipts, within the
real append transaction, and survives compaction. The shared writer/reader
subset and one appended migration are in the formal sources; the semantic
receiver remains isolated. No legacy backfill or compatibility adapter was
added. The [receiver investigation](relocation-design.md) retains both the
original RED and the exact replacement scope and evidence.

The first batch extracted the existing database/durability owner, retained the Tauri
adapter, and added AppKit/UIKit project-name editing through the shared Rust
ABI. The historical [P1 report](acceptance/p1-native.json) retains the latest
failed desktop XCTest rerun. The current [native binding report](acceptance/p2b-native.json)
records passed iPhone/iPad project and prose restart checks, Mac compilation
and an unsigned device-target build. Desktop interaction is documented separately
from XCTest; no physical-device or release acceptance follows from these builds.
Do not attach native applications
to a daily-use database to shortcut acceptance.
