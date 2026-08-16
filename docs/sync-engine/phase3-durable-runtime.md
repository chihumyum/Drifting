# Phase 3 durable SyncEngine runtime

Status: durable runtime, production typed domain kernel, restart-safe native
asset blob lane, normalized storyline membership and App-scope composition are
implemented. Provider connection and restore are separate durable
orchestration milestones; this runtime mounts only their committed bindings.

`SqliteSyncGenerationRuntime` connects the authored journal to the immutable
object log without putting provider I/O inside a SQLite transaction:

1. flush local Yjs/domain durability and seal complete writer-epoch segments;
2. capture/incrementally advance the provider cursor; an invalid cursor/page
   token atomically resets transport progress and starts a new
   capture-before-full-inventory pass;
3. download each opaque object to a durable `LocalObjectRef` inbox;
4. verify/decode segments, or preserve the raw object and quarantine it;
5. keep later writer ranges dependency-pending until the same
   `(syncGenerationId, writerId, writerEpoch)` applied frontier is contiguous,
   then apply each complete change-set through the reducer and typed domain kernel;
6. atomically commit domain rows, reducer clocks, apply receipt, HLC, applied
   frontier and the highest fully applied segment-chain head;
7. publish verified blobs before referencing segments;
8. derive upload/download transfer IDs as deterministic SHA-256 tokens that
   satisfy the native resumable-transfer grammar, reconcile ambiguous upload
   success with immutable stat, then commit transfer, remote-object and
   published-frontier receipts;
9. run checkpoint policy only after the durable pending/gap/conflict/quarantine
   inspection permits it.

SQLite, WAL and SHM are never provider objects. Provider adapters receive only
opaque `LocalObjectRef` values and immutable metadata. Raw downloaded bytes are
`staged`, not `verified`; successful object-codec verification is what promotes
them to `verified` in the same transaction that records the segment/frontier.

A restore may activate with a completed provider cursor because its isolated
discovery already captured inventory and drained changes. Activation persists that
cursor together with every observed immutable object under the runtime's exact
provider epoch. After draining new changes, the runtime stages any observed segment
that still lacks a completed download transfer. This preserves post-checkpoint tail
segments without replaying the cursor, while a removal between activation and the
first cycle is recognized from its durable provider object ID and blocks before the
backlog download or apply lane.

## Provider-neutral object codec

Engine code contains no provider name, OAuth, HTTP, Tauri, or cloud-trust policy. A
static architecture test enforces that boundary. The object codec hashes
canonical logical keys into stable protocol IDs, moves bytes only through an
injected local-object port, and verifies kind, stored SHA-256, byte size, and
canonical protocol content before materialization. It never accepts or resolves
renderer-provided filesystem paths.

The Google Drive product composition follows the trusted-cloud contract: it
does not wrap project content in a Drifting-managed encryption layer. Google is
inside the trust boundary. Opaque native object references still keep paths and
large byte streams out of renderer DTOs, and downloaded bytes remain staged
until their protocol hashes and schemas verify. Integrity verification does not
make the stored objects opaque to Google.

Production startup reconciles the native opaque-object directory against all
SQLite-retained `storageRef` values even when there is no active provider
binding. Native GC recognizes only the current canonical `.object` layout and
atomic `.part` residue older than the safety TTL. Unknown entries and symlinks
fail closed; repeated restart reconciliation is idempotent.

## Scheduler and lifecycle

`SyncEngineCoordinator` owns one global `SyncScheduler`:

- one active cycle globally, with round-robin fairness across SyncGenerations;
- trailing 2-second authored-commit debounce;
- immediate scheduling for manual/start/resume/online and non-suspending
  lifecycle triggers, while an existing provider `Retry-After` remains a hard
  not-before boundary;
- per-SyncGeneration adaptive foreground pull polling: 5 seconds while that
  project has authored activity in the previous 30 seconds, 30 seconds until
  2 minutes after activity, then 60 seconds while idle. Activity in one project
  never accelerates unrelated projects;
- blur/unfocused state removes pending poll-only work and performs no periodic
  provider request. Focus rebuilds the next deadline from the project's current
  activity age without replaying missed intervals;
- cancellation while offline/suspended;
- native `suspended`/`shutdown` persistence callbacks wait only for local
  durability and set the coordinator suspended; they never enqueue or wait for
  provider I/O. Resume clears suspension and schedules the next provider cycle;
- immediate self-pull after a publish;
- full-jitter retry (1 second base, 5 minute cap) for errors explicitly marked
  retryable, including `Retry-After`.

`installSyncEngineCoordinatorRuntime` connects the global authored commit
signal, native ready/resume, persistence lifecycle and online/focus signals.
Callbacks only enqueue work; they never wait for provider I/O. Paused,
needs-reauth and blocked bindings keep accepting local authored transactions but
the SyncGeneration runtime performs no provider operation. Initial and online wakeups
also pass through the injected personal-cloud capability gate; the default app
integration uses `canUsePersonalCloud()`.

This cadence is foreground polling over an immutable object log, not push,
presence or background realtime collaboration. Yjs still merges concurrent
prose updates when they arrive; opening/mounting a project, app start, resume and
online transitions schedule an immediate cycle, while an unfocused app waits
for the next explicit lifecycle wakeup.

Project purge has an explicit terminal lane. The project FK may already have
detached `sync_generation.project_id` when its terminal journal is ready; the
runtime recovers the immutable ProjectSync identity from that SyncGeneration's
change-set history, publishes `sync-generation.purge`, and only then marks the
SyncGeneration and binding `purged`. Remote purge retires the binding after the
typed reducer transaction commits. A purged SyncGeneration cannot start another
provider cycle.

