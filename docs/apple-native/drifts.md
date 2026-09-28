# Drifts

Drifts (漂流) are free-floating notes outside the book order: a `book_node`
with `kind='drift'`, no book order and no storylines, and its own prose body.
The Mac client creates, renames, groups, trashes and restores them, organises
them in drift groups, binds a drift to an act boundary as that act's notes,
and converts a drift into a chapter or an element.

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

Drift trash purges the drift's [relations](relations.md) inside its trash
original; restore does not bring them back. No SQLite migration is added.

## Conversions

- `workspaceDrifts {"action":"convertToChapter","driftId","storylineId"?}`
  makes the same node a chapter in one original: 草稿, appended after the
  last chapter, out of its group, primary in the storyline when given, its
  timeline markers (keeping their caption, or taking the title) and act
  released; a title a chapter already uses is numbered. Body, summary,
  relations and [情节规划格](plot-planner.md) stay. An open drift body is
  saved and released first; the chapter opens its own owner. Word-count reads
  bracket it, so it never counts as today's writing.
- `workspaceDrifts {"action":"convertToElement","driftId","categoryId"}` →
  `{element, driftId, carried: {relations, skippedRelations, comments}}`:
  creates the element (name and summary from the drift, the category's
  template facts) and copies the drift's full body into it as the author's
  input. One more original then re-creates each relation touching the drift
  on the element where the relation type allows an element end (an
  identical edge counts as carried) and moves notes and TODOs on the whole
  drift to `element:<id>` (`field.set`). Last the drift is trashed
  (unbinding markers and acts, purging its relations, so the
  `skippedRelations` are deleted). Notes anchored in the drift's text, its
  version history, 情节规划格 and patch sources stay with the trashed drift
  and come back when it is restored. An element name or alias conflict is
  refused before anything is written. Every failure after the element exists
  starts with “设定「名称」已创建”: `，但灵感正文未能复制：…`,
  `并复制了正文，但关系和批注未能转移：…` or `并复制了正文，但灵感未能移入回收站：…`;
  only the last comes after Rust released the drift's open body.

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
drift's tabs close, so queued input refuses it and keeps everything; a
情节规划格 cell being edited is committed and its gestures answered first
([plot planner](plot-planner.md)).

In the whole-book outline an act row names its bound notes after the act name;
clicking them opens the drift page. The act's 操作 menu adds 绑定幕笔记… (更换幕笔记…
when bound), a picker of drifts not yet bound to any act, and 解除幕笔记. Chapter
prose links drift titles as `node` links in the default link colour with a
“漂流 · 标题” preview; ⌘-click or 打开「标题」 opens the drift page, and a trashed
drift's links dim until it is restored.

Every command reply's complete library updates the panel, open pages, entity
links and the outline. Act create, rename and remove re-read act names and the
drifts, since removing an act releases its notes.

转为章节… and 转为设定… are in a drift page's 操作 menu and the panel's drift
menu. 转为章节… asks for the primary storyline (the first one, or 无主线) and
names what is released; 取消 writes nothing. The drift's tabs become the
chapter's in the same places with the same body and planner (a drift not
open opens as a chapter in the active pane); the chapter list, 整书大纲,
全书长卷, story graph, 底部时间轴, storylines and the 漂流 panel follow.
转为设定… asks for the category (refused in Chinese when there is none) and
says what moves (标题、摘要、正文、关系类型允许设定的关系、整篇漂流上的批注和待办;
other relations are deleted) and what stays with the drift in the trash
(正文里锚定的批注、历史版本、情节规划格、补丁来源, back on restore). The drift's
tabs close, the element page opens where it was shown, and the status line
and the panel report what was carried, leaving out zero parts
(已转为设定「灯塔」：转移了 2 条关系、1 条批注和待办；1 条关系的类型不允许设定，已随漂流删除。).
The 设定库, 回收站, act notes, every 关系 section, the 设定总览's relation
edges, 审阅 and the board follow (the story graph shows no relations).
Refusals, including Rust's name conflict (“灯塔”已被设定“灯塔”使用…), show on
the page or in the panel with nothing written. A conversion that stopped
after the element was created shows Rust's message as it is, reads the
设定库, the drifts and their trash, the relations and 审阅 again, and keeps
the drift's tabs unless the drift is in the trash; when Rust already
released the body (a failed trash) the tabs show it opened again in the same
places. Both conversions commit a 情节规划格 cell being edited and wait for
the drift's queued gestures first.

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
keeping the drift. Three more cases in `native/apple/Tests/PlotConvertAcceptance.swift`
(`--plot-convert-only`) convert from the page and the panel with every view
following and the journal pinned (one original for 转为章节; element, body
copy and trash for 转为设定), 取消, and the name-conflict refusal with nothing
written; and convert a drift with an element-capable relation, a node-only
one, a whole-drift TODO and a passage note: the dialog, the carried counts
and report, the carry original, the element's and chapter's 关系 sections,
the 设定总览 and 审阅 following, and the passage note back on restore. Rust's
failures after the element was created cannot be provoked from the app, so
an injected message drives their handling: the tab kept, a released body
reopened in place and a trashed drift's tabs closed, with the lists read
again. Physical input, desktop XCTest and devices are not covered.
