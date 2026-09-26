# Editor performance experiment

The reproducible corpus contains 5,000, 50,000 and 200,000 UTF-16 units, including
single-LF paragraph separators. It uses the production chapter schema, stable
synthetic block IDs, CJK, composed emoji, combining text and marks. Deterministic
Yjs updates give both implementations exactly the same initial prose. No author
library or account is opened. The fixture loader refuses an existing directory.

Run the two visible-window collectors serially on the same idle Mac:

```sh
node scripts/apple-native-editor-performance.mjs
# If launch activation loses focus, wait for an explicit click in the test window:
node scripts/apple-native-editor-performance.mjs --interactive
node scripts/apple-renderer-performance-runner.mjs --build-only
# Use the .prepared.json path printed by the previous command:
node scripts/apple-renderer-performance-runner.mjs --resume=<prepared.json>
# Click the acceptance-only start button in the renderer window before sampling.
```

The native collector compiles optimized Swift and a Release Rust bridge. It
drives the production NSTextView binding and durable queue, with 30 insert/remove
pairs per document. Each measured insertion has separate synchronous dispatch,
two display-link callback and durable-settled timings. It also samples scrolling,
cached view switching and resident memory after repeated core reopen. Independent
Yjs decoding must reproduce the original schema, IDs, marks and text afterward.

The old-client collector builds an isolated unsigned Release Tauri app with the
actual ChapterEditor and its plugins. Its generated database contains the same
three prose documents and 997 additional metadata-only chapter rows. A temporary
instrumentation entry measures dispatch through two requestAnimationFrame
callbacks, chapter activation, scrolling and a separate durable flush. Reports
arrive through an authenticated localhost collector; the app must quit normally
before an independent SQLite/Yjs replay verifies the saved data.

Both collectors record source fingerprints and binary hashes. Build-only output
is not a measurement. A report's `--check` verifies its recorded source; it does
not convert a measured limitation into an accepted product gate. Raw logs,
temporary applications and databases stay in ignored or system temporary paths.
The interactive collector waits for its start button before sampling; all active,
key-window and visible-window guards still apply throughout the measurement.
Use an actual pointer click on the button when an accessibility action leaves
the application inactive. The wait failure includes its source line so activation
failure can be distinguished from an edit or durable-queue failure.
The renderer acceptance entry also waits for an explicit start click, up to five
minutes. Its measured operations keep their foreground and animation-frame guards.

On the current macOS toolchain, Release proc-macro libraries can fail to load with
dyld's `mis-aligned LINKEDIT string pool` error. The benchmark rustc wrapper adds
`-Wl,-no_fixup_chains` only when compiling a host `proc-macro`. Target libraries
and application link commands retain their normal settings. The wrapper itself
is included in each measurement's source fingerprint.

Display callbacks provide frame opportunities, not measured pixels or physical
keyboard latency. Long-task APIs unsupported by WKWebView remain unavailable;
frame gaps are not relabeled main-thread stalls. Native cached surfaces differ
from full workspace navigation, and three prototype databases differ from a
complete large-project workspace. Core reopen RSS samples are not leak proofs.
These distinctions prevent a partial prototype measurement from certifying the
full P2c budgets in [milestones](milestones.md). Physical IME, minimum-system
execution, complete workspace startup and device behavior remain separate gates.

Timing rows are not interchangeable: native loading includes opening its SQLite
owner, whereas renderer document-open starts after workspace projection is ready.
Native scroll samples jump between endpoints and wait for two display callbacks;
renderer scrolling traverses a continuous 60-frame path. Native switching samples
mix the three retained surfaces; the renderer groups ten switches per size and
records actual editor/document retention. Native RSS is cumulative while those
surfaces remain alive. The reopen loop restarts their Rust owners, not their Swift
windows. These rows must not be used to compute direct speedup or leak claims.

## First visible native sample

The generated [initial native report](acceptance/p2c-native-performance-initial.json) records an
Apple Silicon Mac15,7, 36 GiB RAM, macOS 27.0, a 1100 × 780 point window and the
actual callback cadence. Thirty insert/remove pairs per size preserve the corpus
under independent Yjs decoding. The measured p95 values are:

| UTF-16 units | Synchronous input dispatch | Two display callbacks | Durable queue settled |
| --- | ---: | ---: | ---: |
| 5,000 | 3.2 ms | 33.8 ms | 18.6 ms |
| 50,000 | 12.5 ms | 40.0 ms | 33.5 ms |
| 200,000 | 43.8 ms | 72.3 ms | 106.4 ms |