`SyncEngineStatusStore` exposes sanitized per-project phase, outcome, pull,
publish, convergence and pending counters. Secrets, paths, content and transfer
session values are not diagnostics fields. Successful cycles separately persist
binding pull/publish/convergence timestamps; quarantine state is never reset by
a later status write.

## Crash and convergence acceptance

The file-backed SQLite integration suite proves:

- two Memory replicas converge through segment, inbox, reducer, cursor and all
  three frontier lanes;
- three LocalFolder replicas converge after concurrent writes;
- a crash at the cursor commit after durable download replays the page and
  remains idempotent;
- an expired committed cursor, including the reference-provider uppercase
  `INVALID_CURSOR`, is durably discarded, followed by a new captured cursor,
  complete LocalFolder inventory and changes drain;
- an expired pending inventory page, including native Drive-style lowercase
  `invalid-page-token`, restarts the same full-inventory protocol and remains
  restart-safe;
- cursor recovery marks every active known immutable object
  inventory-unconfirmed. The final inventory page and absence check share one
  SQLite transaction; if any known object is absent, the binding becomes
  `blocked-corrupt` and the current cycle stops before ingest, publish or
  checkpoint. Provider absence never becomes a domain delete;
- an upload whose success response is lost is reconciled by logical key, hash
  and size without a second remote object;
- structured SyncGeneration/object identities are hashed into stable
  `upload|download-<64 lowercase hex>` transfer IDs, so JSON punctuation never
  reaches the native resumable-transfer token boundary;
- malformed protocol bytes are retained and quarantined while the discovery
  cursor advances and domain state remains unchanged;
- a writer's segment 2 arriving before segment 1 remains a durable received
  dependency with no domain apply, quarantine or binding block; after segment 1
  arrives, both ranges apply in sequence and duplicate replay stays idempotent;
- segment sealing reads only the active writer owned by the current native
  installation. With no such writer there is no historical outbound lane;
  checkpoint source histories are never resealed on restore;
- a restore with no historical `sync_segment` rows accepts the exact next
  segment only when its `previousSegmentHash` matches the checkpoint's applied
  chain-head anchor; a different hash is retained and quarantined as
  `blocked-corrupt`;
- removal of a previously observed immutable provider object marks the binding
  `blocked-corrupt`, contributes to pending diagnostics, and never becomes a
  domain delete;
- restore activation atomically persists complete inventory plus its drained cursor;
  an observed post-checkpoint segment applies on the first normal cycle, while
  deleting it before that cycle records removal, blocks the binding and applies
  nothing;
- paused-provider local writes remain fully usable and publish after resume;
- a detached project purge reaches the immutable provider before its binding is
  retired;
- every convergence ends with SQLite integrity and foreign-key checks clean.

Provider conformance and the LocalFolder child-process SIGKILL suite remain the
transport-level durability evidence for duplicate, reorder, removal,
atomic-rename and directory-fsync behavior.

Run:

```bash
pnpm exec vitest run \
  src/renderer/sync/engine/architecture.test.ts \
  src/renderer/sync/engine/cursor.test.ts \
  src/renderer/sync/engine/frontier.test.ts \
  src/renderer/sync/engine/segmenter.test.ts \
  src/renderer/sync/engine/cycle.test.ts \
  src/renderer/sync/engine/scheduler.test.ts \
  src/renderer/sync/engine/coordinator.test.ts \
  src/renderer/sync/engine/transfer-id.test.ts \
  src/renderer/sync/local-object-gc.test.ts \
  src/renderer/sync/engine/sqlite-repository.test.ts \
  src/renderer/sync/engine/durable-runtime.integration.test.ts \
  src/renderer/sync/production-runtime.test.ts \
  src/renderer/platform/tauri.test.ts \
  src/renderer/sync/providers/memory-provider.conformance.test.ts \
  src/renderer/sync/providers/local-folder/provider.conformance.test.ts \
  src/renderer/sync/providers/local-folder/durability.test.ts \
  --reporter=verbose
pnpm exec eslint src/renderer/sync/engine \
  src/renderer/sync/local-object-gc.ts \
  src/renderer/sync/local-object-gc.test.ts \
  src/renderer/sync/production-runtime.ts \
  src/renderer/sync/production-runtime.test.ts \
  src/renderer/platform/tauri.ts \
  src/renderer/platform/tauri.test.ts \
  --max-warnings=0
pnpm typecheck
cargo test --manifest-path src-tauri/Cargo.toml sync_object_store --lib
```

The current machine report is
[`acceptance/phase3-durable-runtime.json`](acceptance/phase3-durable-runtime.json).

## Product composition

- The production typed kernel is available and fail-closed. Authored
  node/storyline membership writers now emit observed-remove OR-set mutations
  and a separate primary register; the old under-specified lifecycle/whole-array
  payload is retired from the reducer vocabulary.
- Downloaded asset blobs need a restart-safe native verification/install hook
  before `asset.bind` can materialize. This gate is now closed by
  [`phase2-native-asset-pipeline.md`](phase2-native-asset-pipeline.md): raw
  downloaded bytes remain unverified until native install and the SQLite blob
  receipt both complete.
- [`phase3-production-runtime.md`](phase3-production-runtime.md) constructs
  runtimes only from committed provider authority bindings and opaque secret
  references, reconciles native asset receipts first, and mounts the
  coordinator at App scope. It never invents or bypasses connect receipts.
