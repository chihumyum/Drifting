# Whole book, statistics and writing plan

The 全书长卷 shows every live chapter in reading order in one scroll, with
act separators. 统计 describes the book on that axis, and the writing plan
(写作计划) sets its word target. Native only; no Tauri interoperability is
kept. There is no new Rust command or SQLite migration.

## Native interaction

视图 › 全书长卷 (⇧⌘B) or 长卷 beside 新建章节 opens a panel over the editor
area, beside the chapter list, like the 故事图谱 panel. Its toolbar has 跳到
(acts and numbered chapters), 统计 and 关闭. While it is open, a chapter row in
the sidebar and a chapter or heading in the 整书大纲 scroll it there, and the
heading takes the caret.

The book comes from Rust's outline rows (acts, including empty ones, and
chapters) and each chapter's status from the chapter list. An act separator
is the act's name on a wash in its colour (stored with 幕颜色, else the
renderer's six story hues by position) with its chapter count; there is no
edge accent. Right-clicking it offers 幕颜色 ([act boundaries](act-boundaries.md)).
Each chapter shows its title, status and word count, then its body.
Right-clicking a chapter offers its 写作状态.

- **Virtualization.** Each row has a frame, placed one after another. Rows
  get a view only within 2.5 viewports of the visible area. Views of farther
  rows leave the page and keep their measured height; unmeasured rows use an
  estimate from the word count. At most six chapters nearest the viewport
  centre (within ¾ of a viewport) get an editor. The chapter being written
  in may stay a seventh while nearby.
- **Bodies.** An attached body is a `NativeDocumentView` that grows with its
  text, opened through `workspaceOpenChapter` like a tab. A tab of the same
  chapter shares its owner, input queue and history. Other rows show
  read-only text: the last projection with the editor's styling, or text
  read with `agentReadProse` (a read only). Clicking it attaches the editor
  there.
- **Release.** An editor is released only when its view has no queued input,
  failed or marked draft. Its owner is closed only when no tab shows the
  chapter. Closing such a tab leaves the owner to the long page. Owner changes
  suspend every editor briefly, so they wait for a pause in typing (0.6 s).
  Rows above the reading position that change height keep it in place.
- **Tab parity.** Edits, undo, formatting, comments and ⌘-click on links
  behave as in a tab. The tab host gives these views the link directory and
  link passes, and counts their saved bodies. A ⌘-clicked link closes the
  panel and opens the target as a tab.

统计 (from the toolbar and 节奏统计… in 项目资料) shows:

- 全书概览: 总字数 (chapters only, from the word-count model), 章节,
  平均每章, 完成度 (the share of chapters 已完成) and the status counts;
- 已写 / 目标 and a progress track, from the writing plan;
- 幕节奏: a strip and one row per act with its chapters, words and share;
- 章节长度节奏: one bar per chapter in book order, scaled to the longest, in
  its act's colour (neutral before the first act). Hovering names the
  chapter; a click scrolls the 全书长卷 there, or opens the chapter from
  项目资料.

Until every chapter has a canonical count, the values read 统计中… and the
rhythm sections stay hidden.

写作计划 in 项目资料 holds 目标总字数 (default 120,000) and 每日目标 (default
1,500). Grouping commas, full-width digits, a trailing 字 and 万 are accepted;
0 turns a goal off. Unreadable input is refused in Chinese and keeps the
typed text. Plans are stored per project in the lab's `settings.json`
(`writingPlans`), never in user defaults, and write nothing to the journal.
The sheet shows the progress towards the target beside the chapter counts by
status.

## Not ported

- **Today's words.** The renderer derives them from client-side daily
  snapshots of the book total. Version-history snapshots are not a daily
  baseline, and a first-observation baseline would count received and
  imported text as the author's, so the daily goal is stored but no progress
  is shown for it.
- **Other features.** Find in the long view (`AllChaptersFindPanel`), the
  outline rail, remembering the reading position across launches, and a
  shared toolbar for the focused chapter are not ported. Each attached
  chapter keeps its own editor controls.

## Acceptance

Five programmatic AppKit cases in `native/apple/Tests/WholeBookAcceptance.swift`
(`--whole-book-only`; [binding report](acceptance/p2b-binding.json)) drive the
real controllers, tab host, Rust workspace and SQLite:

- 200 synthetic chapters in three acts: book order and separators; at most
  six editors, six owners and 60 row views while scrolling to the end; no pass
  over 100 ms (debug build); no journal writes. Text typed in chapter 3 just
  before scrolling far away is saved and the owner closed. It shows again on
  return, and the chapter keeps its editor nearby while focused.
- An attached chapter shared with a tab: edit, element link, undo and redo,
  a comment, word counts in the header and 统计, a closed tab leaving the
  owner, ⌘-click, and releasing only owners no tab shows.
- Scrolling from the 整书大纲 (chapter and heading) and 跳到 (chapter and act).
- 统计 of a six-chapter book: 统计中… before counts; then total, average,
  completion, statuses, target progress, bar colours by act, act rows and a
  bar click that scrolls; statuses written elsewhere follow.
- 写作计划 parsing, refusal, `settings.json`, no journal writes, and a cold
  relaunch.

Physical input, desktop XCTest and a visible panel on screen are not covered.
