# Storylines and chapter membership

The Mac client manages storylines (故事线) and which chapters belong to them,
with one primary storyline per chapter, through shared Rust commands that
write the renderer's rows and originals.

## Domain contract

- Create: the renderer's unique name (trimmed, “New Storyline” when empty,
  case-insensitive “ 2”, “ 3” suffixes), a host colour, an empty summary and
  body template, the project's storyline template facts cloned with fresh IDs,
  `entity.create` with seed `{color, name, nodeContentTemplateJson, summary}`, a
  Yjs seed for `storyline:<id>` and the storyline's order register. The first
  live storyline becomes every live chapter's primary, as in the renderer.
- Update writes `field.set` for changed `color`, `name` (kept unique) and
  `summary` (unchanged values write nothing, where the renderer journals every
  field it is passed); facts use the shared key/value authority; reordering writes
  `order.move` for inserts or one `order.rebalance` per storyline, and the local
  `order_key` becomes each live storyline's rank, as the local reducer projects.
- Membership is the renderer's OR-set on each storyline (`membership`, member =
  chapter) plus the chapter's `node-storyline-primary` register;
  `node_storyline_link` is the local projection. Setting a chapter's storylines
  diffs its live tags per storyline in UTF-8 order (`set.add` with a null value,
  `set.remove` with the observed add tags) and always writes the primary. The
  primary follows `setNodeStorylines`: an absent primary keeps the current one
  (added to the list if missing), an explicit null clears it, and with no
  primary the first listed storyline becomes primary.
- A reorder stamps the moved storyline's `updated_at`, as the renderer's
  `updateStoryline` path does.
- Trash removes all links of live chapters whose primary it was and its links
  from other chapters (a trashed chapter's link silently, as the renderer's store
  only holds live chapters), projects each affected live chapter, then writes
  `entity.trash`.
  Restore reauthors the seed, its order among live rows (placed by its last
  numeric order, as the renderer plans it) and the full body in the next
  incarnation; links are not restored.
- Chapter trash keeps its links; chapter restore re-adds its memberships in the
  new incarnation (see [chapter trash](chapter-trash.md)).

Relations to storylines are refused for trash and restore until relations are
ported. No SQLite migration is added.

## Native interaction

“故事线” (action row and 编辑 › 故事线, ⇧⌘L) opens a panel of live storylines
in their authored order, each with a colour dot, name, summary line and chapter
count (“N 章 · 主线 M”), and a 回收站 section whose rows have 恢复. 新建故事线
asks for an optional name (the first one's prompt says it becomes every
chapter's 主线) and opens the new page with its name selected. Dragging a row,
or 上移/下移 in its context menu, writes `moveStoryline`; a drop in place writes
nothing. The context menu also has 打开页面, 重命名…, 更改颜色 (the shared
palette), 编辑简介… and 移到回收站…, which first explains that chapters whose
主线 it is lose all their storylines (becoming 未归属), other chapters lose only
this one, and restore does not link chapters again. A row click opens the page
on mouse-up, so a drag never opens it.

A storyline opens as a “故事线 · 名称” tab beside chapter and element tabs, in
either split pane. Its header, on a wash of the storyline colour, edits 名称
(Rust's unique name is shown after the commit, e.g. “ 2”), 颜色 (palette, plus
the stored colour when Rust chose one outside it) and 简介, then 字段 with the
element page's facts editor (`setStorylineFacts`). A refusal keeps typed text
and rows. Below it, 章节 lists the storyline's chapters in book order, marking
those whose 主线 it is; a row opens that chapter in the page's pane. The body
is an ordinary durable owner with its own history and no comments. Reopening a
storyline page from disk is disabled because `openStoryline` has no reopen flag.

“故事线…” in a chapter's outline 操作 menu, or the sidebar chapter list's context
menu, opens a sheet with a checkbox per live storyline and a 主线 radio enabled
only for checked rows. Checking the first storyline makes it 主线; unchecking
the 主线 passes it to the first remaining storyline in list order; clearing all
leaves the chapter 未归属. 保存 writes `setChapterStorylines`; 取消 writes nothing;
a refusal (for example a chapter trashed meanwhile) keeps the choice. Outline
chapter rows and sidebar chapter rows lead with a dot in the 主线 colour (hollow
for 未归属) and the outline also names it; no inset accent bars are used.

Every command reply's complete library updates the panel, open pages, the
outline and the sidebar. Chapter create, move, trash and restore re-read the
library, since memberships follow live chapters in book order.

## Acceptance

`pnpm apple:workspace-storyline:acceptance` generates
[the storyline report](acceptance/p3g-storylines.json): core and bridge suites,
renderer use cases authoring the same originals on the same databases, and
production reducer replay with table parity. Three programmatic AppKit cases
in the [binding report](acceptance/p2b-binding.json) drive the real panel,
outline, sheet and pages, wired as the app wires them: the first storyline
created in the panel becomes every chapter's 主线 and the outline shows its
colour; a second storyline, panel and page renames with unique suffixes,
recolour, summary, drag and 上移/下移 reorders follow in pages, tabs and cold
reopen; the chapter sheet adds and removes storylines, moves and clears 主线,
cancels without writing, and outline dots and page chapter lists follow and
survive cold reopen; storyline trash (after its explanation) applies the 主线
rule and closes only its page, restore keeps chapters unlinked with body and
facts intact, chapter trash and restore keep memberships, a stale sheet save is
refused without a journal row, and page body and facts survive cold reopen.
Physical input, the sidebar context menu, desktop XCTest and devices are not
covered.
