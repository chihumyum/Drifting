# Agent prose read performance

The certified prose read under `read_chapter` captures a freshness basis,
dispatches the actual prose read, captures the basis again and persists the
verified result/observations. These checks protect later writes and stay intact.

Previously, both basis captures eagerly read `contentJson` and constructed a
complete Yjs seed before asking the persistence coordinator for authoritative
state. A durable or live Yjs document discarded that seed. Seed construction
includes block normalization, schema conversion, two temporary documents,
hashing and update encoding; repeating it for every tool read is avoidable.

The basis reader now supplies a lazy seed resolver. The coordinator invokes it
only after the same capture transaction proves that durable state is absent
and the revision is zero. Node seed projection reads use that transaction's
executor. Live capture still flushes and verifies its basis twice. A corrupt
nonzero empty revision still fails before any fallback, and resolver failures
release the transaction. The existing byte-seed API used by writes is unchanged.

This is a renderer optimization using the existing shared Rust database. It
does not replace Yjs, the Agent runtime, its provider-neutral transport or write
protocol with native migration code.

## Reproduce and measurement scope

```sh
pnpm exec node --expose-gc --conditions=import --import=tsx scripts/benchmark-agent-prose-reads.ts
pnpm exec node --expose-gc --conditions=import --import=tsx scripts/benchmark-agent-prose-reads.ts --check
```

`--quick` writes an ignored smoke report. `--baseline=<commit>` and
`--output=<path>` support subsequent paired batches. The runner freezes both
the baseline read-runtime and coordinator modules; imported dependencies are
shared with the current checkout. The [generated report](../acceptance/agent-prose-read-benchmark.json)
stores all samples and source/binary/lock fingerprints.

Both lanes run the production certified `read_node` operation underneath the
public `read_chapter` wrapper, including both freshness checks, real dispatch,
word counting/formatting, result budgets, durable paging artifacts and SQLite
read receipts. Synthetic plain and overlapping-mark documents cover short,
long and very long bodies, with a snapshot and eight tail updates. A seed-only
case measures the fallback cost. Every sample uses fresh identical database
copies and distinct tool-call identities so it cannot replay earlier receipts.

Two warmup pairs precede seven measured pairs with alternating order. Node GC
is outside timing; OS caches are not flushed. JSON-lines transport uses linear
line framing. Every returned result and complete database row set must agree;
all tables except read-receipt/observation/result-artifact tables must remain
unchanged. Foreign-key and integrity checks are outside timing.

These are Node/V8 + Release Rust service measurements. Node uses the production
hydration client's inline fallback, so they do not measure the browser worker,
WKWebView, actual Tauri IPC, the public domain wrapper, provider inference, the
whole turn journal or user-perceived Agent completion time. Five focused
coordinator cases additionally cover lazy seed equality/transaction scope,
durable bypass, live flushes, corrupt state and rollback after resolver failure.

## Measured lazy-seed batch, 2026-09-30

Keep the lazy-seed change. On Apple M3 Pro, Node 24.19.0 and Rust 1.96.0,
all seven paired samples are faster for each durable-document workload.
Median service times below include the entire listed batch of distinct reads:

| Body UTF-16 units | Reads | Baseline ms | Lazy seed ms | Improvement | Gateway requests |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5,000, durable | 20 | 216.55 | 161.43 | 25.45% | 560 → 520 |
| 50,000, durable | 10 | 645.56 | 529.06 | 18.05% | 360 → 340 |
| 200,000, durable | 5 | 1,119.52 | 923.68 | 17.49% | 180 → 170 |
| 5,000, seed only | 20 | 172.39 | 183.82 | -6.63% | 520 → 520 |

The fallback case is a measured tradeoff: about 0.57 ms slower per seed-only
read in this run. It performs the same queries and must still build the seed;
construction now happens inside the capture transaction. This batch targets
existing durable prose, and does not claim every input is faster. Exact results,
all durable rows and unchanged authoritative state pass in every pair.

Validation: 45 focused tests and the complete 3,132-test suite pass (one
pre-existing skipped test). Lint has zero errors and 70 existing warnings;
type checks, public boundary, CI contract, generated capability checks and the
source-matched benchmark verifier also pass.

## Other Agent candidates

- Cold `search_prose`: materialization still loops over uncached documents one
  at a time. The existing revision-based LRU and normalized-text cache already
  handle warm searches. Measure bounded snapshot/tail reads on cold and partly
  invalidated corpora, including live-document fallback; do not claim that all
  searches currently reload everything.
- Further prose basis work: the full-state update returned by `readBase` is not
  used by the freshness reader. Any narrower read API must preserve hash/vector
  semantics and the live capture boundary. Removing copies alone needs its own
  measurement before adding another interface.
- Native closed-document operations: shared Yrs can be evaluated for a complete
  read/merge/derive operation that keeps binary data in Rust. Existing native
  projection JSON/hash differences prevent a transparent substitution today.
- Runtime streaming already coalesces thinking fragments before journaling,
  and checkpoints use a digest format. Those existing optimizations must be
  accounted for before proposing generic event batching or history rewrites.

The renderer remains the Agent protocol owner. No real provider, account,
manuscript, Apple acceptance run or private service is involved.
