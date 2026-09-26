# Relocating unselected subtrees

Status: a narrow original-`b` insertion alias is implemented in Rust; its current
formal document, binding and durability reports pass for the declared scope.
P2 is not complete. The three unselected-subtree relocations below remain rejected.
The implementation handles the copied, unformatted left prefix of the existing
`RightSurvivor` shapes without cloning XML. The broader `a`/`d` algorithms in
the experiment sections remain design evidence, not shipped relocation support.

## The gap and the contract

The remaining three cases in [the structure oracle](../../scripts/apple-structure-oracle.ts)
start with two quotes:

```text
left  [a: 开篇, b: 潮汐]
right [c: 夜航, d: 终章]
```

The expected result has one `left` quote containing `a`, `b` and `d`:

| Operation | Native UTF-16 range | Replacement | Resulting b |
| --- | --- | --- | --- |
| Join adjacent quotes | 5, 1 | empty | 潮汐夜航 |
| Replace across adjacent quotes | 4, 3 | 新 | 潮新航 |
| Join quotes at empty partial prefix | 3, 4 | empty | 航 |

Both the unselected prefix `a` and suffix `d` must survive. The existing
[`RightSurvivor`](../../crates/drifting-document/src/structure/containers.rs)
handles shapes where the original right container can survive without moving
either unselected subtree. `Plan::new` rejects these three larger shapes before
mutation because copying a subtree and then using ordinary structural undo can
restore competing copies, lose late edits or create duplicate public IDs.

The product requirements are to preserve user-authored content, formatting and
unknown metadata; keep unique public/domain IDs and their references; preserve
other authors' edits through local undo; and retain these properties after
update exchange and restart. The no-conflict structure must match the oracle.
An unresolved update cannot be silently discarded or reported as applied.

Preserving every original physical `Y.ItemID` through relocation was a stronger
implementation constraint, not the public compatibility promise. It can be
relaxed if durable lineage and routing preserve the requirements above. Public
IDs alone are insufficient: old updates and relative positions refer to
physical types and items. Existing shapes that already retain those identities
should keep their current implementation.

## What was actually measured

The ignored experiments use the installed Yjs package and the three synthetic
oracle seeds. They do not run the native application, SQLite transaction owner,
network reducer or Rust/Yrs implementation. A successful JavaScript experiment
is not native acceptance.

The copy experiment keeps stable canonical copies of `a` and `d` in an auxiliary
shared root of the same `Y.Doc`. The legacy-readable `default` XML is rebuilt
from that content. It records original and joined presentation bases in another
shared root. Given one exact authored update, it reopens each recorded basis,
observes which physical source text changed, and translates the delta into the
corresponding canonical text on a captured author branch. A receipt-derived
client identity makes two importers generate identical translated bytes for the
tested input. Receipt hashes reject identity reuse with different bytes.

This intentionally simple implementation copies whole presentation trees and
stores full basis snapshots. It reconstructs selected `b`/`c` content from
templates and registers only two incarnations. Those shortcuts are not proposed
production behavior.

| Experiment | Observed result | Boundary |
| --- | --- | --- |
| All three shapes, ten stages each | Passed | Join; active-copy prefix/suffix edits; compensating undo; reopen; late original-prefix/suffix edits and original-prefix deletion; redo/undo/redo. |
| Formatting and metadata in that sequence | Passed | Added bold mark and string attribute survived. This is not an exhaustive raw-attribute test. |
| Independent legacy Yjs receiver at every stage | Passed | Starting from the original seed, applying the owner's full update twice produced the same ordinary `default` XML with unique public IDs. No application UI/export path was exercised. |
| Two old peers from the same original basis: front insertion plus last-character deletion | Passed | Both receipt orders, duplicate receipts and a checkpoint/reopen before each receipt yielded `前开`, matching an unmoved Yjs control. |
| Same basis: end insertion plus first-character deletion | Passed | Both orders yielded `篇后`, matching the control. Compensating undo/redo retained it. |
| Two importers reopened from one persisted seed | Passed for canonical import | Translated bytes were identical and duplicate application inserted the text once, without a shared in-memory registry. |
| Those importers independently rebuilding presentation, then exchanging updates | **Failed** | Canonical content converged, but ordinary XML contained duplicate public IDs. |
| Exact insertion followed by the equivalent full checkpoint under another receipt | **Failed in the initial copy prototype** | The logical insertion appeared twice: `远远开篇`. Receipt-only deduplication is insufficient. The scoped span-coverage follow-up below fixes this case in a separate ignored prototype. |
| Edit authored on an unregistered later presentation incarnation | **Unsupported** | Rejected before owner mutation. No durable unresolved-update inbox exists in the experiment. |
| Same receipt identity with different raw bytes | Passed | Rejected atomically; the owner checkpoint was unchanged. |
| Original ItemID relative position after copying/history | **Failed** | It no longer resolved. Merely retaining the public block ID does not repair it. |
| Explicitly migrated canonical anchors after history and reopen | Passed | A synthetic comment range still selected `篇` at UTF-16 offsets 2–3 after a prefix insertion, original-character deletion and late append. Actual SQLite comment records and native selection APIs were not integrated. |

The ten-stage sequence finishes with `a = 新前篇迟前` and
`d = 新后终章迟后`; the prefix attribute and suffix bold mark remain. Canonical
content, receipt records and anchor bytes survive independent document reopening.
The experiment's “undo” is a compensating topology rebuild, not an integration
with the current `DocumentSession` UndoManager.

The current legacy plugin was also run independently with the real chapter
schema, ProseMirror replacement and Yjs UndoManager. All three initial results
matched the structural oracle. After edits to copied nodes, undo produced an
anonymous paragraph containing `新后`, while an append of `迟后` against the
original suffix was absent from the visible final result. These observations are
legacy defect diagnostics, not native acceptance expectations. They establish
why copying the old plugin's history behavior does not satisfy data retention.

### Follow-up: source-span coverage

The separate `coverage.mjs` experiment targets checkpoint deduplication using
the adjacent-quotes fixture's `a` text and two registered incarnations. It stores
source-to-canonical item spans, expressed in UTF-16 clocks, independently of
receipt identity. Checkpoints contribute only previously uncovered string
spans. Exact authored events separately authorize deletion ranges and format
markers; only those changes affect mapped canonical items. This is an
experimental algorithm, not an accepted wire protocol or native implementation.

The follow-up recorded **17 passing scoped cases and one failing diagnostic**:

