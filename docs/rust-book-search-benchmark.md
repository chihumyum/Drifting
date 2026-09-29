# Rust reuse experiment: whole-book find

This evaluates reuse of `drifting_document::native_search_ranges` in Tauri's
whole-book find (`collectBookMatches`). It is separate from global-search SQL
prefiltering and Agent evidence ranking. It does not replace live Yjs, change
search behavior, resume Apple migration or ship a new search implementation.

## Reproduce

```sh
pnpm exec node --expose-gc --conditions=import --import=tsx scripts/benchmark-rust-book-search.ts
pnpm exec node --expose-gc --conditions=import --import=tsx scripts/benchmark-rust-book-search.ts --check
# --quick writes an ignored smoke report instead of acceptance evidence.
```

The [generated report](acceptance/rust-book-search-benchmark.json) contains all
samples, exact source/binary/lock fingerprints, environment, traffic and
compatibility examples. Temporary crates, logs and executables remain under
ignored local-data directories. Fixtures contain synthetic text; no library,
database, account or UI is opened.

## Measured decision, 2026-09-30

Keep the JS implementation. The existing Rust kernel plus the adapter has no
speed advantage in any of the 12 workloads, including internal computation
without transport. Even the favorable resident end-to-end path is 3.3–12.3 times
slower. Transferring documents per query is 4.9–14.1 times slower. These results
reject this reuse candidate; they do not rule out a different index or worker
architecture.

Apple M3 Pro, Node 24.19.0, Rust 1.96.0. Seven-repeat medians in milliseconds:

| Bodies × UTF-16 units | Query | JS | Rust compute | Resident Rust | Rust with transfer |
| --- | --- | ---: | ---: | ---: | ---: |
| 20 × 5,000 | dense-case-insensitive | 0.83 | 3.00 | 7.12 | 7.56 |
| 20 × 5,000 | rare | 0.39 | 1.66 | 1.81 | 2.40 |
| 20 × 5,000 | absent | 0.39 | 1.72 | 1.85 | 2.29 |
| 200 × 5,000 | dense-case-insensitive | 7.20 | 25.24 | 66.48 | 72.89 |
| 200 × 5,000 | rare | 3.34 | 12.88 | 13.25 | 19.51 |
| 200 × 5,000 | absent | 3.54 | 12.72 | 12.87 | 19.74 |
| 1,000 × 5,000 | dense-case-insensitive | 39.37 | 126.80 | 350.09 | 388.36 |
| 1,000 × 5,000 | rare | 16.51 | 63.33 | 64.51 | 97.67 |
| 1,000 × 5,000 | absent | 16.49 | 65.08 | 65.27 | 101.76 |
| 5 × 200,000 | dense-case-insensitive | 6.67 | 28.98 | 81.80 | 93.77 |
| 5 × 200,000 | rare | 3.72 | 14.50 | 14.77 | 21.68 |
| 5 × 200,000 | absent | 4.30 | 13.82 | 14.23 | 20.97 |

Every timed result agrees exactly. Six of ten separate compatibility probes also
agree, including emoji and excerpts that split a surrogate. Four differ:

- Native search trims the query; book find treats surrounding/whitespace-only
  queries literally.
- Native scalar lowercase does not apply JS's contextual Greek final sigma rule.
- Native ranges map lowercase expansions back to original UTF-16 positions;
  the existing JS path uses positions in the lowercased string, which differ
  after characters such as `İ`.

Some differences concern existing JS behavior rather than a Rust defect. They
still prevent an invisible performance-only substitution. Neither the search
kernel nor product code is changed by this experiment.

## Measurement contract

The JS lane calls the production `collectBookMatches`. The Rust lane calls the
existing native literal-search kernel, wrapped by a benchmark-only adapter for
the same chapter order, title/summary/body traversal, outermost block IDs,
occurrence ordinals and UTF-16 excerpts. It does not substitute native-editor
preview conventions or charge Rust for Yrs hydration/relative-position anchors.
Both sides parse each body's JSON and return complete matches on each query.
Typed Rust result structs avoid a dynamic JSON map for every hit. The JS wire
adapter mutates only excerpts containing a lone surrogate, preserving
JavaScript substring semantics without copying every result object.

The benchmark separates:

- the JS service call;
- Rust computation alone, excluding request parsing and output serialization;
- a favorable resident Rust scenario, with all source JSON loaded beforehand;
- a Rust request that sends the complete document set on every search.

The resident scenario does not implement a production cache's lifecycle or
invalidation. Its setup cost is recorded separately. JSON-lines transport uses
linear chunk framing so large result sets do not incur repeated scans of the
accumulated response. This is still a pipe benchmark, not real Tauri IPC.

Four book sizes cover dense case-insensitive matches, rare matches and no
matches. Three warmup triples are discarded, then seven measured triples
alternate ordering. Node GC is outside each timing interval. Every timed result
must match the JS result, including all excerpts and offsets. Ten separate
compatibility probes cover Unicode, whitespace, literal punctuation and a
surrogate split at an excerpt boundary.

This measures Node/V8 and Release Rust on one machine. It excludes database
loading, WKWebView/JSC, painting, DOM highlights, scrolling, cancellation and
input latency. It cannot establish whether moving work off the renderer improves
responsiveness, and cannot support a claim that Rust generally performs worse.
