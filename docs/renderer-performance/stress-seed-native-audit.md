# Heavy-seed native UI audit

## Current acceptance state

The unlocked-desktop continuation on 2026-10-29 exercised the current isolated
Debug app with the real stress library. The [native findings and coverage](stress-seed-native-findings-2026-10-29.md)
record writing, relations, Review, 25 tabs, all three Super Views, search,
materials, settings and a normal quit/restart. A one-second renderer stall was
confirmed by the native watchdog. This is a diagnostic run with explicit gaps,
not complete product acceptance or a release performance budget.

The generated [observation report](acceptance/stress-seed-native-audit.json)
contains the captured source fingerprint and binary hash, 937 document-visible
buckets, 916 comparable buckets and 328 input-to-second-rAF observations.
The [read-only persistence report](acceptance/stress-seed-native-persistence.json)
checks four canonical Yjs markers, word caches, Review/relations, material title,
working memory and SQLite integrity after the native quit/restart.
The report's `observations-only-coverage-must-be-reviewed` status is deliberate:
measurements alone do not certify a journey.

The earlier [Node diagnostic record](stress-seed-audit-findings-2026-10-29.md)
and [Node evidence](acceptance/stress-seed-node-diagnostic.json) remain separate
CPU/retention/domain evidence. In particular, they cover 600-round recovery,
while native transcript interaction is still blocked by the unconfigured-Key
panel guard. No paid model call was made.

## Opt-in collection

Seed once, then launch with the normal isolated worktree launcher:

```bash
pnpm dev:seed --instance stress-native-audit --no-watch --performance-audit
# Subsequent launches reuse this same synthetic library:
pnpm dev:worktree --instance stress-native-audit --no-watch --performance-audit
pnpm dev:worktree --instance stress-native-audit --print-config
```

`performanceAuditDirectory` in the manifest names the private telemetry folder.
Use that path as `$audit_dir` below. The collector only listens through the
loopback Vite server; its fresh per-launch bearer token stays in a mode-0600
`control.json`. Never commit that file, raw process output, databases, absolute
paths or screenshots containing anything other than this synthetic fixture.
Ordinary development does not install the probe. Packaged builds reject this
Vite-only option, and the native process-info command is compiled only for
Debug desktop builds.

```bash
node scripts/native-performance-audit.mjs "$audit_dir" status
node scripts/native-performance-audit.mjs "$audit_dir" mark chapter-long-write-1
node scripts/native-performance-process-sampler.mjs "$audit_dir"
node scripts/native-performance-audit.mjs "$audit_dir" summarize docs/renderer-performance/acceptance/stress-seed-native-audit.json
# After the documented synthetic UI writes and a normal quit/restart:
node --conditions=import --import=tsx scripts/verify-stress-native-session.ts "$profile_dir" docs/renderer-performance/acceptance/stress-seed-native-persistence.json
```

`mark` only labels a measurement interval; it never changes the App. Perform
all acceptance interactions in the current native app through Computer Use,
verify the resulting visible state, and record the operation/sequence and
outcome here. A two-second sample crossing a marker boundary can contain work
from the previous operation. The summarizer excludes those buckets from latency,
Fiber timing and function-counter comparisons. It also requires
`browserVisible: true`; DOM focus alone never makes a hidden bucket eligible. Stop the app and relaunch after changing any observed source;
`source.json` describes the source present at server start. Summaries exclude
raw samples from earlier server launches in the same profile.

When automation needs a registered `.app`, bundle the freshly built Debug
binary with the same generated configuration and profile environment. Preserve
`DRIFTING_DB_DIR` on launch, verify the database actually opened, sign with the
normal development identity, and register its exact owned executable:

```bash
node scripts/native-performance-audit.mjs "$audit_dir" artifact "$owned_debug_binary"
```

The command rejects paths outside the profile's Cargo target. Do not use an old
installed bundle as a substitute. If a window has DOM focus but remains hidden,
use its native Window menu to move it onto the active display before measuring.
The 2026-10-29 run needed this step; the hidden portion remains in raw evidence
and is excluded from comparable interaction metrics.

