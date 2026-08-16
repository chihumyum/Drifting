# SyncEngine Phase 0 domain manifest

Phase 0 freezes a fail-closed classification boundary between authored project
state, authoritative Yjs state, rebuildable projections, device-local runtime,
secrets, and SyncEngine transport metadata. The executable source is
[`domain-manifest.ts`](../../src/renderer/sync/protocol/domain-manifest.ts); the
expanded checked-in inventory is
[`acceptance/sync-domain-manifest.json`](acceptance/sync-domain-manifest.json).

## Locked v1 boundary

- Included: authored project/domain rows, `project_asset` immutable metadata,
  durable `agent_memory`, Yjs updates/full-state snapshots, and explicit
  seed-only editor bodies.
- Excluded: `agent_working_memory`, all Agent session/task/review/receipt state,
  `block_section`, `inline_mention`, prose metrics and outline/preview/cache
  projections, and MCP grants/config secrets. The old hosted sync cursor/outbox
  tables are absent from the clean baseline rather than carried as compatibility
  classifications.
- `content_json` on Yjs-backed entity editors is classified as CRDT seed/cache,
  never as a second prose merge authority. Ordinary comment, library, and patch
  TipTap JSON remains authored whole-field state in protocol v1.
- Legacy `kv_json`, `aliases_json`, `plot_grid_json`, `book_order`,
  `start_order`, and integer `order_key` fields are classified as projections.
  Phase 1 now supplies stable KV-entry, alias OR-set, and normalized Plot Grid
  writer authority, fractional ordering, and checkpoint projection rebuild.
  This manifest does not
  silently promote any old whole-JSON or integer representation into v1 wire
  authority.
- Provider credentials, bearer tokens, and resumable session URIs are never
  domain fields. SQLite may store only opaque credential/session references,
  and those fields must still receive an explicit `secret` classification.
- `sync_app_authority` is global transport policy, not project content. It is
  the persisted gate that prevents different projects in one app from selecting
  different providers; neither it nor an internal per-generation binding enters
  a domain checkpoint.

`authored` and `crdt` fields are eligible for domain/checkpoint encoding.
`derived`, `device-local`, `secret`, and `transport` fields are excluded. A
table marked `exclude` may not contain any included field.

## Machine gate

The test reflects over the current Drizzle exports and compares every physical
table/column name with the manifest. A new table, a renamed column, or a new
column fails until it receives one classification and a non-empty reason. The
test also locks the named product boundaries above and proves the validator
rejects synthetic schema drift.

```bash
pnpm exec tsx scripts/generate-sync-domain-manifest.ts
pnpm exec tsx scripts/generate-sync-domain-manifest.ts --check
pnpm exec vitest run src/renderer/sync/protocol/domain-manifest.test.ts --reporter=verbose
```

The first command deliberately rewrites generated evidence; CI and normal
verification should use `--check`.
