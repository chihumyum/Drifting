# Milestones and acceptance

The active objective is to complete the Mac front-end migration in continuous
batches. Within each batch: **make it work, make it right, make it fast**.
Finish the agreed scenarios, repair demonstrated data errors, then move to the
next part of the writing workflow. Do not grow an open-ended edge-case matrix,
and do not wait for another start instruction between batches.

Each accepted batch updates its topic document and generated evidence and is
committed locally before the next batch accumulates; committing never implies
pushing. Related features may share one batch. Keep compatibility work to the
supported public database contract: no retired-format adapters, speculative
backfills or duplicate write paths. Performance work waits for functional
integration unless there is an unusable stall or a risk that would force an
architectural redesign.

## Scope decisions

- 2026-09-26: Google Drive sync (connection/OAuth, transport, provider snapshot
  bootstrap, account recovery, sync UI) is excluded. The author will redesign
  sync after the migration. Accepted shared CRDT, persistence and receiver code
  stays; the old provider's snapshot restore is not continued.
- 2026-09-27: the native client need not stay compatible or interoperable
  with the Tauri client for any feature (data formats, Agent history, sync).
  New batches use native tests and Mac UI acceptance only; renderer parity
  oracles are not extended. Existing parity reports stay as regression
  evidence while they pass; retire or narrow one when native intentionally
  diverges. The Agent follows the renderer's provider configuration.
- 2026-09-27: the Mac UI uses plain native AppKit style: standard controls
  and system appearance, no custom design system or visual-polish batches.
  Functional UI rules (Chinese strings, no inset-left accent bars) stay.
- 2026-09-27: implementation and routine acceptance are Mac-only. iPhone and
  iPad resume only after the Mac migration and a discussion with the author.
  Shared Rust, existing UIKit code and historical mobile reports are kept.
  Desktop XCTest input stays out of the default run (see [README](README.md)).

## Milestones

| Milestone | Deliverable | Current state |
| --- | --- | --- |
| P0 | Inventory, ADR, scope, interaction design, synthetic corpus | Complete |
| P1 | Buildable Mac host, Swift–Rust ABI, core extracted and reused by Tauri | Complete; desktop XCTest input needs repair |
| P2a | Headless Yjs/Yrs interoperability | Complete for the declared scope, with vendored Yrs fixes |
| P2b | AppKit document binding: stable IDs, comments, marks, multi-view, IME, semantic undo | In progress; see open gates |
| P2c | Durability and measured writing behavior | Crash/replay/compaction pass; performance comparison open |
| P3 | Shared domain commands and queries | In progress: projects (with deletion), chapters, order, trash (with permanent deletion), acts (with boundary moves) and act colours, outline, search (chapters and entities), comments and TODOs, element categories, elements, facts, element patches, entity links, storylines and membership, drifts and groups with conversion to chapters and elements, plot grids, chapter/drift/project metadata, relations and associations, library order, word counts |
| P4 | Agent over native prose; receiver foundations | Receiver accepted; Mac writing assistant with reviewed proposals over prose and domain tools, author rules, working memory, task plans, compaction, retries, usage, MCP extensions, ask_user, 补充, stop after the running tool, a context indicator with Max · 1M and dictation ([agent](agent.md)); experimental Copilot suggestions and Copilot 修改 ([copilot](copilot.md)); Google Drive excluded |
| P5a | Daily desktop writing loop | In progress: see delivered slices |
| P5b | Desktop parity: elements/materials, graph/timeline, comments/review, Agent, import/export/settings/diagnostics | In progress: Agent, materials, import/export, graph/timeline, version history, settings, whole-book editor and statistics, element overview, review and the 备忘与素材 board, global search and today's words, element patches and the bottom timeline, the unified trash, hover cards, typewriter scrolling, the project shelf, Markdown folder export, the diagnostic summary, experimental Copilot suggestions, MCP extensions, printing, PDF export and custom shortcuts, the plot planner and drift conversions, database recovery and the project home, storyline chapter templates and list filters, bulk import and all-project export, editor layout settings, quotes and lists, horizontal rules and list items, page statistics, the heading rail, scrollbar markers and the 便笺栏, the assistant extras, Copilot 修改 and dictation, canvas card popovers with relation type filters, and the caret colour, entity link styles and Tab indent settings, chapter hover previews, the status line's 主线 total, the 全书长卷's shared editor controls and the first-run welcome delivered |
| P6 | iPhone/iPad auxiliary client | Deferred; no current gate |
| P7 | Upgrade, signing, notarization, update, exact-source artifacts | Not started |

