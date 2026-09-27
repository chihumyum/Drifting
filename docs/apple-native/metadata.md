# Chapter, drift and project metadata

Chapters and drifts carry a 摘要 (summary) and a writing status. A project
carries 本书简介 (its summary), 本书字段 (ordered facts) and 故事线字段模版 (the
facts a new storyline clones). The Mac client edits all of them.

## Domain contract

Rust's `workspaceMetadata` command (`project`, `updateProject`, `node`,
`nodes`, `setNodeSummary`, `setNodeStatus`) authors the renderer's originals:

- `nodes` reads every live chapter's and drift's id, kind, title, summary,
  status and `updated_at` in one query. The writing assistant's
  `list_chapters`, the 漂流 panel's statuses and the 设定总览's pills use it
  instead of one `node` read per chapter or drift.

- `updateProject` is one original: project facts through the KV authority
  (purges, creates and `field.set`s, then `order.move` for inserted runs or an
  `order.rebalance` per entry after a reorder), then the storyline template the
  same way, then `field.set summary`. It writes the `kv_json` and
  `storyline_template_kv_json` projections and stamps `updated_at`. Facts keep
  the typed text; rows with a blank key and value are dropped. Storyline
  creation clones the template.
- `setNodeSummary` is `updateNodeSummary`: one `field.set summary` with a
  wall-clock stamp.
- `setNodeStatus` is `updateNode({ writingStatus })`: chapters take
  `draft`/`finished`/`discarded` and drifts `drifting`/`resting`; `updated_at`
  advances at least 1 ms. Any other status is refused before writing.
- An unchanged value writes nothing; the renderer journals some unchanged
  writes (the dashboard resends the summary with every facts edit).

The renderer reducer and the native remote receiver validated a retired status
list (`revising`, `done`, `sorted`), which refused every finished, discarded or
resting status; both now accept the domain values. No SQLite migration is added.

## Native interaction

A chapter tab is a page: the title (renamed from the chapter list) with 状态
beside it and 摘要 below, on a neutral wash above the body. A drift page adds
摘要 and 状态 rows above 分组 and 幕笔记. Status labels are the renderer's zh-CN
labels: 草稿, 已完成 and 已弃用; 漂浮中 and 休眠. A page reads its node's stored
values when it opens and keeps both fields disabled until then.

摘要 is trimmed, as the renderer trims it, and commits on end-editing when it
changed. The trimmed form is shown after the write, and Escape restores the
stored text. 状态 commits on a popup choice; choosing the current status writes
nothing. Commands run one at a time, and edits made during a write are sent
together in the next one. A refusal keeps the typed text, shows the stored
status again and states the reason in Chinese. These are metadata writes: the
body owner, its input and its history are untouched. Every reply reaches the
node's other pages (such as the split pane), the outline, the drift panel and
the chapter list. A drift summary also re-reads the drift library.

The outline shows each chapter's status in small text after its title. 已完成
is slightly stronger, 草稿 is quiet, and 已弃用 also mutes the title. There are
no edge accents. The chapter row's 操作 menu and the chapter list's context menu
have a 写作状态 section with the current status checked. In the 漂流 panel, a
休眠 drift stays in place with a muted title and a small 休眠 note. Its row menu
has a 状态 section. Drift library rows carry no status, so the panel reads each
live drift's metadata once and adopts every later reply. A restored drift is
read again.

文件 › 项目资料… (⌥⌘I; ⇧⌘I is Copilot 分析), or 资料 beside the project
actions, opens a sheet. It shows the chapters counted by status (“共 3 章 ·
草稿 1 · 已完成 1”) and three parts:

- 本书简介 is trimmed and saved on end-editing.
- 本书字段 uses the shared facts editor.
- 故事线字段模版 also uses the facts editor. A note says that new storylines copy
  it and existing ones do not change.

Facts keep the typed text. A blank row stays local, and a list is written after
a row ends editing or is added, removed or moved. 完成 writes any pending edit
and then closes. After a refusal the sheet stays open with the typed text and
rows.

## Acceptance

`pnpm apple:workspace-metadata:acceptance` generates
[the metadata report](acceptance/p3i-metadata.json): core and bridge suites,
renderer use cases authoring byte-identical originals, and production reducer
replay with table parity. The receiver's multi-field stamp defect is pinned
there, as in the drift report.

Three programmatic AppKit cases in the
[binding report](acceptance/p2b-binding.json) (`--metadata-only` runs only
these) drive the real pages, drift panel, outline and project sheet, wired as
the app wires them. They check the journal rows each step writes.

- **Chapter page.** 摘要 is trimmed and written once. Unchanged, Escape and
  refused edits write no row. The status from the page and from the outline
  menu reaches both split panes and the outline, where 已弃用 mutes the title.
  Rust refuses a drift status. The body and its history are untouched, and
  everything survives cold reopen.
- **Drift page.** 摘要 reaches the drift library and link targets. 休眠 from the
  page mutes the panel row. The panel menu checks the current status, writes
  nothing when it is chosen again, and rests a drift that has no open page.
  Rust refuses a chapter status. A cold panel reads the statuses back from
  one `nodes` read, which lists every live chapter and drift as `node` does.
- **Project sheet.** It shows the default facts and the status counts. 本书简介 is
  trimmed, and an unchanged summary writes nothing. Facts are stored untrimmed
  and in order, and a blank row is not written. After a refusal the typed rows
  are kept and 完成 stays open. 完成 saves pending edits. A storyline created
  afterwards clones the template while an older one stays unchanged, and
  everything survives cold reopen.

Pages read their values when they open and do not follow remote metadata
changes while open. Physical input, desktop XCTest and devices are not covered.
