# Native renderer composition acceptance

This attended macOS harness mounts the complete App, desktop shell,
ProjectRuntimeProvider, ChapterEditor, graph and settings in a newly built Tauri
bundle. SQLite IPC, Yjs sessions and persistence use the product implementation.
It is a correctness and lifecycle check, not an RC performance qualification.

```bash
pnpm perf:renderer:native
pnpm perf:renderer:native --check
```

Run on macOS with the repository's Node/pnpm, Rust and Xcode toolchains. Close
existing Drifting processes first. Keep the generated **Drifting Acceptance**
window visible and in front during the scenarios. WebKit can suspend animation
frames in an occluded window; the harness fails explicitly if a two-frame wait
stalls for one minute.

The runner prints an exact verified bundle path. After each successful renderer
sequence, it asks for that app's normal **Quit** command (Cmd+Q). Quit within two
minutes; the runner then launches its second process automatically. Quit that
process when requested, too. An automation operator can supply these two native
UI actions. The runner requires exit code zero after each Quit. It never replaces
the shutdown path with `app.exit(0)`, which would skip the product's
`ExitRequested(code=None)` persistence coordinator.

## Isolation and provenance

- The fixture generator claims a **new** directory before opening SQLite. An
  existing directory is rejected before migration, even when it is empty.
- It creates a synthetic project row, then uses the existing offline Dev CLI
  domain runtime to create chapters, elements, categories and relations. No
  author database, prose, credential or `.env.local` is read.
- Two independently generated fixtures must have identical semantic manifests.
  The control project has 50 chapters, 100 elements and 500 relations; a second
  project has 3 chapters and 3 elements. Every chapter contains 5,000 synthetic
  Chinese characters. Read-only SQLite inspection replays Yjs snapshots and
  updates and verifies all 53 bodies. Operational timestamps and journal bytes
  are not claimed to be byte-identical across databases.
- A detached worktree receives tracked changes and the acceptance scripts.
  Untracked product files are rejected. Dependencies and Cargo's compilation
  cache are reused; the app binary must have a new modification time. Bundle
  identifier, version and binary SHA-256 are checked before launch.
  The source snapshot/fingerprint includes `pnpm-workspace.yaml` and dependency
  patches as well as the lockfile.
- `DRIFTING_DB_DIR` points to the new fixture. A unique app identifier isolates
  application/WebKit storage. The native Keychain service is also replaced in
  the temporary source, since the product's service name is otherwise shared
  across identifiers. The deep-link scheme is unique to the run.
- Temporary Vite instrumentation imports the bounded scenario and observes
  ProjectRuntimeProvider mount/unmount effects. The CSP adds one loopback collector;
  reports require an ephemeral token and a Tauri origin. There is no eval or
  command endpoint. Normal product source/configuration contains none of these
  changes.
- An old default Debug bundle is moved aside recoverably before building. The
  runner prints local artifact locations but commits no personal paths, database
  files or tokens. Failed synthetic fixtures are retained for diagnosis;
  successful temporary worktrees/fixtures are removed.

## Scenario and evidence boundary

The first process opens actual target chapter surfaces, inserts a marker through
Tiptap commands, opens 20 retained tabs, returns to the original editor, and
checks editor/Y.Doc identity plus undo/redo. It opens the actual lazy graph and
fully loaded settings panels, checks that these overlays did not remount the
project runtime, creates a two-pane split, and checks shared document identity.
It closes all tabs and waits for their live Y.Doc registrations to disappear.
It switches to the second project and back, checking the full workspace counts,
old-project document cleanup and restored prose.

The second process reopens the saved chapter. After both native Quit operations,
an independent read-only SQLite/Yjs replay must find exactly one changed chapter
with the saved marker and 52 unchanged chapter hashes. SQLite integrity and
foreign-key checks must also pass.

The generated report is
[`acceptance/f8-native-composition.json`](acceptance/f8-native-composition.json).
Its source commit is the snapshot parent; the content fingerprint also covers
tracked working changes and the harness. `--check` validates that fingerprint
against the checkout instead of treating a parent SHA as the final commit.

Input is synthetic Tiptap commands, product navigation actions and DOM clicks;
native Quit is supplied through the real UI. No physical IME/touch, pending
review masks, remote Agent streams, sync/crash matrix, graph geometry stress,
offline upgrade or account acceptance is claimed. The native build is Debug
with a production Vite renderer and explicit instrumentation.

The report records one command-to-two-animation-frame observation and renderer
module-evaluation-to-editor-ready timing. Neither is a repeated input-to-paint
p95 or a cold-launch RC measurement. Native RSS samples cover the parent
process only, exclude WebKit children and do not establish memory reclamation.
Unavailable JS heap/long-task APIs are recorded as unavailable, not zero. F0
budgets, comparative repetitions, larger fixtures and the device matrix remain
open; F8 remains in progress.

## Editor session refactor scenario

```bash
pnpm perf:renderer:native --sessions
pnpm perf:renderer:native --sessions --check
```

