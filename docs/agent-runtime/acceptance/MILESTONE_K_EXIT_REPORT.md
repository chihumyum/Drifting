# Milestone K exit report — Long-task reliability and Max context

Date: 2026-08-02

Status: **implementation and E0-E3 Standard-context acceptance complete; E4 and a paid 1M canary remain explicit**

## Trigger and root cause

The real session `session-93b4cdc0-d986-4a61-8add-62a8bc2bfdf7` completed two
multi-chapter edit turns and failed on the third cleanup turn. Context had
grown to roughly 170k estimated tokens. Two independent planner defects made
the failure structural:

1. every compressible row in the latest two turns was pinned byte-exact, so a
   broad current turn could never compact its own older read batches;
2. once an older turn became eligible, the product compactor grouped that
   entire turn into one request, ignoring its 18k preferred chunk size. The
   provider returned truncated tool arguments and the planner terminated the
   turn with `COMPACTOR_FAILED`.

The earlier claim of “native Agent acceptance” was too broad. Existing evidence
was deterministic/file-backed/headless plus native artifact build evidence; it
was not a manual E4 interaction run in the App. The durable evidence vocabulary
is now fixed in
[`GENERAL_AGENT_FUNCTIONAL_CHECKLIST.md`](GENERAL_AGENT_FUNCTIONAL_CHECKLIST.md).

## Implementation

- Recent exact compressible history is capped at 64k. Small conversations still
  retain their latest two turns; oversized histories retain a newest
  tool-topology-safe suffix while the current author request remains separately
  exact.
- Compactor chunking now uses the smallest call/result-connected units instead
  of whole turns. Sequential calls in one turn may split; overlapping parallel
  calls remain atomic.
- Compaction follows the submitted turn's provider and model through the same
  provider-neutral driver.
- Compaction reclaims at least half of the planned input when eligible history
  permits, then stops instead of serializing every old chunk. A compaction now
  leaves useful working room instead of landing immediately below the limit.
- Unsupported, missing or malformed structured summary output produces a
  deterministic non-factual fallback. Exact write-result evidence is retained;
  omitted read state must be fetched again.
- The composer menu has a persisted Max toggle. Standard requests 200k; Max
  requests the model's declared window up to 1M and is disabled for models that
  do not declare 1M.
- The checklist defines Core/Expansion scope, E0-E4 evidence, exact pass
  criteria and the historical three-turn live regression.

## Automated evidence

- `pnpm --dir client typecheck`: passed.
- `pnpm --dir client test:agent-runtime`: 63 files, 523/523 tests.
- `pnpm --dir client eval:agent:context`: 11 files, 84/84 tests;
  real-private-book availability, retrieval, compaction, fidelity, restart,
  fault circuit and capability drift gates all passed.
- Full `pnpm --dir client lint` passed; it retained 41 pre-existing
  warnings and reported no error.

The context gate now requires same-turn oversized compaction, topology-safe
chunking, deterministic malformed-output fallback and the 1M Max profile in
addition to its earlier 200k/restart/fidelity assertions.

## Mounted renderer evidence

The original failed conversation was resumed through the mounted Tauri
renderer and configured real provider. Turn
`019fc206-4ad8-734b-b6f1-635b98ce9991` completed a read-only search at
171,581/200,000 planned tokens in 9.9 seconds, with a final answer and no budget,
compactor or durable-commit error.

A first follow-up intended to cross the compaction threshold was invalidated by
unrelated source HMR/page reloads while its parallel reads were running. It is
not counted as passed; the debug broker now fails and releases an active lease
when its mounted renderer disconnects instead of leaving the request occupied.

The repeat used a fixed mounted renderer (`VITE_DRIFTING_AGENT_DEBUG_DISABLE_HMR=1`),
the real `雾港纪事` SQLite/Yjs project and the configured DeepSeek provider:

- forced 60k canary: turn `019fc21a-2c38-72b5-96de-a98f43fa2d37`
  compacted 78,141 source tokens to 36,751, saved 41,390 tokens (52.97%),
  reached `37,863/60,000`, and completed after reading three full chapters;
- production 200k regression: the original failed conversation was resumed.
  Its stale HMR-aborted turn became `interrupted/PROCESS_INTERRUPTED`, then turn
  `019fc21e-c7fe-7349-bd05-bbc7a2324af9` compacted 171,052 source tokens to
  79,142, saved 91,910 tokens (53.73%), reached `80,254/200,000`, and completed
  normally with 91,554 input tokens free.

Both terminal rows and their post-turn checkpoints were queried from the real
App SQLite database after completion. The dated E3 record is
[`GENERAL_AGENT_ACCEPTANCE_RUN_2026-08-02.md`](GENERAL_AGENT_ACCEPTANCE_RUN_2026-08-02.md).

## Explicitly unverified

- Manual E4 desktop/iOS/Android interaction remains unrun. A macOS Computer
  Use attempt was made, but the Mac was locked and was correctly not unlocked
  automatically, so no menu interaction is counted.
- A paid 1M Max canary remains unrun because the configured live route is a
  200k DeepSeek model; the explicit 1M declaration/cap and persistence path are
  covered deterministically.
- The exact historical real-project three-turn write sequence has not been
  repeated. Paid write stress was instead run on disposable database clones as
  recorded below, so it cannot be reported as `LONG-09`/`LONG-10`.

## Paid write stress extension

After the context repair, the mounted renderer was exercised against disposable
copies of the real `雾港纪事` project with the configured paid DeepSeek route.
Through completion of the disposable campaigns, before reopening the normal
App, the primary database SHA-256 stayed
`abfa94e06f4d06afa6f1e5e85e7b652635db03a31c1a914c3f00e0633abc608c`.

- A real five-chapter task edited chapters 03–07, crossed the Standard 200k
  compaction boundary, persisted nine V3 summaries and recovered them on a
  3.285-second cold reopen without a redundant provider compaction call.
- The certified reversible matrix passed 14/14 provider-exposed writes. A
  separate durable-review run accepted one block and rejected another, with
  SQLite/Yjs readback retaining only the accepted effect.
- Repeated compound CRUD runs exposed product-level failures in creation
  guidance, dependent-write ordering, canonical paths, stable tool selection,
  inspiration routing, literal occurrence search, category normalization,
  typed summary initialization and actual word-count reporting. Each failure
  received a regression test before the next paid run.
- The final clean session `session-10ef6e48-fa2e-4589-81c0-f29b92263128`
  completed seven model iterations, 36/36 tools and the turn terminal in
  67.368 seconds. It created and reread a 1,966-character drift, two typed
  entities with independent summaries, exactly three relations, one comment
  and one TODO. Direct comparison found no chapter-row or chapter-Yjs change.
- After the normal App reopened and checkpointed SQLite, logical isolation
  queries still found zero named pressure-test nodes, entities, comments,
  sessions or turns in the primary database.
- Final baseline: 136 files / 897 full Core tests, typecheck passed, lint zero
  errors with 41 pre-existing warnings, and capability acceptance 9/9.

The detailed provider/session/tool-ledger evidence is in
[`GENERAL_AGENT_ACCEPTANCE_RUN_2026-08-02.md`](GENERAL_AGENT_ACCEPTANCE_RUN_2026-08-02.md).
This extension is E3 and does not close the E4, paid-1M, concurrent-session or
exact `LONG-09`/`LONG-10` boundaries.
