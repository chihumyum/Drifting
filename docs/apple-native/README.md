# Apple native client migration

Status: active, staged migration. The Tauri client remains the daily-use client.
Only synthetic projects may be opened by the native lab. No production library,
credentials, cloud account or published migration is changed by this experiment.

## Target and scope

The active migration target is macOS. At the author's latest direction on
2026-09-27, implementation and all routine acceptance are Mac-only: finish the
Mac front-end migration, then discuss iPhone and iPad with the author. Mobile
work is deferred and does not gate completion of the current migration. Keep
shared Rust and the existing UIKit implementation; historical mobile results
remain tied to the sources they actually tested.

New Android and Windows product work remains out of scope. The current native
macOS deployment target is 14; deferred UIKit code retains its iOS/iPadOS 17
configuration. macOS Intel packaging is a separate build gate; the first local
build is Apple Silicon. Minimum-version execution is also separate from building
with a newer SDK.

The author excluded Google Drive synchronization from this migration on
2026-09-26 and will redesign it after the native client migration. Do not port
its connection, credentials, transport, provider snapshots or recovery UI as
native release requirements. Shared document correctness, local persistence and
the already accepted receiver foundations remain; native writing and Agent
work continue without a Google Drive prerequisite.

The existing public `0.1.x` database compatibility promise is unchanged.
`drizzle/0000_local_first_baseline.sql` and all published migrations remain
immutable. The same journal, migration hashes, shadow migration, verified safety
snapshot and fail-closed recovery rules apply to every host.