The 200k display-opportunity sample exceeds the declared 50 ms target. This is a
measured optimization task, not a passed performance gate. The separate durable
timestamp is captured when the queue reports completion, including cases where
that occurs before the two display callbacks. Reopening retained owners ten times
records cumulative RSS rising from 288.8 to 290.2 MiB; this does not establish
either a leak or the required steady-state memory bound. Initial failed launches
remain in ignored logs. The completed collection waits for AppKit's actual visible
occlusion state before starting and checks foreground/key-window state throughout.

The initial old-client Release package built successfully, but three visible runs lost
foreground focus and failed the animation-frame guard. The first retained 73
partial samples; the following attempts completed none. Each application exited
normally. These failed attempts remain historical diagnostics. The attended
collection below supplies the first complete current renderer baseline.

## Incremental styling sample

The Mac view now restyles the edited block and skips an unchanged style reply.
Eight dedicated checks compare every UTF-16 position against full styling, with
full refresh retained for structural changes, remote formatting and composition.
The preserved [incremental-style report](acceptance/p2c-native-performance-incremental-style.json) uses the same
corpus and has 30 insert/remove pairs per size with independent Yjs replay:

| UTF-16 units | Synchronous input dispatch | Two display callbacks | Durable queue settled |
| --- | ---: | ---: | ---: |
| 5,000 | 3.2 ms | 18.4 ms | 11.8 ms |
| 50,000 | 12.9 ms | 30.7 ms | 29.8 ms |
| 200,000 | 42.6 ms | 64.8 ms | 101.9 ms |

The 200k display-opportunity p95 still exceeds 50 ms, and synchronous dispatch
remains near the original 43.8 ms. The principal synchronous bottleneck therefore
remains unresolved. Median callback cadence is about 7 ms in both runs, with
different tail gaps; these whole-run samples do not isolate the styling change's
effect. The new sample's
retained-owner reopen RSS is 257.9–258.4 MiB, still not a leak or memory-budget proof.
Two automatic launches failed their foreground guards; an explicit start-button
click then completed all samples without relaxing those guards. The failed logs
are retained. Next profile the synchronous text-change and optimistic-projection
path before adding another optimization. At this stage no renderer baseline had
completed; the later attended collection is recorded below.
Code inspection identifies three full target-string constructions in ordinary
input: prepared TextKit input, Store validation and incremental-style validation.
Measure those costs separately from layout, style application and selection
restoration before removing duplicate work. Reuse must verify the same authored
basis; ordinary prepared input does not use the scalar-array diff fallback.

## Exact-text identity sample

The binding now compares exact storage text and skips full-text selection checks
when no capture is eligible. This also fixes lost NFC/NFD edits and stale passive
views; independent AppKit and hosted UIKit regression tests cover correctness.
An isolated pre-change cost probe identified repeated Swift comparisons against
Cocoa-backed text as a hotspot: at 200k, its median was 8.46 ms versus 1.90 ms
for Foundation literal equality. That probe is diagnostic, not UI acceptance.

The preserved [exact-text report](acceptance/p2c-native-performance-exact-text.json) measures the
same visible corpus with 30 insert/remove pairs per size and independent Yjs
replay. Its p95 values are:

| UTF-16 units | Synchronous input dispatch | Two display callbacks | Durable queue settled |
| --- | ---: | ---: | ---: |
| 5,000 | 8.2 ms | 27.6 ms | 29.4 ms |
| 50,000 | 7.0 ms | 27.1 ms | 32.0 ms |
| 200,000 | 15.4 ms | 37.8 ms | 101.9 ms |

The measured 200k display-opportunity metric is now below 50 ms; the durable
queue p95 remains about 102 ms. Median display cadence was 6.95 ms and cached
surface switching p95 was 13.9 ms. The retained-owner reopen RSS range was
248.1–248.7 MiB. The 5k tail differs from earlier runs, so these samples do not
establish a uniform speedup or isolate every changed operation. The previous
reports remain available unchanged. Actual pointer activation completed the run
with all foreground guards intact after one accessibility-only start failed the
activation wait. Full project startup, physical input, minimum OS, device and
full application comparison remain open; this is not the complete P2 performance gate.

## Attended production-renderer baseline

The preserved [first renderer report](acceptance/p2c-renderer-performance-first.json) contains
132 successful samples from a freshly built unsigned Release Tauri/WKWebView app.
An actual click starts the acceptance entry; the production editor and every
existing focus/frame assertion remain in use. The process quits normally, then
independent SQLite integrity, foreign-key and Yjs replay checks confirm 1,000
chapter rows and unchanged prose, marks and IDs for all three synthetic documents.
Source and bundle fingerprints are recorded; the report passed its `--check`
against the source present at collection time.

