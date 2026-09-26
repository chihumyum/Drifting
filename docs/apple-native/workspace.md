# Local project and chapter writing slice

This is the first functional integration of P3 shared commands with the minimum
P5/P6 native host. The creation/editing slice was accepted in `15e298ba`.
The current extension adds project/chapter rename; its shared-core, bridge,
renderer comparison and native simulator checks pass.
It does not complete P3, P2 remote semantics, desktop parity or mobile release.
Performance tuning is deferred.

## Ownership and behavior

`crates/drifting-core/src/workspace.rs` owns project/chapter queries, creation and rename.
The Swift hosts pass names and selected IDs through the Apple bridge; they do not
assemble SQL, defaults or journal mutations. The bridge generates identities and
one stable empty paragraph using the existing document engine. A new chapter's
SQLite rows, System prose revision, positive materialization receipt and complete
canonical change set commit in the same transaction.

Project creation writes six normalized default facts and their order, the built-in
generic association type, an active sync generation and local lifecycle records.
Chapter creation uses explicit chapter/draft values, preserves fractional order,
deduplicates titles across chapters and drift nodes, and records a null primary
storyline without inventing membership. The title stays separate from prose.
A cold open loads the CRDT snapshot and tail; it never seeds from the JSON cache.

AppKit presents project and chapter lists beside the editor. UIKit uses project,
chapter and editor screens. Both offer creation, rename, automatic saving,
explicit save and reopen. A successful chapter transition installs a new document handle and
Swift store; selections and history cannot leak between chapters. The old owner
is retained until its work is saved and the candidate document opens successfully.
Pending input, marked composition and failed persistence prevent replacement.

Rename uses the same active-scope and transaction owner. Project names must be
nonblank. Chapter titles use the existing project-wide, case-insensitive namespace
shared with drift nodes, excluding the renamed chapter itself. A changed name
writes its canonical field mutation and current-incarnation field clock atomically;
an unchanged effective name is a no-op. A chapter's concurrency timestamp advances
on a real rename, including changes within the same millisecond. Receipt failure
rolls back the name, clocks, journal and writer state together.

The native name dialog starts with the current value. AppKit exposes rename beside
each list's creation action; UIKit exposes project rename on the chapter list and
chapter rename in the editor. Successful replies update lists, headings and window
or navigation titles without replacing the document handle, Swift store or editor.
Prose, its selection and undo/redo history remain unchanged. Failed requests leave
the prior name and current editor intact. Pending or marked input and unsaved
prose must be resolved before the UI submits a rename.

The applications use their existing separate native identities and an independent
`apple-native-workspace.db`. The older fixed editor fixture remains in
`native-lab.db` for binding tests. There is no production-library import, cloud
transport, delete/restore workflow, or new compatibility adapter in this slice.

## Bounded acceptance

Run `pnpm apple:workspace:acceptance` for shared command/bridge integration and
actual renderer protocol/materializer comparison, and `pnpm apple:acceptance`
for native builds, hosted UIKit binding and iPhone/iPad simulator workflows.
The generated [workspace report](acceptance/p3a-workspace.json) fingerprints its
source and raw logs; [native platform evidence](acceptance/p2b-native.json) records
UI/build dimensions separately. The agreed scenarios are:

- Project defaults and two chapter creations write valid atomic journals.
- Creation failures roll back domain/prose/journal state and allow retry.
- Two chapters retain independent prose, local history, save and cold reopen.
- A failed save or active draft retains the current owner on attempted switch.
- Actual Rust journal bytes decode canonically and reproduce the declared domain
  values through the existing renderer's materializer on a fresh SQLite database.
- Rename preserves the current document handle, exact prose bytes, selection and
  local undo/redo history; subsequent editing and cold reopen remain usable.
- Rename excludes itself from title deduplication, validates the live incarnation,
  preserves no-op behavior and rolls back a failed receipt before a successful retry.
- Actual creation and rename journals reproduce names and authored field clocks
  through the renderer, without changing project defaults or chapter prose.
- Native UI creates projects/chapters, edits, undoes/redoes, switches chapters,
  renames, reopens and survives process restart with the new names.

Desktop XCTest input, physical IME/device, real account, minimum OS and signed
distribution remain separate gates. The known old-peer alias-delete failures are
still open; this local writing flow does not certify general remote convergence.

## Previous accepted result: creation and writing

At `15e298ba`, the source-matched workspace runner passed five shared-core cases and five ABI
cases, plus three actual Rust change sets replayed through the existing renderer.
Core/prose/bridge regression passed 66/27/23 tests; the authored-prose report
passed 248 Rust and 80 renderer tests. Document, 61-case AppKit binding
and 23 SIGKILL/46 cold-restart reports were regenerated for that source.

That batch's native report passed macOS, iOS simulator and unsigned iOS device
builds. Both iPhone and iPad passed 13 hosted binding cases and two complete UI
workflows (creation, editing/history, chapter isolation, reopen and process
restart). Targeted CUA inspection also exercised Mac creation, input and disk
reopen; it is an attended observation, not desktop XCTest or physical IME proof.
Repository contract, public boundary, lint and type checking passed. These are
the preceding batch's results, not a claim about the rename extension's native run.

## Current rename acceptance

The current shared-core workspace group passes 8 cases and its full library
passes 69; the bridge workspace group passes 7 and its full library passes 25.
The actual renderer comparison accepts 3 creation and 7 rename change sets and
matches 4 authored field clocks. Both Swift targets pass static type checking.
The refreshed authoring report passes 253 Rust and 80 renderer tests; the
61-case AppKit binding and 23 SIGKILL/46 cold-restart reports also pass for this
source. These checks remain separate from native UI execution.

The existing two native UI scenarios now include rename followed by undo/redo
and cold launch using the new names. Both iPhone and iPad pass those two UI
scenarios and 13 hosted binding cases. macOS, iOS simulator and unsigned iOS
device builds pass. Targeted CUA on the rebuilt Mac application also confirms
project/chapter rename, retained prose history and disk reopen; the observation
and source/binary hashes are in the ignored
`.local-data/apple-native/workspace-rename/macos-observation.json`. It is not
desktop XCTest or physical IME evidence. Repository contract, public boundary,
lint, type checking and Agent capability checks pass. Generated reports remain
authoritative for the exact source and execution dimensions. No push or release
is part of this batch.

Next: shared chapter reordering and minimal AppKit/UIKit controls, with the same
transaction/journal owner. Preserve act/chapter/scene/beat/note semantics without
expanding this batch into delete, the complete outline or performance testing.
