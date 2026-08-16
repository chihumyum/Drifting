# P3 Agent write-runtime acceptance

This suite verifies the first write-certified Drifting Agent path without a
provider API:

```text
ReaderWriterAgentRuntimeScheduler
  -> central permission policy (automatic or author-approved)
  -> DriftingWriteToolRuntime
  -> authorized agent_runtime_write_effect
  -> runAgentTool
  -> renderer usecase boundary
  -> local projection + durable outbox
  -> durable writeRef/checkpoint
```

## Commands

Run the complete acceptance suite:

```bash
pnpm eval:agent:p3
```

Run only the product write path or the process-crash matrix:

```bash
pnpm eval:agent:p3:write
pnpm eval:agent:p3:crash
```

Write a machine-readable combined report:

```bash
pnpm eval:agent:p3 \
  --output=docs/agent-runtime/acceptance/p3-write-summary.json
```

## Hard gates

`p3-write-path.acceptance.test.ts` uses a file-backed SQLite database through
the renderer's `DatabasePlatformApi`, the production runtime/write-effect
repositories, the production reader/writer scheduler, the production
`DriftingWriteToolRuntime`, and its default `runAgentTool` dispatch.

It requires:

- successful canonical authorization/effect persistence for certified writes;
- author-approved calls have zero Yjs, domain SQLite, outbox, or effect mutation
  before approval, and zero mutation after denial; automatic certified calls
  persist equivalent authorization provenance before mutation;
- duplicate delivery replay without a second renderer usecase or outbox row;
- node-field writes create no prose-review row; broader product integration
  verifies that Yjs prose writes create canonical review rows and project their
  inline badge/reveal only after those rows exist;
- crash reconciliation from the domain receipt without replaying the write;
- pre-mutation failure and post-mutation-start `uncertain` classification;
- no blind retry at the three entered-mutation fault boundaries;
- stale Yjs revision/vector rejection with zero Y.Doc, projection, or outbox
  mutation;
- 100 deterministic seeds x 50 mixed operations, with 1,000 unique writes,
  1,000 concurrent duplicate deliveries, and 3,000 reads;
- exactly 1,000 effects, renderer usecase dispatches, and outbox rows, with no
  duplicate review rows and no project crossover.

`p3-crash-consistency.acceptance.mjs` adds real process death. Every case uses a
separate file-backed SQLite WAL database with `synchronous=FULL`, product
receipt tables from the current local-first baseline, and a real `Y.Doc`. The
parent waits until the worker reaches one of these exact boundaries and then
sends `SIGKILL`:

1. before the mutation transaction;
2. after the in-memory Yjs update but before projection persistence;
3. after Yjs/projection writes but before outbox insertion, while the SQLite
   transaction is open;
4. after the Yjs/projection/outbox transaction commits but before the runtime
   result receipt.

Recovery is run twice. The suite requires deterministic `failed` vs
`uncertain` settlement, no second dispatch, atomic rollback/commit agreement
between Yjs updates, projection, and outbox, clean foreign keys, clean SQLite
integrity, and a stable recovery hash.

## Boundary of the evidence

The original P3 node-field suite remains a focused regression layer. Broader
product integration covers the current certified entity, prose, patch, comment,
and virtual-file strategies. Native UI acceptance of destructive-operation
permission cards and the inline editor badge/reveal still requires author
testing in the Tauri app.
