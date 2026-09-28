# Native chapter tabs and split editing

Retained tabs and at most two editor panes in one window, first delivered in
`791cbb62`; tab management, 后退/前进 and per-project restore on relaunch
followed. UIKit keeps its single-editor navigation. Additional windows, the
divider position across launches and an expanded iPad workspace remain later
work. Native only; no Tauri interoperability is kept.

## Ownership and transitions

The Apple workspace keeps one Rust document handle for each open
`(projectId, chapterId)`. Opening an existing chapter verifies its current scope
and reuses the owner; loading a new chapter does not evict other chapters.
Each owner keeps its own prose, local undo/redo history and persistence state.
Outline reads use any already-open chapter owner before loading a temporary
read-only copy. No database migration or second prose persistence path is added.
A tab's target is a chapter or an [element page](element-library.md); element
owners are keyed separately as `(projectId, elementId)` and follow the same
retained-view, split, close-guard, reopen and save rules. Chapter-only features
(comments, outline, search, chapter trash) are unavailable on element tabs.

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

## Tab management

A pane's strip shows its 项目主页 tabs, then its body tabs. A tab's context
menu (right-click or ⌃-click on it) offers 关闭, 关闭其他, 关闭右侧全部 and 全部关闭,
then 移到另一侧 and 解除分屏 with two panes, or 在另一侧打开 with one. Every close
goes through the close path above (header edits saved, 情节规划格 gestures
answered, owners saved before they close); a batch closes left to right and
stops at the first tab that cannot, saying “标题”无法关闭：… with the
reason, while the tabs already closed stay closed. Closing the shown tab (×,
关闭, ⌘W) shows the tab after it, or before it when it was last.

- 在另一侧打开 opens the page in a new second pane on the same owner.
- 移到另一侧 moves the tab with its view (selection, scroll, local history);
  when the other pane already has the page, that pane's tab shows it and this
  one goes. 解除分屏 moves the second pane's tabs after the first's the same
  way, keeps the page the active pane showed and closes no owner; first, as
  closing would, the second pane's header edits are saved and its 情节规划格
  gestures answered, and a refusal keeps both panes and says why. 关闭分栏
  still closes the second pane's tabs.
- 视图 › 上一个标签 (⌥⌘←) and 下一个标签 (⌥⌘→) cycle the active pane's tabs.
  文件 › 关闭标签 (⌘W) closes the shown tab of the main window's active pane.
  When that pane shows none but a pane still has tabs (open, restored or a
  项目主页), that pane becomes active and shows its tab instead; the main
  window closes only without any tab. Other key windows (a panel, 设置, the
  shelf) close.
- Dragging a body tab along its strip drops it before the first tab whose
  middle is right of the pointer; owners, views and the shown tab stay.

## 后退 and 前进

视图 › 后退 (⌘[) and 前进 (⌘]) step through the pages the window showed
(chapter, drift, element, category, storyline, 项目主页), each in the pane
that showed it, like a browser: opening or switching to a page, or to the
other pane, records it; a new visit after 后退 drops the pages ahead; at most
100 are kept. A page whose tab was closed opens again in its pane, or in the
active pane once that pane is gone. Pages that were trashed or purged, and
the page already shown, are skipped; a page that no longer opens leaves the
history. The usual guards apply (queued or marked input, 情节规划格 gestures
on their way). Showing another project starts a new history; deleting one
drops its pages, its 项目主页 included.

## Restoring tabs

Each project's tabs are kept in `settings.json` (`tabSessions`, identities
only): each pane's body tabs in order, the one it shows, its 项目主页 tab and
whether the split is shown. They are saved half a second after tabs, their
order, the shown tab, the split or the active pane change (typing changes
none); quitting saves them as they are and closing them to quit saves
nothing. Showing a project (the project list, the 项目书架, creating or
deleting a project) first reads its chapters (a failed read keeps the
project shown before, tabs and all), then saves and closes the tabs of the
project shown before through the close path, open ones first; a tab that
cannot close keeps that project shown with its unopened tabs and 项目主页,
is named and saves nothing. Its own tabs then come back, and navigation
waits until they have: every tab in its place,
while only each pane's shown tab opens its body; the others open theirs, in
place, when selected. Pages that no longer exist (trashed, purged, a deleted
project's) are left out silently; restoring records no 最近 and writes
nothing to the journal. A restore never erases the stored tabs: pages of a
list that could not be read (reported as 部分标签未能恢复) stay in every later
save of the project, each after the page it followed, until a restore
completes or the author opens one (it is theirs again: closing it leaves it
out, also when it opens and closes between two saves); a restore refused while navigation is held keeps the stored tabs
in every save and runs again once navigation is possible, unless the project
has tabs by then; one overtaken by another switch saves nothing. At launch the project selected last (`lastProject`)
opens with its tabs; without one, or once it is gone, the 项目书架 opens.

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

Seven `--tabs-nav-only` cases in `native/apple/Tests/TabsNavigationAcceptance.swift`
([binding report](acceptance/p2b-binding.json)) drive the real tab host,
panes, tab buttons, menu layout, settings store and tab session: 后退 and 前进
across kinds and panes (also by ⌘[ and ⌘]), a closed tab and a gone pane, a
trashed and a purged page skipped, the guards, a new history per project;
every context-menu command with a 情节规划格 refusal in the middle of 全部关闭,
⌥⌘← ⌥⌘→ and ⌘W through the menu, drag reorder by synthesized mouse events;
saving (coalesced, not while typing), a cold relaunch with only the shown
tabs opened, dropped pages, unreadable entries, a deleted project and the
last project; switching projects and back with a refusal naming the tab; no
journal rows from navigation, restore or switching; 解除分屏 saving the
right pane's unsaved 摘要, element name and 情节规划格 cell and a refused cell
keeping both panes; ⌘W showing another pane's tab or a restored one instead
of closing the window; a refused and an overtaken restore and a refused
switch leaving the saved tabs, unopened tabs and 项目主页 as they were, a save
during the refusal keeping them and the refused restore running once
navigation is possible; a restore whose drift list cannot be read keeping the
drift at its place through a later save until a complete restore brings it
back, and a drift opened and closed after such a restore staying out of the
stored tabs; and a forgotten project leaving 后退. The chapter read before closing, and holding
navigation until the tabs are back, are AppDelegate wiring outside these
headless cases.
