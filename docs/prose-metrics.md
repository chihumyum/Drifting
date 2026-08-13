# Canonical prose metrics

Updated: 2026-08-14

Drifting treats `book_node.word_count` as a rebuildable materialized projection,
never as an independent prose truth. Live and durable Yjs state owns prose;
pre-Yjs content is an explicit seed boundary.

## Durable basis

Every trusted count carries:

- `word_count_basis_kind`: `seed` or `yjs`;
- `word_count_basis_hash`: SHA-256 of canonicalized ProseMirror JSON;
- `word_count_basis_revision`: the exact local Yjs revision, when local;
- `word_count_basis_server_seq`: the exact merged Server update watermark,
  when Server-owned.

A missing basis means a legacy or incomplete projection. UI, project summaries,
Writing History and directory-style Agent reads must show a pending state rather
than present that scalar as exact. A full `read_node` remains able to report an
immediate count because it reads live Yjs prose directly.

## Write and rebuild boundaries

- Manual editor persistence captures one stable Yjs base and commits
  `node_content`, outline, count, basis and the cache sync outbox in one SQLite
  transaction guarded by the captured Yjs revision. The Server derives its own
  metric from Yjs rather than accepting a client-local metric outbox.
- General Agent prose commits derive count and basis inside the same
  renderer-owned Yjs command transaction and durable receipt boundary.
- Snapshot restore and legacy prose writes run the same materializer after the
  Yjs COVER/write operation.
- Project boot performs bounded, idempotent reconciliation (four workers). It
  never changes Yjs prose or author-facing node recency; it only rebuilds local
  projections and marks aggregate metrics ready after every active node has a
  basis.
- New seeded nodes hash the exact canonical empty/template ProseMirror document.

## Server merge boundary

The Server serializes updates per `document` row. A historical document without
a compacted state asks one client for a full-state checkpoint; it then applies
the complete append-only update log, stores the merged state and derives the
node metric at `latest_server_seq`. Later pushes incrementally apply only rows
after `compacted_through_seq`.

The client freezes one local state generation, uploads every update row from
that generation, and only then submits its checkpoint. It does not advance the
local push cursor until the checkpoint succeeds, so a failed bootstrap retries
without hiding newer local edits in an unpullable Server state.

Yjs updates are idempotent, so a submitted checkpoint may already contain some
logged operations. Reapplying them cannot duplicate prose. Older entity-sync
payloads may keep writing structural fields, but an unproven or older scalar
cannot overwrite a Server-owned metric basis. Entity-sync wire compatibility
still accepts local basis fields, but the Server strips them: a client-local
revision is meaningless on another device. Server summaries stay pending until
the Server derives an explicit content seed or assigns the merged Yjs sequence;
clients cannot assert `word_count_basis_server_seq`.

Project totals are chapter-only. Drift nodes retain their own exact count but do
not contribute to project targets, Writing History, or Server project-summary
totals. The local Writing History store upgrades to version 2 by clearing the
incompatible v1 total snapshots while preserving author-owned project and daily
goals; subsequent snapshots rebuild from canonical chapter totals.

## Deterministic acceptance

```bash
pnpm --dir client eval:prose-metrics
cd private service && bun test src/modules/sync/prose-metrics-materializer.test.ts src/modules/node/node-prose-metric-policy.test.ts src/modules/node/node-route-contract.test.ts
pnpm --dir client typecheck
pnpm --dir private service typecheck
```

The fixture covers the established mixed CJK/Latin rule, canonical semantic
hashing, seed versus revision-backed projections, Agent-created prose, and
order-independent concurrent Yjs merge materialization.

## Manual and platform boundary

Desktop visual review should confirm that project, storyline, node, stats and
status surfaces say “统计中” during reconciliation, then converge without a
visible stale non-zero count. iOS and Android share the data/materialization
code, but physical-device foreground/background sync, touch, safe-area, IME and
visual presentation remain manual acceptance. Build, typecheck, Simulator, or a
touch handler alone does not close those gates.
