# Project home (项目主页)

One project's overview as a tab page, after the renderer's
`ProjectDashboard` overview. It is built from existing workspace reads; it
adds no Rust command, and showing it writes nothing to the journal. Native
only; no Tauri interoperability is kept.

## Opening

视图 › 项目主页, 项目主页 on the 项目书架 (button and row menu) and on the
project list's menu open it as a tab (“项目主页 · 名称”) in the active pane.
There is one per project: opening it again shows the open tab, in whichever
pane holds it, and reads everything again. The tab has no body, so body
commands (保存, 历史版本…, 在另一栏打开) are off while it shows; any body tab
replaces it in the pane, and closing it shows the pane's body tab again.
Closing the workspace and deleting the project close it.

## Content

- **Header.** Name and 本书简介; 编辑资料… opens 项目资料 for that project, and a
  saved summary shows at once.
- **概况.** 故事线 (live storylines), 章节 (live chapters), 设定 (live elements),
  总字数 (chapter words, 统计中… until every chapter is counted) and 最后编辑
  (the latest stamp of the project and its live chapters and drifts, as
  刚刚, N 分钟前, 今天 14:05…).
- **章节状态.** 草稿, 已完成 and 已弃用 counts, a plain progress bar of 已完成
  over all chapters and “已完成 1 / 3 章 · 33%”.
- **继续写作.** The live chapter with the latest stamp (body, 摘要 or 状态),
  its last paragraph (at most 80 characters, read once per stamp), its last
  edit and words; the button opens it.
- **写作节奏.** 今日, 连续天数, 本周 and 本月 from the 今日字数 days in
  `settings.json` against the 写作计划's daily goal: the streak counts
  consecutive days with positive words ending today, or yesterday while
  today has none, and continues past the kept days through the run carried
  when they were dropped (`dailyStreaks`: its last dropped day and length);
  weeks start on Monday; 本周 and 本月 target the daily goal
  times the days of the week or month, and 本月 names the days written. The
  ledger keeps 31 days, a whole month ([whole book](whole-book.md)).
- **故事线.** Each live storyline with its member chapters in book order as
  small squares in system colours (草稿 blue, 已完成 green, 已弃用 grey, with
  a legend); a square names “§n 标题 · 状态” and opens the chapter.
- **设定分类.** Each live category with its live elements' count, opening the
  分类页; 未分类 counts elements without a live category.
- **最近.** The last ten chapter, drift, element, category and storyline pages
  this device opened in the project, newest first, once each. Every page
  opened in a tab is recorded under `recentPages` in `settings.json`
  (identities only, titles are read live). Trashed pages are left out until
  restored; purged pages and deleted projects are forgotten. A row opens it.

Library, chapter, status, count and project-name replies reach an open page
through the tab host, as they reach other pages; stamps and the excerpt are
read again after counts change while the page is shown.

## Acceptance

Three `--recovery-home-only` cases in
`native/apple/Tests/RecoveryHomeAcceptance.swift`
([binding report](acceptance/p2b-binding.json)): opening from the menu and the
shelf as one reused tab per project, counts and statuses against Rust,
编辑资料…, 继续写作 with its last paragraph; the rhythm from a seeded ledger
across a month boundary, storyline tracks and categories that open pages and
follow a category trash; 最近 order, deduplication, limit, trash and purge,
renames, a status change, word counts, a project rename, no journal rows and
a cold relaunch.
