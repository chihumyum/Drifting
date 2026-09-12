# Renderer performance work and evidence

The [implementation plan](optimization-plan.md) remains the scope authority.
F0 is **in progress**: the first input-path baseline is available; app-wide,
Agent, graph, reference, multi-tab memory and native/device measurements remain
NOT RUN. This initial input baseline permits the bounded F1 input-path work;
it does not satisfy unrelated phases' baseline requirements.

## Isolated editor baseline

```bash
pnpm perf:renderer
pnpm perf:renderer:check
```

The runner builds an isolated harness with Vite production optimizations and
opens a fresh, disposable headless Chromium profile. Set `DRIFTING_PERF_CHROME`
if Chromium is not in a standard installation location. It does not load the
App, read author databases, import credentials, or touch an existing browser
profile. No harness import is added to the production application entry point.

The three deterministic fixtures contain 5k/20k/50k synthetic Chinese
characters, 0/100/500 entity links and 100/1,000/5,000 synthetic entities. Every
run records a fixture hash, checkout commit plus renderer source fingerprint,
dirty state, CPU/memory/system/browser identity, raw timing samples and explicit
limitations. No usernames, personal paths, browser profile data or author prose
are written into the report. Temporary builds and profiles are removed.

Each fixture warms up with 10 transactions, counts operations across 100
insertions, then samples 60 more transactions over animation frames. The
counter pass is separate from timing, although disabled instrumentation wrappers
remain in both builds for equivalent comparison. All insertions occur outside
the existing link marks. The end document must retain the exact link count and
expected synthetic text length.

`transactionMs` measures synchronous ProseMirror dispatch, not native input.
`transactionToAnimationFrameMs` ends at a requestAnimationFrame callback, not a
compositor paint. Neither metric proves the desktop RC input-to-paint target.
The `subscriptions` field counts direct store subscriptions; the later
`reactSubscriptions` scenarios count actual committed React consumer renders.

Output defaults to ignored `.local-data/renderer-performance/latest.json`.
For a reviewed milestone, use `--output=docs/renderer-performance/acceptance/<name>.json`
and run `pnpm perf:renderer:check --report=<same-path>`. Reports are runner output;
do not hand-edit measurements. A dirty checkout is identified by its source
fingerprint instead of claiming all source was already in its parent commit.

## Fixed first input-path budgets

Before changing production source, the initial baseline recorded the following
work across 100 insertions (see generated [baseline-editor.json](acceptance/baseline-editor.json)):

| Fixture | Full link queries | Color resolutions | Style writes |
| --- | ---: | ---: | ---: |
| 5k characters / no links | 100 | 0 | 0 |
| 20k characters / 100 links | 100 | 10,000 | 10,000 |
| 50k characters / 500 links | 100 | 50,000 | 50,000 |

F1's deterministic budget for this exact unchanged-mark input trace is **zero**
full link queries, target color resolutions and color style writes. New marks
and explicit appearance changes are separate correctness scenarios and must
still acquire the current color. F1 must preserve those behaviors before a
lower counter is considered a success.

For this isolated Chromium fixture on the recorded machine, the preliminary
timing guard is synchronous transaction p95 <=2 ms for the first two profiles
and <=5 ms for the 50k/500-link profile. These are local synthetic regression
budgets fixed before F1, not advertised device capacity or native latency.
Run baseline and candidate in the same environment; if timing fails, repeat
three times and retain every report. Deterministic counters must pass every
time. Other phase budgets remain uncalibrated until their F0 scenarios exist.

## Current verification boundary

The fixture's deterministic data/target integrity is covered by Vitest.
`perf:renderer:check` validates phase dependencies, criterion IDs, evidence
paths, report identity, metric summaries, and final document integrity. A
complete phase requires passed criteria with evidence; the checker never
converts a measured synthetic report into physical-device acceptance.

The initial F0 batch passed typecheck, lint, public/CI contract checks, capability
checks (19 tests), and the full Vitest suite (2,164 passed, 1 skipped). The three
browser scenarios completed with final document integrity validated. These
results cover the baseline harness, not subsequent optimization batches.

## F1 input-path implementation

The first production optimization is implemented. Tiptap already invokes the
mark serializer for new/replaced mark DOM, so ordinary document edits no longer
scan all existing links. External appearance revisions still refresh existing
marks, with no-op CSS writes skipped. Color resolution uses shared weakly held
indexes of immutable collections instead of per-link array searches. No new
transaction-range cache or prose mutation is needed.

Generated [f1-editor.json](acceptance/f1-editor.json) records 13 browser behavior
checks, including HTML paste, undo/redo, changed mark attrs, external appearance
changes and real two-Y.Doc convergence. All six deterministic/timing budget
checks passed. Across 100 unchanged-mark insertions, all three profiles now
produce zero full-link queries, color resolutions and color style writes.
The 50k/500-link fixture's sampled synchronous transaction p95 changed from
about 13.9 ms to 0.3 ms on the recorded machine. This is an isolated synthetic
result, not a native app speedup or input-to-paint measurement.

Validation: focused appearance tests (12 passed), typecheck, lint, full Vitest
(2,167 passed, 1 skipped), public/CI contract, Agent capabilities and conversation
sync checks, and the explicitly configured production renderer build. The
production assets were checked to exclude the harness. The pre-existing large
main chunk remains for F7. Physical IME, native latency and app-wide interaction
remain NOT RUN, so F1 stays `in_progress` with partial acceptance rather than
being declared fully complete.

Reproduce the guarded candidate run with:

```bash
pnpm perf:renderer --assert-input-budget
pnpm perf:renderer:check --report=.local-data/renderer-performance/latest.json
```

## F2a explicit field subscriptions

All 25 audited whole-workspace hook call sites now request only their existing
fields with `useDataStoreFields`. This covers editor views, sidebars, desktop
graphs/timelines, mobile papers/previews/stats and shared hover content. The
helper reads one snapshot and uses Zustand's shallow equality; it does not add
another store, copy domain records, or alter project publication. Model types
used by hover/stats are narrowed to the fields they actually consume.

Generated [f2-subscriptions.json](acceptance/f2-subscriptions.json) compares the
old whole-store hook and the production field helper in mounted React consumers:

| Mounted consumers per group | Whole-store commits / 100 unrelated updates | Field-selected commits | Commits for one relevant update |
| --- | ---: | ---: | ---: |
| 1 | 100 | 0 | 1 |
| 5 | 500 | 0 | 5 |
| 20 | 2,000 | 0 | 20 |

These are isolated consumer measurements, not full-app editor or tab counts.
Changing the requested field keys and reading an atomic multi-field update
also pass. The existing input counters/budgets and 13 link behavior checks
remain passing. A new architecture test prevents whole-workspace hook calls
from returning in product components, features, views, hooks or shells.

Validation: typecheck, six architecture tests, full Vitest (2,168 passed,
1 skipped), lint (no errors; existing warnings), public/CI contract, capabilities,
conversation-sync checks and a production renderer build. Shared name/color
invalidation, record reference reuse and app-wide measurements are still pending;
this completes the F2a batch, not all F2 acceptance.