## Delivered writing slices

| Slice | Commit | Contract |
| --- | --- | --- |
| Native editor and shared durable core | `d983ec6f` | [document core](document-core.md), [durability](durability.md) |
| Project/chapter creation, rename, reorder | `15e298ba` `5a604200` `5bc7a9f8` | [workspace](workspace.md) |
| Selection and heading formatting | `be701d92` | [formatting](formatting.md) |
| Whole-book outline navigation | `94a9e6f9` | [outline](outline.md) |
| Retained chapter tabs and split editing | `791cbb62` | [tabs and split](tabs-and-split.md) |
| Project title and prose search | `03c29136` | [search](search.md) |
| Remote prose and complete chapter receive | `09694c33` `84fb8c92` `12e3f728` | [remote prose](remote-prose-sync.md), [chapter receiver](remote-workspace-sync.md) |
| Recoverable chapter trash | `0e97a995` | [chapter trash](chapter-trash.md) |
| Act boundary editing | `ea5d75f3` | [act boundaries](act-boundaries.md) |
| Chapter selection comments | `dcab1328` | [chapter comments](chapter-comments.md) |
| Elements library (设定库) | `5f187170` | [element library](element-library.md) |
| Element facts, category templates and trash | `d7056fba` | [element library](element-library.md) |
| Entity links and backlinks | `6e189fd5` | [entity links](entity-links.md) |
| Storylines and chapter membership | `aaffcdd5` | [storylines](storylines.md) |
| Drifts, drift groups and act notes | `c4cfcdb0` | [drifts](drifts.md) |
| Chapter, drift and project metadata | `034c6d7c` | [metadata](metadata.md) |
| Relation types and relations | `9b4432b1` | [relations](relations.md) |
| Word counts and body projections | `abff994a` | [word counts](word-counts.md) |
| Writing assistant (写作助手) | `fcd813f4` | [agent](agent.md) |
| Materials library, portraits, import and export | `6d0c627a` | [library](library.md) |
| Story graph, timeline and version history | `0bf81171` | [timeline](timeline.md), [history](history.md) |
| Settings, imported bold/italic, Enter after a linked name | `a246b632` | [settings](settings.md), [library](library.md), [entity links](entity-links.md) |
| Category pages and element body templates | `f251cf7b` | [categories](categories.md) |
| Whole-book editor, statistics and writing plan | `38d5e4e7` | [whole book](whole-book.md) |
| Element overview (设定总览), atomic story graph drops, version reasons and word counts, one-read node metadata | `9e4e8960` | [element overview](element-overview.md), [timeline](timeline.md), [history](history.md), [metadata](metadata.md) |
| Review panel, TODOs, memo board, act colours and project deletion | `9624e834` | [review](review.md), [library](library.md), [act boundaries](act-boundaries.md), [chapter comments](chapter-comments.md), [workspace](workspace.md) |
| Global search and today's words | `92569a46` | [search](search.md), [whole book](whole-book.md), [timeline](timeline.md) |
| Element patches and the bottom timeline | `0fd6f68a` | [patches](patches.md), [timeline](timeline.md), [act boundaries](act-boundaries.md) |
| Writing assistant tools | `f802c7d4` | [agent](agent.md), [entity links](entity-links.md), [act boundaries](act-boundaries.md) |
| Trash, hover cards, typewriter scrolling, the project shelf and Markdown folder export | `2c017a2a` | [trash](trash.md), [entity links](entity-links.md), [settings](settings.md), [workspace](workspace.md), [library](library.md) |
| Assistant rules, working memory, task plans, compaction and retries | `add67d34` | [agent](agent.md), [review](review.md) |
| Review fixes: trash confirmation, project deletion cleanup, compose target, whole-book undo, atomic reading-order drops | `bea818b8` | [trash](trash.md), [workspace](workspace.md), [review](review.md), [whole book](whole-book.md), [timeline](timeline.md) |
| Copilot suggestions (experimental) | `c2d4ab42` `30439d6d` | [copilot](copilot.md), [review](review.md), [settings](settings.md), [chapter comments](chapter-comments.md) |
| MCP extensions and assistant memory fixes | `ab4e6a8a` | [agent](agent.md), [settings](settings.md), [whole book](whole-book.md), [trash](trash.md) |
| Printing, PDF export and custom shortcuts | `507f67ad` | [library](library.md), [settings](settings.md) |
| MCP and Copilot hardening | `ec4bf6f2` | [agent](agent.md), [copilot](copilot.md), [settings](settings.md) |
| Plot planner and drift conversions | `1866145c` | [plot planner](plot-planner.md), [drifts](drifts.md), [trash](trash.md) |
| Review fixes for printing, planner and conversions | `faa58ca4` | [drifts](drifts.md), [plot planner](plot-planner.md), [settings](settings.md), [agent](agent.md), [copilot](copilot.md) |
| Database recovery and project home | `3717a99d` `a6a1db34` | [recovery](recovery.md), [project home](project-home.md), [whole book](whole-book.md), [settings](settings.md) |
| Editor formatting, find and pickers | `dd217788` | [formatting](formatting.md), [settings](settings.md), [library](library.md), [whole book](whole-book.md), [entity links](entity-links.md) |
| Tabs, navigation and restore | `2f24cbb9` | [tabs and split](tabs-and-split.md), [workspace](workspace.md), [settings](settings.md), [project home](project-home.md) |
| Picker, shortcut and tab fixes | `e754a7f7` | [formatting](formatting.md), [entity links](entity-links.md), [settings](settings.md), [tabs and split](tabs-and-split.md) |
| Storyline templates, filters, bulk import/export and editor settings | `bd42e93c` | [storylines](storylines.md), [categories](categories.md), [library](library.md), [settings](settings.md), [whole book](whole-book.md), [history](history.md), [workspace](workspace.md) |
| Quotes and lists, picker and restore fixes | `8f3d5809` | [formatting](formatting.md), [settings](settings.md), [tabs and split](tabs-and-split.md), [history](history.md) |
| Page statistics, heading rail, markers, rules, list items and import fixes | `d8f60710` | [page statistics](page-stats.md), [formatting](formatting.md), [library](library.md), [storylines](storylines.md), [categories](categories.md), [tabs and split](tabs-and-split.md), [settings](settings.md) |
| Assistant extras, Copilot inline, dictation, list and reading-aid fixes | `b1fb1d0a` | [agent](agent.md), [copilot](copilot.md), [settings](settings.md), [formatting](formatting.md), [page statistics](page-stats.md) |
| Canvas popovers, relation filters, list exit and assistant fixes | `ed1e6862` | [timeline](timeline.md), [element overview](element-overview.md), [relations](relations.md), [formatting](formatting.md), [settings](settings.md), [agent](agent.md), [copilot](copilot.md) |
| Editor settings, previews, long-page toolbar, welcome and canvas/Copilot fixes | `bcb2e8fa` | [settings](settings.md), [entity links](entity-links.md), [whole book](whole-book.md), [workspace](workspace.md), [word counts](word-counts.md), [outline](outline.md), [copilot](copilot.md), [agent](agent.md), [timeline](timeline.md), [element overview](element-overview.md) |
| Review fixes for colour wells, hover cards, popover saves and Agent change matching | this batch | [settings](settings.md), [workspace](workspace.md), [timeline](timeline.md), [agent](agent.md) |