The session-refactor snapshot is
[`acceptance/f3-editor-sessions-native.json`](acceptance/f3-editor-sessions-native.json).
The earlier F8a report remains a historical snapshot with its original source
fingerprint; its default `--check` is not current evidence for later changes.

This mode adds temporary observations of actual editor session attach, detach,
outline publication and projection-save callbacks. It authors a synthetic
heading directly into a hidden chapter's live Y.Doc using the product's authored
queue, then reads the materialized outline through native SQLite. The hidden
session must save without publishing an outline to React. Opening the chapter
must preserve its Y.Doc and display that heading in the actual outline rail.
A plain prose edit must not republish an unchanged outline. The scenario undoes
that edit, removes its synthetic heading and verifies the original 5,000-character
body before proceeding with split/cleanup/project switching and restart.

All bindings belonging to the 20 closed chapter tabs must have matching detach
events. The final currently open editor is deliberately still attached when
its report is sent; the normal Quit command then ends the process. These
observations are bounded test instrumentation, not a production telemetry API.
The authored Yjs mutation is explicitly synthetic and does not stand in for
remote-sync or pending-review-mask acceptance.

## Typewriter presentation scenario

```bash
pnpm perf:renderer:native --typewriter
pnpm perf:renderer:native --typewriter --check
```

This mode includes all session-refactor scenarios and enables the real typewriter
setting. It writes `acceptance/f3-typewriter-native.json`; earlier native reports
remain historical fingerprints and are not overwritten. Temporary transforms
count each real controller's resume, pause, tail read, caret alignment, scheduled
frame and final disposal without adding production telemetry.

With 20 retained chapter tabs, exactly one typewriter display binding must be
active. A hidden chapter's authored Yjs update still reaches native SQLite but
cannot change its typewriter work counters. The scenario sets a reading scroll
position, switches tabs, then changes the hidden viewport's CSS height and the
real position preference. Hidden tail CSS and counters must remain unchanged.
Returning without focus must preserve scroll and prepare the tail from the
current viewport height and preference. Focusing the real editor then checks
caret geometry and removal of the one-frame repaint compensation. Both visible
split viewports must retain typewriter bindings, including the unfocused side;
closing all tabs must dispose every controller before project switching.

Viewport sizing, Tiptap selection and settings actions in this test are synthetic.
These checks establish scoped native geometry and lifecycle behavior, not physical
IME, perceived caret repaint quality, total layout cost or an input p95 budget.

## Outline viewport scenario

```bash
pnpm perf:renderer:native --outline
pnpm perf:renderer:native --outline --check
```

This mode includes the session and typewriter scenarios and writes
`acceptance/f3-outline-native.json`. Temporary observations count each actual
outline viewport's resume, pause, measurement, anchor read, scheduled frame and
disposal. Twenty retained chapter tabs must leave exactly one display binding;
a hidden authored Yjs update must reach SQLite without any outline measurement.

Sixty synthetic headings exercise the actual dense rail and its body-portal
omission entries. Clicking an omission uses the canonical scroll target; clicking
an already visible heading retains its primary location. Switching away closes
the portal. A hidden viewport resize, heading edit and dispatched scroll/resize
events must not change that controller's counters. Returning prepares geometry,
shows the updated real TOC label and leaves the old portal closed. The heading
fixture is removed before both visible split owners and final disposal are
checked. The original chapter hashes and restart checks remain enforced.

These are synthetic native control operations, not physical wheel/touch or IME
acceptance. Whole-book active-chapter behavior and mobile portal rendering retain
their own acceptance requirements; this chapter scenario does not substitute for
them or for comparative layout/input/memory budgets.

## Selection memory scenario

```bash
pnpm perf:renderer:native --selection
pnpm perf:renderer:native --selection --check
```

This mode includes all marker, outline and typewriter scenarios and writes
`acceptance/f3-selection-native.json`. Temporary observations count selection
captures, changed snapshot writes and closed-tab pruning. A burst of 200 backward
selection moves must capture and write exactly once per move, and the resulting
snapshot must contain only anchor/head/focus preference. Navigation retains the
canonical editor and range direction. A hidden authored Yjs prefix insertion
must move both live PM and stored endpoints by the prefix length; deleting it
must restore the original range and prose. Failure diagnostics contain positions,
lengths and identity booleans, not document text.

The scenario observes automatic selection-restoration focus in the command-active
split editor and checks that the other visible pane does not take focus in later
frames. Both panes share a split surface key, so the check addresses their actual
editor DOM nodes without using the single-node surface selector or supplying
explicit focus. It also checks removal of
all closed selection keys, and backward selection restoration after switching
projects. On project return, the new session must restore focus before the
harness supplies any explicit focus. Position memory is process-local; the restart sequence checks durable
prose, not cross-process caret persistence. Selection burst counters do not
measure physical input latency or total editor work. The separate
`perf:renderer:selection` microbenchmark measures capture-only document/text work
on 5k/20k/50k fixtures.
