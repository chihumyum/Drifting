# Chapter comments

The Mac editor can comment on a selection, list the current chapter's comments,
locate one, edit its body and resolve or reopen it. Rows, anchors and canonical
originals use the shared Rust owners. Notes and TODOs outside a selection,
priorities, 批注↔待办 conversion, deletion and 关联 belong to the project's
[审阅](review.md); Agent suggestion handling is not ported.

## Domain contract

`WorkspaceStore` owns direct chapter comments (`target_kind='node'`,
`target_id=<chapter>`), listed in the renderer's `created_at, rowid` order.
Creation writes a manual user note (`kind=note`, `source=manual`) and one
`entity.create` original with the renderer's complete 15-field comment seed.
The body uses a byte-for-byte port of `createPlainCommentDoc`. Editing a body
writes one `field.set` for `bodyJson`; resolving or reopening writes
`resolvedAt` then `status`. Unchanged values write nothing, and a `converted`
suggestion cannot be resolved or reopened here. Rows written before comment
lifecycles existed update at incarnation 0, matching the renderer's placeholder
normalization. Body and status writes never touch anchors, metadata or prose.
No SQLite migration is added.

## Anchors and the live owner

The document owner captures the anchor from its current projection at the
submitted revision. Surrounding whitespace is excluded, like the renderer's
trimmed selection. The payload keeps the renderer fields (`selectedText`,
`blockText`, `blockSnapshots`, `textAnchor`) and adds `nativeAnchorV1` sticky
positions; ProseMirror `selectionFrom/To` are not invented. A selection must
lie in editable blocks with stable identities.

The bridge commits the row and original first. Only then does the owner track
the same record, which also becomes its comment compare-and-swap baseline, so
a failed commit leaves anchors, baseline and prose history untouched. Adding a
comment is not an undo step. Later prose edits move anchors through the existing
checkpoint path; deleted text shows as changed or collapsed and never re-attaches
to equal text elsewhere.

## Native interaction

The Mac editor offers “添加批注…” (⌥⌘M) for a non-empty selection and a comment
panel (编辑 › 批注列表, or 本章批注… in 审阅) for the active pane's chapter, with anchor
status kept separate from open/resolved state. Notes written on the whole
chapter in 审阅 are listed as 整章, and TODOs as 待办. Deleting a passage note in 审阅
while its chapter is open makes the owner drop the anchor first; every view's
highlight leaves and later saves never restore it. Locating selects the current
anchor range in the active pane only. Body editing is enabled for manual notes;
other sources are shown read-only. UIKit is unchanged while mobile work is
deferred.

## Acceptance

`pnpm apple:workspace-comment:acceptance` generates
[the chapter comment report](acceptance/p3d-chapter-comments.json): core and
bridge suites plus actual native originals applied by the production TypeScript
reducer on independent SQLite copies. AppKit cases in the
[binding report](acceptance/p2b-binding.json) cover two same-chapter views,
locate, body/status history and cold reopen. Physical IME, desktop XCTest input
and devices are not covered.