## Next batch

Paused on 2026-09-29 (tag `apple-native-paused-2026-09-29`); the author is
iterating on the Tauri client. If resumed, the next work is the Mac shell
restructure to the Tauri skeleton, in six batches with a review after each:

1. Window skeleton: three-pane split view with collapsible sidebars, unified
   toolbar (sidebar toggles, back/forward, right-panel switcher), a title-bar
   tab strip (drag, close, context menu) and the status bar.
2. Left sidebar: 章节/设定/灵感 switch with the project in its header,
   source-list rows with SF Symbols, grouping and sorting, actions in context
   menus instead of button rows.
3. Right sidebar: 审阅, 素材, 统计 and 写作助手 as collapsible panes instead of
   floating windows.
4. Super views and bottom timeline: 设定总览, 故事图谱 and 备忘与素材 as
   in-window full-content destinations from the toolbar's workspace
   navigation (with 项目主页 and 全书长卷), returning to the tabs; the bottom
   timeline docked under the centre column.
5. Editor pages: compact headers, collapsible 摘要 and 关系, an icon format
   bar, the body as a centred page; the same for element, drift, category and
   storyline pages.
6. Visual consistency: spacing, type scale, colours, dark mode, empty states.

The open gates that need the author: attended performance certification,
physical IME, signing and distribution.