| Cases | Observed result |
| --- | --- |
| 4: old/new incarnation × event-first/checkpoint-first | Equivalent checkpoints under new receipts did not duplicate text. A partially covered, merged `ContentString` contributed only its new tail, including `👩🏽‍🚀`; the late exact insertion event then contributed zero characters. |
| 2: overlapping checkpoint after known deletion and formatting | Only the new character `新` was inserted. Old deletion and format effects were not repeated; a replacement `开` and newer italic formatting survived. |
| 4: checkpoint first, exact deletion/format events in either order | New text became available while unknown deletion/format evidence remained unresolved. Later exact events produced `远篇` with bold formatting in both orders, without duplicating the late insertion event. |
| 2: disjoint edits through old/new aliases, both arrival directions | Both produced `旧篇新` with the expected italic mark. This does not establish general cross-alias ordering. |
| 4: GC format tombstones, old/new aliases and both event orders | Late exact format payloads restored the required provenance; authorized removal remained effective. Repeating old format bytes under another receipt did not overwrite newer italic formatting. |
| 1: five independent importer processes | Each process read only the serialized owner and next packet. Inserted character counts were `1/0/1/0/0`, finishing at `开篇甲乙`. No in-memory lineage crossed process boundaries. |
| 1 diagnostic: same-gap insertion through different aliases | **Failed**: arrival orders produced `旧新开篇` and `新旧开篇`. Live canonical-neighbor offsets do not replace a fixed causal basis for cross-alias ordering. |

Peers use Yjs's default GC behavior; the importer retains source clones with
`gc: false`. A checkpoint can already contain a `ContentDeleted` tombstone where
the original event contained a format marker. Applying the late original event
does not replace the content of that already-integrated item. The prototype
therefore persists an immutable format-payload catalog keyed by original item
ID, recovered from raw authored bytes, separately from format authorization and
removal coverage. Trusted before/after format projections then identify the
specific mapped characters to patch. Any port needs this retained provenance,
not just insertion coverage or a Yjs state vector.

The process test establishes serialization/reopen behavior, not SQLite crash
atomicity. Unknown deletion/format evidence is retained but the unresolved inbox
and its retry/compaction lifecycle are not implemented. New insertions are not
blocked merely because a checkpoint also contains unresolved historical effects;
that partial progress must not be reported as full semantic application. Missing
authored deletion intent remains unrecoverable from checkpoint bytes alone.
Unknown incarnations, general dependency closure and conflicting alias formats
are not covered. The earlier multi-materializer duplicate-public-ID failure is
unchanged. The coverage-only prototype does not solve either issue. The later
immutable-origin experiment below addresses same-gap ordering within a limited scope.

### Follow-up: immutable origins for same-gap ordering

The separate ignored `causal-order.mjs` experiment addresses the earlier
cross-alias same-gap failure. It maps each source item's immutable `origin` and
`rightOrigin` through the persisted alias spans into the same canonical basis,
rather than inserting beside whichever canonical neighbor is currently live.
It emits ordinary Yjs `ContentString` updates with stable source-derived item
identities and lets Yjs resolve concurrent ordering. Neither insertion is
discarded or selected by last-writer-wins text replacement. Deletion and format
provenance retain the preceding coverage experiment's separate handling.

The report contains **24 passing scoped cases**: the previous 17 passing
coverage cases, the previously failing same-gap counterexample, and six new
combinations of prefix/interior/tail gaps and event-first/checkpoint-first
delivery. Each new combination tests both old/new alias arrival directions and
repeats checkpoints and exact events under new receipt identities. For each gap,
all four schedules start from the same persisted basis and compare both final
text/format runs and the emitted canonical string-update bytes.

The concurrent runs `旧👩🏽‍🚀` and `新é🧭` remain whole, with their respective
bold and italic formatting. An exact old-peer deletion removes the original
`开`, and an exact new-peer format operation underlines the remaining original
`篇`, without leaking those marks onto the concurrent insertions. Repeated
envelopes contribute zero inserted/deleted characters and zero format patches.
The public IDs remain `left`, `a`, `b`, `d`, and an ordinary independent Yjs
receiver reads the same public XML. The inherited five-process test also passes;
it proves serialization/reopen, not SQLite process-crash atomicity.

Reproduction uses only ignored local files:

```sh
node .local-data/apple-native/relocation-experiments/causal-order.mjs
```

The runner writes `causal-order-report.json`; its process fixture files are
`causal-order-worker-input.json` and `causal-order-worker-output.json`. These
artifacts are not present in a clean checkout. The earlier failure remains
reproducible in the separate `coverage.mjs` experiment; this follow-up changes
only the insertion-ordering algorithm in its own prototype.

This is not an accepted protocol or native acceptance. The prototype allocates
an experimental 52-bit hash-derived client identity per Unicode scalar, with a
recorded collision check. That neither defines a production collision-resolution
protocol nor establishes acceptable storage cost. Retained source clones use
`gc: false`; ordinary peers use default GC. The implementation directly inspects
Yjs item internals and has not been ported to Yrs.

Concurrent activation and multi-materializer convergence remain unresolved;
the prior duplicate-public-ID failure is unchanged. Actual comment/selection
anchor migration, shared undo integration, conflicting formats across aliases,
unknown incarnation/dependency recovery, SQLite atomic durability and bounded
retention are also unproven. Checkpoint-only lost deletion intent remains
unrecoverable. The same-gap scoped success does not remove the product's
structural rejection or close P2.

## Implemented slice: late original-left pure insertions

The motivating failure started with `[b:潮汐] [c:夜航,d:终章]`: an offline old
peer inserted `保` at original `b[0]` after another peer joined the quotes. Before
the retention guard, both native and production ProseMirror/y-tiptap omitted
that text through join, undo and redo. Their full-state exports replaced its
string payload with a deleted item. The independent legacy probe remains an
ignored investigation artifact, `original-b-production.ts` and its report in
`.local-data/apple-native/relocation-experiments/`. That legacy defect is not the
native acceptance expectation.

[`relocation_alias.rs`](../../crates/drifting-document/src/relocation_alias.rs)
now records the original text identity, retained source clocks, copied target
clocks and source state vector in an immutable Y.Map definition. The existing
physical `c` text is the joined target; no paragraph or container is cloned.
Incoming pure string insertions map their immutable `origin`/`rightOrigin`
through those spans. They do not use current offsets or search for matching
text. A persisted, nonzero 53-bit namespace maps each source writer to one
canonical writer by XOR, preserving source clocks. Allocations that collide
with ordinary writers or another alias are rejected. Canonical GC may cover the
registered pre-join clock prefix and exact safe gaps proved by immutable receipts;
unknown holes remain unresolved. Original source clocks use Skip for those gaps.

The repair includes canonical strings, explicit deletion coverage for their
original items, immutable original insertion evidence and render ownership.
Evidence is deduplicated by source clocks across overlapping packet ranges:
receiving `A` then `AB` and receiving one `AB` checkpoint must produce the same
owned ranges after exchange. Conflicting payloads or mappings are rejected.
The XOR mapping is per writer and activation, not the ignored prototype's
per-scalar client allocation.

