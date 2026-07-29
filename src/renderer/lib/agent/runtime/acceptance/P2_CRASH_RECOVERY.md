# P2 crash/recovery acceptance harness

Run the full P2 crash matrix with Node 22:

```sh
node src/renderer/lib/agent/runtime/acceptance/p2-crash-recovery.acceptance.mjs
```

The suite creates a fresh temporary SQLite database from the product
`0060_agent_runtime_persistence.sql` migration for each case. For every one of
the 10 lifecycle markers and 20 deterministic seeds, it starts a writer
process, waits until the committed marker is reported, sends that process
`SIGKILL`, then starts a separate recovery process. A cleanly closed reference
database is recovered independently and its canonical state hash must match the
killed database. The repository itself is exercised separately against the
same migration in
`agent-runtime-persistence-repo.integration.test.ts`.

The assertions cover:

- no accepted prompt loss;
- no duplicate or orphaned tool call/result;
- exactly one terminal event per accepted turn;
- contiguous event sequence numbers;
- no corrupt session, foreign-key violation, or failed `PRAGMA integrity_check`;
- streaming assistant content is marked interrupted and excluded from complete
  provider history;
- 10,000-event recovery has stable output and both worker-only and end-to-end
  p95 latency below two seconds.

For a quick local smoke run:

```sh
node src/renderer/lib/agent/runtime/acceptance/p2-crash-recovery.acceptance.mjs \
  --seeds=1 \
  --performance-samples=2
```

The child process intentionally drives the product schema with raw SQL so the
parent can hard-kill it at exact committed boundaries without a renderer or
Tauri lifecycle. `createAcceptanceSchema` always loads the checked-in product
migration rather than maintaining a second acceptance-only schema.
