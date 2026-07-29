# P3 Agent write-runtime acceptance

This suite verifies the first write-certified Drifting Agent path without a
provider API:

```text
ReaderWriterAgentRuntimeScheduler
  -> DriftingWriteToolRuntime
  -> canonical agent_runtime_write_effect
  -> runAgentTool
  -> renderer usecase boundary
  -> local projection + durable outbox
  -> canonical soft review
  -> next-turn feedback/checkpoint
```

## Commands

Run the complete acceptance suite:

```bash
pnpm --dir client eval:agent:p3
```

Run only the product write path or the process-crash matrix:

```bash
pnpm --dir client eval:agent:p3:write
pnpm --dir client eval:agent:p3:crash
```

Write a machine-readable combined report:

```bash
pnpm --dir client eval:agent:p3 \
  --output=docs/agent-runtime/acceptance/p3-write-summary.json
```

## Hard gates

`p3-write-path.acceptance.test.ts` uses a file-backed SQLite database through
the renderer's `DatabasePlatformApi`, the production runtime/write-effect
repositories, the production reader/writer scheduler, the production
`DriftingWriteToolRuntime`, and its default `runAgentTool` dispatch.

It requires:

- successful canonical effect/review persistence for the two write-certified
  node-field tools;
- duplicate delivery replay without a second renderer usecase or outbox row;
- user accept/reject decisions in the next-turn feedback and a durable
  checkpoint;
- exact inverse rejection through the same usecase;
- crash reconciliation when an exact inverse committed but the review receipt
  did not;
- pre-mutation failure and post-mutation-start `uncertain` classification;
- no blind retry at the three entered-mutation fault boundaries;
- stale Yjs revision/vector rejection with zero Y.Doc, projection, or outbox
  mutation;
- 100 deterministic seeds x 50 mixed operations, with 1,000 unique writes,
  1,000 concurrent duplicate deliveries, and 3,000 reads;
- exactly 1,000 effects, reviews, renderer usecase dispatches, and outbox rows,
  with no project crossover.

`p3-crash-consistency.acceptance.mjs` adds real process death. Every case uses a
separate file-backed SQLite WAL database with `synchronous=FULL`, product
`0060`/`0061` receipt schemas, and a real `Y.Doc`. The parent waits until the
worker reaches one of these exact boundaries and then sends `SIGKILL`:

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

The end-to-end product path currently applies to `rename_node` and
`set_node_summary`, the only provider-visible write-certified tools. The crash
worker deliberately models the future prose transaction with the product
receipt schema and real SQLite/Yjs primitives; it does not claim that prose
tools are provider-visible or write-certified. Production prose certification
still depends on wiring the monotonic Yjs revision/persistence coordinator into
the tool strategy.
