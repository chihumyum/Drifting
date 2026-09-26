# Native project search

This bounded batch adds project chapter-title and prose search to the local
writing workspace. Mac opens the search panel from its toolbar or Command–Shift–F
and navigates in the current editor pane. UIKit exposes search from the chapter
list and editor, retaining its single-editor lifecycle. Summaries, elements,
materials, replacement and full global-search parity remain later work.

## Shared search and navigation

The Rust workspace lists the project's current chapters and reads an existing
document owner when present. Other chapters use a temporary scoped reader over
the persisted snapshot and update tail. Search does not replace a live owner,
create history, checkpoint a document, or write a second text index. It reads
authoritative prose rather than the `contentJson` cache. Unresolved or unreadable
chapters are listed as unavailable; they are not silently treated as no matches.

Literal matching trims the query and lowercases Unicode scalars. Lowercase
expansions map back to whole original scalars and original UTF-16 ranges. There
is no normalization, locale-specific comparison or full case folding. Prose
matches stay inside one editable block and exclude structural placeholders.
Results retain chapter order and document order, with at most 100 title/prose
hits and an explicit truncation flag.

Each prose hit carries its full project/document lifecycle scope, two CRDT
relative anchors and the original matched text. Navigation opens or reuses the
chapter owner, resolves those anchors against current accepted prose and compares
the exact original text. A changed scope, replaced occurrence or unresolved
document refuses navigation. A temporary reader's revision or cached offset is
never used to select text in another owner.

The native view also checks the returned live revision, current displayed text
and idle input state before selecting and scrolling to the match. Queued or
marked input cannot be overwritten by navigation. Other pane selections and
local history remain independent. Superseded query responses are discarded;
clearing the query immediately clears the result list.

## Bounded acceptance

- Titles and live/cold prose are found without database writes, owner changes
  or new undo units. No-match, unreadable and capped results remain distinct.
- Anchors from a cold reader resolve after opening and after prefix edits;
  Unicode ranges select the original match. Replaced matches and changed
  lifecycle scopes refuse navigation.
- AppKit and hosted UIKit views preserve history and other selections, reject
  queued/marked input and obsolete revisions, then allow normal continued input.
- Native UI workflows search from chapter lists and editors, navigate across
  chapters and continue editing the selected occurrence.

The generated [document](acceptance/p2a-document.json),
[workspace](acceptance/p3a-workspace.json), [binding](acceptance/p2b-binding.json)
and [native](acceptance/p2b-native.json) reports own exact source fingerprints,
test counts and outcomes. Targeted Mac interaction is recorded separately from
desktop XCTest. Physical IME, physical-device execution, account integration and
signed distribution remain separate gates. This batch adds no schema migration
and makes no performance certification.

The source and binding run includes 144 document cases, 38 bridge cases and 71
AppKit cases. The workspace subset includes 14 core and 20 bridge cases, with
existing renderer journal comparisons. The added search scenarios cover
read-only live/cold access, exact UTF-16 matching, stale results and native input
guards. Review also repaired candidate-owner cleanup and kept UIKit recovery
controls available when loading a search target fails.

Targeted CUA interaction on a fresh Mac build verifies Command–Shift–F,
case-insensitive repeated matches, selecting and replacing the second occurrence,
opening a closed chapter from its prose hit, and cross-chapter search in the
right pane while the left remains unchanged. Immediate undo restores the
selected text without a navigation history unit. After quitting and relaunching,
title search and both chapters' exact saved prose remain correct. The ignored
`.local-data/apple-native/search/macos-observation.json` records the runtime
fingerprint and complete bundle hashes, including the Debug dylib. This evidence
is separate from desktop XCTest and physical keyboard/IME acceptance.

The completed platform run passes 17 hosted UIKit cases and all three UI
workflows on each of the iPhone and iPad simulators, plus Mac, simulator and
unsigned device builds. An earlier iPhone UI attempt was interrupted by host
clamshell sleep; its failed report and power-state log remain in ignored local
evidence. The unchanged-source retry passed after the host woke. Neither an
unsigned build nor simulator execution certifies physical-device behavior.
