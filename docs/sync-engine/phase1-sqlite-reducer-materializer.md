# Phase 1 SQLite reducer materializer

Status: implemented and machine-checked for scalar/tuple LWW, observed-remove
sets, fractional order registers, entity lifecycle, semantic conflicts, and
atomic journal receipts.

## Transaction boundary

Remote apply has one mandatory caller-owned SQLite transaction:

1. `stageRemoteChangeSetInTransaction()` verifies the complete change-set and
   inserts its immutable `sync_change_set`/`sync_mutation` rows as `applying`.
2. `applyVerifiedRemoteChangeSetInTransaction()` replays only receipt-backed
   history, runs the deterministic reducer, asks a typed
   `SyncDomainMaterializationKernel` to validate and materialize accepted
   effects, and writes reducer metadata/conflicts.
3. Only after those writes succeed does
   `completeRemoteApplyInTransaction()` advance the local HLC and create the
   immutable apply receipt. Any failure rolls back domain rows, reducer
   metadata, journal staging, HLC, and receipt together.

Remote application never reserves a local sequence and therefore cannot echo
a remote change-set. Duplicate delivery returns before calling the domain
kernel. Reordered delivery replays the immutable receipt-backed log and
materializes the same canonical winners.

Local authored transactions already wrote typed domain rows before journal
finalization. Their post-write observer updates the same reducer metadata in
the transaction. A newly blocked semantic effect throws and rolls the complete
domain + journal transaction back.

## Persistence rules

- `sync_field_clock.field_key` uses `field:<name>` for scalar registers and
  `tuple:<name>` for atomic tuples. Register values remain recoverable from the
  immutable canonical change-set bytes; the clock table stores merge authority.
- `sync_set_tag` stores every add tag and its deterministic winning remover.
  A remove received before its referenced add stays in replay state and is
  materialized when the add later arrives.
- `sync_order_register` stores the winning position key and full total-order
  source.
- `sync_entity_lifecycle` stores only a resolved current projection. Missing
  create/restore ancestry stays in the immutable log and an invariant conflict.
- `sync_generation_purge` stores the winning `sync-generation.purge` source and
  full total-order clock. Its presence is a permanent absorbing state for that
  SyncGeneration:
  later non-purge operations are still durably staged, receipted, and included
  in applied frontiers, but every domain effect is forced to
  `materialize=false`. No writer order, cache restart, duplicate delivery, or
  restore can clear this register.
- Before a local change-set is hashed, the journal resolves every mutation to
  the current entity incarnation in the same SQLite transaction. A restore is
  accepted only from `trashed(n)` and becomes `live(n+1)`; create, trash,
  restore, and purge never guess or reuse an incompatible lifecycle sequence.
- Reducer-owned conflict IDs are namespaced by `syncGenerationId`. Resolving reducer
  conflicts never changes object-collision or writer-fork conflicts owned by
  the transport layer. Core and domain-validator conflicts have separate
  ownership; a domain conflict closes only after that domain validator actually
  runs again and no longer reports it.
- Reducer metadata code never writes domain tables. Only the injected typed
  domain kernel may do that, so remote sync cannot bypass existing validators.
- Immutable receipt-backed history is replayed once after process start or
  cache invalidation. Later applies reuse canonical state keyed by
  `syncGenerationId` only when its receipt count matches SQLite; a rolled-back optimistic cache entry is
  therefore rejected automatically. Restore/checkpoint activation calls
  `invalidateSqliteReducerStateCache()`.

`yjs.update`, `asset.bind`, `asset.unbind`, and `sync-generation.purge` are explicit
external typed-reducer actions. They may share an atomic change-set with core
effects, but a remote kernel must explicitly claim, validate, and materialize
them. Asset bind/unbind has a reducer-owned LWW register, so a late old unbind
cannot erase a newer bind. Yjs updates remain CRDT operations and are applied
only when their prose owner incarnation is current and live. Asset
bind/unbind follows the same owner-lifecycle gate. Late Yjs/asset operations
from a pre-restore incarnation remain immutable reducer evidence but cannot
materialize into the restored entity. Unknown target kinds and unclaimed
actions fail closed.

## Production domain kernel

The production factory is
`src/renderer/sync/reducer/production-domain-kernel.ts`:

```ts
import {
  createProductionSyncDomainMaterializationKernel,
  productionSyncDomainMaterializationKernel,
} from '../sync/reducer';
```

The factory has no network, provider, OAuth, Tauri, or process-global
dependency. All persistence authority arrives in the per-apply
`SyncDomainMaterializationContext` (`tx`, `origin`, canonical `changeSet`, and
reducer effects), so it is safe to inject into a `SqliteSyncGenerationRuntime` only
after the runtime has a committed SyncGeneration and provider binding plus verified local object
dependencies. The singleton is stateless; the factory exists for explicit
composition and future test dependency injection.

