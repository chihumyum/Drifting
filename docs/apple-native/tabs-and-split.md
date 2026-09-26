# Native chapter tabs and split editing

This batch connects the existing shared document binding to the Mac writing
workspace. It follows whole-book outline navigation (`94a9e6f9`). The bounded
scope is retained chapter tabs and at most two editor panes in one window;
UIKit keeps its single-editor navigation. Saved window layouts, additional
windows and an expanded iPad workspace remain later work.

## Ownership and transitions

The Apple workspace keeps one Rust document handle for each open
`(projectId, chapterId)`. Opening an existing chapter verifies its current scope
and reuses the owner; loading a new chapter does not evict other chapters.
Each owner keeps its own prose, local undo/redo history and persistence state.
Outline reads use any already-open chapter owner before loading a temporary
read-only copy. No database migration or second prose persistence path is added.

Swift holds exactly one `LabCore` for each live handle. Tabs retain their native
view and binding when hidden, preserving selection and scroll position. Two
panes displaying the same chapter share the existing `DocumentStore` and Rust
history, with independent view identities and selections. Different chapters
retain independent owners. The focused pane determines editing commands,
formatting, saving and outline navigation.

The second pane receives half the available editor width when first created.
Later tab changes preserve the user's divider position. Window-backed acceptance
checks both editor panes have usable visible widths; the programmatic document
checks alone cannot establish this layout behavior.

Closing a tab or pane is distinct from closing its chapter owner. A remaining
view must stay usable. The last view releases its owner only after the existing
save/draft guards succeed; a failed close retains the view and recovery controls.
Workspace close prepares every open owner before releasing any of them. Explicit
disk reopen names its project and chapter and replaces only that owner; it is
unavailable while that chapter has two views. Queued input, marked composition
and failed drafts cannot be discarded by hiding or closing a view.

Input submission guards are distinct from TextKit editability. While native
marked text exists, a recovery-state change must not toggle `isEditable` and
cancel that composition. The shared binding continues to guard submission and
retain the draft until recovery or an explicit native commit.

## Bounded acceptance

The agreed scenarios are:

- A → B → A retains each tab's view, selection and local history; the chapters'
  contents remain independent and survive cold reopening.
- Two panes of one chapter share edits and history while keeping separate
  selections; closing one leaves the other editable.
- Queued input, marked composition and failed saving block destructive close
  or reopen. Retry completes without losing the draft, and a later cold open
  recovers the saved content.

Bridge tests exercise the real registry and file-backed owners. Programmatic
AppKit acceptance uses the actual workspace coordinator and native views.
Attended Mac interaction verifies tab, focus, split and close controls on a
fresh build. Existing iPhone/iPad writing workflows verify the shared lifecycle
change without claiming mobile split support.

The generated [workspace](acceptance/p3a-workspace.json),
[binding](acceptance/p2b-binding.json) and [native](acceptance/p2b-native.json)
reports own exact source identities and outcomes. Physical IME, physical devices,
accounts, minimum-OS execution and signed distribution remain separate gates.
No new performance matrix or historical-format migration is part of this batch.

The completed programmatic run passes all 68 AppKit cases, including the three
workspace scenarios, and all 34 bridge cases. Shared workspace acceptance also
passes 14 core cases, 16 bridge workspace cases and existing renderer journal
comparisons. Integration caught and repaired two regressions: recovery activity
cancelling marked text, and a zero-width second pane. The original recovery cases
remain required, and the split case now mounts a sized `NSWindow` and verifies
both visible editor widths and retention of a manually moved divider.

Attended CUA on a fresh Mac build verifies A → B → A and local undo/redo,
same-chapter edits appearing in both visible panes, a left-pane history action
leaving the right pane's different chapter unchanged, closing the right pane and
continuing input, closing/reopening the last tab, and both chapters' exact text
after quitting and relaunching. The ignored
`.local-data/apple-native/tabs-split/macos-observation.json` records the runtime
and complete bundle fingerprints, including the Debug dylib. This is targeted
desktop interaction, not desktop XCTest or physical keyboard/IME evidence.
