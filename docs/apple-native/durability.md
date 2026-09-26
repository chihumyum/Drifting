# Native prose durability: P2c slice

The shared owner in `crates/drifting-prose` joins the Rust 1.88 SQLite core and
the Rust 1.96 Yrs document. It is used by the synthetic Apple lab. Production
library import, full domain operations and remote reducer acceptance remain
separate P3/P4 work. Published migrations are unchanged.

## Write and replay contract

- Capture the actual local and UndoManager transaction update events. Remote
  imports, persisted-tail replay and selections do not create authored updates.
  A state-vector diff is unsuitable because it can re-emit old remote deletions.
- Retain captured bytes until one SQLite transaction commits update rows,
  semantic revision and provenance, writer sequence/HLC, immutable change-set,
  mutation, apply receipt and caller-owned comment-anchor CAS. Retry saves those
  same bytes; it does not rerun native input or undo. A failure after COMMIT
  retries replay/checkpoint only.
- The ordinary read-only open loads a snapshot and its tail in one read
  transaction. It refuses any row that requires an unjournaled derived repair.
  The lab instead opens the safe snapshot with `open_for_replay`, installs its
  persisted comment anchors, and performs the staged replay described below
  before exposing the document. Each path reads actual tail IDs in ascending
  order. IDs are global and need not be contiguous; coverage is independent of
  native projection revisions and durable semantic revisions.
- A checkpoint first replays all available rows, writes its exact v1 state,
  updates owned projections and deletes only rows at or below its coverage in
  one transaction. Snapshotting does not advance semantic revision. Immutable
  sync mutations remain after tail pruning. A bad row prevents crossing its ID,
  opening the document successfully or saving an incomplete compacting snapshot.
- Remote delivery commits SQLite before live replay. Lost notifications cannot
  justify pruning unseen rows: final checkpoint/release drains the durable tail.
  The lab's remote append is a reducer seam, not the full network receipt,
  duplicate-change-set, generation or conflict-resolution implementation.

The lab receipt validates standard wire representation before opening its write
transaction, retains original v1 bytes (normalizes v2 losslessly to v1), then
commits before semantic preflight. A valid but unsafe update is a durable receipt,
not a successful semantic application. `remoteBlock { updateId, reason }` names
the first unapplied row. Ordinary replay can acknowledge earlier rows; staged
replay publishes none of its candidate until COMMIT. The blocked row and every
later row remain uncovered. A byte-identical uncovered retry reuses its row ID
without another revision/provenance write. Later receipts can be stored despite
the blocker. This bounded tail deduplication is not production receipt identity
or an applied network frontier, and it does not cover already pruned deliveries.

All checkpoint retries replay the retained row and refuse snapshot/prune while
it is unsafe. Cold open runs the same preflight and stops with recovery guidance
when the update is outside the supported repair scope; it never silently skips
the row. The live bridge retains its owner, blocks local
commit/history/close and refuses bare export that would omit retained bytes.
Existing queued and marked UI drafts stay in memory, with the same blocked
status in all views. Such unsubmitted input is not claimed durable across process
death; the original received update is. The plain retained-prefix repair below
addresses one relocation case. Other relocation shapes, formatting/deletion
intent and broader old-peer interoperability remain P2 gates.

The shared native queue continues to deliver remote dependencies while local
jobs are held by this state. It selects the next remote job without removing or
reordering the held local jobs, and removes only the completed remote job. Once
the owner reports a successful repair, ordinary queue processing resumes. Marked
text remains on its original input branch until native commit, and receives a
recovery status that still identifies it as an unsubmitted draft. These view
properties are checked separately by AppKit and hosted UIKit acceptance.

## Staged relocation repair

For a supported plain insertion into the copied retained original prefix, the
document layer prepares exact combined bytes and a separate derived repair on
an isolated candidate. Preparation leaves the live document, its input branches
and its undo history unchanged. A prepared update records a logical state-vector
and revision precondition; the committed bytes are applied without translating
the event again.

The shared owner holds `BEGIN IMMEDIATE` while it prepares every uncovered row.
It journals captured local events first, then each derived repair as a local
`RevisionSource::System` event through `AuthoredProseJournal`. The repair includes
canonical text, explicit retirement of the original routed items and persistent
alias coverage. Its update row, revision/provenance, writer reservation,
change-set/mutation/receipt, caller-owned comment-anchor CAS and full covering
snapshot commit in the same transaction. No raw tail row is pruned by this
transaction. The local System event can enter the existing journal/outbox path;
it is not an applied remote receipt or remote frontier.