The kernel uses explicit kind/field/tuple/set/order codecs. It never chooses a
column from untrusted wire text without first passing the frozen allowlist. It
materializes lifecycle seeds, then OR-set membership rows, then the independent
primary-storyline LWW register and other fields. Purges run after
scalar/set/order effects, then KV, aliases and Plot Grid JSON projections are
rebuilt. A SyncGeneration purge is different: it suppresses every non-purge effect,
deletes the project, and retires the current SyncGeneration and provider binding in the
same transaction. Remote staging alone may continue against that detached,
purged SyncGeneration so receipts/frontiers converge; local authored writes still
require an active SyncGeneration. Relation
types use the existing portable normalizer and relation validator. Canonical
replay of an unchanged locked built-in relation type compares its endpoint set
and is a no-op; it never attempts the forbidden delete-and-reinsert sequence.
A non-equivalent locked endpoint projection still fails closed, while editable
relation types retain explicit replacement semantics. Yjs uses
the existing repository with `remote` revision provenance. Assets require a
locally verified blob, immutable matching metadata, one typed owner, and a
kind-compatible owner row. SyncGeneration purge calls the existing transactional
project deletion kernel and preserves the SyncGeneration journal/receipt.

Invalid semantic effects remain immutable reducer evidence but are returned
with `materialize=false` and a deterministic `sync_conflict`; the receipt still
commits. Structural protocol errors still reject/quarantine the whole
change-set. Remote materialization never calls `runAuthoredTransaction`, so it
cannot reserve a local sequence or echo a change-set.

Trash remains a protocol lifecycle state even for authored tables without a
`deletedAt` column. Nodes, elements, storylines, and categories keep their row
and project `deletedAt`; comments, comment actions, element patches, relations,
and relation types remove only the SQLite domain projection while retaining a
restorable `sync_entity_lifecycle` tombstone. Their full `entity.restore` seed
recreates the row at incarnation `n+1`. Rejecting an Agent-created comment or
memory record writes `entity.trash`, and an approved element-patch delete
restores its full seed plus order authority at incarnation `n+1`; none of these
reversible paths emits a purge and then recreates the same ID.

The four reachable Trash restore paths and the Agent structural inverse share
`appendAuthoredLifecycleRestoreInTransaction()`. It captures the full typed
seed, full Yjs state, current order/tuple authority, explicit chapter
memberships and primary register, aliases, and an element portrait binding in
the same authored change-set. A restore does not reattach deleted relations.

Storyline membership is no longer encoded as a synthetic entity lifecycle or
whole-array field. `appendAuthoredNodeStorylineProjectionInTransaction` reads
the final typed `node_storyline_link` rows inside the caller-owned transaction,
diffs them against live `sync_set_tag` add tags, emits UTF-8-bytewise ordered
`set.add`/observed `set.remove`, and appends
`node-storyline-primary.storylineId` as a separate field register. The normal
UI and Agent graph-replacement paths both use this helper. Node create seeds no
longer carry `mainStorylineId`.

The following boundaries remain deliberately fail-closed rather than guessed:

- `chapter` is accepted only as an order-list kind, never as an entity row.
- Retired `node-storyline-link` lifecycle and whole-array payloads are not in
  the frozen reducer target vocabulary. Clean-first builds reject them as
  unknown protocol input; no current UI or Agent writer emits them.
- Any future target kind, field, tuple, set, order encoding, or external action
  is blocked until it is classified in the protocol/domain manifest and this
  kernel together.

## Machine acceptance

```text
pnpm exec vitest run \
  src/renderer/sync/journal/change-builder.test.ts \
  src/renderer/sync/journal/repository.integration.test.ts \
  src/renderer/sync/reducer/reducer.test.ts \
  src/renderer/sync/reducer/sqlite-materializer.integration.test.ts \
  src/renderer/sync/reducer/production-domain-kernel.integration.test.ts \
  src/renderer/sync/journal/authored-transaction.integration.test.ts \
  src/renderer/usecase/sync-lifecycle-restore.integration.test.ts \
  src/renderer/usecase/sync-helpers.test.ts \
  src/renderer/lib/agent/runtime/drifting-domain-crud-write-strategy.integration.test.ts \
  src/renderer/lib/agent/runtime/drifting-element-patch-write-strategy.integration.test.ts \
  src/renderer/lib/agent/runtime/drifting-entity-write-strategy.integration.test.ts \
  src/renderer/services/node-create-sync-contract.test.ts
```

The real file-backed SQLite suite covers duplicate delivery, reverse winner
delivery, remove-before-add, semantic conflict blocking, local post-write
observation, and an injected failure at the receipt boundary. It asserts both
`PRAGMA`-backed transaction rollback and absence of local-origin echo.

The production suite additionally runs against the real baseline in a
file-backed database and covers typed field materialization, OR-set membership
plus primary-register ordering, invalid primary blocking, blocked semantic
effects, relation invariants, Yjs remote provenance, verified asset binding,
asset bind/unbind reverse delivery, and terminal `sync-generation.purge` with receipt
survival. It also reproduces the physical-device sequence where the next
chapter bundle follows the locked built-in relation type and proves that the
second receipt, chapter row, prose row, and unchanged endpoint set commit
without bypassing the SQLite lock trigger. SyncGeneration purge acceptance uses two writer orders plus duplicate,
cache-restart replay, and reducer-state checkpoint restore; canonical snapshots
converge and the deleted project never reappears. Lifecycle acceptance additionally covers all four UI restore
facades, Agent trash/restore for structural objects, explicit comment-action
cascade, Agent-created comment and memory rejection, element-patch delete and
incarnation-one restore, remote physical trash projections for tables without
`deletedAt`, and late incarnation-zero Yjs/asset suppression. This milestone
does not claim provider activation, Google account credentials, or real-device
Google Drive acceptance.
