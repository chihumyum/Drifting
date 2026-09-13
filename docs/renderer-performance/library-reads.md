# Covered library reads

Library updates now use the same durable workspace coverage as nodes and
elements. The published `0002_workspace_projection_journal.sql` already records
library entity IDs and identity replacement revisions; no migration changes.

For a trusted base with at most 128 changed identities, the projection reads
only those complete library rows. SQLite then returns all project library IDs
in `orderKey ASC, updatedAt DESC, rowid ASC` order. The full repository read and
skinny read use the same explicit tie-breaker. Unchanged rows retain their object
identity, including text bodies and notes, while edited rows can move freely in
the returned order. The capture stays inside one read transaction and retains
the existing project/request/publication guards.

An insertion, deletion, delete/reinsert, project move, ID change, oversized
batch, unavailable coverage or unexpected membership promotes to a complete
library read. Empty ID requests do not accidentally select every row. Library
queries remain project scoped; no cache or second prose owner is introduced.
The initial capture and every fresh process still read the full workspace.

## Headless acceptance

`acceptance/f6-library-reads.json` compares the exact `94916185` checkout with
the changed implementation using the same measurement test and synthetic
product-schema SQLite fixtures. A warm capture is excluded, followed by five
samples for 64 and 1,024 synthetic text items plus the existing fixture item.
Each measured covered result must equal a separate full authoritative capture.

Measured median gateway work for one edit:

| Fixture total | Full body rows before → after | Serialized row bytes before → after | Queries before → after |
| --- | --- | --- | --- |
| 65 | 65 → 1 | 540,406 → 9,405 | 4 → 5 |
| 1,025 | 1,025 → 1 | 8,640,876 → 21,875 | 4 → 5 |

The larger fixture's instrumented Node capture median was 31.12 ms before and
3.48 ms after; these five-sample timings include row serialization and concurrent
host activity. They are descriptive diagnostics, not a fixed-device budget or
an application startup improvement claim.

The 53 checks include body/notes edits, order and timestamp ties, a payload-kind
change, the 128-row boundary, lifecycle and identity fallback, rollback, project
isolation, read failure/retry and rejection after optimistic publication. The
reported row bytes are serialized gateway results; timings include that
instrumentation and are not native IPC, whole-app or device measurements.

`acceptance/f6-library-recovery.json` executes the actual authored transaction,
projection capture and refresh queue. Across two seeds it sends SIGKILL at five
observed boundaries: before commit, after commit, waiting in the queue, after
capture before publication, and after publication. Each of the ten cases has
two independent process restarts. Recovery must preserve every persistent row,
match the fixture and full-capture oracle, preserve the other project, and pass
SQLite integrity and foreign-key checks. This is process recovery over the
Node SQLite gateway, not native renderer or power-loss acceptance.

```bash
node scripts/run-workspace-library-acceptance.mjs --baseline=94916185
node scripts/run-workspace-library-acceptance.mjs --check
node scripts/run-workspace-projection-recovery.mjs --library
node scripts/run-workspace-projection-recovery.mjs --library --check
pnpm exec vitest run src/renderer/architecture/workspace-library-acceptance.test.ts
```

Both check commands require the current source fingerprint by default. Explicit
`--historical` validates recorded contracts without asserting current-source
coverage; the library read check also retains its measurement-probe hash check.
The eleven report tests accept the recorded contracts and reject omitted
profiles/crash cases, full-body rereads, excess queries/transfers, disagreeing
restarts and unmeasured native or power-loss claims.

The optimization removes repeated transfer of unchanged bodies. SQL still scans
and sorts the library IDs, JavaScript still merges an O(N) array, and initial
load retains all library bodies. The changed path adds one query and one returned
row versus the earlier whole-collection read. Remaining collection work, React
publication, reference indexing and whole-application budgets remain separate.
