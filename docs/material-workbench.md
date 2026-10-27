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
- The right-sidebar Library panel (a folder tree, see Folders) and the ⌘⌥5
  TODO & 素材库 view (cards) are indexes: activating a material opens its tab
  (double-click keeps it, and the material of the active tab is highlighted,
  as in the chapter panel). Notes show a short read-only excerpt of the note
  document.
- A note tab has the entity editors' furniture: the outline rail of its
  headings, margin comments and TODOs on its text (the shared sticky-note
  rail, anchor highlights and scroll ticks, targeting the note), and a stats
  tab section (length, checklist progress, open comments, embeds, relations)
  with the entity history entry. Image and PDF tabs keep their comment
  column; their stats section shows the file.
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
`body_json` becomes its seed and projection, exactly like `contentJson` for
storylines and categories: the editor writes it with a derived, never-journaled
transaction (`projectNoteBody`), remote updates refresh it in the sync kernel,
and the ordinary row update refuses body edits.

- A note seeds its document from `body_json` when it is first opened, using
  the `note` schema (`createYjsProseSeedState(json, 'note')`, deterministic, so
  two devices seeding the same body merge idempotently). Creating a note does
  not require a seed in the same change-set; notes made before this design
  simply seed on first open.
- The kernel accepts `library-item:` updates only when the owner is a note.
- Checkpoints carry note documents (`proseSeedRows` includes text items).
  Restore accepts packages captured before note documents existed.
- Agent review, references and check-ins skip note documents
  (`proseEntityTypeForDocKind`); notes sit outside the book. Entity history
  includes them (`SnapshotEntityKind`): the local time machine captures and
  restores a note's body and title like any prose entity.
- Project deletion removes note documents; deleting a single material leaves
  its Yjs rows, as for every other entity.

### Note schema (`note` profile)

The prose schema plus:

| Node / mark | Notes |
| --- | --- |
| `bulletList`, `orderedList`, `listItem` | enabled (disabled in prose) |
| `taskList`, `taskItem` | `checked`; `todoId`: a TODO id, `''` (a plain checkbox), or null (not yet projected) |
| `codeBlock`, `code` | enabled |
| `table`, `tableRow`, `tableHeader`, `tableCell` | `@tiptap/extension-table` |
| `highlight` mark | single highlight colour |
| `callout` | a bordered wash block with an emoji-free label |
| `materialEmbed` | atom block `{ libraryItemId }` referencing an image or PDF material |

