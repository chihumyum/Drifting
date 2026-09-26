# Drifts

Drifts (漂流) are free-floating notes outside the book order: a `book_node`
with `kind='drift'`, no book order and no storylines, and its own prose body.
The Mac client creates, renames, groups, trashes and restores them, organises
them in drift groups, and binds a drift to an act boundary as that act's notes.

## Domain contract

- Create writes the renderer's seed `{bookOrder: null, driftGroupId, kind:
  "drift", narrativeOrder: null, summary: "", title, writingStatus: "drifting"}`
  and a Yjs seed for `node-content:<id>`. Titles share one case-insensitive
  namespace with chapters (“New Drift”, “New Drift 2”, …). The graph position is
  local-only: native uses 0,0 where the renderer scatters it randomly.
- Edits follow the renderer's three paths: a title alone is `renameNode` (a
  colliding title gains “ 2”, `updated_at` advances at least 1 ms), a group alone
  is `moveDriftToGroup` (wall-clock stamp), and both together are `updateNode`
  (title kept as given, both fields journaled). Unchanged edits write nothing.
- Binding writes `field.set` on the act's `driftNodeId`; a drift binds to at most
  one act.
- Trash first unbinds the drift's timeline markers and acts (rowid order), each
  kind in its own original when any are bound, then writes `entity.trash`, as the
  renderer's delete path does. A marker also journals its `label`; a blank one
  takes the drift title (or “Marker”). Restore reauthors the seed, the graph position and the full
  body in the next incarnation; bindings are not restored.
- Groups: create writes `{color: null, name, parentGroupId}` (an empty name
  becomes “新分组”) and plans its order in the parent scope
  `["<project>", parent]`; groups nest one level (`MAX_DRIFT_GROUP_DEPTH`).
  Rename writes `field.set name` (a blank name becomes “新分组”). Deleting a group
  lifts its subgroups to its parent (`field.set parentGroupId`), rebalances that
  scope, moves its drifts to the parent group in id order and purges it; no
  drift is lost. The local `sort_order` is the
  rank in scope, as the local reducer projects.
- Chapter prose links drift titles like chapter titles
  ([entity links](entity-links.md)).

Relations to drifts are refused for trash and restore until relations are
ported. No SQLite migration is added.

## Native interaction

“漂流” (action row and 编辑 › 漂流, ⇧⌘D) opens a panel of root groups in their
authored order, each followed by its subgroups and then its drifts, then 未分组
drifts and a 回收站 section whose rows have 恢复. Nesting is shown by spacing and
weight only; a group row (or its ▸/▾) folds it, and a drift that is an act's
notes shows “幕笔记 · 幕名” under its title. 新建漂流 and 新建分组 ask for an
optional title or name (Rust's defaults and unique “ 2” suffixes apply); a new
drift opens as a page with its title selected. A drift's context menu has 打开,
重命名…, 移到分组… (未分组 or any group, subgroups named “父 / 子”) and 移到回收站,
which first explains the unbinding when the drift is an act's notes. A group's
menu has 新建漂流 (in that group), 新建子分组… (disabled with the reason on a
subgroup; a stale request shows Rust's refusal and writes nothing), 重命名… and
删除分组…, whose confirmation says where its drifts and subgroups move.

A drift opens as a “漂流 · 标题” tab beside chapter, element and storyline tabs,
in either split pane. Its header on a neutral wash edits 标题 (trimmed; an empty
title is refused locally; Rust's unique title is shown after the commit) and
分组 (a popup), and names the bound act under 幕笔记. The body is an ordinary
durable owner with its own history and no comments; reopening from disk is
disabled because `openDrift` has no reopen flag. Trash commits before the
drift's tabs close, so queued input refuses it and keeps everything.

In the whole-book outline an act row names its bound notes after the act name;
clicking them opens the drift page. The act's 操作 menu adds 绑定幕笔记… (更换幕笔记…
when bound), a picker of drifts not yet bound to any act, and 解除幕笔记. Chapter
prose links drift titles as `node` links in the default link colour with a
“漂流 · 标题” preview; ⌘-click or 打开「标题」 opens the drift page, and a trashed
drift's links dim until it is restored.

Every command reply's complete library updates the panel, open pages, entity
links and the outline. Act create, rename and remove re-read act names and the
drifts, since removing an act releases its notes.

## Acceptance

`pnpm apple:workspace-drift:acceptance` generates
[the drift report](acceptance/p3h-drifts.json): core and bridge suites, renderer
use cases authoring the same originals (every original of a step, in order), and
production reducer replay with table parity. Three programmatic AppKit cases in
the [binding report](acceptance/p2b-binding.json) drive the real panel, pages and
outline, wired as the app wires them: groups, a subgroup and drifts created in
the panel, the nesting refusal without a journal row, panel and page renames and
moves with titles unique across chapters, folding, and group deletion lifting
subgroups and drifts through cold reopen; a drift page body with its own history
through cold reopen, chapter prose linking and retro-linking drift titles, ⌘-click
opening the page and a trashed drift's link dimming until restore; act notes bound
from the outline picker on the act row and page following an act rename, a stale
bind refused, queued input blocking the trash, trash unbinding and closing the tab
only after commit, restore returning it unbound, and unbinding or removing an act
keeping the drift. Physical input, desktop XCTest and devices are not covered.
