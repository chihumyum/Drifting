# Shelf statistics read model

`useProject` delegates statistics to `sqlite-repo/project-stats-repo.ts`.
One SQLite statement returns one aggregate row for a project. The statement
counts live nodes and their storyline memberships, chapters' canonical words,
storylines, elements, categories, relations and mentions. The renderer no longer
receives the node/entity inventories solely to calculate lengths, nor constructs
one SQL parameter per node. All counts in that statement share SQLite's read
snapshot. There is no persisted cache or new migration.

The use case keeps its existing shelf lifecycle: initialize the authenticated
user's database, fetch that user's projects, read summaries, await any required
prose-metric reconciliation with two workers, then re-read and publish. Summary
reads now have at most four workers within one load. This is not a cross-request
scheduler and does not cancel another shelf load. Equal-date ordering and the
final updated-date sort are preserved. A failed statistics query still rejects;
failed per-project reconciliation still leaves that project's words pending.

Only live chapters contribute words. A seed with the canonical hash is ready;
a nonempty non-seed basis also needs a revision or server sequence (zero is
valid). Unknown nonempty basis kinds keep the existing behavior. Empty projects
and projects with only nonchapter nodes are ready. The SQL hash predicate is
checked against the portable `isProseMetricBasisHash` contract across 84 basis/
hash combinations, including case, truncation, invalid hex, newline, Unicode
and embedded NUL. Changes to the portable format require updating this read
predicate and its compatibility test together. Yjs remains prose authority.

## Reproduction and evidence

```sh
node --conditions=import --import=tsx scripts/measure-shelf-stats.ts
node --conditions=import --import=tsx scripts/measure-shelf-stats.ts --check
pnpm exec vitest run src/renderer/sqlite-repo/project-stats-repo.integration.test.ts src/renderer/usecase/useProject-shelf.integration.test.ts src/renderer/architecture/shelf-stats.acceptance.test.ts
```

`acceptance/f2-shelf-stats.json` comes from temporary, synthetic, file-backed
WAL/FULL SQLite with all published product migrations. The collector retrieves
the exact old `buildLocalProjectStats` function from `880d8963`, strips its
TypeScript syntax, and executes it against the same gateway and fixture as the
new repository. Its source hash is recorded. Each 100 / 1,000 / 5,000-node
profile excludes paired warmups and records five alternating measurements.
Results must match exactly; structural bounds, rather than elapsed-time wins,
are enforced. The 40,000-node scenario verifies the constant result and parameter
bounds. The original implementation exceeds this Node SQLite build's variable
limit there; no corresponding native limit is inferred.

The 5,000-node read changes from seven statements and 5,006 returned rows to
one statement and one row. Decoded result-row JSON changes from 608,964 to 28
bytes. This excludes column metadata and native wire tags. SQL still visits
project rows; constant output size does not imply constant CPU. The query plan
is retained, including existing full scans for storylines and elements. Schema
index work is separate and would require a new immutable migration.

Median query-path times on the recorded Node SQLite host were:

| Nodes | Historical path | Aggregate path |
| --- | ---: | ---: |
| 100 | 0.639 ms | 0.509 ms |
| 1,000 | 2.606 ms | 2.818 ms |
| 5,000 | 11.113 ms | 13.250 ms |

The local SQL timings are descriptive and can regress: evaluating the hash
predicate in SQLite adds work relative to the former JavaScript filter. This
batch does not establish a startup speedup. A native control was attempted using the [repeated Release protocol](native-startup.md); it did not produce a passing report. The original baseline is retained. These controls do not qualify physical IME, a signed RC,
fixed M1/8 GB budgets, cold filesystem behavior or the complete device matrix.

## Native attempt and acceptance limit

The fresh unsigned Release `Drifting Startup 7f89f43f4f51.app`
(binary SHA-256 `a0a579a972bf888bec1eaec3c84c6effd178fbee5a3e9fef14bb1506940e1745`)
was rejected at shelf readiness with `OS launch did not foreground the application`.
An earlier incomplete series was rejected by the source fingerprint guard after
formatting changed during collection. Neither attempt generated a passing report.

A diagnostic collector that awaited focus for 30 seconds also failed
(`Startup timed out: native foreground focus`, binary SHA-256
`753d2dbdf997987f6fc5dc1cfbf73f9f8decf67b71f0c6835b9fb25d606c6574`).
The console was subsequently observed unlocked; the cause is unresolved. That
experimental collector change was reverted. No timing from these attempts enters
the aggregate report, and no startup regression or improvement is asserted.
The automated SQLite/read-model milestone can be accepted independently; native
startup acceptance remains open.
