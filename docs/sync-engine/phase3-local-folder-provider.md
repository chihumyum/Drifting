# Phase 3 LocalFolder reference provider

Status: reference provider complete; it is connected to the Phase 3 reference
runtime acceptance, but no user-facing/native folder picker is connected.

`LocalFolderObjectLogProvider` is the durable filesystem reference for the
provider-neutral SyncEngine. It is a development and fault-injection provider,
not a user-facing sync option. The renderer provider never receives a selected
folder path, a source path, raw object bytes, Drizzle tables, Yjs state, or a
domain use case.

## Boundary

The provider accepts only:

- an opaque `secretRef` identifying a native-authorized folder root;
- opaque `LocalObjectRef` source and destination handles;
- object-log metadata (`objectKind`, logical key ID, stored hash and size);
- opaque provider generation, object, cursor, and page handles.

`LocalFolderObjectTransportPort` owns every filesystem operation. Its product
implementation must root-confine handle resolution, serialize writers across
processes, verify source hash/size, and perform durable atomic publication. The
Node implementation beside the tests is deliberately not exported as a product
adapter; it proves the port contract against real files.

An absolute or relative folder value such as `/tmp/sync-generation`,
`../sync-generation`, `folder/sync-generation`, or `C:\sync-generation` is
rejected before the transport is invoked.

## Durable event format

The Node reference stores one monotonically numbered event per committed
revision. A present event stages `object.bin` and `event.json` together:

1. create a same-filesystem staging directory;
2. write and `fsync` object bytes and event metadata;
3. `fsync` the staging directory;
4. atomically rename the whole directory into `events/`;
5. `fsync` `events/` and the SyncGeneration directory;
6. resolve the upload only after the directory durability boundary.

Incomplete staging directories are not part of inventory or changes and are
removed on reopen. A committed event with a missing/duplicated revision,
conflicting historical logical-key identity, reused object ID, or invalid
removal fails closed as `REMOTE_STORE_CORRUPT`.

Removal is provider degradation only. It appends a transport `removed` event;
it never creates a Drifting entity tombstone. The historical identity ledger
remains, so the same logical key and hash may be restored while a different
kind, hash, or size is permanently rejected.

## Pagination and recovery

Inventory and change page tokens include a captured revision cutoff. Objects
committed during pagination are therefore picked up by the later change drain,
not injected into an in-progress page sequence. Successful-upload response
loss is reconciled by logical key plus stored hash. Download verifies metadata,
size, and bytes before writing the destination `LocalObjectRef`.

The real SIGKILL suite stops a separate writer process at three boundaries:

- `stage-durable`: reopen sees no object;
- `commit-renamed`: reopen sees one complete, verified object;
- `commit-directory-durable`: reopen sees one complete, verified object.

This proves process-crash atomicity. The explicit file and directory `fsync`
sequence is the power-loss contract; a normal CI filesystem cannot simulate
hardware cache loss.

## Machine acceptance

Run:

```bash
pnpm exec vitest run \
  src/renderer/sync/providers/memory-provider.test.ts \
  src/renderer/sync/providers/memory-provider.conformance.test.ts \
  src/renderer/sync/providers/local-folder/architecture.test.ts \
  src/renderer/sync/providers/local-folder/provider.test.ts \
  src/renderer/sync/providers/local-folder/provider.conformance.test.ts \
  src/renderer/sync/providers/local-folder/durability.test.ts \
  --reporter=verbose
pnpm exec eslint src/renderer/sync/providers/local-folder \
  src/renderer/sync/providers/object-log-provider.conformance.ts \
  src/renderer/sync/providers/memory-provider.conformance.test.ts
```

The shared conformance definition is instantiated by both Memory and
LocalFolder. It covers cutoff-stable pagination, duplicate/reordered delivery,
concurrent same-object publication, response loss, immutable identity across
removal, verify-before-write corruption handling, and SyncGeneration handle
isolation.

The durable runtime integration additionally runs three independent SQLite
replicas against one LocalFolder SyncGeneration, injects a failure after inbox durability
but before cursor commit, replays the page, and proves canonical LWW convergence
without duplicate apply receipts.

The current machine report is
[`acceptance/phase3-local-folder-provider.json`](acceptance/phase3-local-folder-provider.json).

## Deliberate limitations

- No native Rust filesystem port is implemented or changed by this milestone.
- No provider picker or product lifecycle is connected.
- This provider is not the source of product trust policy. Google Drive follows
  the trusted-cloud contract and can process the synchronized Project objects.
- POSIX SIGKILL cases are skipped on Windows; Windows requires a separate native
  restart/power-loss acceptance before claiming support.
