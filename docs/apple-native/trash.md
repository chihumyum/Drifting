# 回收站 and permanent deletion

One trash per project lists every trashed chapter, drift, element, category
and storyline. Moving to the trash and restoring stay each kind's own
commands ([chapter trash](chapter-trash.md), [elements](element-library.md),
[categories](categories.md), [drifts](drifts.md), [storylines](storylines.md));
this page adds the unified list and 彻底删除. Native only; no Tauri
interoperability is kept.

## Purge contract

- `workspacePurgeTrashed {handle, projectId, kind, id}` (`chapter`, `drift`,
  `element`, `category`, `storyline`) removes one trashed entity and what only
  it owns in one original: comments written on it (with their relations),
  its facts, an element's patches, its Yjs body, revisions and version
  history. The lifecycle moves from `trashed` to `purged`; earlier originals
  stay in the journal. Live content is refused (“只有回收站里的内容才能彻底删除”)
  and so is an open page (“请先关闭这一页，再彻底删除”), writing nothing.
- `workspaceEmptyTrash {handle, projectId}` purges everything in the project's
  trash in one original. Both reply `{purged:[{kind,id,documentId}],
  trashed:[{kind,id}]}`, the latter being what remains.
- Nothing rewrites prose. A link mark to a purged entity stays in the bodies
  that hold it; the host's link directory no longer resolves it, so it reads
  as plain text: no colour, no hover card, no click ([entity links](entity-links.md)).
- The list's trash time is each row's `updatedAt`, which trash stamps with
  `deleted_at`. Replies carry no `deletedAt`, so a later change to a trashed
  row (trashing its category detaches a trashed element too) moves it.

## Mac interaction

视图 › 回收站 and 项目 › 回收站 (also the project list's menu) open a panel of
the project's trash: 类型, 名称 and 移入回收站 in a table, newest first, with a
显示 filter by kind whose items show counts. 恢复 runs the kind's restore
command through the tab host: its reply reaches the 设定库, 漂流 and 故事线
panels, the chapter list's own trash, pages and links, exactly as a restore
from that panel does, and nothing opens. 彻底删除… asks, naming the item and
what goes with it; 清空回收站… asks with the counts by kind. After a purge the
host reads the kind's list again, reloads relations, patches and 被引用, and
the 审阅 notes. The panel follows trash and restore made anywhere else,
because every library and chapter list the host adopts passes through it.
Queued or marked input holds every command with a Chinese reason.

## Acceptance

Two programmatic AppKit cases in the [binding report](acceptance/p2b-binding.json)
(`--trash-shelf-only`) drive the panel, the tab host and the panels' models
wired as AppDelegate wires them: the listing order, kinds, times and filter; a
trash elsewhere reaching the open panel; 恢复 of each kind in one original with
its own list following and no tab opened; 取消, Rust's refusals for live and
open content and marked input writing nothing; an element purged with its
TODO, fact, patch, body and history in one pinned original and the rows gone;
the link to it plain yet unchanged in the prose; 清空回收站 in one pinned
original; and a cold reopen. Rust suites cover the ABI in
`workspace_purge_tests.rs`. The panel's sheets and physical input are not covered.
