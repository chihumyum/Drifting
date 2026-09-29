# Rust reuse experiment: whole-project prose metrics

This is a Tauri backend experiment. It does not resume the Apple UI migration
or refresh its archived acceptance reports. Production reconciliation remains
in `node-prose-metrics.service.ts`.

## Reproduce

```sh
pnpm perf:prose-metrics          # Release build, warmup, five measured repetitions
pnpm perf:prose-metrics:check    # Check source fingerprint and report structure
pnpm perf:prose-metrics --quick # Four-node smoke run; writes only ignored evidence
```

The generated [report](acceptance/prose-metrics-benchmark.json) contains every
measured sample, source and binary hashes, dependency-lock hash, runtime and
SQLite configuration, compatibility cases and the integration decision.
Scratch sources, logs, databases and binaries live in the ignored
`.local-data/prose-metrics-benchmark/` directory. All prose is synthetic; the
runner creates a fresh directory and never opens the author's library.

## Initial measured result, 2026-09-30

The initial results below are preserved at commit `da38cba3`. As the renderer is
optimized, new runs update the generated report; the paired before/after results
and current decisions live in [performance batches](prose-metrics-performance-batches.md).

Apple M3 Pro, 36 GiB, macOS kernel 27.0.0, Node 24.19.0, Rust 1.96.0,
SQLite 3.46.0. Median elapsed milliseconds across five repetitions:

| Bodies × initial UTF-16 text units | TS first | Rust first | TS repeat | Rust repeat |
| --- | ---: | ---: | ---: | ---: |
| 20 × 5,000 | 116.7 | 27.9 | 94.6 | 23.9 |
| 200 × 5,000 | 970.9 | 274.0 | 715.7 | 232.7 |
| 1,000 × 5,000 | 4,782.1 | 1,384.3 | 3,338.8 | 1,182.1 |
| 20 × 50,000 | 485.5 | 346.5 | 429.5 | 337.6 |
| 5 × 200,000 | 451.0 | 332.4 | 403.0 | 326.6 |

At 200 bodies, database gateway requests fall from 3,601 to 2,201. Transport
calls fall from 3,601 to one; native still executes its internal database
requests. At 1,000 bodies the corresponding request counts are 18,001 and
11,001. The renderer lane transfers roughly 101 MB of JSON-lines requests and
responses at that size, including repeated bodies and binary arrays. The Rust
lane returns only completion/failures; returning UI rows is outside this
SQLite-only measurement. The larger advantage with many short bodies supports
investigating batching and data movement, rather than attributing all gains to
the language.

Word counts and durable revisions match for every timed node; the stable-ID
outlines also match. Repeat rebuilds produce zero SQLite row changes on both
lanes. All checked non-projection data remains unchanged. Nevertheless, every
timed node's body cache differs, and overlapping-mark nodes also differ in basis
hash. Returning to the renderer rewrites those projections back exactly.

Of 24 compatibility cases, all counts agree, 13 body byte strings differ, eight
basis hashes differ, and one case differs in its generated outline IDs. Native
also leaves the two deliberately uncounted seed-only nodes unchanged, while the
renderer establishes their seed counts. These are reasons to reject a direct
replacement, not evidence of lost authoritative prose.

The experiment establishes a useful backend optimization opportunity, with
integration still open. Prefer a bounded batch read/write interface and exact
Tauri projection semantics; keeping the existing JS Yjs projector in a worker
is also a candidate to measure. Do not broaden this into replacing the live
editor owner merely to obtain the measured batching benefit.

## What is measured

The renderer lane calls the production `reconcileProjectProseMetrics` with
`publishToDataStore: false`, its four workers, repositories, Drizzle proxy and
database wire codec. The Rust lane calls the existing
`drifting_prose::workspace::reconcile_node_projections`. Both use the same
Release-built `DatabaseGateway` and SQLite implementation, with the production
WAL/NORMAL configuration. The database is initialized by the real migration
gateway; synthetic rows are then seeded outside the measured interval.

The only gateway modification is a relaxed atomic request counter in a scratch
source copy. It counts queries, executions and transaction requests, not
trigger-internal SQLite statements. The report separately records transport
calls and bytes, changed projection rows, and SQLite's `total_changes()` delta
(including triggers). Startup, migrations, fixture generation, inspection and
Node GC happen outside each timing interval.

Each scenario contains chapters and drifts, CJK/Latin text, emoji, combining
characters, headings with stable IDs, and plain/overlapping-mark variants.
Every body has a snapshot plus an ordered update tail, so its initial JSON cache
is stale. Workloads cover 20, 200 and 1,000 bodies of 5,000 UTF-16 text units;
20 bodies of 50,000; and five bodies of 200,000. Length excludes heading/paragraph
separators and the later update tail; it is not the product's word count.

The lanes alternate order. One warmup per scenario is excluded. Five first
rebuilds use fresh identical database copies; five repeat rebuilds use their
already-reconciled owners. OS file caches are not flushed. Each lane must leave
all prose, revisions, journal rows, domain metadata and recency unchanged. Only
count/basis/body/outline projections and their projection-journal triggers may
change. Every repeat must issue zero SQLite row changes. A renderer rebuild
after Rust must return exactly to the renderer's original projection.

## Compatibility and acceptance boundary

The existing 24-case synthetic projection corpus is reused as input without
running or modifying Apple acceptance. It includes editor attributes, later and
concurrent formatting, unusual Unicode, marks and headings without IDs.
The benchmark compares word counts, JSON bytes, JSON objects, basis hashes and
outline bytes independently. It does not normalize mark order or generated
heading IDs into an apparent pass. A separate seed-only database verifies
whether each reconciler handles prose that has no durable Yjs state yet.

This is a Node/V8 plus JSON-lines service benchmark. Pipes substitute for Tauri
IPC, and a small request pool permits transaction commits while other requests
wait. It does **not** measure WKWebView/JSC, visible stalls, paint, physical
input, cold application startup, unsaved live documents, concurrent editing or
crash recovery. Ratios combine batching, different service work and algorithms;
they cannot be attributed solely to Rust or advertised as product speedups.

The implementation is not a drop-in replacement if cache/basis behavior differs
or seed-only nodes remain uncounted. A later integration should preserve Tauri's
projection contract and live-document owner, then benchmark an isolated actual
Tauri build before claiming user-visible gains. Adding the experiment itself
does not change a published migration, Rust library, product route or editor.
