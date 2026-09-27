# Element patches (设定补丁)

A 设定补丁 records how an element changes from a point in the story: a
title, a plain-text body and, when made from a chapter or drift selection,
the text it is anchored to. Native only; no Tauri interoperability is kept.

## Domain contract

`workspacePatches` (`WorkspaceStore` in `drifting-core`) owns patches:

- A patch belongs to one live element and keeps its place in the element's
  ordered list (`element-patch` order registers). Creating one writes
  `entity.create` and its order originals; moves write order originals only
  when the order changes; deletion purges the patch's relations and writes
  `entity.trash`.
- The title is trimmed and stored as null when empty; `title: null` clears
  it. The body is plain text: blank lines split paragraphs and a single
  line break reads as a space. Title and body cannot both be empty
  (“补丁的标题和内容不能都为空”). An edit writes one `field.set` per
  changed field; an unchanged edit writes nothing.
- A patch made from a selection records the chapter or drift, the block
  holding the selection's start, that block's text and the selected text.
- Every chapter or drift body save rechecks that node's anchored patches:
  a patch is invalid while its anchor (white space collapsed) is missing
  from the body text, and valid again when it returns. Only transitions
  write, one `field.set invalidatedAt` each; the save never fails for it.
  Hosts only read patches again.

No SQLite migration is added.

## Native interaction

An element page shows 补丁 between 关系 and 被引用: the patches in order, each
with a drag handle, its title, 已失效 while its anchored text is gone (on a
tinted wash, no edge accent), a ⋯ menu (编辑…, 上移, 下移, 删除…), the source
(来自“章名”, 无章节归属, or 来源章节已删除), the anchored text and the body.
Title and body are edited in place and saved when editing ends; a refusal
keeps the typed text with Rust's reason. 新建补丁… and 编辑… open a prompt
with both fields. Dragging a handle shows where the patch will go and sends
one move. 删除… asks first. The rows scroll inside the section beyond a
bounded height. Every page of the element follows each reply.

The source link opens the chapter (or drift) in the page's pane and selects
the anchored text while it is still there, preferring the recorded block;
once it is gone the page just opens.

新建补丁… in the prose context menu of a chapter or drift (tabs and the
全书长卷) appears for a non-empty selection. Its sheet quotes the selection,
searches elements by name and alias, offers 创建设定「名称」 in a chosen
category (written at once, reaching the 设定库 and link names), and takes an
optional title and the body; nothing else is written until 创建补丁.

After a chapter or drift body is saved at a new revision, open 补丁 sections
of the project read their patches again (debounced), so 已失效 appears and
clears as the author deletes the anchored text or undoes it.

## Acceptance

Three programmatic AppKit cases in `native/apple/Tests/PatchAcceptance.swift`
(`--patches-only`; [binding report](acceptance/p2b-binding.json)) drive the
real page, coordinator, tab host, sheet, Rust workspace and SQLite: floating
patches created, edited in place and through 编辑…, refused, dragged and moved
through the menu, deleted after confirmation, followed by a second pane and a
cold relaunch, each checked against the journal; patches from a chapter and
a drift selection with alias search and element creation; and validity after
deleting the anchored text, after undo and after a cold relaunch, with the
source link's selection. Core and bridge tests cover the Rust commands.
Physical input, desktop XCTest and a sheet on screen are not covered.