The process sampler obtains both PIDs from that app's development watchdog and
verifies executable identity before sampling. It records only the owned native
process and its WKWebView content process, including RSS and `ps` CPU percent.
Stop it with Ctrl-C at the end of a run; restart it after relaunching Vite,
which rotates the bearer token. Do not combine samples from unrelated WebViews.

## What the measurements mean

- Frame callback intervals, 250 ms timer lateness, and input to a second rAF
  expose scheduling gaps. They do not measure compositor presentation or prove
  a specific number of visible frames per second. Hidden-page timer/frame
  results are excluded from latency summaries.
- A React root Profiler records `actualDuration`; this is render-phase work,
  not the entire commit/layout/paint. The probe chains the existing development
  DevTools hook for per-component render-phase self time. Function-entry counters
  are separate and include Strict Mode double invocation. Top components are
  retained per two-second sample. Reused
  Fiber subtrees are excluded using their render start timestamps. Fiber-walk
  and DOM-snapshot costs are recorded separately, but these are not the total
  probe overhead. Do not translate Strict Mode timings into release budgets.
- DOM element/editor counts and mutation counts can reveal retained editors or
  expensive updates. A mutation is neither a repaint nor a forced layout.
  Confirm layout, paint, GC or script hypotheses with native stack samples or
  an attended Web Inspector timeline before calling them measured causes.
- Observed SDK `invoke` calls provide IPC counts, completion durations and
  returned row/string sizes without arguments or result text. Raw bridge calls
  and the watchdog process probe are outside that wrapper. Durations include scheduling
  and delivery; they do not isolate SQLite execution time.
- OS RSS includes resident process memory, not just JavaScript heap or physical
  footprint. An elevated post-close value alone does not establish a leak;
  compare repeated equal workloads after idle, resource counts, heap/GC evidence
  and the process lifecycle. WebKit may not expose `longtask` entries; the report
  includes supported entry types and never interprets unsupported as zero cost.
- Error counts omit error messages, stacks, input text and manuscript contents.
  Investigate an error through local diagnostics without publishing private data.

The existing [one-second stall watchdog](dev-stall-watchdog.md) continues to run
and keeps its automatic native WebContent stack samples. No artificial stall
is needed for this audit. Avoid competing builds, seed import or other profiling
work while measuring. Record any unavoidable external CPU pressure.

## Coverage and remaining work

The [native coverage table](stress-seed-native-findings-2026-10-29.md#实际覆盖与持久化)
records each completed operation and its limits. Warm tab switching covered
20 distinct documents across 25 switches; isolated long-document find covered
six queries. Closing 25 tabs returned the live editor count to zero. A normal
restart and read-only canonical reconstruction confirmed the synthetic writes.

Remaining acceptance includes IME composition, drag-to-split, full comment
reply/resolve/reopen and relation removal, import/trash restore, large media
files and a native 600-round transcript. The settings history management list
is reachable, but the offline Agent panel does not expose transcript controls.
Do not mark those rows passed based on Node recovery or a metadata list.

## Source hypotheses to investigate

The native report ranks the reproduced observations. Remaining source leads
need targeted before/after evidence:

- `NoteExcerpt` converts the entire note into Markdown/HTML and mounts that HTML
  even for a folded card. The native run found missing clamp styles as well.
  Check material Super View's DOM/commit/parse cost
  with the 500k-word note corpus; CSS clipping does not bound DOM size.
- `libraryItemMatchesQuery` extracts and lowercases every note body for each
  non-empty query. Check typing and filtering in material lists before proposing
  cached searchable text or deferred search.
- `ChapterPanel`, `ElementPanel` and `DriftPanel` still read the entire UI store
  before selecting the relevant UI slice. Check their render counters during
  unrelated tab/sidebar changes before narrowing subscriptions or adding memo.
- Agent transcript blocks preserve all history DOM. Check the longest history's
  cold restore, Markdown rendering, DOM size and close/reopen retention. Existing
  memoized message blocks do not establish a bounded cold mount.
- `trackGlassFlow` reads animated geometry and writes CSS properties each frame.
  Check the sidebar transition's layout/paint stack before changing animation.

Use actual traces and repeatable journeys to rank these, then describe targeted
changes and before/after evidence. Do not apply blanket `memo` based on source
appearance or report all of these leads as reproduced problems.