[`relocation_history.rs`](../../crates/drifting-document/src/relocation_history.rs)
removes only receipt-owned render items before ordinary undo/redo, then renders
the retained source graph into the active logical `b`. A new activation has
fresh render identities; deleted render clocks cannot be reused. Definitions
and source evidence remain outside undo scope. The history owner captures this
sequence as one authored event, and relative anchors route from old render
identity through source identity to the current render. This supports the
implemented comment/selection history path without introducing competing public
`b` IDs.

The [document runner](../../scripts/apple-document-acceptance.mjs) now checks
both bounded shapes under `relocationAliasAcceptance`: automatic insertion,
independent receivers, duplicate events/full states, history, native checkpoint
reopen and an ordinary Yjs receiver. The unchanged production oracle still
covers the original right-suffix history sequence separately. Four mixed-packet
scenarios add safe `d` text from independent writers and from later clocks of the
same writer. Raw-only loss detection selects only threatened strings for repair;
the safe suffix retains its original physical text/item identities and anchors
through history and reopen. Mixed packets containing any unmappable loss still
refuse as a whole. Source-matched generated reports remain the acceptance authority.
Formatted insertion, authored deletes, unproved clock gaps, unresolved dependencies,
general relocated `a`/`d`, and concurrent topology activation remain open.

The implemented gap extension proves non-alias source-clock intervals for
`d→b` and `b→d→b` insertion sequences. Each proof identifies the exact live
original string, its parent and UTF-16 clocks outside the alias graph, or reuses
an immutable earlier proof. It never infers coverage from a higher writer
clock alone. [`gaps.rs`](../../crates/drifting-document/src/relocation_alias/gaps.rs)
encodes explicit Skip intervals for sparse source-evidence replay and accepts
GC only with a checked canonical coverage plan. No gap is an owned visible render.
History reuses the proof under a fresh namespace while preserving the
original suffix and respecting its later legitimate deletion. Pending bytes can
participate only when the isolated complete candidate resolves their
dependencies. A candidate with remaining dependencies and any immediately lost
text still refuses the whole packet. Proof currently requires a single alias;
source/target text and all live historical render parents are excluded.

The history preflight runs the same pure rematerialization planner with the
already-selected fresh namespace before removing an owned render or invoking
UndoManager. Actual integration reuses that namespace. This prevents a late
receipt conflict or second alias from causing an error after text has already
been removed. Regressions cover both undo and redo with complete state, anchors,
history stacks and authored capture unchanged; history without a gap remains
available when another alias exists. Generated reports establish current acceptance.

Arrival order still matters for an unapplied oldest journal row. A first-arriving
`b` in `d→b` can have all item dependencies present: Yrs may integrate a sparse
Skip before that `b`, whereas Yjs keeps it pending. Under the deleted original
parent the native guard refuses `b` before mutation because the absent `d` clocks
cannot yet be proved. The document API accepts the later complete combined
update. Context-aware durable replay now retries the complete remaining stored
tail after this specific refusal, validating each raw row before merge. It
requires an explicit derived repair and no remaining dependencies, commits the
repair with comments and a covering snapshot, then applies the prepared closure
once and acknowledges its actual row IDs. Unsupported later members still block
the whole candidate; no-repair explicit cancellation remains a separate recovery
case to implement. A final
`b` in `b→d→b` referencing the first `b` is genuinely pending and its later
dependency completion is covered by this implementation.

The distinction between a bare Yjs state and the full sync package matters.
The existing [journal writer](../../src/renderer/sync/journal/yjs-update.ts)
stores payload bytes in immutable change-set/mutation rows. The full
[checkpoint reducer state](../../src/renderer/sync/checkpoint/reducer-state.ts)
and [restore path](../../src/renderer/sync/checkpoint/restore.ts) retain those
rows too. Consequently, a normal journal-backed sync package may still contain
the original event even after its prose snapshot garbage-collects the character.
Do not describe every such package as irreversibly losing all history.
Snapshot-only documents are also supported, so this recovery source is not
universal. Furthermore, `yjs.update` carries exact events, creation seeds and
full-state lifecycle/Agent writes without an event-kind or causal-basis tag.
Receipt identity and payload hashes do not turn historical DeleteSets into
newly authored deletion intent.

### Confirmed deletion gap after a successful repair

The separate [deletion diagnostic](acceptance/alias-delete-diagnostic.json)
exercises the current document implementation with real Yjs transaction events
and full states. After the native join and late `保` repair, the visible text is
`保潮航\n远🙂终章`. An old-layout peer then deletes `保`, `潮`, or both. In all
six event/full deliveries the document API currently returns success with no
pending dependency, but leaves the visible text unchanged. The required first
line is respectively `潮航`, `保航`, or `航`. These are unresolved semantic
failures, not successful deletion support or an atomic refusal.

The unseen-string retention guard cannot detect this case: the original source
items were already physically deleted by structural editing or the insertion
repair. Their surviving copies use other item identities. Existing alias spans
and render receipts prove the correspondence but do not establish why a received
DeleteSet covers the source items.

A packet-level guard cannot simply require the complete repair metadata. A
normal aware peer's state-vector differential can contain a new insertion into
the untouched `d` plus historical source deletions, without the already-known
repair structs. The current implementation accepts that ordinary incremental
flow. Moreover, merging each of the three old-author deletion events into a
normal repaired checkpoint produces exactly the same full-state and
same-vector differential bytes as a harmless replay. Thus neither metadata
presence, local receipt coverage nor a fresh receipt identity proves that a
source deletion is a semantic no-op.

The next implementation needs a versioned operation supplement that identifies
the exact authored event, authored deletion ranges distinct from structural
retirement, and a reconstructible causal basis. Bind it to the original journal
operation and payload hash. A Yjs state vector alone omits deletion-only causal
history. Translate verified ranges by source identity and persist logical
deletion coverage; every later history activation must consume that coverage
so rematerialization cannot resurrect the deleted character. Missing or
ambiguous provenance must remain recoverable and unapplied. This contract is
not yet implemented; old untagged checkpoints cannot be retroactively labelled
as authored events.

The checkpoint validator now requires every materialized mutation row to match
the decoded immutable change-set, including canonical payload bytes and hash,
target, action, version and complete index coverage. Valid outer package hashes
cannot substitute for that cross-check. This closes a prerequisite integrity
gap for future provenance lookup; it does not classify a legacy event or enable
alias deletion routing. See the [checkpoint contract](../sync-engine/phase2-checkpoint-restore.md).

### Captured transaction evidence foundation

