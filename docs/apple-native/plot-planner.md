# Plot planner (情节规划格)

A small grid of author-named rows and columns with text cells, docked below
the prose of a chapter or drift page. It belongs to the node, beside its
prose and never derived from it: it does not touch the Yjs body, its undo
history or word counts. Native only; no Tauri interoperability is kept.

## Domain contract

- `workspacePlotGrid {handle, projectId, nodeId, ops?}` without `ops` reads
  `{grid: null | {nodeId, cellWidth, cellHeight, rows:[{id,label}],
  columns:[{id,label}], cells:[{rowId,columnId,value}]}, created: []}`;
  `null` means the node has never been edited. With `ops` it applies them in
  order in one original and replies the same shape; any refusal rolls the
  whole batch back.
- Operations (`op`): `setSize {width 120–440, height 56–380}`, `addRow {id?,
  label, after?}`, `setRowLabel`, `moveRow {rowId, after?}`, `removeRow`
  (purges its cells), the same four for columns, and `setCell {rowId,
  columnId, value}` (at most 10,000 characters; empty clears the cell).
  `after` omitted means first. The Mac supplies its own row and column ids,
  so later operations of a batch can name them.
- Normalized `plot_grid_*` rows are the truth; `node_content.plot_grid_json`
  is rebuilt after every write. Chapters and drifts only; a trashed node
  refuses. Purging the node purges its grid (journaled), and 转为章节 keeps it
  ([drifts](drifts.md)). No SQLite migration is added.

## Native interaction

The page header's 情节规划格 button and 视图 › 情节规划格 (⌥⌘G) show or hide
the dock for the active chapter or drift page, in every pane showing that
page. Shown or hidden and the dock height are remembered per page in the
lab's `settings.json` (`plotPlanners`, keyed by project, then node), never in
the journal; project deletion and 彻底删除 of the node forget them. The dock's
top edge drags to resize it (140–640 points).

The dock header has 添加行, 添加列 (after the selected row or column, else at
the end; the new header is then edited), the cell width and height sliders
within Rust's limits, and 隐藏. A node without a grid shows an unsaved blank
3×3 template; the first edit writes it, as it then looks, in one original.

- **Cells.** A click or Return edits a cell in place; Return commits, ⌥Return
  starts a new line, Tab and ⇧Tab commit and edit the next or previous cell
  (wrapping rows), Esc cancels. With the grid focused, the arrows, Tab and
  ⇧Tab move the selection, typing starts an edit, Delete clears the cell and
  ⌘C copies it. Leaving the editor (a click elsewhere, hiding the dock,
  closing the tab) commits it.
- **Headers.** A double-click or 重命名 renames (trimmed); dragging a header
  or 上移/下移 (左移/右移) reorders; 在上方/下方插入一行 (左侧/右侧插入一列)
  inserts; 删除此行/此列 removes it at once when empty and asks first when its
  cells hold text. The last row and column stay.
- **Paste.** Tab-separated columns and line-separated rows pasted on the grid
  or into a cell editor fill cells from that cell, adding rows and columns at
  the end as needed, in one command.

Each gesture is one `workspacePlotGrid` call with the operations it needs;
operations that change nothing are dropped and an unchanged edit writes
nothing. Gestures run in order and show at once. A refusal shows Rust's
Chinese reason in the dock, drops the gestures queued behind it and reads the
grid again. Every dock of the same page shares one model, so two panes follow
each other; the grids are read again when a dock is shown, when the window
becomes key and after a received original.

## Acceptance

Four programmatic AppKit cases in `native/apple/Tests/PlotConvertAcceptance.swift`
(`--plot-convert-only`; [binding report](acceptance/p2b-binding.json)) drive
the real tab host, pages, dock and grid canvas with synthesized clicks, key
presses and header drags over the Rust workspace, SQLite and `settings.json`:
the toggles and their persistence; the template written by the first edit;
keyboard editing with Tab, ⇧Tab, arrows, ⌥Return, Esc and Delete; unchanged
edits writing nothing; rows and columns added, renamed, moved by menu and
drag and deleted with and without confirmation, each pinned to its journal
original; a pasted block as one original; sizes within the limits and the
refusals of an out-of-range size and an over-long cell restoring the grid;
two panes following; a grid written elsewhere read again; a drift's own
planner; the dock height; the prose's text, revision, undo history and word
counts unchanged; a cold relaunch; and 彻底删除 of a drift. Rust suites cover
the ABI in `workspace_plot_grid_tests.rs`. A dock on screen, physical input
and desktop XCTest are not covered.
