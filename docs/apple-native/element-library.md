# Elements library

The Mac client has a 设定库: element categories and elements, with each
element's page (name, aliases, summary, group, category, facts and prose body)
opening in the existing tab and split workspace. Categories have pages and body
templates of their own ([categories](categories.md)); portraits live in the
[materials library](library.md); element pages list their
[patches](patches.md); element and category trash purge their
[relations](relations.md).

## Domain contract

`WorkspaceStore` owns categories and elements with the renderer's rows and
originals:

- A category is created with the renderer's six-field seed (`color`,
  `elementTemplateJson: "{}"`, null grid, `layoutMode: "auto"`, `name`; an empty
  name becomes “New Category”) and a Yjs seed for `category:<id>`. Rename and
  recolour write `field.set` for changed fields only.
- An element is created with seed `{categoryId, groupName, name, summary}` and a
  Yjs seed for `element:<id>`. Without a name it becomes “New Element”, “New
  Element 2”, … Explicit names and aliases follow `findElementNameConflict`:
  trimmed, case-insensitive, against every other live element's name and
  aliases. A category's facts template is cloned into the new element, and its
  body template fills the new body ([categories](categories.md)).
- Updates write alias set changes first, then one `field.set` per changed scalar
  (`categoryId`, `groupName`, `name`, `summary`) in UTF-8 order. Aliases use the
  renderer's set authority: display is trimmed NFKC, the member is its
  lowercase, the last value of a member wins, and `set.remove` carries exactly
  the observed add tags. `aliases_json` is the projection in member order.
  Unchanged values write nothing.
- Trash purges the element's relations, then writes `entity.trash`. Restore
  reauthors the next incarnation: restore seed, one `set.add` per alias, then
  the complete body state, with a System revision, like chapter restore.
  A trashed element keeps its portrait and restore brings it back.

Facts (`entity_kv_entry`) port the renderer's normalized key/value authority:
rows with a blank key and value are dropped; entry IDs are reconciled (exact
row, then equal key, then the same slot when the count is unchanged); removed
entries are purged, new ones created and changed ones get `field.set` for `key`
or `value`; order registers use fractional-indexing keys (a Rust port checked
against the JavaScript package), with `order.move` for inserted runs and one
`order.rebalance` per entry after a reorder. The JSON projection is written to
`kv_json` or `element_template_kv_json`. A category's template facts are cloned
with fresh IDs into each new element, before its create, as in the renderer.

Trashing a category detaches all its elements locally (their category becomes
null, with no original, exactly as the renderer repository does) and writes
`entity.trash`; restoring reauthors its six-field seed and full body state in
the next incarnation and does not re-attach elements.

The journal writer now records `set.add`/`set.remove` in `sync_set_tag` and
upserts order registers for `order.rebalance`, as the local reducer does. NFKC uses the pinned `unicode-normalization` crate. No
SQLite migration is added.

## Native ownership

An element body is an ordinary durable prose owner keyed apart from chapters.
It supports the same editing, history, drafts and save guards. Opening one
saves the other owners first; trashing retires its owner only after commit;
restore requires it closed and reopens from the restored full state. Chapter
features (comments, outline, search) stay chapter-only.

## Mac interaction

“设定库” (action row and 编辑 › 设定库, ⇧⌘E) opens a panel of categories with a
colour swatch, their elements grouped by group name, an 未分类 section and a
回收站 with 已删除分类 and deleted elements, each with 恢复. Context menus rename or
recolour a category, edit its 模板字段…, or move it to the trash, and open or
trash an element. An element opens as a “设定 · 名称” tab in the active pane,
beside chapter tabs and in either split pane: a header on a category-colour wash
edits 名称, 别名, 分组, 分类 and 简介 (committed on Return or end of editing; a refusal
keeps the typed text), then 字段, an ordered list of key/value rows with 添加字段,
上移, 下移 and 删除, above the body editor. The whole list is written with
`setElementFacts` when a row ends editing or is added, removed or moved; text is
sent exactly as typed, a blank new row writes nothing until it has text, and a
refusal keeps every typed row with the reason. Other views of the element follow
saved facts unless they hold uncommitted rows. Trashing an element closes its
tabs only after the command commits.

模板字段… opens a sheet with the same row editor; 保存 writes
`setCategoryTemplateFacts`, and the sheet says the template only applies to 设定
created later. Moving a category to the trash asks first and explains that its
设定 move to 未分类 and are not moved back on restore. Elements are not trashed:
their open tabs, owners and history stay, and every open page's 分类 shows 未分类.
Restoring a category lists it again without re-attaching elements.

## Acceptance

`pnpm apple:workspace-element:acceptance` generates
[the element library report](acceptance/p3e-element-library.json): core and
bridge suites; each native original is byte-identical to the one the renderer
use cases author on the same database, and the production TypeScript reducer
replays it on an independent copy. The replay exposed a renderer reducer defect:
after a restore, a receiving replica duplicates alias displays in
`aliases_json` because it reads set members from every incarnation. The report
pins that difference so `--check` fails once the reducer is fixed. New fact
entry IDs are replayed into the renderer run so its originals are comparable
byte for byte. Two cross-replica differences are pinned rather than hidden:
alias- or facts-only updates stamp `updated_at` only on the authoring side, and
category trash detaches elements only locally (a receiver keeps their
`category_id`), both matching the renderer's own local path. AppKit cases in the
[binding report](acceptance/p2b-binding.json) cover element tabs beside chapter
tabs, header edits and conflicts, trash and restore; facts added, edited,
reordered and deleted on a page (an untrimmed ordered list, typed rows kept on a
refusal, a second page following, cold reopen); a template edited in the sheet
cloning into an element created through the panel while an older element keeps
none; and category trash moving elements to 未分类 with tabs and popups updated,
a stale template save refused, and restore without re-attaching. The page facts
refusal is injected at the page's commit seam; the template refusal is Rust's. Physical input, desktop
XCTest and devices are not covered.
