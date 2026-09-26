# Native editor formatting

This writing-workflow batch adds selection bold/italic and paragraph/heading 1–3
to AppKit and UIKit. It follows chapter ordering (`5bc7a9f8`) and keeps the same
document owner, history and persistence path. It does not complete editor parity
or enable general remote synchronization.

## Document command

`DocumentSession::format_native(NativeFormatting)` takes the displayed revision,
a global UTF-16 range and one action: `bold`, `italic`, `paragraph`, `heading1`,
`heading2` or `heading3`. The core validates the entire selection before mutation.
One command uses one local transaction and one undo unit, including selections
across paragraphs. Empty inline selections are disabled; block actions accept a
caret. Formatting does not introduce a separate typing-marks state.

Bold/italic remove the target mark when all selected text already has it;
otherwise they apply it across the selection. Other marks and entity links are
preserved. Heading commands change the actual XML tag and numeric level. They
retain text, public block IDs, typed metadata, comments and selection lineage.
Changing the heading level invalidates both native views' style projections.

Paragraph converts selected root text blocks to paragraph, removes their level,
and clears bold/italic/strike only from selected characters. A caret does not
clear all characters in its paragraph. Entity links, unknown metadata and current
indent/alignment values remain intact. This is a bounded paragraph command, not
full `clearNodes` parity. Container unwrapping and block indentation are later
workflow work. Paragraph reset inside quotes/lists and converting a list item's
required first paragraph to a heading are rejected atomically. A supported
heading inside a quote retains the quote container.

The `documentFormat` bridge guards pending recovery and active drafts/composition,
then uses the existing durable session. `NATIVE_FORMATTING_UNAVAILABLE:` denotes
a pre-mutation refusal: Swift keeps its input bases and resumes queued input.
Persistence failure instead returns the edited state with `saved: false` and its
save error; retry retains the format and does not author a duplicate operation.

## Native interaction

Both toolbars expose bold, italic and a paragraph-style menu. macOS Cmd+B/Cmd+I
dispatch through the text responder to the same command. Formatting preserves
selection, focus and scroll position. Pending input, marked text, recovery and
failed drafts guard the actions. Unsupported operations surface their reason
without making the editor unusable. Heading 1/2/3 use 28/24/20 point styles.

## Acceptance and limits

- Six Rust document tests cover selection toggling, actual tags/levels, typed
  metadata, comments, history, cold reopening and atomic refusal.
- The document acceptance runner exchanges actual format updates with installed
  Yjs, checks one undo across two Unicode paragraphs, links, unknown metadata,
  heading levels and paragraph clearing, duplicate delivery and fresh reopening.
  The old peer edits after receiving the new structure; this does not prove late
  edits against deleted physical parents.
- Two bridge tests use real workspace SQLite: format/history/reopen and
  refusal/continued input/receipt failure/retry without duplicate writes.
- Programmatic AppKit checks both views' real text attributes, selection,
  heading sizes, history, links/comments, reopen and usable input after refusal.
- Hosted UIKit checks selection, actual fonts, history, body reset, links/comments,
  composition guards and SQLite reopen. The simulator writing UI scenario uses
  the heading menu and checks its value after process restart.

Exact source identities, counts and outcomes are generated in
[document](acceptance/p2a-document.json), [workspace](acceptance/p3a-workspace.json),
[binding](acceptance/p2b-binding.json) and [native](acceptance/p2b-native.json)
reports. Existing authoring and process-recovery evidence is refreshed for the
changed core. No new performance matrix is part of this batch.

The completed run passes 138 document tests, 29 bridge tests, 63 programmatic
AppKit cases and 266 total Rust authoring tests with 80 renderer comparisons.
Both iPhone and iPad pass 14 hosted binding cases and two UI workflows. Mac,
simulator and unsigned device builds pass. Targeted CUA on the freshly rebuilt
Mac app observes Cmd+B, the italic button, heading 2, selection-preserving
undo/redo and bold/italic/heading persistence after quitting and restarting.
The attended record includes source and binary hashes in ignored
`.local-data/apple-native/editor-format/macos-observation.json`.

Desktop XCTest, physical IME/device, real accounts and signed distribution remain
separate gates. The six known old-peer alias-delete failures and the existing
late-parent retention guard remain open; local format acceptance does not certify
the affected remote path. Next connect the native outline while preserving
act/chapter/scene/beat/note semantics.
