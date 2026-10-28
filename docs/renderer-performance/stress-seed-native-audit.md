# Heavy-seed native UI audit

## Current acceptance state

The 2026-10-29 audit is **waiting for access to the unlocked macOS desktop**.
The current source was compiled into an isolated Debug app, and its stress
database passed the seed's canonical-data and word-budget audit. Computer Use
reported that macOS was locked and automatic unlock was paused after physical
input. The launched WebView reported `visible: false`. No writing, navigation,
relation, graph, material or Agent UI journey has yet been accepted. Hidden-page
startup observations are not evidence of interactive performance or stability.

The unattended continuation produced a [detailed diagnostic record](stress-seed-audit-findings-2026-10-29.md)
and [source-matched Node evidence](acceptance/stress-seed-node-diagnostic.json)
using a disposable backup of the real heavy library. It covers production
projection, material conversion/search, 600-round Agent recovery, allocation/
retention trends and authored prose/TODO/relation writes with SQLite reopen.
A browser fallback reached the shelf, then its control channel timed out.
These results do not close the pending native UI coverage below.

The generated [observation report](acceptance/stress-seed-native-audit.json)
records its source fingerprint, binary hash and available samples. Its status
is deliberately `observations-only-coverage-must-be-reviewed`; a generated
timing summary cannot certify that a user journey succeeded. Keep that report
and this coverage statement together when continuing the audit.

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
```

`mark` only labels a measurement interval; it never changes the App. Perform
all acceptance interactions in the current native app through Computer Use,
verify the resulting visible state, and record the operation/sequence and
outcome here. A two-second sample crossing a marker boundary can contain work
from the previous operation. Exclude boundary samples for precise per-operation
comparisons. Stop the app and relaunch after changing any observed source;
`source.json` describes the source present at server start. Summaries exclude
raw samples from earlier server launches in the same profile.

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
- React 19 development's DevTools hook records commits and per-component render
  phase self time. Top components are retained per two-second sample. Reused
  Fiber subtrees are excluded using their render start timestamps. Fiber-walk
  and DOM-snapshot costs are recorded separately, but these are not the total
  probe overhead. Do not translate Strict Mode timings into release budgets.
- DOM element/editor counts and mutation counts can reveal retained editors or
  expensive updates. A mutation is neither a repaint nor a forced layout.
  Confirm layout, paint, GC or script hypotheses with native stack samples or
  an attended Web Inspector timeline before calling them measured causes.
- Native IPC counts, completion durations, outstanding calls and returned row/
  string sizes omit arguments and result text. Durations include scheduling
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

## Native coverage to complete

All rows below are pending actual unlocked-desktop interaction. Run affected
warm paths at least five times, separate cold hydration from warm work, and
record failures as well as successful operations. Use synthetic markers and
verify persistence after restarting the same instance.

| Surface | Normal operations and checks |
| --- | --- |
| Shelf and project | Open the heavy project, return to the shelf, reopen; dashboard, project summary and loading/error state |
| Left sidebar | Chapter/storyline, category/element and inspiration tabs; filter/search, collapse/expand, resize, selection and navigation |
| Right sidebar | Every available panel/tab, outline, relations, comments/TODOs, materials and Agent; repeated open/close and panel splitting |
| Writing | Shortest and 20k-word chapters, 50k inspiration, 10k element and note; type/paste, selection, formatting, undo/redo, find, durable save |
| Many tabs | At least 20 documents, mixed entity types, warm switching, split view, close/reopen; editor/DOM counts and memory after idle and repeat cycles |
| Structure | Storyline assignment, chapter/outline navigation, whole-book view if exposed, bottom timeline navigation and resizing |
| Relations | Create and remove synthetic links through picker and graph; verify endpoints, selector updates and durable restore |
| Review | Create/reply/resolve comments, create/edit/complete/reopen TODOs, verify anchors and persistence |
| Materials | Long notes, folder navigation/filtering, image and PDF preview/open/close; edit notes, move items and verify saved state |
| Story Super View | Open, pan/zoom, select/open entity, filters, relation controls, return to editor |
| Element Super View | Categories, 300 elements and 200 inspirations; pan/zoom, filters, relation creation, selection and entity popovers |
| Material Super View | All materials/TODOs, search with body matching, kind/entity filters, drawer, note edit and relation controls |
| Agent | Short and 600-round histories, conversation switches, scroll, long tool-result expansion, draft editing and repeated panel close/reopen; no paid/live model call is needed |
| Overlays | Global search, in-document find, history, trash/restore, import dialog and every settings rail reachable from the main UI; use synthetic files for any import/export |
| Recovery | Save and restart; reopen prose, note, relation, comment/TODO and Agent history; compare counts and changed markers |

## Source hypotheses to investigate

These are code leads, **not confirmed native performance defects**:

- `NoteExcerpt` converts the entire note into Markdown/HTML and mounts that HTML
  even for a CSS-clamped card. Check material Super View's DOM/commit/parse cost
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
