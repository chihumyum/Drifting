# Material workbench

Status: **design accepted 2026-10-27; implementation in progress** (see
[Milestones](#milestones)). Data and asset boundaries remain those of
[`local-assets.md`](local-assets.md); generated images and provenance remain
[`image-generation.md`](image-generation.md).

## Product model

Materials (素材, the `library_item` table) are the author's reference shelf
next to the book. They are not manuscript.

| Kind | What it is | Opens as |
| --- | --- | --- |
| `image` | an imported or generated picture | image tab: zoom/pan, region comments |
| `pdf` | an imported PDF | PDF tab: pages, region comments |
| `text` | **笔记** — the author's own notes, outside the story | rich note tab |

- `url` materials are **retired** (M1). Existing rows become notes; nothing is
  deleted. There is no embedded browser and no web clipping.
- Future kinds stay local and non-prose (for example ePub).
- **笔记 vs 构想.** A drift (构想) belongs to the book and can grow into a chapter.
  A note is the author's own thinking *about* the work — research, plans,
  checklists — a much richer to-do. Notes are never counted in prose metrics,
  never enter manuscript export, and never appear in the outline.
- **Two editing profiles, one kernel.** Chapters, drifts, elements, storylines
  and categories keep the restrained novel-writing editor (`prose` profile).
  Notes use the `note` profile: the same TipTap/Yjs/IME stack plus tables, task
  lists, bullet/ordered lists, code blocks, highlights, callouts and material
  embeds, reached through the slash menu. The profile is a property of the
  document kind, never of the view.

## Surfaces

- **Every material opens as a workspace tab** (`WorkspaceEntityType`
  `'library_item'`, the same spelling as its `EntityKind`, so comment targets
  and entity links open it without translation), with preview-tab semantics,
  splits and persistence like other entities. A tab shows a header (kind, editable title, relations, actions)
  and a kind-specific body.
- The right-sidebar Library panel and the ⌘⌥5 TODO & 素材库 view are indexes:
  activating a card opens the material tab. Note cards render a short
  read-only excerpt of the note document.
- The in-place fullscreen preview, the text snippet popover and the card's
  inline text expansion are removed once tabs exist.
- Image and PDF tabs carry the material's `notes_json` description as a small
  editable field. Notes do not show it: their body is the note.

## Data model

### `library_item`

Unchanged columns. After M1 the accepted kinds are `image`, `pdf` and `text`.
Migration `0011` rewrites every `url` row into a `text` row whose body is one
paragraph holding the link as a link mark (title, `notes_json`, provenance,
relations and order are preserved; the cached preview is dropped) and installs
insert/update guards that reject `kind = 'url'`. The published CHECKs and the
`external_url` / `preview_image_url` columns stay; a table rebuild would drop
every `library_item` trigger.

### Note body

A note's body is a Yjs document `library-item:<id>` (DocKind `library-item`).
`body_json` becomes its seed and cache, exactly like `contentJson` for
storylines and categories. Existing text materials seed their Yjs document on
first open; their plain paragraphs are valid in the richer schema.

### Note schema (`note` profile)

The prose schema plus:

| Node / mark | Notes |
| --- | --- |
| `bulletList`, `orderedList`, `listItem` | enabled (disabled in prose) |
| `taskList`, `taskItem` | `checked`, optional `todoId` linking a TODO |
| `codeBlock`, `code` | enabled |
| `table`, `tableRow`, `tableHeader`, `tableCell` | `@tiptap/extension-table` |
| `highlight` mark | single highlight colour |
| `callout` | a bordered wash block with an emoji-free label |
| `materialEmbed` | atom block `{ libraryItemId }` referencing an image or PDF material |

`BlockId` identifies every top-level block and every `taskItem` so TODO links
and agent snapshots have stable anchors.

Paste from a note into a prose editor degrades note-only nodes (tables become
paragraphs of tab-separated cells, task items become paragraphs, embeds are
dropped with their caption) before ProseMirror sees them.

### Embedded images are materials

`materialEmbed` holds a reference, never bytes. Inserting an image (slash menu
`图片`, paste or drop) imports it as an ordinary image material through the
local asset transaction and inserts the reference. Deleting the node leaves the
material in the library; deleting the material renders the node as a missing
placeholder. Asset ownership therefore stays "expressed exactly once".

### TODO links

A task item can be linked to a TODO (`comment.kind = 'todo'`). Promoting a task
item creates a TODO targeting the note (`target_kind = 'library_item'`,
`target_block_id` = the task item id) and writes its id into `todoId`. While
linked, the TODO's status is authoritative: the checkbox renders the TODO
status and toggling it resolves or reopens the TODO, mirroring `checked` for
export. The TODO rail shows the item; activating it opens the note at that
item. Unlinked task items stay local checkboxes.

### Region comments

Comments and TODOs may target an image or PDF material
(`target_kind = 'library_item'`). Their anchor adds a `region`:

```json
{ "region": { "v": 1, "page": 3, "x": 0.12, "y": 0.4, "w": 0.2, "h": 0.1 } }
```

Coordinates are normalized to the image or PDF page (`page` only for PDFs).
The tab draws regions over the media and lists the comments beside it; the
Review panel and TODO rail list them like other comments.

## Agent

- `list_materials` / `read_material` keep their contract; `read_material`
  returns a note's live document as Markdown (tables and task lists included)
  instead of the cached `body_json`.
- The Agent does not edit notes in this design.

## Export

Relational and readable Markdown export render notes from the live document:
GFM tables, `- [ ]` task lists, code fences, and embeds as links to the
referenced material document. Retired url rows export as the notes they became.

## Compatibility

Every 0.1.x database still opens and migrates (AGENTS.md). Sync is the harder
boundary, because older builds validate what they receive:

- **Retired url records.** The sync kernel keeps `url` in its field policy so
  history and older devices still validate, and converts url seeds while
  materializing (`normalizeLegacyUrlRecord`, byte-identical to the migration).
  Field sets that would reintroduce a url kind or link are not materialized.
  Checkpoint restore converts url rows the same way
  (`withRetiredUrlMaterialAsNote`). An older device still holds those rows as
  url items, so editing a converted note's body from a current build makes that
  older device's remote apply fail its CHECK: update every device first.
- **Note documents** (M3) are Yjs documents with a new owner prefix. Older
  builds record a conflict for their live updates and reject whole checkpoints
  that contain them, so every device syncing a project needs a current build
  before notes are edited. The paused Apple client's Rust receiver also rejects
  unknown document ids; it still writes note bodies as a row field and may
  diverge (AGENTS.md: native need not interoperate).
- **Material comments** (M5) carry `target_kind = 'library_item'`. Older
  kernels reject that value as a conflict, so material comments are created in
  their own change sets and existing comments are never retargeted to a
  material. Region data lives inside `anchor_json`, which every build treats as
  opaque JSON.

## Milestones

| # | Scope | Status |
| --- | --- | --- |
| M1 | Retire url materials (migration `0011`, sync and checkpoint conversion, UI, native metadata command and the `external-content` network purpose removed) | done |
| M2 | Material tabs for image, PDF and text (desktop tabs and mobile papers); fullscreen preview kept only as a lightbox; snippet popover removed | done |
| M3 | Notes on Yjs (`library-item` doc kind), edited in their tab | planned |
| M4 | `note` editor profile: lists, tasks, tables, code, highlight, callout, slash items | planned |
| M5 | Region comments on images and PDFs | planned |
| M6 | Note task items ↔ TODOs; image embeds ↔ image materials | planned |

Deferred: image markup/ink, ePub, Agent note editing, mobile material tabs.
