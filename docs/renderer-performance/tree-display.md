# Agent transcript tree display

Desktop and mobile transcript views now read the coalesced immutable tree
snapshot directly. The display scheduler publishes its identity without
materializing a message array. Its existing array API remains an explicit,
cached compatibility boundary; both APIs share the same subscription and
control, conversation, visibility and teardown fences.

The per-view block projection compares immutable 32-message leaf identities
before inspecting individual rows. It keeps the existing 64-message groups and
React keys, with at most one previous projection per mounted view. Rebuilt
hydration trees, array callers and nonmonotonic snapshots fall back to row
identity comparisons, so an abandoned render cannot become an authority for
conversation state. Historical DOM, text selection and expanded tool details
remain mounted. This does not add DOM windowing.

Usage totals and mobile evidence still traverse the messages in their original
order. The tree iterator descends once per leaf and yields rows sequentially;
it does not construct a complete array or recursively delegate each row through
every tree level. No aggregate regrouping changes floating-point addition or
evidence ordering. Persistence and idle turn-reference reads retain their
existing array boundaries. Mobile voice and other legacy array consumers can
still materialize a full array.

## Reproduction and evidence

```bash
node scripts/run-renderer-transcript-display.mjs
node scripts/run-renderer-transcript-display.mjs --check
node scripts/run-renderer-performance.mjs --ci --output=docs/renderer-performance/acceptance/f4-tree-display-regression.json
node scripts/check-renderer-performance.mjs --deterministic --current --report=docs/renderer-performance/acceptance/f4-tree-display-regression.json
```

`acceptance/f4-tree-display.json` builds the actual desktop and mobile views on
the exact `c355d6cfff6e48932cd60d51aff186401bd094f9` baseline and candidate
checkouts with an identical synthetic harness. Each of the six profiles mounts
all history, then applies 20 synchronous visible tail updates. Measurement
deliberately excludes journal ingress and frame batching. All nine continuity
checks per profile must pass, including rebuilt snapshots, an old tool result
changing in place and a completed answer with usage/output controls.

| History rows | Complete arrays, before → after | Flattened rows, before → after | Message identity comparisons, before → after | Block leaf visits after |
| ---: | ---: | ---: | ---: | ---: |
| 300 | 20 → 0 | 6,020 → 0 | 6,020 → 900 | 200 |
| 3,000 | 20 → 0 | 60,020 → 0 | 60,020 → 1,140 | 1,880 |
| 10,000 | 20 → 0 | 200,020 → 0 | 200,020 → 340 | 6,260 |

These deterministic counts apply separately to desktop and mobile. A streaming
tail adds one message to each history. Leaf/group traversal remains
O(history / 32), and usage/evidence traversal and full mounted DOM still scale
with history. Timings include injected counters and React/layout work on a
shared machine; they are diagnostic samples, not fixed-device or full-app
latency/heap acceptance.

| View / history | Median update ms, before → after | p95 update ms, before → after |
| --- | ---: | ---: |
| Desktop / 300 | 0.25 → 0.20 | 0.90 → 0.80 |
| Desktop / 3,000 | 0.90 → 0.90 | 1.30 → 1.20 |
| Desktop / 10,000 | 2.80 → 2.65 | 3.50 → 3.40 |
| Mobile / 300 | 0.20 → 0.15 | 0.30 → 0.30 |
| Mobile / 3,000 | 0.90 → 0.90 | 1.10 → 1.10 |
| Mobile / 10,000 | 5.50 → 3.60 | 8.50 → 5.00 |

These are the 20 stored samples per profile, rounded to two decimal places;
p95 uses the nearest-rank sample. Some profiles show unchanged medians. The
before/after browser measurement runs sequentially; normal desktop activity
and machine load are uncontrolled. The deterministic allocation/comparison
reduction is the acceptance target, not a general latency improvement claim.

`acceptance/f4-tree-display-regression.json` reruns the existing combined
headless renderer scenarios, including actual journal ingestion, cancellation,
permissions, terminal delivery, background timer/foreground flush behavior,
desktop history continuity and mobile output ownership. Background timer
publication now requires zero complete arrays; the later explicit legacy read
still returns the entire canonical display. Historical reports without this
tree-publication version retain their original assertion when validated without
the current deterministic contract.

Both reports retain their real pre-commit SHA and source fingerprint. Ordinary
checks assert current source identity; `--historical` on the dedicated runner
only validates recorded evidence and explicitly makes no current-source claim.
All fixtures are synthetic. No native windows, physical focus/input, live
provider or device acceptance is performed. F4 remains in progress.

Validation also includes all six repository checks and renderer architecture:
2,950 tests passed with one existing skip across 435 files; lint reports zero
errors and 30 existing warnings. The ordinary production build has 45 JS assets
and contains no acceptance probes. Regenerated conversation-sync evidence has
60 renderer and 108 Rust library/database checks, followed by the contract
check. The generator's Rust checks run without a desktop window; its physical
gate remains `not-run`.
