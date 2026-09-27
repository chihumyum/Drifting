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
| P3 | Shared domain commands and queries | In progress: projects (with deletion), chapters, order, trash (with permanent deletion), acts (with boundary moves) and act colours, outline, search (chapters and entities), comments and TODOs, element categories, elements, facts, element patches, entity links, storylines and membership, drifts and groups, chapter/drift/project metadata, relations and associations, library order, word counts |
| P4 | Agent over native prose; receiver foundations | Receiver accepted; Mac writing assistant with reviewed proposals over prose and domain tools, author rules, working memory, task plans, compaction, retries and usage ([agent](agent.md)); experimental Copilot suggestions ([copilot](copilot.md)); Google Drive excluded |
| P5a | Daily desktop writing loop | In progress: see delivered slices |
| P5b | Desktop parity: elements/materials, graph/timeline, comments/review, Agent, import/export/settings/diagnostics | In progress: Agent, materials, import/export, graph/timeline, version history, settings, whole-book editor and statistics, element overview, review and the 备忘与素材 board, global search and today's words, element patches and the bottom timeline, the unified trash, hover cards, typewriter scrolling, the project shelf, Markdown folder export, the diagnostic summary and experimental Copilot suggestions delivered |
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
| Copilot suggestions (experimental) | this batch | [copilot](copilot.md), [review](review.md), [settings](settings.md), [chapter comments](chapter-comments.md) |

## Next batch

MCP extensions with the assistant memory fixes; then printing, PDF export
and custom shortcuts.

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
- **Copilot in drifts**: Rust anchors suggestions in chapters only
  (`documentCreateComment` on a drift owner is refused), so with 在灵感中启用
  drift paragraphs are analysed but their suggestions are not stored.
  [Copilot](copilot.md#known-gap).
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