## Open gates

These stay open; they block only the paths named, not the local writing loop.

- **Old-peer deletions after alias repair**: six known failures where a
  late deletion does not remove the repaired visible copy. Needs authored-delete
  provenance and durable logical deletion through history before that remote
  path is enabled. [Diagnostic](acceptance/alias-delete-diagnostic.json),
  [investigation](relocation-design.md).
- **Structural concurrency**: general same-block and cross-container
  reconciliation, and relocation of unselected subtrees (three rejected
  blockquote shapes) remain unsupported. Keep the causal source graph and the
  shared history path; do not replace them with offset-based copies.
  [Relocation design](relocation-design.md), [document core](document-core.md).
- **Semantic receiver and authority owner**: tested in isolation only; general
  incoming/tail recovery and production host integration remain.
  [Receiver investigation](relocation-design.md), [authoring](native-authoring.md).
- **System input method**: automated system-Pinyin input commits Latin text
  without marked composition (also in a stock NSTextView). Physical keyboard
  composition has not been established. [Observation](system-ime.md).
- **Desktop XCTest input**: keyboard synthesis opened System Settings and timed
  out; repair the input path before rerunning it.
- **JSON body caches**: chapter and drift caches follow every save
  ([word counts](word-counts.md)); `element`, `element_category` and
  `storylines` `content_json` remain creation seeds, and native readers use
  live Yjs state.
- **Performance**: the 200k prototype sample and the Tauri baseline are recorded
  but not a workspace-budget certification. [Experiment](performance.md).
- **Device, account and distribution**: signing and installation are blocked by
  the missing Xcode account session. [Device prerequisites](device-acceptance.md).

## Budgets and evidence

Target budgets once the writing flow is complete, measured on the synthetic
corpus against the current editor on the same machine: input-to-paint p95 at
most 50 ms, no ordinary edit/scroll main-thread stall above 100 ms, warm chapter
switch at most 200 ms, and no memory growth over repeated open/close. These are
targets, not results.

Evidence dimensions are independent: source tests, file-backed integration,
macOS native UI, iPhone simulator, iPad simulator, physical device, real account,
minimum OS, Intel build and distribution package. A skipped dimension is
`not-run` and is never inferred from another. Logs and xcresult bundles stay in
ignored local output; checked-in reports hold relative paths and hashes only.
Generated reports under [acceptance](acceptance/README.md) are the authority for
exact counts and outcomes. `pnpm apple:refresh` regenerates stale reports.