The renderer now accepts an optional `sourceRetentionProvenance` inside the
existing `yjs.update` payload. Version 1 has two shapes: `state-transfer`, or
`transaction-event` with an encoded Yjs v1 `beforeSnapshot` and sorted,
non-overlapping `transactionDeletes` ranges (`client`, `clock`, `length`).
The snapshot includes both the state vector and prior deletion coverage. The
original change-set identity, mutation index and canonical payload hash bind
these fields to their update; no self-referential receipt hash is introduced.
Snapshot parsing requires exact decode/encode round-trip, at most 1 MiB, and
delete ranges use safe client integers and u32 clock bounds. The 100,000-range
field limit is not a publishable packet-size promise: the canonical CBOR
whole-tree limits still apply and can reject a smaller range count.

The opt-in `captureYjsTransactionEvidence` helper copies the actual update
event, its transaction's DeleteSet and the preceding snapshot synchronously.
It rejects a basis already changed by an earlier `beforeTransaction` listener
or by the eligibility predicate, including pure deletion with an unchanged
state vector. Remote application and already-persisted origins are excluded.
Capture failures produce an explicit `unavailable` queue entry with the raw
update, without throwing into Yjs transaction cleanup. The caller owns draining
the queue and durable retry; disposing the observer preserves queued entries.

These are associated-event facts, not a certificate of one author's deletion
intent. In actual Yjs observer reentrancy, an outer transaction inserting `A`
can emit bytes containing `AB` after its observer inserts `B` in another
transaction. The helper retains the outer event and its own transaction facts;
it does not claim all encoded structs belong exclusively to that transaction.
Structural retirement also contributes transaction deletions. An operation
adapter and a reconstructible causal history are still needed before translating
any range into logical deletion of an alias.

The journal writer has an explicit optional argument and copies it before the
asynchronous SQLite scheduler. Update rows, revisions, the immutable mutation
and receipt remain one transaction; an injected post-journal observation failure
rolls them back together. Wire/segment decode, remote materialization and
checkpoint restore retain the supplement unchanged. Malformed or unsupported
present evidence is rejected by new readers, and source labels alone never
manufacture evidence. Existing editor sessions, seeds, restores and Agent
callers remain untagged unless an operation explicitly supplies it; automatic
production capture is not enabled by this foundation.

Mutation creation also owns its target and canonical payload before the first
asynchronous hash. Previously the returned mutation retained caller-owned nested
objects and binary buffers: changing them while hashing or after return could
leave its bytes inconsistent with its hash. The helper now hashes the same
canonical payload bytes it snapshots. Wire regressions mutate actual Yjs update,
snapshot, deletion ranges, unknown nested fields and target at both boundaries,
including shared-buffer byte views, and require change-set/segment round-trips.
This does not change the public v1 encoding or authorize semantic deletion.

An omitted field retains the original `{ update }` encoding. Unknown top-level
fields retain their existing read compatibility; the versioned supplement's own
keys are strict. Old clients ignore this optional field, so it cannot enforce a
future required authored-delete contract against old readers. That requires a
separate required payload version/capability rollout before semantic use. The
six native deletion failures above remain open.

The generated [transaction evidence report](acceptance/yjs-transaction-provenance.json)
covers synthetic Yjs and file-backed SQLite, not native UI, physical input,
accounts or distribution. Reproduce or verify it with:

```sh
node scripts/apple-yjs-provenance-acceptance.mjs
node scripts/apple-yjs-provenance-acceptance.mjs --check
```

The separate owner cancellation experiment remains unmerged. Four narrow
storage/recovery cases worked when a known author cancelled newly threatened,
never-rendered text, but deleting copied base text exposed the same semantic
gap. Formal stored-tail replay still requires an explicit derived repair.
Removing that requirement or writing a covering snapshot alone is insufficient.

The next command adapter must own the complete logical action, including all
member transactions. A structural copy followed by text-only retirement in a
second transaction has a plain deletion shape but is not a standalone authored
delete. Observer-created deletions may emit separate raw events, and an observer
exception can occur after text already changed. Preserve unclassified events;
if capture itself was interrupted, a recovery state-transfer must remain labelled
as such, without inventing an original event or retrying the successful edit.

The retained-body and logical-delete routing experiments are still isolated.
Their composed synthetic cases exercise original-envelope binding, reconstruction
of the exact source snapshot, source-ID deletion, repeated history and reopen.
They do not make the existing bare event/full-state diagnostic pass. Production
admission must independently validate the original operation before accepting
any replicated logical-delete ledger row; a row's schema or immutable map key
cannot supply authorization. Restore must rebuild that verified authority before
loading a snapshot that carries such rows, and persistence must commit authority,
repair and prose together. Required version rollout and this owner integration
remain prerequisites for enabling the route.

The implementation now separates three checks instead of letting
the replicated document authorize itself:

- The shared core's [canonical-CBOR reader](../../crates/drifting-core/src/original_operation.rs) verifies the original envelope, full scope,
  selected declaration, and every mutation's index, schema and payload hash.
  Its opaque result is byte/declaration verification, not source visibility or
  writer authority. Rust 1.88 passes six test groups covering eight valid and
  49 invalid envelopes and 52 canonical-value vectors. The exact deletion
  event reader also refuses trailing bytes that `Y.decodeUpdate` ignores.
- Its [read-only SQLite lookup](../../crates/drifting-core/src/original_operation_store.rs) reads that envelope, its matching application
  receipt and **all** materialized mutation rows in one snapshot. It refuses an
  applied flag without its receipt, rebound sibling rows, rehashed payload
  substitution, missing/extra indices and unsupported application states.
  WAL concurrency and caller-owned transaction tests verify snapshot consistency
  and no side effects. Protocol text and binary cells are bounded before the
  gateway copies them. The complete core run passes 45 tests, including
  11 file-backed lookup groups; published migrations remain unchanged.
- The document authority prototype binds independent grants to the original
  operation reference and complete source-ID coverage. It rejects partial
  physical deletion claiming a larger operation, unauthenticated ledger rows
  and bare snapshots that contain them. Input forks inherit admitted authority;
  captured IME drafts retain the authority from their own basis. This fixes a
  regression where those internal reconstructions lost grants. Its composed
  run preserves the prior 134 cases and passes 147 Rust tests plus 15 producer
  cases, including six event/full deliveries, history and cold revalidation.

The first two checks are formal shared-core code with a reproducible synthetic
oracle and [source-matched evidence](acceptance/original-operation.json). The
oracle builds its own Yjs documents and uses the production capture and wire
helpers; it does not read ignored experiment files. Its intent declarations are
test data, not a production command classifier. Reproduce with
`node scripts/apple-original-operation-acceptance.mjs`; append `--check` to verify
the recorded source fingerprint. This read-only layer introduces no schema,
prose write, logical-deletion receipt or editor emission.

