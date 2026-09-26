# Elements library

The Mac client has a 设定库: element categories and elements, with each
element's page (name, aliases, summary, group, category and prose body) opening
in the existing tab and split workspace. Facts, category templates, category
trash, portraits and relations are later batches and are refused explicitly.

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
  aliases. A category with a body or facts template is refused until templates
  are ported.
- Updates write alias set changes first, then one `field.set` per changed scalar
  (`categoryId`, `groupName`, `name`, `summary`) in UTF-8 order. Aliases use the
  renderer's set authority: display is trimmed NFKC, the member is its
  lowercase, the last value of a member wins, and `set.remove` carries exactly
  the observed add tags. `aliases_json` is the projection in member order.
  Unchanged values write nothing.
- Trash writes `entity.trash`. Restore reauthors the next incarnation: restore
  seed, one `set.add` per alias, then the complete body state, with a System
  revision, like chapter restore. Elements with relations or a portrait are
  refused until those domains are ported.

The journal writer now records `set.add`/`set.remove` in `sync_set_tag`, as the
local reducer does. NFKC uses the pinned `unicode-normalization` crate. No
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
回收站 with 恢复. Context menus rename or recolour a category and open or trash an
element. An element opens as a “设定 · 名称” tab in the active pane, beside
chapter tabs and in either split pane: a header on a category-colour wash edits
名称, 别名, 分组, 分类 and 简介 (committed on Return or end of editing; a refusal keeps
the typed text), above the body editor. Trashing closes that element's tabs only
after the command commits.

## Acceptance

`pnpm apple:workspace-element:acceptance` generates
[the element library report](acceptance/p3e-element-library.json): core and
bridge suites; each native original is byte-identical to the one the renderer
use cases author on the same database, and the production TypeScript reducer
replays it on an independent copy. The replay exposed a renderer reducer defect:
after a restore, a receiving replica duplicates alias displays in
`aliases_json` because it reads set members from every incarnation. The report
pins that difference so `--check` fails once the reducer is fixed. AppKit cases in the
[binding report](acceptance/p2b-binding.json) cover element tabs beside chapter
tabs, header edits and conflicts, trash and restore. Physical input, desktop
XCTest and devices are not covered.
