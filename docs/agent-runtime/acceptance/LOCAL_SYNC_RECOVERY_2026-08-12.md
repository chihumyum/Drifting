# Local sync recovery — 2026-08-12

## Incident

The desktop client could authenticate and pull successfully, but its durable
entity outbox never advanced. The captured server log showed repeated
`POST /api/projects/:id/nodes` responses with HTTP 422 and a missing
`mainStorylineId` property. The active development SQLite database contained
154 pending mutations; the head mutation was an Agent-created drift node.

The pull/Yjs transport was healthy. This was a deterministic entity-write
contract failure, amplified by strict outbox ordering and an 800 ms retry.

## Root causes and repair

1. The manual node use case emitted `mainStorylineId`, while the General Agent
   structural writer built a separate create payload and omitted it.
2. The server route described `mainStorylineId` as nullable but still required
   the property, so old durable outbox rows were rejected before reaching the
   service.
3. A permanent 422 was treated like a transient transport error and therefore
   retried forever at the head of the queue.
4. Once that blockage cleared, a legacy relation create exposed a second
   deterministic server failure. The relation-type compatibility transaction
   materialized a newly inserted type before inserting its endpoint rows, then
   attempted `values([])` from that empty projection.

The repaired boundary now:

- builds Agent node creates through the shared node-create sync contract and
  emits an explicit `mainStorylineId: null` for drift nodes;
- normalizes historical node-create outbox payloads at request resolution, so
  persisted rows written by older clients can be replayed without rewriting
  SQLite history;
- accepts an omitted primary-storyline signal on the server as the legacy form
  of `null`, while continuing to validate explicit values;
- quarantines an immutable logical mutation chain after HTTP 422 so unrelated
  mutations can continue instead of entering a hot retry loop;
- records the server response message for actionable sync diagnostics without
  logging request credentials; and
- seeds legacy relation-type endpoint rows from the compatibility definition,
  rather than from the temporarily empty post-insert projection.

## Machine-checkable evidence

The following commands passed on the repaired checkout:

```bash
pnpm --dir client exec vitest run \
  src/renderer/services/node-create-sync-contract.test.ts \
  src/renderer/services/entity-sync-coalescing.test.ts
# 2 files, 11 tests passed

pnpm --dir client exec vitest run \
  src/renderer/lib/agent/runtime/drifting-domain-crud-write-strategy.integration.test.ts
# 1 file, 17 tests passed

pnpm --dir private service exec bun test
# 28 files, 136 tests passed

pnpm --dir client typecheck
pnpm --dir private service typecheck
# both passed
```

Targeted ESLint over the changed Core and Server paths exited successfully with
zero errors. Core reported ten pre-existing `no-explicit-any` warnings in the
shared entity-sync projection code; Server reported no warnings.

## Live development acceptance

Before starting the repair client, a consistent SQLite backup was captured at
`/tmp/drifting-sync-repair.Gj7K4f/before.sqlite`. Its integrity check is `ok`
and it records all 154 original pending mutations.

The client was then mounted directly on project
`synthetic-project-0001` against the already-running
local Bun server and PostgreSQL container:

- the original node-create 422 cleared and the queue advanced from 154 to 69;
- the newly exposed relation failure was diagnosed from the actual response as
  `values() must be called with at least one value`;
- after the relation compatibility repair, the durable outbox reached 0;
- the active SQLite database still reports `PRAGMA integrity_check = ok`;
- PostgreSQL contains Agent-created drift node
  `89bf976b-8186-51be-a77d-bb709da10ed2` (`夜航船`);
- PostgreSQL contains relation
  `7d4297d5-8dca-5fb0-a78d-b3523daab2f5` and its `包含章节` compatibility type;
  and
- that type has all seven allowed source kinds and five structural target
  kinds, proving the companion endpoint rows committed with the relation.

This acceptance proves recovery of the existing local entity queue and the
node/relation contract paths against the local development stack. It does not
claim remote deployment acceptance or physical-device UI acceptance.