The same read-only foundation now separates complete envelope verification from
standalone-delete classification. An opaque original-body archive collects
ordinary seed, insertion and deletion events from canonical original envelopes;
it checks the generation/project catalog, matching applied receipts and every
materialized sibling mutation in one SQLite snapshot. Discovery does not trust
the mutable target index. The portable body oracle generates four synthetic
originals with five mutations and three matching body events; the shared-core
body-archive slice added six cases to the preceding 45; the current report also
includes native event-order and optional-journal cases (57 total). Missing required
originals, redirected target/header fields, missing receipts and exceeded local
read budgets reject. This conservative whole-catalog reader currently limits a
read to 4,096 envelopes, 64 MiB in aggregate and 16 MiB per envelope. Those are
local implementation budgets, not new public wire limits. The returned retained
collection does not prove complete historical coverage or recover lost/GC bodies.

The authority composition remains an ignored local experiment. Its later
152-case bridge replaces the integration tests' factory with a real Rust
original/source-view constructor and revalidates originals through a reopened
SQLite gateway. However, independent review found that two real concurrent
native joins can create competing mappings for one source: a valid deletion
can then leave one copy visible. Both packet orders reproduce this defect.
The subsequent isolated guard now rejects ambiguous graphs both before granting
authority and when a later packet changes an already-authorized graph. It shares
the same source-graph check between local planning and remote admission, while
allowing history to change the active target, incarnation and spans within the
same graph. Its 155-case suite retains all previous cases; independent review
also passes the three new groups for both packet orders, invalid activation and
six-operation history/cold-replay compatibility. Planning failures preserve
bytes, history and grants. This closes the wrong-success path in the experiment;
actual multiple-graph deletion semantics and production admission remain
unfinished. Frozen source and evidence are under
`.local-data/apple-native/original-authority-guard-next/`.

The next isolated composition now derives source bodies from that opaque SQLite
archive. Three actual synthetic Yjs creation/insertion events and the selected
delete original are installed as canonical records with receipts. All six
delete deliveries pass repeated history, duplicate delivery and cold admission
without reading the old `retainedBody` fixture. A valid deletion-only archive
still fails causal reconstruction, and foreign document scopes are rejected.
Independent review found that scope alone did not bind the requested deletion
to an applied original: an alternative same-scope original could borrow the
archive. The fixed constructor also requires an entry with the exact complete
original reference and update bytes. Its regression fails before the fix and
passes after it; an independent copy confirms both results. The old raw-body
constructor is now test-only. The composed suite passes 160 document cases and
51 core cases, with ordinary library compilation and source-matched evidence in
`.local-data/apple-native/original-archive-composition-next/`.

The isolated atomic owner now commits the verified original, derived repair,
comment projection and covering checkpoint through the existing prose repository
and authored journal. It verifies the current generation and incarnation in the
same transaction, including after the projection callback; independent review
reproduced and verified a fix for stale-incarnation authority. Live publication
occurs only after commit, and a publication interruption requires verified reload.
Cold open discovers untrusted references from the checkpoint and resolves them
against originals and source bodies in one read transaction; callers need no
remembered operation list. Six new owner cases and the existing 18 prose, 160
document and 51 core cases pass in
`.local-data/apple-native/original-authority-atomic-next/`.

A separate source-matched process harness kills this actual owner before commit
and after commit/before live publication for three distinct deletion originals:
six real SIGKILL cases and twelve independent cold processes pass. Before-commit
recovery preserves all 14 checked SQLite tables exactly before explicit retry;
after-commit recovery retains the committed deletion. Both paths reach a stable,
no-write duplicate with matching comments, integrity and foreign-key checks.
Stored checkpoint bytes are compared exactly; reopened CRDT states are also
compared in full with independent Yjs GC normalization, accounting for lost
session-only undo retention. Independent source/log review confirms this scope.
The frozen runner and evidence are in
`.local-data/apple-native/original-authority-crash-next/` (`run.mjs --check`).

This is WAL/NORMAL process recovery, not power-loss evidence. This first owner
requires an already-applied original and a fully covered checkpoint. The later
single-row recovery extension below addresses one uncovered-tail case; general
incoming reduction and arbitrary-tail recovery remain to be integrated.

The following isolated composition now persists actual native command records.
Plain same-text deletion captures the live pre-state, source IDs and exact
transaction event. Queued/draft input rebinds its original selected IDs to the
live range; a remote insertion that splits the range prevents a single-range
declaration. The durable owner retains the whole record through rollback and
later input, and commits optional evidence with the unchanged event. Three real
native deletion originals pass journal/store/archive verification, receiver
application, repeated history, comments, duplicate delivery and cold reopen.
The actual Rust-written envelopes also pass the production TypeScript decoder
and independent full-state Yjs comparison. The combined runner passes 176
document, 57 core, 9 authority-owner and 27 prose integration tests in
`.local-data/apple-native/original-native-persistence-next/`.

This integration exposed two compatibility/ownership gaps. The strict original
event reader now accepts either legal Yjs/Yrs client-group order while retaining
exact event bytes and rejecting malformed, duplicate or trailing data. The
durable owner now binds project/generation/document/incarnation while opening
the same SQLite read snapshot, and rechecks that scope for persistence, replay
and checkpoints. Independent tests reproduced old input being assigned to a new
incarnation, a projection callback changing incarnation before commit, and a
direct replay crossing incarnation. All three regressions now pass; failed
writes retain their original command records. An unscoped owner cannot gain
command evidence retrospectively at persistence time.

The semantic receiver/authority writes remain isolated. Its earlier SIGKILL
results apply to the frozen owner source. The actual command-capture and journal
subset has separately been promoted into the shared crates and NativeLab bridge:
132 document, 57 core, 27 prose and 18 bridge cases pass, with three journal and
four native wire cases checked against production TypeScript/Yjs. The formal
durability harness now passes 23 SIGKILL cases and 46 cold restarts, including
five native deletion boundaries. See the source-matched
[authoring report](acceptance/native-authoring.json) and
[process report](acceptance/p2c-durability.json).
Production receiver integration, required capability rollout and general
relocation remain open. No simulator, physical-input, account or distribution
result follows from these reports, and the six bare-packet deletion failures
remain open.

### Explicit single-row cold recovery

The next isolated owner closes a concrete interruption boundary: the renderer
has committed an original, its materialized mutations, apply receipt and exact
raw prose row, but the native document has not consumed that row. The existing
read-only `open` continues to refuse uncovered tails. A separate
`recover_single_applied_tail` factory accepts an untrusted original selector and
verifies the complete scope, original, receipt, opaque body archive, checkpoint
references and source reconstruction in one `IMMEDIATE` transaction. It first
bounds the stored checkpoint and tail before reading their BLOBs. Exactly one
same-document row must match the selected original's exact event; this equality
does not manufacture a row-to-original database relation or authenticate a writer.