Only after COMMIT does the owner apply the recorded plans to its original live
document and acknowledge each actual row ID, including rows appended in that
transaction. Derived events use the remote application origin and do not create
a user undo entry. Pending captured local edits share this transaction, so a
snapshot cannot silently include unjournaled local text. A comment CAS, journal
or snapshot failure retains those local bytes for retry, retains the separately
committed raw remote row, and leaves the live document and coverage unchanged.
After COMMIT, an interrupted live replay can recover from the committed snapshot
and System journal without manufacturing a second repair.

Cold context replay starts from the safe snapshot and persisted comments. If a
repair had not committed, it can prepare and journal one; if the repair had
committed, snapshot coverage makes the same raw event and its recorded repair
ordinary idempotent replay. Bare `open`, `replay` and checkpoint never create an
unjournaled repair implicitly. The bridge routes receipt and pending local saves
through the same context-aware owner path.

If one row fails the document's atomic text-retention preflight and later rows
exist, context replay can prepare the complete remaining stored tail together.
Each v1 envelope is validated separately before merge; an invalid member reports
its actual SQLite row ID. The core merges validated structures and applies the
same retention and alias rules. This first path requires a derived alias repair
and no unresolved dependencies. Absence of pending state alone is not evidence
that every sparse writer clock is known. A later explicit deletion that cancels
the lost text without a repair remains retained by this path, even though the
combined update can be valid at the document layer. An unrelated invalid later
row also prevents whole-tail recovery; neither case is silently discarded.

Each prepared closure carries the exact stored row IDs it covers, applies once
after COMMIT, and advances coverage only through those IDs. Earlier safe candidate
steps retain their order. Captured local edits, System repair, both comment CAS
updates and covering snapshot reuse the same transaction. A failed projection
keeps an existing blocked status until a successful commit and live publication.
The original received events stay unchanged, including across retries and cold
recovery. The ordinary context-free replay path still cannot create repairs.

The narrow native `yjs.update` writer validates active generation/project/owner
and lifecycle incarnation, rotates installation writers, preserves monotonic
sequence/HLC, and supplies Yrs validation inside its caller transaction. Seven
synthetic fixtures compare exact payload CBOR, full change-set bytes and SHA-256
against the existing TypeScript `SyncChangeBuilder` and protocol codec. They
cover Unicode, empty valid updates, CBOR length boundaries and safe-integer
limits. The narrow guard reads persisted lifecycle state; it does not yet rebuild
canonical reducer state from receipt-backed history, reject all reducer semantic
conflicts, repair metadata/conflict projections, author generation/provider
bindings or emit the production committed-change notification. Those existing
authored-runner effects, remote HLC observation and restored-writer initialization
remain P3/P4 gates. A standalone `yjs.update` has no additional order/lifecycle
materialization, but that does not make this writer a replacement for the
general authored transaction service.

The bridge still takes a full checkpoint after a lab operation. This deliberately
conservative path is not a performance claim or the final batching policy.
Existing synthetic lab document keys are normalized within the isolated lab
database; public migrations and real workspace databases are untouched.

## Executable evidence

`pnpm apple:durability:acceptance` runs the shared-owner integration tests, builds
the real Rust worker, waits for each flushed phase marker and sends SIGKILL.
Each case is reopened by two independent processes. The parent compares durable
state hashes and decodes each recovered export with the installed Yjs and
y-prosemirror implementations, including duplicate-update replay.

The nine boundaries are authored before/after COMMIT, remote committed before
replay, replay applied before coverage advancement, checkpoint after snapshot,
after prune and after COMMIT, and two delayed-delivery cases for remote N+1
before local N+2. The latter genuinely contains local N+2 in live memory while
remote N+1 is still absent. After ordered replay/checkpoint, a later remote row
must remain in the tail and recover on restart.

Three raw-retention cases use a newly styled insertion, outside the supported
plain-prefix repair scope. They interrupt the actual lab receipt before
COMMIT, after COMMIT and after semantic replay rejection. Their six independent
restarts compare exact snapshot, received bytes, revision/provenance and journal
rows. Before COMMIT the receipt is absent and open succeeds. After COMMIT the
original `ContentString` remains in the tail, open stops with the same unapplied
row, and neither retry nor checkpoint can manufacture coverage or prune it. The
parent separately decodes the original event in Yjs and checks that its text was
not explicitly deleted. These remain `raw-retention-not-semantic-merge` cases.

