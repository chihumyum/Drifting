# Local project and chapter writing slice

This is the first functional integration of P3 shared commands with the minimum
P5/P6 native host. The declared local slice has passed source, file-backed and
simulator acceptance. It does not complete P3, P2 remote semantics, desktop
parity or mobile release. Performance tuning is deferred.

## Ownership and behavior

`crates/drifting-core/src/workspace.rs` owns project/chapter queries and creation.
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
chapter and editor screens. Both offer creation, automatic saving, explicit save
and reopen. A successful chapter transition installs a new document handle and
Swift store; selections and history cannot leak between chapters. The old owner
is retained until its work is saved and the candidate document opens successfully.
Pending input, marked composition and failed persistence prevent replacement.

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
- Native UI creates projects/chapters, edits, undoes/redoes, switches chapters,
  reopens and survives process restart.

Desktop XCTest input, physical IME/device, real account, minimum OS and signed
distribution remain separate gates. The known old-peer alias-delete failures are
still open; this local writing flow does not certify general remote convergence.

## Accepted result

The source-matched workspace runner passes five shared-core cases and five ABI
cases, plus three actual Rust change sets replayed through the existing renderer.
Core/prose/bridge regression passes 66/27/23 tests; the authored-prose report
passes 248 Rust and 80 renderer tests. Existing document, 61-case AppKit binding
and 23 SIGKILL/46 cold-restart reports have been regenerated for their inputs.

The final native report passes macOS, iOS simulator and unsigned iOS device
builds. Both iPhone and iPad pass 13 hosted binding cases and two complete UI
workflows (creation, editing/history, chapter isolation, reopen and process
restart). Targeted CUA inspection also exercised Mac creation, input and disk
reopen; it is an attended observation, not desktop XCTest or physical IME proof.
Repository contract, public boundary, lint and type checking pass. No push or
release is part of this batch.

Next: shared project/chapter rename commands and native management controls,
with the same transaction/journal owner and bounded save/reopen acceptance.
