# Relations

Curated relations (关系) link two entities through a first-class relation type.
The Mac client creates, edits and deletes author relation types, adds, retypes,
swaps and removes relations between chapters, drifts, elements, categories and
storylines, and removes an entity's relations when it moves to the trash.
Inline mentions stay a separate derived index ([entity links](entity-links.md)).

## Domain contract

- A type has a name (unique per project by `normalizedName`: trimmed, ASCII
  lowercase), a description, an orientation and allowed source/target kinds in
  canonical order. Directed types need both roles; symmetric types connect
  structural kinds only, with identical source and target kinds and one shared
  role (default “端点”). Create writes `entity.create` with the ten authored
  fields; update journals all ten as `field.set` in UTF-8 field order and is
  refused when an existing relation of the type would violate it or need its
  ends swapped. The built-in “Generic association” is locked; a type in use
  cannot be deleted. Deleting writes `entity.purge`; endpoint rows cascade.
- A relation is validated against its type. A reversed direction is refused
  with the renderer's swap hint; symmetric relations store the bytewise-smaller
  `kind:id` endpoint first; an identical edge of the same type is returned
  without writing. Create writes `{fromId, fromKind, relationTypeId, toId,
  toKind}`; retype/swap journals all five fields; remove writes `entity.purge`.
- Both ends never coincide (the reducer's `relation.self-edge` invariant).
  Native endpoints are live chapters and drifts (`node`), elements, categories
  and storylines, and comments and library items as the source of the
  built-in Generic association (关联, [review](review.md)); patches are not
  addressable. Deleting a comment or library item purges its relations.
- Trashing a chapter, drift, element, category or storyline purges every
  relation touching it first, inside the trash original, as
  `deleteEntityRelationsInTransaction` does; restore does not bring relations
  back. A relation without a lifecycle fails the trash closed.
- Unchanged type edits and retypes write nothing (the renderer journals them).

No SQLite migration is added.

## Native interaction

Element, chapter, drift and storyline pages show a 关系 section below the header
(above 被引用 on element pages). 关联 from notes, TODOs and library items are shown
with those instead. It lists the entity's relations on either side, newest
first, as “类型 · 角色 → 对方名称” followed by the other entity's kind (章节, 漂流, 设定, 分类
or 故事线). The role is this entity's own role; ← marks it as the target and ↔
marks a symmetric type. A self-relation is listed once. Long lists collapse
after five rows. Typography and spacing carry the layout; there are no edge
accents.

Clicking a name opens the other entity in the same pane: element, drift and
storyline pages, or a chapter tab. Categories have no page, so the app opens
the 设定库 at the category. Each row's ⋯ menu (also its context menu) offers
打开, 改为其他类型…, 交换方向 and 删除关系. 交换方向 appears only for directed
types and is disabled when the swapped ends would not fit. 改为其他类型… lists
the author types that fit the ends directly or swapped (marked “交换两端”,
which also swaps them). Choosing the current type writes nothing.

添加关系… opens a sheet that searches live chapters, drifts, elements,
categories and storylines by name and kind. It leaves out this entity and
every entity already related to it. The sheet shows the direction (“老周 →
阿岚”) with 交换方向, and a type popup of the author types that fit the pair in
either direction. A type that fits only the other way shows Rust's swap hint,
and 添加 waits until the ends fit. 新建关系类型… opens the type editor preset
to the pair's kinds. A definition that would not fit is refused before
anything is written, and the new type is then chosen. The built-in Generic
association is never offered.

编辑 › 关系类型… (⇧⌘R), or 关系类型… in any section, opens a panel. It lists
author types with their roles, description and relation count, then the
built-in type (shown as 关联) as locked. The editor sheet holds 名称, 方向, the
roles, 说明 and the allowed kinds. The four native kinds are checkboxes; patch,
comment and library item are shown disabled and keep their stored state. A
symmetric type has one 端点角色 and the same structural kinds at both ends. A
type in use is sent to Rust, which refuses to delete it and states the count.
An unused type is deleted after confirmation.

Relation writes change no document owner, input or history. Every reply
carries the whole library, which updates every open section, the add sheet,
the panel and the [设定总览](element-overview.md), whose edges select, retype,
swap, remove and create relations through the same library; the
[故事图谱](timeline.md) draws chapter and drift relations from it. Both
canvases colour edges by type and hide types chosen in 关系类型. Rows resolve names from the tab host's element, chapter, drift
and storyline libraries, so they follow renames. A trash command, or an
entity leaving its live list, reads the library again. Rust's Chinese refusals
are shown as they are; those naming stored identities are restated.

## Acceptance

`pnpm apple:workspace-relation:acceptance` generates
[the relation report](acceptance/p3j-relations.json): core and bridge suites,
renderer use cases authoring the same originals, and production reducer replay
with table parity.

Four programmatic AppKit cases in the
[binding report](acceptance/p2b-binding.json) (`--relations-only` runs only
these) drive the real 关系类型 panel, page sections, add sheet, type editor and
row menus, wired as the app wires them. Each step checks the originals it
wrote.

- **Types.** The panel creates a directed and a symmetric type, refuses a
  duplicate name and built-in edits without writing, and journals an edit as
  ten fields. An unchanged edit writes nothing, and an unused type is deleted
  after confirmation.
- **Adding.** Relations are added from element, chapter, drift and storyline
  pages, one with a type created inline. A reversed direction is refused in
  the sheet, in the inline editor and by Rust, with nothing written. A
  symmetric edge is listed on both sides, names open the other entity, and
  rows follow element and chapter renames.
- **Row menus.** 交换方向 and 改为其他类型… (including a type that swaps the ends)
  each journal the five endpoint fields. The current type writes nothing,
  删除关系 purges the relation from both sides, and deleting a type in use is
  refused with its count.
- **Trash and reopen.** Trashing an element purges its three relations inside
  its trash original and drops them from other entities' open sections.
  Restore does not bring them back, the freed type then deletes, and types,
  relations and page rows survive cold reopen.

Physical input, desktop XCTest and devices are not covered.
