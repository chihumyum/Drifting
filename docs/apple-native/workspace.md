# Local project and chapter writing slice

This is a functional integration of P3 shared commands with the minimum P5/P6
native host. Creation and editing were accepted in `15e298ba`; project/chapter
rename followed in `5a604200`. The current extension adds chapter reordering,
accepted by shared-core, production renderer comparison and native platform checks.
This slice does not complete P3, P2 remote semantics, desktop parity or
mobile release. Performance tuning remains deferred.

## Ownership and behavior

`crates/drifting-core/src/workspace.rs` owns project/chapter queries, creation,
rename and ordering. Swift passes names, identities and destination anchors through
the Apple bridge; it does not assemble SQL, defaults, order values or journals.
The applications use separate native identities and `apple-native-workspace.db`.
The older fixed editor fixture remains in `native-lab.db` for binding tests.
There is no production-library import, cloud transport, delete/restore workflow
or new compatibility adapter in this slice.

Project creation writes six normalized default facts and their order, the built-in
generic association type, an active sync generation and local lifecycle records.
Chapter creation uses explicit chapter/draft values, deduplicates titles across
chapters and drift nodes, and records a null primary storyline without inventing
membership. The bridge generates identities and one stable empty paragraph.
Domain rows, System prose revision, positive materialization receipt and the
complete canonical change set commit together. Cold open loads the CRDT snapshot
and tail; it never seeds from the JSON cache.

AppKit presents project and chapter lists beside the editor. UIKit uses project,
chapter and editor screens. Both offer creation, rename, ordering, automatic save,
explicit save and reopen. Chapter transitions create a new document handle and
Swift store only after saving the old owner and opening the candidate successfully.
Selections and history cannot cross chapters. Pending input, marked composition
and failed persistence prevent replacement or metadata commands.

Rename validates active scope and the target entity's current incarnation. Project
names must be nonblank. Chapter titles share the existing project-wide,
case-insensitive namespace with drift nodes, excluding the renamed chapter itself.
A changed name writes its canonical field mutation and authored field clock
atomically; an unchanged effective name is a no-op. A chapter's concurrency
timestamp advances on a real change, including within the same millisecond.
Receipt failure rolls back the name, clocks, journal and writer state together.

Name dialogs start with the current value. AppKit exposes rename beside each
list's creation action; UIKit exposes project rename on the chapter list and
chapter rename in the editor. Successful replies update lists and titles without
replacing the document handle, Swift store or editor. Prose, selection and local
undo/redo history remain unchanged. Failure retains the prior name and editor.

## Chapter move contract

`workspaceMoveChapter` takes `projectId`, `chapterId` and nullable
`beforeChapterId`. A destination ID places the chapter immediately before that
chapter; null places it last. Source and destination must belong to the project's
chapter list, and the moved chapter's live incarnation is verified. The shared
command returns the current ordered chapter array.

The core chooses a strict finite numeric gap and emits a scalar `field.set` for
the moved chapter's `bookOrder`, with its timestamp and field clock in the same
transaction. Only that chapter moves. Other chapter order values and act records,
including fixed act boundaries, are not rewritten. There is no global reindex or
conversion to a different ordering protocol. If no strict finite value can be
represented at the requested position, the command fails atomically and retains
the previous order. Moving before itself, before its immediate successor, or to
the end when already last is a no-op without new journal, clock or timestamp writes.

AppKit offers up/down buttons beside the chapter list. UIKit offers up/down in
the editor's ordering menu. The first/last position disables the unavailable
operation. Swift selects a destination identity and adopts the core's returned
array; it never computes `bookOrder`. Successful movement updates the list and
keeps the current editor, selection, prose and undo/redo history. Failed movement
keeps the previous list and owner. The UI blocks moves while input, composition,
persistence or another workspace operation is pending.

## Bounded acceptance

Run `pnpm apple:workspace:acceptance` for shared command/bridge integration and
actual renderer protocol/materializer comparison. Run `pnpm apple:acceptance`
for native builds, hosted UIKit binding and iPhone/iPad simulator workflows.
The generated [workspace report](acceptance/p3a-workspace.json) records exact
source and raw logs; [native platform evidence](acceptance/p2b-native.json) keeps
UI/build dimensions separate. Agreed scenarios are:

- Defaults and chapter seeds have complete atomic journals; creation failure
  rolls back domain, prose and journal state and permits retry.
- Independent chapters preserve prose, history, save and cold reopen; failed save
  or active draft retains the current owner on attempted switch.
- Rename preserves exact prose and selection/history, excludes itself from title
  deduplication, validates current scope, and supports no-op and receipt rollback.
- Move to the start, middle and end returns the expected order while leaving
  other chapters, act boundaries and prose unchanged; cold reopen retains it.
- Self/already-positioned requests are no-ops. Invalid identities, foreign scope,
  a missing numeric gap or failed receipt leave order, clocks and journal unchanged.
- Actual Rust creation, rename and move journals decode and reproduce the declared
  domain values and field clocks through the existing renderer on fresh SQLite.
- Native UI creates, renames and reorders chapters, continues undo/redo on the same
  prose owner, switches chapters and restores names, order and prose after restart.

The current workspace report passes 11 core and 9 bridge cases. Production
renderer replay accepts the actual creation, rename and reorder journals, including
all three order transitions and matching field clocks. The source-matched native
report passes macOS, simulator and unsigned device builds; iPhone and iPad each
pass 13 hosted binding cases and two complete UI scenarios, including movement,
continued history and cold order recovery. Existing authoring, binding and
durability checks are current for their source inputs.

Targeted CUA on the rebuilt Mac app confirms up/down, boundary button state,
selection and history retention, and ordered list/prose recovery after quitting
and restarting. The attended observation and source/binary hashes are in ignored
`.local-data/apple-native/workspace-reorder/macos-observation.json`; it is not
desktop XCTest or physical IME evidence. Repository contract, public boundary,
lint, type checking and Agent capability checks also pass.

Desktop XCTest input, physical IME/device, real account, minimum OS and signed
distribution remain separate gates. The six known old-peer alias-delete failures
stay open; this local workflow does not certify general remote convergence.
No push or release is part of this batch.

Next add native editor actions for bold/italic selections and paragraph/heading
formatting through the existing Rust document transactions and history, then
connect the outline. Preserve act/chapter/scene/beat/note semantics; deletion,
the complete outline and performance testing are outside this ordering batch.