The nearest comparable measurements are programmatic dispatch through two display
callbacks, with 30 edit samples per size. Both are opportunities to paint:

| UTF-16 units | AppKit p95 | Tauri/WKWebView p95 |
| --- | ---: | ---: |
| 5,000 | 27.6 ms | 30.0 ms |
| 50,000 | 27.1 ms | 32.0 ms |
| 200,000 | 37.8 ms | 45.0 ms |

Both samples are below 50 ms for this narrow metric. This table does not establish
a general native speedup: callback cadence, typography, layout and surrounding
work differ. Tauri's p95 dispatch-to-Yjs-commit is 2 ms at each size; this excludes
SQLite flush and must not be compared to native durable-settled timings. Native
cached-surface switches are not equivalent to complete Tauri tab activation.
The Tauri main-process RSS excludes WebKit helper processes, so no memory-ratio
claim follows either. Large-project native startup, physical input, full workspace
navigation, minimum-OS/device runs and steady-state open/close budgets remain open.

## Prefix-deletion regression sample

After adding pure-prefix-deletion reconciliation for same-paragraph Enter, both
collectors were rebuilt and run serially with explicit pointer activation. The
[prefix-deletion native report](acceptance/p2c-native-performance.json) again has 30
insert/remove pairs per size and independent Yjs replay. The
[paired renderer report](acceptance/p2c-renderer-performance.json) has 132 samples,
normal process exit and independent SQLite/Yjs checks. These measure ordinary
editor input after the change; concurrent deletion itself is covered by the
document and binding correctness suites, not by this timing workload. These
fingerprints precede the later partial quote-deletion extension; this is a
recorded baseline, not performance acceptance for that newer source.

| UTF-16 units | Native synchronous p95 | Native two-callback p95 | Native durable p95 | Tauri two-callback p95 |
| --- | ---: | ---: | ---: | ---: |
| 5,000 | 3.3 ms | 19.4 ms | 9.7 ms | 29.0 ms |
| 50,000 | 5.7 ms | 24.0 ms | 25.3 ms | 30.0 ms |
| 200,000 | 15.3 ms | 38.5 ms | 91.1 ms | 42.0 ms |

Native median callback cadence was 6.95 ms and cached-surface switching p95 was
15.1 ms. Ten retained-owner reopens recorded 274.9–275.3 MiB RSS. The current
200k callback result is close to the preceding 37.8 ms sample; these single runs
do not establish statistical equivalence or isolate the new concurrent path.
All comparison, physical-input and full-workspace limitations above still apply.

## Materialization batch cost

A focused file-backed renderer journal probe found repeated whole-envelope work
in the new admission writer. One transaction with 1, 16 or 64 small synthetic
prose appends decoded the same original 1, 16 or 64 times and checked 1, 256 or
4,096 mutation rows. The formal batch writer now verifies that original once
and retains each append's token, event, raw row and historical revision checks.
It uses no global cache or compatibility fallback.

The independent source-matched after probe confirms one full-envelope pass per
batch and 1, 16 or 64 mutation comparisons. At 64 appends, directly decoded
envelope bytes decrease from 1,054,080 to 16,470 and gateway SQL requests from
1,043 to 917. Trigger-internal statements are excluded. Both probes use fresh
temporary SQLite files, WAL/FULL, three samples per size and one commit per
sample. A receipt-disabled variant exists only in the diagnostic copy.

Raw evidence is retained under
`.local-data/apple-native/original-materialization-admission-cost-review` and
`original-materialization-admission-cost-after-review`; each has a source and
counter checker. The latter report SHA256 is
`1006bcb812874f6b0fded95d0cc7138b6c918a832f99ba4b4a7d52952341413a`.
Concurrent build/test load made elapsed-time comparisons unreliable, so these
results establish reduced repeated work, not an end-to-end speedup percentage
or native input acceptance. Remote calls still use the single-append adapter.

Further native measurement is deferred until the main writing flow is usable,
except for unusable stalls or demonstrated architectural risks. When resumed,
the measurement must time deletion as well as insertion. The current
collector measures insertion and uses deletion only to restore the corpus;
it therefore does not expose the newer native deletion-capture cost. Split
capture/edit, durable commit and checkpoint/refresh timings on the existing
200k corpus when a measured bottleneck justifies changing those production paths.
Do not make this experiment a prerequisite for project/chapter integration.
