# Whole book, statistics and writing plan

The 全书长卷 shows every live chapter in reading order in one scroll, with
act separators. 统计 describes the book on that axis, the writing plan
(写作计划) sets its word target and daily goal, and 今日字数 counts today's
writing against that goal. Native only; no Tauri interoperability is kept.
There is no new Rust command or SQLite migration.

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
  failed or marked draft. Its owner is closed only when no tab or other view
  shows the chapter. Closing such a tab leaves the owner to the long page.
  Owner changes suspend every editor briefly, so they wait for a pause in
  typing (0.6 s). Rows above the reading position that change height keep it
  in place.
- **Undo across scrolling.** The owner of a chapter typed in during this
  session stays open without an editor while it has undo (or redo) history,
  so scrolling back reattaches the same owner and ⌘Z undoes the typing. At
  most 12 such owners are kept; beyond that the least recently edited one is
  closed and its undo history is lost, as it is for all of them when the
  panel closes.
- **Failed closes.** An owner whose close fails stays tracked and is tried
  again at the next quiet moment (a pause in typing, at least 2 s after the
  failure). The status line names its chapter and the reason until it
  closes. 删除项目 asks the panel first and refuses, naming the chapter,
  before anything closes; a panel closing for deletion reports the failure
  instead of waiting ([workspace](workspace.md)).
- **Tab parity.** Edits, undo, formatting, comments and ⌘-click on links
  behave as in a tab. The tab host gives these views the link directory and
  link passes, and counts their saved bodies. A ⌘-clicked link closes the
  panel and opens the target as a tab.

统计 (from the toolbar and 节奏统计… in 项目资料) shows:

- 全书概览: 总字数 (chapters only, from the word-count model), 章节,
  平均每章, 完成度 (the share of chapters 已完成) and the status counts;
- 已写 / 目标 and a progress track, from the writing plan;
- 今日: today's words against the daily goal, with a progress track;
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
status, and “今日 523 / 1,500 字 · 34%” with its track below it.

## Today's words (今日字数)

Today's words are the net change in canonical chapter word counts that this
device's own saves made on the current local calendar day: typing and
deleting, undo and redo, the writing assistant's accepted changes and
imports (a new chapter counts from zero). They can be negative. Drifts and
other bodies do not count. Received remote originals, reconciliations,
version restores, and chapter trash and restore do not count.

- **Ledger.** Rust stores a chapter's count with every body save, and all
  saves and count reads run in order on the one workspace queue. The Mac's
  ledger (`DailyWordLedger`) compares each count read with the previous one
  and adds the change to today. Around each change it must not count,
  `LabWorkspaceCore` sends a count read directly before it and an unauthored
  read directly after it (a reconcile after a receipt, which may change
  closed bodies), so the ledger re-bases over it. The first read of a project
  in a session is only a baseline; words saved but never read before quitting
  are not counted.
- **Storage.** `settings.json` keeps `dailyWords` per project and
  `yyyy-MM-dd` day, for the last 30 days (today included); older days are
  dropped when a day is written or rolls over. The ledger writes nothing
  else: no journal row, nothing that leaves the device. Deleting a project
  removes its days.
- **Days.** A change counts on the local day its read runs. A timer at the
  next local midnight starts today again from 0 in open sheets and 统计.
- **Limits.** Undoing a version restore counts as an edit. There is no
  streak or weekly total yet.

## Not ported

Find in the long view (`AllChaptersFindPanel`), the outline rail, remembering
the reading position across launches, and a shared toolbar for the focused
chapter are not ported. Each attached chapter keeps its own editor controls.

## Acceptance

Seven programmatic AppKit cases in `native/apple/Tests/WholeBookAcceptance.swift`
(`--whole-book-only`; [binding report](acceptance/p2b-binding.json)) drive the
real controllers, tab host, Rust workspace and SQLite:

- 200 synthetic chapters in three acts: book order and separators; at most
  six editors, six owners plus kept ones and 60 row views while scrolling to
  the end; no pass over 100 ms (debug build); no journal writes. Text typed
  in chapter 3 just before scrolling far away is saved and its owner kept.
  It shows again on return and ⌘Z undoes it; with the limit at one, a later
  edit elsewhere closes chapter 3's owner. The chapter keeps its editor
  nearby while focused.
- An injected close failure: the owner stays open and tracked through
  repeated attempts, the status line names it, 删除项目 refuses naming it
  with nothing closed or written, it closes once closes work again, and a
  shutdown reports a failure instead of waiting.
- An attached chapter shared with a tab: edit, element link, undo and redo,
  a comment, word counts in the header and 统计, a closed tab leaving the
  owner, ⌘-click, and releasing only owners no tab shows.
- Scrolling from the 整书大纲 (chapter and heading) and 跳到 (chapter and act).
- 统计 of a six-chapter book: 统计中… before counts; then total, average,
  completion, statuses, target progress, bar colours by act, act rows and a
  bar click that scrolls; statuses written elsewhere follow.
- 写作计划 parsing, refusal, `settings.json`, no journal writes, and a cold
  relaunch.
- 今日字数 with an injected clock: typing, undo and redo, an accepted
  writing-assistant change and an import count in 项目资料 and 统计; received
  originals into an open and a closed chapter (from a second replica), a
  version restore, and chapter trash and restore do not; midnight rollover,
  30 kept days, no journal writes, and a cold relaunch that counts nothing twice.

Physical input, desktop XCTest and a visible panel on screen are not covered.
