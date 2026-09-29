# Tauri prose metric performance batches

The Tauri client remains active. These batches reuse the extracted Rust SQLite
gateway while retaining JavaScript's exact Yjs/ProseMirror projection semantics.
They do not resume Apple UI migration or refresh archived native acceptance.

## Batch 1: bounded closed-document reads

Reconciliation reads at most 16 closed documents' snapshots, ordered update
tails and revisions in one SQLite transaction. Four workers derive projections
from those captured documents without constructing a redundant seed, hashing a
command-preparation state, encoding that state again, or rehydrating a second
document. The same projector still owns counts, JSON, semantic hashes and
outlines. Projection writes retain their per-document revision CAS.

Live documents retain the existing flush/capture lifecycle; a document opened
during batch capture falls back to it. Empty durable state retains seed-only and
corrupt-revision handling. Revision changes trigger a fresh capture, including
when an existing projection would otherwise be reused. Only a bounded group of
document blobs is retained at a time (the bound is a document count, not bytes).

The file-backed regression suite covers formatted Unicode prose, snapshot plus
ordered noncontiguous update IDs, chapter/drift nodes, batch boundaries, exact
projection parity, unchanged authoritative data and timestamps, write-free
repeat reconciliation, seeds, corrupt revisions, live flushes, revisions that
change after prefetch and documents opened after prefetch.

Five-repeat medians on Apple M3 Pro / Node 24.19.0 / Rust 1.96.0, milliseconds:

| Bodies × UTF-16 units | Before first | Batch 1 first | Before repeat | Batch 1 repeat |
| --- | ---: | ---: | ---: | ---: |
| 20 × 5,000 | 111.0 | 63.0 | 82.8 | 33.4 |
| 200 × 5,000 | 943.3 | 521.2 | 685.2 | 277.7 |
| 1,000 × 5,000 | 4,517.1 | 2,542.3 | 3,249.4 | 1,297.9 |
| 20 × 50,000 | 464.4 | 261.6 | 420.7 | 210.1 |
| 5 × 200,000 | 432.8 | 243.9 | 394.8 | 214.4 |

First rebuild time drops 43–45%; repeat time drops 46–60%. The paired
[machine-readable report](acceptance/prose-metrics-batch-1.json) requires exact
projection equality in every sample; all pairs pass. This is accepted as a
service optimization, subject to the platform limitations below.

```sh
pnpm exec vitest run src/renderer/services/node-prose-metrics-batch.integration.test.ts
pnpm perf:prose-metrics:batch --baseline=da38cba3 --output=docs/acceptance/prose-metrics-batch-1.json
pnpm perf:prose-metrics:batch --baseline=da38cba3 --output=docs/acceptance/prose-metrics-batch-1.json --check
```

## Measurement contract

The paired runner loads the original service source blob from the specified Git
commit into an ignored temporary directory, rewriting only import locations.
Both implementations share dependency instances, including the database owner,
repositories, Yjs runtime and stores. This is a frozen **service** comparison,
not a separately installed historical dependency tree; review dependency
changes before interpreting each result. Batch 1 only adds a new bounded-read
repository API; the old repository methods are unchanged.

Both lanes use the same Release-built shared Rust `DatabaseGateway`, real
migrations, WAL/NORMAL SQLite, wire codec and JSON-lines transport. Fixtures are
synthetic. Each scenario uses an excluded warmup and five alternating paired
measurements. First rebuilds use identical fresh database copies; repeats reuse
their owners. Every pair must match all projection fields byte-for-byte, leave
all non-projection state unchanged and produce no SQLite row changes on repeat.
Seed-only projections are also compared. Raw samples, traffic, source and
binary hashes are generated into the acceptance report.

These are Node/V8 service measurements. They do not measure WKWebView/JSC,
actual Tauri IPC, physical input, paint or cold product startup. They establish
reduced service work, not a claimed user-visible speedup or native UI acceptance.