Three `plain-prefix-relocation-recovery` cases interrupt staged repair before
COMMIT, after COMMIT and after live application but before coverage advancement.
Before COMMIT, the first restart verifies that only the original raw receipt
survived, then repairs through the context-aware owner. After COMMIT, the repair,
covering snapshot and comment CAS must already be durable. Both restarts verify
one System journal event, exact retained raw bytes, mapped comment ranges and
unknown metadata, unique public node IDs, no user undo or remote frontier, and
no duplicate repair on retry. Yjs independently reads the snapshot and applies
the raw/derived events in duplicate and reversed order.

Three additional stored-dependency cases first prove that an early original-`b`
event is durably retained and atomically refused, then receive its missing safe
`d` event in another row. They interrupt the same three repair boundaries. Both
cold restarts verify both exact original event bytes, one System repair, both
comment anchors and the original `d` item identity. Yjs independently verifies
the safe gap proof, snapshot and duplicate/reordered replay.

Five additional actual native deletion cases interrupt authored persistence
before and after COMMIT, and checkpointing after snapshot, prune and COMMIT.
They capture a real NativeReplacement and persist its exact event and optional
declaration through the scoped owner. Every cold restart revalidates the
canonical original, receipt, source-body archive, selected IDs, pre-transaction
snapshot, comment mapping and unchanged sequence counts. Independent Yjs checks
the pure-deletion event and unchanged state vector. Before-COMMIT termination
leaves no durable deletion or declaration; empty cold retries create no duplicate.

The expanded harness defines 23 SIGKILL boundaries and 46 independent restarts.
Its source-matched generated report is the acceptance authority; adding these
cases or a trial run during concurrent source edits does not mark that report
current or accepted.

Every restart checks prose, original quote and mapped anchors, immutable comment
body/unknown metadata, semantic revision/provenance, journal/receipt, expected
tail coverage, another project's isolation, SQLite integrity and foreign keys.
Separate file-backed tests inject comment, snapshot and pruning failures and
insert malformed tail bytes. They also cover a failed repair snapshot followed
by cold context retry, and a pending local edit plus repair whose comment CAS
fails and then succeeds without changing local-only undo. They verify atomic
rollback, retained-byte retry, no remote echo and refusal to compact beyond the
failure.

The mixed-packet owner test receives original-left prefix text and safe `d` text
from one writer. It checks one System repair, comment CAS at both locations,
unchanged original suffix item identities, duplicate/full-state delivery, two
structural history cycles, checkpoint pruning and context-aware cold reopen.
Two further owner tests exercise prefix/suffix/prefix source clocks. Live history
uses two undo/redo cycles before checkpointing; later old-source edits still
route after opening a new SQLite worker and CRDT owner. A genuinely pending final
prefix update survives snapshot compaction and that cold reopen. Dependency
completion then commits one System repair and both comment CAS updates. A forced
failure in the second comment rolls back the first comment, snapshot and repair
journal, preserves pending bytes, and succeeds exactly once on retry. Original
safe suffix anchors and duplicate/full-state replay remain stable. Cold reopen
does not restore an earlier undo stack; new local history is checked separately.
Seven additional file-backed tests cover oldest-row recovery with later stored
dependencies, noncontiguous global row IDs, a full closure on cold open, two
history cycles, malformed/format/pending tail rejection, two-comment CAS rollback,
an earlier safe row and pending local edit, and interruption after COMMIT before
live publication. The explicit cancellation case proves valid document-level
deletion and the owner's current atomic refusal separately. A caught panic in
the unit test is not SIGKILL evidence; the 23 process cases above supply that
independent dimension.

The generated [P2c report](acceptance/p2c-durability.json) records source and
worker hashes, test counts, actual exit signals, both restarts and Yjs semantic
hashes. `pnpm apple:durability:check` rejects stale or incomplete evidence and is
included in `pnpm apple:check`. CI reruns the recovery harness independently.

The worker checks the actual WAL/NORMAL configuration. SIGKILL is process
termination evidence; it does not simulate a power failure, interruption inside
SQLite COMMIT, disk errors or iOS background suspension. Physical input/device,
real-account synchronization, signing and distribution remain unaccepted by this
report. The performance budgets and current-editor comparison in
[milestones](milestones.md) also remain open.