Recovery does not append the Remote event again. It adds one System repair,
performs comment CAS, snapshots the covered state and prunes the two observed
rows before COMMIT, then returns the cold owner. Other documents' noncontiguous
row IDs remain untouched. Zero-tail duplicate recovery succeeds only when the
reverified checkpoint already records the operation; a missing row with no
completed ledger refuses. No caller can supply a hot editor or pending local
input to this factory, and it does not restore a prior process's undo stack.

Actual callback probes exposed two defects. An existing apply path could commit
after a callback quarantined a required source original, leaving a live document
whose next cold open failed. A duplicate recovery path could also commit a
comment loader's lifecycle mutation. Both now refuse and roll back. Comment
loaders must be read-only; projection callbacks are followed by bounded storage
shape checks, exact checkpoint/revision/row-set checks, original/archive
reverification and reconstruction of the candidate checkpoint. The old apply
path uses the same checks. Independent copies reproduce both RED results and
confirm the fixes, without changing formal runtime sources.

The actual production TypeScript materializer prepares three synthetic file
databases through its real SQLite transaction and journal/repository paths.
Receipt failure is observed after raw materialization and rolls back all tables;
duplicate delivery writes nothing. All six originals per case are real reducer
writes. Each closed database retains one target row, an unrelated document's row,
the original checkpoint and comments. Five archived bodies independently
reproduce the checkpoint's full normalized Yjs state, including opaque roots.
This prepares the materializer boundary only: it runs neither provider download,
durable-runtime frontier updates nor live reconciliation.

The source-frozen candidate in
`.local-data/apple-native/original-tail-recovery-next/` passes 176 document,
57 core, 27 prose and 21 owner tests (20 assertion groups plus the fixture-export
hook), all three actual renderer databases and three independent Yjs checks.
The producer and its hashes are in
`.local-data/apple-native/original-tail-renderer-fixture-next/run-final/`.
The independent process runner in
`.local-data/apple-native/original-tail-crash-next/` passes six actual SIGKILL
cases and twelve cold restarts: three original selections, each interrupted
before COMMIT or after COMMIT before publication. Precommit termination preserves
every table exactly before explicit retry; postcommit termination preserves the
committed state. Repeated recovery and ordinary verified cold open write nothing.
The worker checks selected original/receipt bytes, one System revision, safe
comment identity, the unrelated tail, legitimate projection-journal effects,
integrity/foreign keys and full GC-normalized Yjs state.
An independent review verifies all 18 process IDs/signals, source and log hashes,
all-table rollback, preserved immutable rows and normalized CRDT state without
rerunning the SIGKILL cases; its record is in
`.local-data/apple-native/original-tail-crash-review/`.

Producer preparation uses WAL/FULL; the native workers explicitly use
WAL/NORMAL. These are process-termination results, not power-loss evidence.
First recovery still needs an explicit selector; it does not infer missing
identity from raw bytes. Multiple same-document rows, pending dependencies,
unsupported intent and ambiguous source graphs still refuse. General incoming
reduction, hot publication with local input, capability negotiation and full
relocation remain open. This receiver is isolated and has no native UI,
physical-device, account or distribution acceptance.

### Cold-open read boundary and materialization admission

The subsequent `original-open-read-boundary-next` copy closes the same loader
boundary in ordinary `open`. Previously a comment loader could retire the
generation or quarantine a required original and still return a live owner.
Both actual failures now reject and roll back all durable tables. Normal
read-only loading still succeeds. Open/attach check tail count and bounded
checkpoint storage before copying BLOBs. Four focused groups and all 25 owner
functions pass (24 assertion groups plus the fixture-export hook); library,
formatting and source checks also pass. The prior six-kill process result remains
evidence for its earlier frozen source, not a new crash run on this copy.

Actual renderer experiments in `original-tail-batch-audit` show why arbitrary
tail recovery needs more than row order or byte equality. Two distinct valid
originals can carry the same exact update, and a causally dependent event can
arrive before its prerequisite. The complete closure succeeds despite the first
arrival being genuinely pending. Missing row-to-original identity alone does
not require a migration: independently admitted operations could in principle
be restored as a set while raw transport is covered idempotently.

However, the existing processing receipt is not such admission evidence. In a
real production-reducer fixture, six body/command originals arrive before their
document owner exists. Each receives an applied receipt but materializes no
prose row. A valid entity-create plus full-state original later creates the
owner at the same incarnation. It does not replay the suppressed command;
duplicate command delivery also writes nothing. The one deduplicated
missing-owner conflict is now resolved and has no per-mutation identity.
Repository compaction followed by a distinct valid state-transfer original
leaves exactly one row carrying the suppressed command's bytes.

The independent `original-admission-review` Rust test consumes that closed
database through the frozen single-tail factory. Selecting the suppressed
command incorrectly returns `Applied`, installs one logical operation, changes
SQLite and deletes the synthetic protected prefix. The expected refusal test
records **zero passed and one failed**. This is a reproduced receiver defect;
the earlier positive and process-recovery tests do not close this admission
boundary. Formal semantic writing remains disabled.

The replacement receiver separately verifies durable positive materialization
evidence before granting command semantics, including on checkpoint reopen.
It cannot infer admission from applied receipts, currently resolved/absent
conflicts, or equal update bytes. Source-body reconstruction is a separate role
and does not itself admit every archived command. Any added admission record
must survive raw-row compaction and be written by the real materialization
transaction; old records must not be backfilled by guessing.

The source-frozen `original-materialization-admission-integration-next` now
passes that actual renderer counterexample: selecting the suppressed command
refuses without changing any SQLite table, even though another admitted
original has the same event bytes. Three positive renderer databases still
recover with one System event, preserve prior originals/admissions and comment
identities, and reopen with a zero-write duplicate. The independent Yjs oracle
checks all three full states. The existing three-database positive test also
passes unchanged. The integration source fingerprint is
`2582544d555de0040db6f0ee470792537c51639cc9b36c356b550732f0022472`.
This is fresh-owner/file-database evidence, not a new process-termination run.

The positive-admission writer/reader subset is integrated separately from the
semantic receiver. New migration `0004_yjs_materialization_admission` adds local
append facts; published migrations are unchanged and existing rows receive no
invented admission. Rust and renderer writers bind the immutable original to
the actual append within the same transaction. Admission survives raw pruning
and is excluded from portable domain checkpoints. A nested-savepoint token
failure was independently reproduced and fixed: an expired token cannot borrow
a reused row ID/revision, while valid tokens and failed-insert retry still work.
The earlier REDs remain frozen evidence; general tail recovery, hot publication
and semantic receiver rollout are still open.

Reproduce the independent synthetic diagnostic without launching either client:

