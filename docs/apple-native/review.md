# Review (审阅), TODOs and the 备忘与素材 board

审阅 lists the project's notes and TODOs; the 备忘与素材 board sets open TODOs
beside the 素材库's cards. TODOs and library items are associated (关联) with
chapters, drifts, elements, categories and storylines. Native only; no Tauri
interoperability is kept. No SQLite migration is added.

## Domain contract

- `workspaceComments {projectId, command}`: `list`; `create` with `kind`
  (`note`/`todo`), an optional `targetKind`/`targetId` (`node`, `element`,
  `category`, `storyline`; none makes a floating TODO, never a note), `body`
  and an optional `priority` (`low`/`med`/`high`); `update` with any of
  `body`, `kind` and `priority` (`null` clears it; absent fields stay; an
  unchanged value writes nothing; a floating TODO cannot become a note);
  `setResolved`; `delete`. `create` with `byAssistant: true` (the writing
  assistant's accepted `create_comment`) stores author kind `ai`, name
  写作助手 and source `api`. Every reply carries the result and every comment
  of the project, oldest first. Writes are `entity.create`, one `field.set`
  per changed field and `entity.purge` (after purging the comment's
  relations), in one original each.
- Selection notes are still created through the chapter's owner
  (`documentCreateComment`, ⌥⌘M); their anchors stay with that owner.
  Deleting one while its chapter is open makes the owner drop the anchor, so
  later saves never write it back.
- 关联 is the built-in Generic association (`system:generic-association:<projectId>`)
  from `comment` or `library_item` to a structural entity, through
  `workspaceRelations addRelation`/`removeRelation`. Deleting a comment or a
  library item purges its relations with it.

## Native interaction

审阅 (the action row, 视图 › 审阅, ⌥⌘R) opens a panel beside the editor.
全部/批注/待办 filter the kind. 当前 lists what concerns the focused tab's
chapter, drift, element, category or storyline: notes and TODOs on the whole
page first, then passage notes, then items associated with it, each newest
first. 全书 lists everything; without a tab 当前 reads as 全书. Open items
come first; resolved ones wait under 已解决（n）. Converted suggestions are
not listed.

A card reads its kind, priority, where it is written (“章节「雨夜」” or 浮动),
a passage's live anchor state and quote (from the open owner, else the
stored quote), 写作助手 when the assistant wrote it (still editable), the body
and its 关联 chips. 定位 opens the page as a tab; a
passage note then selects its anchored text in that tab, as the comment
panel does. 编辑 opens the comment composer. 解决/重新打开 changes the state.
⋯ offers 优先级 (无/低/中/高, the current one checked), 转为待办/转为批注
(disabled for a floating TODO), 关联 (the project's live pages by kind,
leaving out those already associated), 移除关联, 编辑… and 删除…, which
confirms first. A passage note is not deleted while its chapter has input in
flight; once deleted its highlight leaves every open view of the chapter.

新建批注… and 新建待办… open a sheet with the kind, 位置 (当前 page, or 浮动
for a TODO), 优先级, 关联 chips and the body. A new TODO floats with the focused
page pre-associated, as in the renderer; a note needs a page. 当前 is the page
focused when the sheet opens: 创建 writes on that page even if another tab is
focused meanwhile. If that page was trashed or deleted meanwhile, 创建 is
refused naming it (“漂流「旧信」已不可用（可能已移到回收站），批注没有创建。”).
A refusal (an empty body, a missing page, Rust's messages) keeps everything
typed.

The chapter's own 批注 panel (编辑 › 批注列表, or 本章批注… in 审阅) keeps the
anchor view of selection notes and shows notes written on the whole chapter
as 整章. Changes in either panel reach the other.

备忘与素材 (视图 › 备忘与素材, ⌥⌘T, or 看板… in 审阅) is a panel over the
window: kind chips 待办, 图片, PDF, 链接 and 文字 with their counts show or hide
each kind; the TODO column has cards with 完成, the ⋯ menu and chips, and
已完成（n） lists finished TODOs with 重新打开 and 删除…; the right side is the
素材库's own list (import, links, notes, Quick Look), with 关联 and drag
reordering ([library](library.md)).

## Not ported

- The sticky-note rail, Copilot suggestion acceptance and the board's search
  field, entity filter and 待整理 drawer.
- Inline editing on the card: the body is edited in the composer sheet.

## Acceptance

Eight programmatic AppKit cases in `native/apple/Tests/ReviewAcceptance.swift`
(`--review-only`; [binding report](acceptance/p2b-binding.json)) drive the
real controllers, tab host, Rust workspace and SQLite with synthetic data:
composing, filters and 当前 ranking with a changing focus; a sheet that writes
on the page it opened on after another tab is focused, and refuses a page
trashed while it is open keeping the text; priority,
resolve/reopen, 已解决 and the board's archive, conversion and body edits;
定位, deletion (a passage note in a chapter open in two panes, then typing, a
save and cold reopen); 关联 for TODOs and library items with a cold relaunch;
board chips and drag reordering; 幕颜色 ([act boundaries](act-boundaries.md));
and 删除项目 ([workspace](workspace.md)). Refusals are shown in Chinese with
nothing written. Physical input, desktop XCTest and panels on screen are not
covered.
