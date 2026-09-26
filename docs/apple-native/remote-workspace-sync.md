# Canonical chapter originals

P4b extends the native receiver to the complete existing-project chapter writing
workflow. Both hosts share the same Rust metadata reducer and Swift delivery
queue. This is not full synchronization acceptance. Google Drive and its
provider bootstrap/import are excluded from the migration by the author's
2026-09-26 scope update; Agent and local domain work continue separately.

## One transaction

`RemoteWorkspaceJournal` owns original verification, immutable journal staging,
metadata application, Yrs projection, revision/provenance, materialization and
apply receipts, and remote HLC observation. `RemoteProseJournal` is a narrow
entry point into that same transaction and still rejects metadata originals.
It preserves the distinction between prose-only delivery and workspace refresh.

The supported chapter original contains all three authored mutations: node
creation, its prose seed and the null primary-storyline register. Title and
reading-order changes use `node.title` and scalar `node.bookOrder`; project
rename uses `project.name`. Receiving these never calls a local authoring command,
reserves a local sequence, generates a second seed or rewrites the original.
Unknown actions, unsupported fields and invalid scopes reject the complete
original before a receipt can commit. A transport must not skip them to advance
its frontier.

Lifecycle and field registers use the production total order: HLC wall/counter,
writer ID UTF-8 bytes, writer epoch UTF-8 bytes, device sequence and mutation
index. A field can arrive before the chapter seed; its winning immutable source
reference survives until creation can project it. Current chapter owners are
established inside the same transaction before the Yrs projector reads them.
Missing prose owners/dependencies are retryable refusals, not accepted receipts.
The bridge now samples numeric and ISO wall-clock forms in one SQLite step,
so an original and its local metadata timestamp cannot differ merely because
two clock reads crossed a millisecond. No new schema, migration rewrite, legacy
fallback or parallel write path is added.

## Native delivery

`workspaceReceiveChanges` and `LabWorkspaceCore.receiveChanges` return the
canonical receipt, all retained prose owners, current projects and the affected
project's chapter list. Existing chapter handles are retained through rename
and ordering; a newly received chapter opens through the ordinary owner path.
The caller can refresh workspace lists without rebuilding an existing editor.
Prose updates follow the established queued/marked-input refresh path. A failed
original returns no replacement workspace projection.

## Evidence and remaining gates

The generated [workspace receive report](acceptance/p4b-workspace-remote.json)
uses synthetic independent file-backed replicas and the actual production
TypeScript decoder, journal and reducer. Four fixed groups cover complete
chapter creation and editing; competing titles/orders and duplicate delivery;
fields arriving before creation; and atomic rejection, receipt fault rollback
and retry. Comparisons include immutable originals, lifecycle/field clocks,
metadata rows, receipts, revisions, local HLC and authoritative Yjs/cache state.
Direct receive duplicates perform no SQL writes. At the live bridge, duplicate
notification may refresh a checkpoint timestamp; the test still compares its
exact snapshot bytes and all other durable tables.

The separate [AppKit binding](acceptance/p2b-binding.json) and
[native simulator](acceptance/p2b-native.json) reports cover new-chapter list
refresh, native input and cold reopen, plus metadata changes that preserve the
existing owner, selection and undo history. Fault injection and cold reopen are
not process-kill or power-loss tests. Simulator/programmatic input does not prove
physical IME, device, account or signing/distribution behavior.

The next migration work is the local chapter trash/restore workflow. Provider
snapshot restoration is deferred with Google Drive to the author's later sync
redesign. Copying a closed synthetic baseline remains a test fixture technique,
not a product import workflow.
