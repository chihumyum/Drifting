# Apple native client migration

Status: active, staged migration. The Tauri client remains the daily-use client.
Only synthetic projects may be opened by the native lab. No production library,
credentials, cloud account or published migration is changed by this experiment.

## Target and scope

The target client supports macOS, iPhone and iPad. New Android and Windows
product work is out of scope; existing implementations and checks remain until
replacement behavior is accepted. The initial native deployment targets are
macOS 14 and iOS/iPadOS 17. macOS Intel packaging is a separate build gate; the
first local build is Apple Silicon. Minimum-version execution is also a separate
gate from building with a newer SDK.

The existing public `0.1.x` database compatibility promise is unchanged.
`drizzle/0000_local_first_baseline.sql` and all published migrations remain
immutable. The same journal, migration hashes, shadow migration, verified safety
snapshot and fail-closed recovery rules apply to every host.

- [Architecture decision](architecture.md)
- [Capability migration inventory](inventory.json) and [generated coverage](acceptance/inventory.json)
- [Milestones and acceptance](milestones.md)
- [Local project and chapter writing slice](workspace.md)
- [Native editor formatting](formatting.md)
- [Whole-book outline navigation](outline.md)
- [Chapter tabs and split editing](tabs-and-split.md)
- [Native interaction specification](design.md)
- [P2 document corpus specification](fixtures.md)
- [Shared document contract and P2a findings](document-core.md)
- [Unselected-subtree relocation investigation](relocation-design.md)
- [SQLite prose durability and process recovery](durability.md)
- [Native command capture and durable originals](native-authoring.md)
- [Canonical remote prose receive and replay](remote-prose-sync.md)
- [Reproducible editor performance experiment](performance.md)
- [Physical-device prerequisites and acceptance](device-acceptance.md)
- [macOS system input-method observation](system-ime.md)

## Reproduce the first batch

```sh
pnpm apple:check
pnpm apple:core:test
pnpm apple:workspace:acceptance
pnpm apple:remote-prose:acceptance
pnpm apple:document:acceptance
pnpm apple:authoring:acceptance
pnpm apple:binding:acceptance
pnpm apple:durability:acceptance
pnpm apple:build:macos
pnpm apple:build:ios
pnpm apple:build:ios-device
pnpm apple:acceptance
```

The document and prose crates, Apple bridge and Apple CI lane require Rust 1.96. Application builds require
Xcode, XcodeGen and the corresponding installed Rust
Apple targets. The build script generates the Xcode project from
`native/apple/project.yml`; generated projects and build outputs are ignored.
The device build is unsigned and does not establish installation or distribution
acceptance. There is no development-team ID in tracked sources.
The separate physical-iPhone development-signing attempt is currently blocked
by Xcode's missing account session and an ineligible Native Lab profile; its
generated diagnostic records installation and device tests as not run.

The default acceptance run does not synthesize macOS desktop input. Desktop
XCTest requires `--macos-ui` and a suitable test session. On the current host,
two keyboard-synthesis attempts timed out while System Settings opened; the
precise OS trigger is unresolved. The user permits desktop interaction; avoid
repeatedly running the same failing path without fixing it. Targeted native UI inspection, headless checks and simulator tests
remain available. A default passing report does not imply desktop XCTest passed.

The two applications now open a separate local workspace with project and chapter
lists, creation, rename, chapter up/down, native editing, explicit save and reopen. Both call the shared
Rust workspace service for domain defaults, transactions and canonical journals.
Rename and reordering retain the current document, selection and prose history.
Both editors expose selection bold/italic and paragraph/heading 1–3 through the
same Rust document transactions; see the bounded [formatting contract](formatting.md).
The [whole-book outline](outline.md) reads shared act/chapter order and live
scene/beat/note headings, with lazy expansion and navigation by stable identity.
Ordering submits a destination chapter ID; the core updates only the moved
chapter's scalar `bookOrder`, without global reindexing or rewriting act boundaries.
The [local writing slice](workspace.md) records source-matched creation, rename
and reorder acceptance, with native platform dimensions kept separate.
The workspace database is `apple-native-lab/apple-native-workspace.db`; the older
fixed fixture and `native-lab.db` remain test harnesses for the editor binding.
No production library import or selection is exposed, and neither application
accesses Keychain or registers the production URL scheme. Use synthetic content
until the remaining migration and distribution gates pass.

Prose uses a shared Rust document owner, one ordered Swift queue across views, local-origin
undo, original-comment highlights, atomic authored updates/comment anchors/sync
journal and replay-covered SQLite checkpoints. Creation, rename and chapter ordering use shared domain commands. The [canonical remote prose path](remote-prose-sync.md) now receives complete originals
and reconciles open Rust owners; Swift delivery and provider orchestration remain
open. The older raw-update entry point remains a fixture-only seam. Read [the binding contract](document-core.md)
for current behavior and remaining structural, remote IME, selection and durability gates.
The Mac [workspace](tabs-and-split.md) retains chapter tabs and supports two
editor panes; UIKit keeps one visible editor. Views of the same chapter share
their document owner and history while retaining independent selections.
Both hosts support [project title and prose search](search.md), with current
CRDT anchor resolution before selecting a match in the editor.
Local multi-view and overlapping marked-text behavior have programmatic
AppKit evidence. Hosted UIKit tests cover its real input entry points, remote
composition, repeated-character identity, Unicode deletion, focus loss and native
history routes on iPhone/iPad simulators. AppKit responder actions and menu
availability also route to the shared Rust history. These do not replace physical IME or desktop UI acceptance.
The separate CUA/system-Pinyin attempts currently fail before marked composition:
the observed five keycodes, window focus and input contexts match under both
Doubao and Apple Pinyin, but Latin input commits directly.
Its generated report is failed, not a replacement for real composition acceptance.
The current editor is an acceptance prototype, not desktop feature parity.

The P2c durability slice preserves published migrations and adds one local
materialization-receipt migration. Exact transaction update bytes enter the authored journal; stored tail
rows are replayed in ID order before snapshot/pruning. The generated
[process-recovery report](acceptance/p2c-durability.json) records real SIGKILL
boundaries and two independent restarts per case, separately from native UI
tests. WAL/NORMAL process recovery is not a power-loss guarantee. Performance,
the remaining project lifecycle and full remote reducer integration remain open.

The durable status and next work are in [milestones](milestones.md).
[Generated P1 evidence](acceptance/p1-native.json) covers the first runnable batch. Generated
reports distinguish source, integration, macOS UI, simulator, physical device,
real account and distribution evidence. A compiled application is not evidence
of a working editor or input method.
