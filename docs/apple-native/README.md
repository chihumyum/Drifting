# Apple native client migration

Status: active, staged migration. The Tauri client remains the daily-use client.
Only synthetic projects may be opened by the native lab. No production library,
credentials, cloud account or published migration is changed by this experiment.

## Target and scope

The active migration target is macOS. At the author's latest direction on
2026-09-27, implementation and all routine acceptance are Mac-only: finish the
Mac front-end migration, then discuss iPhone and iPad with the author. Mobile
work is deferred and does not gate completion of the current migration. Keep
shared Rust and the existing UIKit implementation; historical mobile results
remain tied to the sources they actually tested.

New Android and Windows product work remains out of scope. The current native
macOS deployment target is 14; deferred UIKit code retains its iOS/iPadOS 17
configuration. macOS Intel packaging is a separate build gate; the first local
build is Apple Silicon. Minimum-version execution is also separate from building
with a newer SDK.

The author excluded Google Drive synchronization from this migration on
2026-09-26 and will redesign it after the native client migration. Do not port
its connection, credentials, transport, provider snapshots or recovery UI as
native release requirements. Shared document correctness, local persistence and
the already accepted receiver foundations remain; native writing and Agent
work continue without a Google Drive prerequisite.

The existing public `0.1.x` database compatibility promise is unchanged.
`drizzle/0000_local_first_baseline.sql` and all published migrations remain
immutable. The same journal, migration hashes, shadow migration, verified safety
snapshot and fail-closed recovery rules apply to every host.

- [Architecture decision](architecture.md)
- [Capability migration inventory](inventory.json) and [generated coverage](acceptance/inventory.json)
- [Milestones and acceptance](milestones.md)
- [Local project and chapter writing slice](workspace.md)
- [Chapter trash and restore](chapter-trash.md)
- [Chapter selection comments](chapter-comments.md)
- [Elements library](element-library.md)
- [Element patches (设定补丁)](patches.md)
- [Entity links and backlinks](entity-links.md)
- [Storylines and chapter membership](storylines.md)
- [Drifts and drift groups](drifts.md)
- [Native writing assistant](agent.md)
- [Settings: appearance, typesetting and language](settings.md)
- [Native editor formatting](formatting.md)
- [Whole-book outline navigation](outline.md)
- [Act boundary editing](act-boundaries.md)
- [Story graph, story time and the bottom timeline (底部时间轴)](timeline.md)
- [Chapter tabs and split editing](tabs-and-split.md)
- [Whole book (全书长卷), statistics, writing plan and today's words](whole-book.md)
- [Element overview (设定总览)](element-overview.md)
- [Review (审阅), TODOs and the 备忘与素材 board](review.md)
- [Native interaction specification](design.md)
- [P2 document corpus specification](fixtures.md)
- [Shared document contract and P2a findings](document-core.md)
- [Unselected-subtree relocation investigation](relocation-design.md)
- [SQLite prose durability and process recovery](durability.md)
- [Native command capture and durable originals](native-authoring.md)
- [Canonical remote prose receive and replay](remote-prose-sync.md)
- [Complete chapter originals and workspace delivery](remote-workspace-sync.md)
- [Reproducible editor performance experiment](performance.md)
- [Physical-device prerequisites and acceptance](device-acceptance.md)
- [macOS system input-method observation](system-ime.md)

## Working loop

During development run only the affected tests (`cargo test` for the touched
crate or module, one XCTest class). Before each batch commit:

```sh
pnpm apple:refresh        # regenerate only stale evidence, then macOS acceptance
pnpm apple:check          # verify all evidence is current
```

`pnpm apple:refresh --list` shows what is stale; `--all` regenerates everything.
Each generator's `--check` decides staleness, so an unchanged report is verified
rather than rerun. Documentation edits never invalidate native acceptance; only
runtime sources do. The individual `pnpm apple:*:acceptance` commands remain for
focused iteration.

The document and prose crates, Apple bridge and Apple CI lane require Rust 1.96.
Application builds require Xcode, XcodeGen and the installed Rust Apple targets;
the build script generates the Xcode project from `native/apple/project.yml`.
Generated projects and build outputs are ignored. There is no development-team
ID in tracked sources.

Native acceptance is Mac-only by default. `--binding-only` runs programmatic
AppKit acceptance. Mobile flags (`--with-ios`, `--ios-only`, `--include-ipad`)
exist for later explicit runs and are not part of current acceptance. Desktop
XCTest requires `--macos-ui`: on this host keyboard synthesis opened System
Settings and timed out, so repair that path before rerunning it. A passing
default report does not imply desktop XCTest passed.

## Current state

The Mac lab opens a separate synthetic workspace
(`apple-native-lab/apple-native-workspace.db`) with project and chapter lists,
creation, rename, ordering, recoverable trash, act boundaries, selection
comments, an elements library with element pages, element patches anchored to
chapter text and automatic entity links with backlinks from chapters and pages, storylines with chapter membership, drifts with groups and act notes, a writing
assistant whose 53 tools read the project and propose prose, element, patch,
storyline, relation, note/TODO, chapter, drift and project changes the author
reviews, a whole-book
outline, a continuous whole-book editor with statistics and a writing plan,
an element overview of categories around the chapter band with relation edges,
a review panel of notes and TODOs with associations, a 备忘与素材 board with
library ordering, act colours, project deletion, a bottom timeline dock with
a draggable act rail,
chapter tabs with a two-pane split, formatting, project search over chapters,
summaries, drifts, elements, categories, storylines and materials, today's
words against the daily goal, native editing, save and reopen. Every write
goes through shared Rust domain commands, transactions and canonical journals;
views of one chapter share its document owner and history while keeping their
own selections. Remote prose and chapter
originals are received through the shared native queue without replacing live
editors. The writing assistant keeps provider API keys in the lab's own Keychain
service (`Drifting Native Lab`); the production Keychain service and URL scheme
are not used.

The editor is an acceptance prototype, not desktop feature parity. Physical IME,
desktop XCTest input, devices, accounts and signed distribution are unaccepted.
Delivered slices, the next batch and the open gates are in
[milestones](milestones.md); generated reports distinguish source, integration,
macOS UI, simulator, device, account and distribution evidence. A compiled
application is not evidence of a working editor or input method.
