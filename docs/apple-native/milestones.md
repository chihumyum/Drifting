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
| P3 | Shared domain commands and queries | In progress: projects, chapters, order, trash, acts, outline, search, comments, element categories, elements, facts, entity links, storylines and membership, drifts and groups, chapter/drift/project metadata |
| P4 | Agent over native prose; receiver foundations | Receiver accepted; Agent not started; Google Drive excluded |
| P5a | Daily desktop writing loop | In progress: see delivered slices |
| P5b | Desktop parity: elements/materials, graph/timeline, comments/review, Agent, import/export/settings/diagnostics | Not started |
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
| Chapter, drift and project metadata | this batch | [metadata](metadata.md) |

## Next batch

Relation types and curated relations, with relations removed by trash; then
the asset library (portraits, materials), import/export and settings as P5b
parity. The in-process Agent (P4) waits for the author's decision on its
approach.

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
- **JSON body caches**: native writers keep `node_content`, `element` and
  `element_category` `content_json` as creation seeds; native readers use live
  Yjs state. Refresh the caches (or port their readers) before metrics and the
  reference index are ported.
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
