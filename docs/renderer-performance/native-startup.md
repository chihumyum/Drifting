# Native startup and first chapter baseline

This collector builds a new unsigned **Release** Tauri app with the production
Vite renderer, then launches it six times through macOS LaunchServices. It uses
the complete application, SQLite IPC, workspace capture, tab navigation,
ChapterEditor and canonical Yjs sessions. It is a repeatable diagnostic baseline
on the recorded host, not the signed RC or fixed M1/8GB performance qualification.

```bash
node scripts/run-renderer-startup.mjs
node scripts/run-renderer-startup.mjs --check
```

An optional `CARGO_TARGET_DIR` reuses a compilation cache. The tool requires an
unlocked macOS desktop and no other running Drifting app. It prints the verified
bundle path, identity, modification time and binary hash. LaunchServices opens
each new process in the foreground. After each measured sequence, use that
specific application's normal Quit menu or Cmd+Q when requested; the next sample
starts automatically after a fixed 1.5-second quiet interval outside the measured
launch boundary. This lets macOS finish its prior-app focus transition. Do not interact with other apps during a measured sequence.

## Fixed operation sequence

1. Start from the book shelf. An enabled synthetic project card, loaded fonts
   and two animation frames form the shelf ready boundary. Startup time begins
   immediately before `open -n -W`, so LaunchServices/window activation and renderer
   loading are included. Both epoch clocks belong to the same host.
2. Click the actual project card and wait for the current workspace projection
   to report all 50 chapters, then two frames. This separates project opening
   from later editor hydration. A pair of temporary marks isolates the awaited
   workspace capture within this interval.
3. Open chapter 001, containing 50,000 characters of synthetic Chinese prose,
   through the product tab/navigation commands. Require that its Y.Doc was not
   already live; then require the correct visible editable ChapterEditor, the
   exact canonical text length, native focus, loaded fonts and two frames.
4. Open chapter 000 with 5,000 characters using the same checks. This is a small
   control **after** the first long editor; it is not an independent cold editor.
5. After normal Quit, verify the exact observed app PID has disappeared and the
   LaunchServices wait handle exited zero. Independently replay SQLite Yjs
   snapshots/updates and compare all 53 chapter hashes. The native exit code is
   unavailable because LaunchServices owns the process, and is recorded as null.

The existing native fixture generator's `--startup` mode keeps 50 chapters,
100 elements and 500 relations in the control project, plus the separate
3-chapter project. It overrides control chapter 001 to 50,000 characters.
Bodies are a single plain-text paragraph with no entity links; this control
baseline does not represent the multi-block/link-density stress matrix.
Two independent generated fixtures must have the same semantic manifest. Each
launch receives a fresh copy of the closed original SQLite file, so background
metric writes from earlier samples do not warm the next database. The synthetic
app's in-memory tabs reset before React mounts; its own OS/WebKit disk caches,
local storage and isolated empty Keychain service may warm across launches.

## Measurement and isolation

The first launch is retained separately. Summary statistics use the subsequent
five fresh processes: median and nearest-rank p95, plus min/max. With five samples,
p95 equals the maximum and is not a stable estimate of tail latency. Filesystem
caches are not flushed, background applications are not controlled, and this
must not be described as six cold boots. Polling adds up to 5 ms at ready
boundaries and two animation frames provide a paint-opportunity observation,
not a photometric measurement of displayed pixels.

A detached source snapshot, an ephemeral app identifier, Keychain service,
deep-link scheme and database directory isolate the run. The only network
addition is a token-authenticated loopback report endpoint restricted to Tauri
origins, with bounded payload size and no command or eval endpoint. No author
project, credential, `.env` file or prose is collected. Failed synthetic artifacts
are retained for diagnosis; successful fixtures/worktrees are removed. Normal
product source and build configuration do not import the collector or emit marks.

The report records the exact source fingerprint, artifact, host RAM/CPU/OS,
WebKit user agent, fixture hash, per-launch observations and derived statistics.
`--check` rejects a stale source or collector. Contract mutation tests reject
missing repetitions, short substitutes for the 50k case, changed prose, hidden
windows, reused fixtures, missing ready stages, invented native exit codes,
incorrect percentile summaries and unsupported fixed-device/RC claims.

The existing M1/8GB goals remain unchanged: cold startup to interactive <=4 s,
50k opening <=3 s and input-to-paint p95 <=50 ms. This baseline neither measures
physical input latency nor verifies those goals on the required hardware.


## Recorded baseline

`acceptance/f0-native-startup.json` records the new Release bundle
`Drifting Startup 0f29d8b97da5.app`, binary SHA-256
`0f333ef267fadc54fc7b49fa0a55a3d3cfe1b201b8db89660d56c23b2b7db47d`,
from source parent `be4425c9` plus the recorded collector/test fingerprint.
The host is Apple M3 Pro with 36 GiB RAM. Six fresh processes passed the complete
sequence and normal Quit checks. Each independent SQLite/Yjs replay confirmed
53 unchanged chapters, database integrity and foreign keys.

| Interval | First launch (ms) | Next five median (ms) | Next five p95/max (ms) |
| --- | ---: | ---: | ---: |
| Launch request to shelf ready | 1,762 | 994 | 1,009 |
| Shelf click to workspace ready | 108 | 110 | 112 |
| First 50k chapter open | 348 | 348 | 355 |
| Subsequent 5k chapter open | 225 | 211 | 222 |
| Bootstrap metadata hydration | 23 | 23 | 30 |
| Awaited workspace capture | 13 | 13 | 14 |

Raw marks locate 375–400 ms of the five later shelf launches between the React
mount request and shelf readiness, while workspace capture takes 11–14 ms.
These observations justify profiling the initial shelf/auth/database path before
attributing startup latency to graph chunks. They do not identify which operation
inside that interval dominates, and no speedup is claimed in this baseline batch.

A pilot with no inter-launch quiet interval was stopped on its third process
because animation frames stalled. It generated no passing report. The final
series above uses the fixed 1.5-second interval and a newly built artifact; pilot
samples are not mixed into the summary. The collector still fails on a hidden or
non-drawing window instead of weakening the ready condition.

Validation for this baseline: all six repository checks and the separate
architecture command passed; 2,762 full-suite tests passed with one existing skip.
The ordinary production build has 42 JS assets and excludes all startup collector
marks/configuration. No application behavior or published migration changed.