```sh
node scripts/apple-alias-delete-diagnostic.mjs
node scripts/apple-alias-delete-diagnostic.mjs --check
```

Its `open` status means the missing behavior was reproduced. Successful script
execution verifies the diagnostic and its controls, not successful deletion.

The [native lab bridge](../../crates/drifting-apple-bridge/src/lib.rs) retains
valid received bytes through the [prose owner](../../crates/drifting-prose/src/lib.rs)
before semantic replay. Unsupported loss remains a stored-but-unapplied state;
blocked rows and later rows cannot be covered by a compacting snapshot. Native
views retain queued/marked input. The new prepared-replay path stages alias
repairs without changing the live owner, then journals repairs and persists the
matching snapshot/coverage and comment projection in one SQLite transaction.
Only the committed prepared bytes may be published live. This remains a lab
delivery seam, not a completed production reducer/frontier protocol.

An ordinary Yjs peer needs the complete repair closure, including source
dependencies, canonical strings, deletion coverage and alias metadata. Bare
original events still target the deleted physical parent. Old peers do not
independently implement alias routing, and wire readability does not certify
old application export/compaction behavior. The broader retention guard and
its restart, queue and process-interruption checks remain necessary outside
this pure-insertion scope.

## Reproducing the experiment

The local probe files and their JSON reports are ignored artifacts under
`.local-data/apple-native/relocation-experiments/`. They are not shipped test
fixtures and will not exist in a clean checkout. During this investigation the
following commands completed successfully; the boundary runner deliberately
asserts the documented failures as well as the successes:

```sh
node .local-data/apple-native/relocation-experiments/durable-copy.mjs
pnpm exec tsx --conditions=import .local-data/apple-native/relocation-experiments/old-plugin.ts
node .local-data/apple-native/relocation-experiments/boundaries.mjs
node .local-data/apple-native/relocation-experiments/coverage.mjs
```

The coverage runner writes `coverage-report.json` and uses ignored
`coverage-worker-input.json` / `coverage-worker-output.json` for its independent
child processes. Its successful exit also asserts that the same-gap diagnostic
still fails; it must not be interpreted as all relocation cases passing.

To reproduce the design independently, use the three seeds and ranges above
from `apple-structure-oracle.ts`, retain two immutable snapshots named original
and joined, and perform these operations:

1. Clone `a` and `d` into an auxiliary shared map before deleting any presentation
   node. Record each source XML text's physical ID and the canonical basis.
2. Render the expected tree using current canonical `a`/`d`. Register that
   presentation basis before old peers edit it.
3. On two separate joined-basis peers, capture the exact `update` event for
   inserting `新前` at the start of `a` plus attribute `futurePrefix=retained`,
   and inserting bold `新后` at the start of `d`.
4. For each receipt, reopen its source basis, observe the source delta, and apply
   it on a branch of the recorded canonical basis. Apply that branch's update
   to the owner. Repeating the same receipt must be a no-op. Rebuild presentation
   from current canonical data after each operation.
5. Render the original topology, export and reopen the document. Import three
   independent original-basis receipts: append `迟前` to `a`, append `迟后` to
   `d`, and delete the first character of original `a`. Render joined/original/
   joined topology. At every stage verify unique public IDs, text, attributes,
   marks and independent legacy receipt of the full state.
6. For the opposing-edit tests use original `a = 开篇`: insert `前` at 0 and
   delete at 1 on separate peers; then separately insert `后` at 2 and delete
   at 0. Compare each arrival order to ordinary unmoved Yjs peers, not a guessed
   string ordering. Reopen the owner before every receipt.
7. Merge two independently materialized owners; deliver an already imported
   peer checkpoint with a new receipt; edit a newly rebuilt but unregistered
   presentation; and resolve original versus migrated relative anchors. These
   reproduce the failures in the table rather than hiding them behind rejection.

Port this recipe into tracked Yjs/Yrs integration tests before changing the
production rejection. Local ignored output is discovery evidence, not a durable
machine-checkable milestone report.

## A checkpoint cannot replace deletion provenance

There is a stronger limitation than incomplete routing. The following complete
counterexample can run from the repository root with `node --input-type=module`:

```js
import assert from 'node:assert/strict';
import * as Y from 'yjs';
const base = new Y.Doc();
base.clientID = 9991;
base.getText('t').insert(0, 'AB');
const fork = () => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
  return doc;
};
const structural = fork();
let structuralEvent;
structural.on('update', update => { structuralEvent = update; });
structural.getText('t').delete(0, 2);
const stale = fork();
let authoredEvent;
stale.once('update', update => { authoredEvent = update; });
stale.getText('t').delete(0, 1);
assert(authoredEvent.length > 0);
Y.applyUpdate(stale, structuralEvent);
assert.deepEqual(Y.encodeStateAsUpdate(stale), Y.encodeStateAsUpdate(structural));
```

The stale author explicitly deleted `A`, but its final checkpoint is identical
to a peer that only received the structural deletion of `AB`. After the original
text has been deleted for relocation, no algorithm can distinguish those two
authorship histories from these checkpoint bytes alone. Keep the original
authored event or another equally informative operation record; do not infer
authored deletion intent from a merged delete set.

## Proposed protocol boundary

The recommended direction is a versioned, optional relocation sidecar in the
same Yjs document, activated only where relocation is necessary. Ordinary
`default` XML remains consumable by old clients. Stable content, topology intent
and presentation incarnations become distinct. This is a design direction;
multiwriter generation and causal import are still blocking algorithm work.

The sidecar needs immutable operation/activation identities, logical block IDs,
source physical type and item spans, canonical item spans, incarnation records,
causal dependencies, and import coverage. Store raw attributes using their
existing wire representation. Do not round-trip them through a lossy native
projection. Every new presentation incarnation must be registered in the same
durable operation that creates it.

Two deduplication layers are required:

- A receipt is identified by the stable journal source and payload hash. The
  renderer already exposes `(changeSetId, mutationIndex)` through
  [`ReducerSource`](../../src/renderer/sync/reducer/types.ts). A local SQLite
  row ID is not a cross-device receipt identity.
- Source item/span and operation coverage prevents the same physical insertion
  being imported again through another envelope or checkpoint. Delete and
  format operations also require their original authored provenance and basis;
  merely marking insertion clocks as seen is not a complete operation log. The
  scoped coverage prototype demonstrates this separation, including retained
  raw format payloads when a checkpoint has already integrated GC tombstones.

The experiment's frozen-basis delta observation handles independent single-event
inputs. General import must reconstruct the source's causal dependency closure,
including earlier edits from the same old peer, and translate through persisted
item lineage. It must not replay a delta at the same numerical offset in whatever
canonical text happens to be live. Likewise, deterministic imported structs
must use a fixed recorded basis: reusing a client identity while changing its
origin/content is invalid. The prototype's 52-bit receipt hash has no collision
protocol and is not suitable as a production identity allocation rule.

