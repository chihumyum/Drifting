# Agent message summary ownership

Desktop usage and mobile evidence now consume one per-view summary of the
existing immutable message blocks. Unchanged blocks reuse message classification
and usage results when their incoming totals match. Changed preceding usage
replays the later usage values in their original order; block subtotal addition
is deliberately avoided because floating-point regrouping can change cost.
Old summaries remain immutable and no cache entry retains an earlier projection.

Only message facts are cached. Mobile evidence still resolves successful tools
against current workspace data on every canonical display update, including a
new transcript identity whose message blocks are unchanged. The 32-result
limit, deduplication, order and current target navigation remain unchanged.
This does not add a workspace entity-resolution cache or change runtime state.

`acceptance/f4-transcript-summary.json` compares the actual desktop/mobile
components with commit `44bdb498043d17991fe4e4d3528afe009d34d932`. Six synthetic
profiles cover 300/3,000/10,000 historical messages containing assistant, tool
and usage rows, each followed by twenty visible tail updates. For 10,000 rows:

| Work across 20 updates | Before | After |
| --- | ---: | ---: |
| Desktop usage candidates | 200,020 | 20 |
| Mobile evidence candidates | 200,020 | 1,960 |
| New classification visits, each view | 0 | 340 |
| New summary block visits, each view | 0 | 3,140 |

Existing message comparisons (340), block-leaf visits (6,260) and complete-array
materializations (zero) remain unchanged. Total work is not constant: block
traversal, eligible tool resolution and full mounted DOM still scale with
history. Historical edits can replay affected usage suffixes. Timings are stored
as diagnostic samples with instrumentation and uncontrolled machine load;
neither fixed-device latency nor retained-heap acceptance is claimed.

Each profile checks history DOM/selection, tool expansion, final text, immutable
snapshots, rebuilt blocks, historical tools, usage/output controls and current
mobile evidence navigation. Six summary tests additionally check original
arithmetic (including non-associative values), independent views, old results,
empty/reset behavior and 800 seeded mixed updates. The report includes these
and existing block/mobile model tests (16 total). Eleven report-contract cases
reject missing or inflated coverage, changed usage/footer, stale targets and
unsupported device claims.

Reproduction:

```bash
node scripts/run-renderer-transcript-summary.mjs
node scripts/run-renderer-transcript-summary.mjs --check
node scripts/run-renderer-performance.mjs --ci --output=docs/renderer-performance/acceptance/f4-transcript-summary-regression.json
```

The companion report reruns the established combined headless renderer
contracts. Reports retain their actual pre-commit SHA and source fingerprint.
Historical-only validation does not assert current source. Per the maintainer's
current direction, simulator, physical device and native-window acceptance are
left to manual testing.