- [Architecture decision](architecture.md)
- [Capability migration inventory](inventory.json) and [generated coverage](acceptance/inventory.json)
- [Milestones and acceptance](milestones.md)
- [Local project and chapter writing slice](workspace.md)
- [Database recovery (恢复)](recovery.md)
- [Project home (项目主页)](project-home.md)
- [Chapter trash and restore](chapter-trash.md)
- [回收站 and permanent deletion](trash.md)
- [Chapter selection comments](chapter-comments.md)
- [Elements library](element-library.md)
- [Element patches (设定补丁)](patches.md)
- [Entity links and backlinks](entity-links.md)
- [Storylines and chapter membership](storylines.md)
- [Drifts and drift groups](drifts.md)
- [Plot planner (情节规划格)](plot-planner.md)
- [Native writing assistant](agent.md)
- [Copilot（实验）: element and patch suggestions while writing](copilot.md)
- [Settings: appearance, typesetting and language](settings.md)
- [Native editor formatting, find and pickers](formatting.md)
- [Page statistics, heading rail, scrollbar markers and 便笺栏](page-stats.md)
- [Whole-book outline navigation](outline.md)
- [Act boundary editing](act-boundaries.md)
- [Story graph, story time and the bottom timeline (底部时间轴)](timeline.md)
- [Chapter tabs and split editing](tabs-and-split.md)
- [Whole book (全书长卷), statistics, writing plan and today's words](whole-book.md)
- [Element overview (设定总览)](element-overview.md)
- [Review (审阅), TODOs and the 备忘与素材 board](review.md)
- [Native interaction specification](design.md)
- [P2 document corpus specification](fixtures.md)
- [Shared document contract and P2a findings](document-core.md)
- [Unselected-subtree relocation investigation](relocation-design.md)
- [SQLite prose durability and process recovery](durability.md)
- [Native command capture and durable originals](native-authoring.md)
- [Canonical remote prose receive and replay](remote-prose-sync.md)
- [Complete chapter originals and workspace delivery](remote-workspace-sync.md)
- [Reproducible editor performance experiment](performance.md)
- [Physical-device prerequisites and acceptance](device-acceptance.md)
- [macOS system input-method observation](system-ime.md)

## Working loop

During development run only the affected tests (`cargo test` for the touched
crate or module, one XCTest class). Before each batch commit:

```sh
pnpm apple:refresh        # regenerate only stale evidence, then macOS acceptance
pnpm apple:check          # verify all evidence is current
```

`pnpm apple:refresh --list` shows what is stale; `--all` regenerates everything.
Each generator's `--check` decides staleness, so an unchanged report is verified
rather than rerun. Documentation edits never invalidate native acceptance; only
runtime sources do. The individual `pnpm apple:*:acceptance` commands remain for
focused iteration.

The document and prose crates, Apple bridge and Apple CI lane require Rust 1.96.
Application builds require Xcode, XcodeGen and the installed Rust Apple targets;
the build script generates the Xcode project from `native/apple/project.yml`.
Generated projects and build outputs are ignored. There is no development-team
ID in tracked sources.

Native acceptance is Mac-only by default. `--binding-only` runs programmatic
AppKit acceptance. Mobile flags (`--with-ios`, `--ios-only`, `--include-ipad`)
exist for later explicit runs and are not part of current acceptance. Desktop
XCTest requires `--macos-ui`: on this host keyboard synthesis opened System
Settings and timed out, so repair that path before rerunning it. A passing
default report does not imply desktop XCTest passed.

## Current state

The Mac lab opens a separate synthetic workspace
(`apple-native-lab/apple-native-workspace.db`) with project and chapter lists,
creation, rename, ordering, recoverable trash, act boundaries, selection
comments, an elements library with element pages, element patches anchored to
chapter text and automatic entity links with backlinks from chapters and pages, storylines with chapter membership, a 章节模版 per storyline
that chapters created in it (新建章节 on its page or in the 故事线 panel) start
from, list filters on storyline pages (全部, 已写, 未起) and category pages (已填写,
未填写) remembered per page, drifts with groups and act notes that
convert into chapters or elements, a 情节规划格 (plot planner) docked below a
chapter's or drift's prose, a writing assistant whose 64 tools read the project, ask the author (ask_user) and propose prose, element, patch,
storyline, relation, note/TODO, chapter, drift and project changes the author
reviews, with 作者规则, per-conversation 工作记忆 and 任务计划 (继续 after the
round limit), context compaction, automatic retries and token usage in
设置 › 写作助手 › 用量, 补充 while it works, 在当前工具后停止, a context
indicator with Max · 1M 上下文 for 1M models, and 听写 into its composer
(DashScope Qwen3-ASR with the key in 设置 › 模型服务 › 语音转写, proper nouns
corrected from the project's names), per-project MCP servers (local commands and
Streamable HTTP) in 设置 › 写作助手 › MCP 扩展 whose tools the author allows,
asks for or disables and whose results only reach the model, an
experimental Copilot (off by default) that proposes
new elements and element patches from newly written paragraphs as
suggestions the author accepts or rejects in 审阅, and Copilot 修改 (⌃⌘I) for
local rewrites with a preview, questions about a passage and chapter
summaries written only on 接受, a whole-book
outline, a continuous whole-book editor with statistics and a writing plan,
an element overview of categories around the chapter band with relation edges,
a review panel of notes and TODOs with associations, a 备忘与素材 board with
library ordering, act colours, project deletion, a bottom timeline dock with
a draggable act rail,
chapter tabs with a two-pane split (tab menus to close, move, open on the
other side and merge the panes, ⌥⌘←/⌥⌘→, ⌘W, drag to reorder, 后退/前进 with
⌘[ ⌘], and each project's tabs saved and restored when it opens, the last
project at launch), formatting (bold, italic, underline,
strike, headings, alignment, Tab indent and URL links from the 格式 menu, the
toolbar and the context menu), quotes and bulleted and numbered lists (also
typed as “> ”, “- ” or “1. ”, joining an adjacent one of the same kind,
Return starting the next item and ending the list on an empty last item, ⌫ at
the start and ⌫ or ⌦ removing the empty paragraph after it, drawn with markers in every
editor, the 全书长卷, the 历史版本 preview and print), horizontal rules
(分隔线, from 格式 and the slash menu, removed by ⌫, ⌦ or their context menu,
drawn as a centred line everywhere), a slash menu offering what applies
where it opens, find in the editor (⌘F, no
replace), an @ picker that inserts and links names, project search over chapters,
summaries, drifts, elements, categories, storylines and materials, today's
words against the daily goal, one 回收站 per project with 彻底删除, hover cards
on entity links, typewriter scrolling at a chosen height, 设置's 段间距, 版心宽度
and 自动链接设定名称, a 项目书架 of every project, import of several files or a
folder, Markdown folder export of one or every project, printing of the focused
page and PDF export of the whole book, a 全书长卷 that reopens where it was read,
a 历史版本 preview with the version's formatting,
custom menu shortcuts in 设置 › 快捷键, 统计 of the open page (视图 › 页面统计 or
its header: place in the book, words, paragraphs, sentences, 对白比, linked
设定, citations; appearances, category health, storyline status and core
设定), a 大纲轨道 of headings and page sections beside every page, shown per
page kind, scrollbar ticks for notes, TODOs and the writing assistant's
pending revisions, a 便笺栏 of notes pinned to a page's margin, a diagnostic
summary, a 项目主页 per
project (counts, chapter statuses, 继续写作, today's words with streak, week
and month, storyline tracks, categories and recently opened pages), a 恢复
window instead of the workspace when its database does not open (重试,
restore from the verified safety copy, export, diagnostics), native editing,
save and reopen. Every write
goes through shared Rust domain commands, transactions and canonical journals;
views of one chapter share its document owner and history while keeping their
own selections. Remote prose and chapter
originals are received through the shared native queue without replacing live
editors. The writing assistant keeps provider API keys, MCP secrets and the
transcription key in the lab's own Keychain service (`Drifting Native Lab`); the production Keychain
service and URL scheme are not used.

The editor is an acceptance prototype, not desktop feature parity. Physical IME,
desktop XCTest input, devices, accounts and signed distribution are unaccepted.
Delivered slices, the next batch and the open gates are in
[milestones](milestones.md); generated reports distinguish source, integration,
macOS UI, simulator, device, account and distribution evidence. A compiled
application is not evidence of a working editor or input method.