Canonical activation and public rendering both need a convergent multiwriter
policy. Two replicas can independently activate the same block or materialize
the same intent. A map key or matching public ID does not make their nested
Yjs items identical. A candidate is deterministic generation from an immutable
basis plus registered generation identities and convergent removal of obsolete
incarnations. It must first pass the two-materializer test, concurrent activation
and differing-but-compatible inputs. An importer-byte equality test alone does
not establish this property. Until then, the prototype cannot be enabled for
multi-device editing.

Structural undo should compensate the local topology change against current
canonical content. It must integrate with the existing shared history owner,
not create a second independent undo stack. Selected `b`/`c` content needs an
operation-scoped inverse that retains concurrent edits; restoring template
strings, as the experiment does, is unacceptable. The existing
[`lineage.rs`](../../crates/drifting-document/src/lineage.rs) tapes and
[`history.rs`](../../crates/drifting-document/src/history.rs) metadata are
in-memory mechanisms, not a durable relocation registry. Their identity-mapping
ideas can be reused, but cannot substitute for persisted source/canonical spans.

Comment anchors must be translated before their original types disappear.
Persist the migrated comment record atomically with the structural write and
retain its source lineage. New selections and comments on later incarnations
need the same translation. The measured canonical-anchor success does not imply
that original relative-position bytes continue resolving.

## Network, persistence and old-client compatibility

The current [`yjs.update` mutation](../../src/renderer/sync/journal/yjs-update.ts)
carries raw update bytes, not a semantic edit envelope. Existing journal sources
can identify a receipt, but the operation still has to be classified: seeds and
lifecycle restores can contain full state, while normal live editing records
actual transaction events. An arbitrary payload must not be assumed to be one
new user operation merely because it has a new receipt ID.

The raw authored event is an existing asset, not a proposed replacement wire
format. Native [`capture.rs`](../../crates/drifting-document/src/capture.rs)
explicitly avoids state-vector diffs because those include historical delete
sets. Relocation should consume the exact event with its journal provenance,
retain missing dependencies, and emit ordinary Yjs repair updates. Existing
origin filtering captures local and history transactions only; derived import
and materialization origins need explicit persistence and remote-echo rules.

Use the existing [prose durability owner](durability.md) for the atomic boundary:
incoming source evidence, translated update, presentation/registry update,
coverage and comment changes must become a consistent recoverable state before
the operation is considered semantically applied. The experiment uses multiple
in-memory Yjs transactions and proves none of this crash atomicity. Integration
must retain staged bytes for retry without reauthoring after a failed commit.

Unknown incarnation or missing provenance requires a durable unresolved record
with the original bytes and source identity. Distinguish “durably received” from
“semantically applied”; do not advance an applied/compaction watermark past an
unresolved operation or claim it visible. Retry after dependencies arrive. This
is a recovery mechanism, not an acceptable permanent replacement for supporting
the three ordinary editing shapes.

Aliases cannot be pruned solely because one device made a checkpoint. An offline
old peer can still address them. Establish a peer/version retention horizon or
retain the necessary basis and item lineage. A checkpoint that includes the
sidecar and prior coverage can restore that knowledge; a receiptless old
checkpoint cannot manufacture missing authored-delete provenance. Existing
public SQLite migrations remain immutable. If durable inbox/schema additions
are ultimately needed, they require a new migration and the existing safety
snapshot path.

The experiment confirms an ordinary Yjs receiver can decode and preserve the
extended document and read its public XML. It does not prove every old-client
save, export, import or compaction path preserves unknown roots. Those paths,
reordered repair delivery, and old-client offline edit/undo must be checked.
An old peer does not implement sidecar routing: it reaches the repaired visible
state after receiving a native owner's repair closure. Compatibility claims
must name that condition. If old peers must independently repair before any
native owner participates, the legacy client also needs the protocol; raw Yjs
wire compatibility alone cannot supply it.

## Smallest useful implementation sequence

The first safety prerequisite is product code: `retention.rs` preflights
unseen and pending string spans before live integration; `DurableDocument`
receives validated raw updates before semantic replay and leaves blocked rows
uncovered. The bridge exposes stored-but-unapplied state, native views preserve
their queued/marked input, and the process harness checks all three receipt and
rejection interruption boundaries. The new original-`b` alias now makes a
specific class of those retained updates visible automatically. Its Rust
implementation includes persistent spans/evidence, allocation collision checks,
overlapping-receipt normalization, active history and anchors; the integrated
document, binding and durability reports pass. The general guard still has
a full-document preview cost, and this slice has not established a resource
budget for long-lived alias metadata.

1. **Extend the implemented insertion core to genuine subtree relocation.**
   Reuse the tracked original-`b` alias tests, raw encoder validation and prepared
   durability owner. The existing single-target solution avoids the prototype's
   duplicate-XML materializers; it does not solve concurrent topology activation
   or copying both unselected `a` and `d`. Implement exact authored insert,
   delete, mark and attribute import for relocated `a`/`d`, dependency replay,
   checkpoint restore and anchor translation. Resolve deterministic activation
   and rendering in the same test harness. Port the passing duplicate/overlapping
   checkpoint coverage cases into tracked tests, and close the remaining
   same-gap cross-alias ordering and dual-materializer failures. Do not
   reclassify them as acceptable rejections. Keep the user-facing three-shape
   rejection until that behavior is proven.
2. **Wire the three real structural commands and their shared undo.** Replace
   the corresponding `Plan::new` rejection only after the import core works;
   preserve current safe `RightSurvivor` cases. Implement selected `b`/`c`
   operation history, use current canonical unselected content for compensating
   topology, and translate durable comments and live selections. Run the real
   Yjs structural oracle through Rust, with two independent native owners and
   ordinary old peers, duplicate/reordered receipts, checkpoint/restart and
   process-crash boundaries. Then regenerate document, binding and durability
   acceptance against the exact implementation.

This is product code preparation followed by actual feature completion, not a
proposal to close P2 with a larger rejection matrix. No broad P3 interface work
is unlocked by these experiments.

An alternative is to extend both native and legacy clients with explicit
relocation-aware operation envelopes and capability negotiation. That may
simplify causal import and ownership, but changes the compatibility surface and
still needs offline-peer recovery. It must be an explicit product/protocol
decision, not an implicit assumption that older clients will stop writing.

Still open beyond the implemented prefix slice: concurrent activation and
general public materialization, authored delete/format provenance, unknown
dependency closure, arbitrary selected-span remote edits, old application
export/compaction, resource growth and GC/alias retention. The scoped Rust
history and anchor work does not waive those gates or complete P2.