`BlockId` identifies every top-level block and every `taskItem` so TODO links
and snapshots have stable anchors. `lib/editor-schema-profile.ts` owns both
profiles: the headless schema (seeding, Markdown), the live editor
(`useEntityEditor({ profile: 'note' })`) and the note-only extensions share one
definition. The note page adds slash items (lists, to-do list, table, code
block, callout, highlight, insert material), a floating bar and an embed
picker that can also import a new image or PDF. The floating bar
(`views/NoteFloatingBar.tsx`) holds the checklist line's 转为 TODO / 不作为
TODO and the table's row and column actions. It floats above the caret's line
(below it near the top of the window), portaled to the body, so the note never
reflows; it shows while the editor has focus and the caret rests, and hides
while the author types. Code reads in the ink colour in a monospace face
(Tailwind's prose styles assume a dark code block).

Paste from a note into a prose editor relies on ProseMirror parsing the copied
HTML with the prose schema, which keeps the text of tables, task items and
callouts as paragraphs and drops embeds. This is not covered by an automated
test (no DOM test environment).

### Embedded images are materials

`materialEmbed` holds a reference, never bytes. Inserting an image (slash menu
插入素材…, or pasting or dropping an image or PDF file into a note) imports it
as an ordinary image material through the local asset transaction and inserts
the reference. Pasted bytes are staged by the native
`material_stage_import_bytes` command with the picker's size limit, symlink
check, sniffed extension and naming, so the import path cannot tell them from
a picked file. Deleting the node leaves the material in the library; deleting
the material renders the node as a missing placeholder. Asset ownership
therefore stays "expressed exactly once".

### Checklist items are TODOs

A note's task items become TODOs by default (`views/note-todo-links.ts`). The
note owns which lines exist and what they say; the TODO owns the status.

- A finished line (the caret left it, or the editor lost focus) becomes a TODO
  targeting the note (`target_kind = 'library_item'`, `target_block_id` = the
  task item id, `metadata_json = {"kind":"note-task"}`) and its id is written
  into the item's `todoId`. Lines already in a note are projected when it is
  opened. Empty lines are not projected.
- Editing a linked line updates the TODO's text; removing the line deletes the
  TODO. Deleting the TODO anywhere (Review panel, Agent) removes the line from
  the note, live or closed (`lib/note-task-document.ts`), so the note does not
  project it again. Undo restores a removed line, which is projected anew.
- Status: resolving or reopening the TODO anywhere moves the checkbox; ticking
  the checkbox resolves or reopens the TODO.
- **不作为 TODO** keeps a line as a plain checkbox (`todoId = ''`) and deletes
  its TODO; **转为 TODO** links it again.
- A TODO belongs to the line it is anchored to (same note, same block id).
  Enter at the end of a linked line starts a new line, not a copy of the link;
  a pasted copy of a linked line (from this note or another) gets its own
  TODO. A copy whose original line is gone keeps the link.
- Deleting a TODO whose line has sub-tasks moves the sub-tasks up into its
  place; they are TODOs of their own.
- The note's ⋯ menu turns the projection off (`library_item.task_todos`);
  existing links keep syncing, new lines stay checkboxes.
- Only the author's own edits on this device create, edit or delete TODOs;
  edits arriving from another device were reconciled where they were made.
  A link to a TODO this device does not have is never rewritten: the TODO
  may still be syncing (the line can arrive before its TODO row). Until it
  arrives the line acts as a plain checkbox, and **转为 TODO** gives it a new
  TODO.
- Restoring a note version from history deletes the TODOs of lines the
  restore removed, and gives restored lines whose TODO is gone a new one
  (with the note's switch off they are left to be projected later).
- Reconciles run one at a time; one requested while another runs follows it
  rather than being dropped. If the note closes while a line's TODO is being
  saved, the line is linked in the note's stored document.
- The note editor paints no anchor highlight for these TODOs (the line shows
  them), and their Review cards send text edits back to the note.

### Review panel groups

The Review panel groups comments and TODOs under the entity they target
(chapter, drift, element, storyline, category, note, image, PDF), each group a
collapsible header that opens its target; unattached items come last
(`features/comments/review-groups.ts`). Groups follow their newest item; inside
a group, block-anchored items follow the document when its body is in memory
(notes, elements, storylines, categories; chapters keep time order). A list
with a single target shows no header. The sort menu switches between grouped
and flat (`reviewGroupMode`, per panel). Grouping is presentation only.

### Region comments

Comments and TODOs may target an image or PDF material
(`target_kind = 'library_item'`). Their anchor adds a `region`:

```json
{ "region": { "v": 1, "page": 3, "x": 0.12, "y": 0.4, "w": 0.2, "h": 0.1 } }
```

Coordinates are normalized to the image or PDF page (`page` only for PDFs).

- The tab's **框选批注** tool turns the stage into a drawing surface: drag a
  rectangle, write the comment in a floating composer (⌘↩ saves, optionally
  as a TODO). Regions are numbered over the media and zoom and pan with it;
  a PDF shows only the current page's regions.
- The comment column beside the stage lists the material's comments in
  reading order with the ordinary review card; selecting one highlights its
  region and turns the PDF to its page.
- With a material tab active, the Review panel's current scope is that
  material, and composing a note or TODO there targets it directly (a
  material cannot be a relation target).
- `CommentTargetKind` includes `library_item`. `parseMaterialRegion` reads
  anchors leniently.
- Deleting a material deletes the comments that target it, with their
  relations, in the same transaction. The paused Apple client's Rust delete
  does not cascade yet.
- The Agent can read and name material comments; it does not create them.

## Folders

Materials can be filed in user-defined nested folders (`material_folder`,
migration `0012`; `library_item.folder_id`). A material sits in at most one
folder; relations to chapters and elements stay the cross-cutting link.

- The Library panel is the folder tree; it has no flat view. The root has no
  row of its own. Folders are thin rows; materials are taller cells with a
  preview (a thumbnail, or a note's first two lines) that expand to the full
  preview and the material's relations. Collapsing a folder is the compact
  view. Folders come first and everything is sorted by name.
- On desktop it works like Finder: click opens a material (a folder toggles),
  ⌘-click and ⇧-click select several materials and folders, ⌥-click a folder
  opens or closes everything inside it, drag a selection onto a folder (or the
  empty area for the root), right-click to create, rename, move or delete one
  item or the selection. On mobile it shows one folder at a time under a
  breadcrumb. New materials go into the folder last selected.
- **移动到文件夹…** is on tree rows, TODO & 素材库 cards and the material tab
  menu; the picker disables a moving folder and everything below it.
- Deleting a folder moves its sub-folders and materials up a level
  (`usecase/useMaterialFolder.ts`), like drift groups; no material is deleted.
- Concurrent edits can leave a folder or material pointing at a deleted folder,
  or two folders inside each other. Neither is an invariant: the tree shows
  such folders at the root (a loop is broken at its smallest id, the same on
  every device) and such materials at the root.

## Agent

- `list_materials` / `read_material` keep their contract and add the folder
  path; `read_material` returns a note as Markdown (`lib/note-markdown.ts`:
  GFM tables, task lists, code fences, callouts) rendered from its projection.
- The Agent does not edit notes in this design. Deleting a note-task TODO
  through the Agent removes its line like any other deletion.

## Export

Relational and readable Markdown export render notes with `noteToMarkdown`
from their projection: GFM tables, `- [ ]` task lists, code fences, `> [!note]`
callouts, `==highlights==`, and embeds and mentions as links in each export's
own style (wiki links in the relational ZIP, relative links in the readable
projection). Retired url rows export as the notes they became. The readable
projection nests materials in their folders under 资料; the relational export
records the path as `folder` metadata and keeps its flat layout.

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
- **Folders and the checklist switch** (M9, migration `0012`). Older kernels
  reject the `material-folder` entity kind and the `folderId` / `taskTodos`
  fields, and an unknown entity kind rejects the whole change set: the older
  device quarantines it (`blocked-update`) and stops applying that project
  until it updates. Materials at the root with the switch on omit both
  fields, as provenance does, so only creating a folder, filing a material or
  turning the switch off needs every device on a current build. Checkpoints
  are stricter: an older build accepts only its exact table and column set, so
  no checkpoint captured after `0012` restores there, folders or not.
  Checkpoints captured before `0012` restore on a current build with an empty
  folder table, every material at the root and the switch on.
- **Note-task TODOs** are ordinary TODO rows with a metadata marker; older
  builds show them as plain TODOs about the note.
- **Images and PDFs from another device.** Through `588efb32` a receiving
  build failed to apply an imported image or PDF, and failed every remote apply
  after a restart once the project held one, which stalled that project's sync.
  The kernel now inserts the material with the asset bound in its creating
  change set (`docs/local-assets.md`); every syncing device needs this build.

## Milestones

| # | Scope | Status |
| --- | --- | --- |
| M1 | Retire url materials (migration `0011`, sync and checkpoint conversion, UI, native metadata command and the `external-content` network purpose removed) | done |
| M2 | Material tabs for image, PDF and text (desktop tabs and mobile papers); fullscreen preview kept only as a lightbox; snippet popover removed | done |
| M3 | Notes on Yjs (`library-item` doc kind), edited in their tab | done |
| M4 | `note` editor profile: lists, tasks, tables, code, highlight, callout, material embeds, slash items; Markdown excerpts on cards | done |
| M5 | Region comments on images and PDFs | done |
| M6 | Note task items ↔ TODOs; pasted/dropped images and PDFs become embedded materials | done |
| M7 | Tab parity: panel highlight and double-click, note outline, note margin comments, material stats, note history | done |
| M8 | Checklist items are TODOs by default; Review panel groups by target | done |
| M9 | Material folders (migration `0012`), folder view, move-to-folder, folder paths in tabs, export and Agent reads | done |
| M10 | Folder tree as the only panel view (preview cells, multi-select); floating note bar; note code colour | done |

Deferred: image markup/ink, ePub, Agent note editing, Agent folder edits.
