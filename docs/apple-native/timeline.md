# Story timeline and graph

The story graph (故事图谱) lays chapters out in storyline lanes along either
the book order or the story-time (narrative) order, with timeline markers on
the narrative axis and drift cards placed freely. Native only; no Tauri
interoperability is kept.

## Domain contract

- A chapter's narrative order is a finite number or `null` (not placed in story
  time). Setting it writes `field.set narrativeOrder` and advances `updated_at`
  by at least 1 ms; drifts have none. Unchanged values write nothing.
- Moving a chapter into another lane makes that storyline its primary (the
  previous primary's membership is dropped, others stay); a lane change alone
  is a storyline membership command.
- `moveChapter` is one graph drop: an optional order (`null` unplaces), an
  optional lane (a storyline becomes primary by the same rule; `null` removes
  every link) and an optional `bookBefore` (a reading-order move before that
  chapter, or last with `null`, as chapter reordering does) change together
  in one original, or not at all, and it returns the moved node. With a lane
  it also returns the storyline library (`storylines`: `{storylines,
  trashedStorylines, memberships}`). A destination that is gone is refused.
  An unchanged drop writes nothing.
- Timeline markers (`timeline_marker`) sit at a narrative order with a label,
  optionally bound to a live drift, which captions a label-less marker. Create,
  edit (order, label, binding) and delete journal a `timeline-marker` entity;
  trashing a bound drift unbinds its markers and captions blank ones with its
  title. Markers from before native journaling are edited without a lifecycle.
- Drift cards keep a graph position (`tuple.set graph.position`).
- `workspaceTimeline` returns every live node's narrative order and position
  and the markers in narrative order.

No SQLite migration is added.

## Native interaction

故事图谱 (the sidebar's 故事图谱 beside 上移/下移, and 视图 › 故事图谱, ⌃⌘G) opens a
large panel over the window. Its toolbar switches the axis between 成书顺序 (the
default) and 故事时间 and offers 添加标记…. The canvas has one lane per live
storyline in authored order, then 未归属 (本书 while there are no storylines);
lane names, colour dots and chapter counts float at the leading edge while the
axis scrolls. Chapter cards sit in their primary's lane on a wash of its
colour, one slot per position: book order on 成书顺序, rank in story time (ties
by book order) on 故事时间, where unplaced chapters wait in a 未放置 tray. A card
shows its § book number, a status other than 草稿, the compact word count and,
once two markers carry numbers (“1938 春”), the converted story time;
discarded chapters are dimmed.

A drag moves layer-backed views only; the drop sends the commands. Along the
book axis the chapter moves before the neighbour it was dropped ahead of;
along the narrative axis it takes the midpoint of its new neighbours' orders
(one step beyond a single neighbour, 1 on an empty axis), and a drop on the
tray sets null. Dropped in another lane, the target storyline becomes primary,
the previous primary's membership is dropped and others stay (未归属 clears
them). On 故事时间 the lane and the order go in one `moveChapter` command, so a
refusal (a storyline trashed elsewhere, say) leaves both as they were; the
reply's storyline library replaces the graph's and the tab host's, with no
second read. On 成书顺序 the lane and the book position go in one
`moveChapter` with `bookBefore` in the same way, so a refused destination (a
chapter trashed elsewhere) leaves the lane unchanged too; the chapter list is
read after it, and the storyline library when no lane was sent. A lane change
alone is the membership command. Each is sent only when it changes; a drop in
place writes nothing. A card's menu offers 打开 (also double-click),
移出故事时间 or 放到故事时间末尾, 移到轨道 and 写作状态.

On 故事时间 the marker row shows pins at their orders, placed linearly between
the placed chapters' slots and one slot per unit beyond them. 添加标记… adds a
marker after the last chapter or marker; the row's menu adds one at the
clicked order. A pin drags along the axis; its menu has 重命名… (also
double-click), 绑定漂流, 打开漂流, 解除绑定 (a label-less marker keeps its drift's
title) and 删除标记… after confirmation. Drift cards flow in the 漂流 area until
placed; a drag stores the position inside the area, and double-click or 打开
opens the drift page. Opening a page closes the panel, which sits over the
editor; the axis is remembered per project for the session. Book moves, lane changes and statuses reach the chapter
list, pages and the outline; changes made elsewhere reach the panel, which also
reads everything again, without blocking drags, whenever it becomes key.

## Bottom timeline (底部时间轴)

视图 › 底部时间轴 (⌥⌘B) toggles a dock between the editor area and the status
line for the shown project; shown or hidden and the mode are remembered per
project in the lab's `settings.json` (`bottomTimelines`), never in the
journal. It reuses the story graph's model: the same lanes, placement rules
and drop commands, while outline rows supply its acts.

- **阅读顺序.** Compact chapter tiles (§ number and title) sit in storyline
  rows (then 未归属; 本书 without storylines) at their book slot, on a wash of
  the row's colour; discarded chapters are dimmed. The 幕 rail above shows
  each act as a band over its chapters in its stored colour or its hue by
  position, with its name and chapter count; empty acts keep a small band.
  Dragging a band moves its boundary ([act boundaries](act-boundaries.md#moving-boundaries));
  its menu and the bare rail's offer 重命名…, 在此处开始新幕, 删除 and 幕颜色.
- **故事时间.** Tiles sit at their rank in story time with the timeline
  markers on the rail row, placed as on the 故事图谱. 未放置 N lists the
  chapters without a story time (a popover under the button): a title opens
  the chapter, 放到末尾 places it after the last placed one.
- **Tiles.** A click opens the chapter as a tab (or scrolls the open 全书长卷);
  the active tab's chapter is outlined in the accent colour and 定位当前章
  scrolls to it. A drag moves only the tile view and shows the insertion
  point; the drop sends the story graph's commands (one `moveChapter` for a
  book move with or without a row change or for story time, or a lane
  change alone), and a drop in place writes nothing. A tile's menu offers 打开, 移到轨道, 在此开始新幕 or 移出故事时间.
- **Following.** Chapters created, renamed, moved, trashed or restored,
  acts changed in the 整书大纲 or a 全书长卷 separator, storylines, statuses,
  counts and story time changed in the 故事图谱 reach the dock without
  reopening it, and it reads everything again when the window becomes key.
  Its own book moves, lane changes, story time and act commands reach the
  chapter list, tabs, the outline, the 全书长卷, the 设定总览 and the 故事图谱.
  Showing, switching modes and scrolling only read.

Tiles, bands and markers are small views that draw themselves, so 200
chapters lay out in a few milliseconds.

## Acceptance

Core and bridge tests cover narrative order, markers, positions, drift trash
unbinding and cold reopen.

Eight programmatic AppKit cases in the [binding report](acceptance/p2b-binding.json)
(`--timeline-only`) drive the real panel, canvas and cards with synthesized
mouse events: lanes by primary with book positions, statuses and counts; a
book drag (no Rust call or render until the drop, one `field.set node`, the
chapter list and memberships following, nothing for a drop in place), a drop
into another lane and slot as one original, and a destination trashed
elsewhere refused with the lane and the book order unchanged; lane
drags and 移到轨道 checked against the storyline library and journal; tray
placement at neighbour midpoints, reordering, a combined lane and order drop
as one original and one request whose library matches a separate read, a
drop into a storyline trashed elsewhere and a non-finite order refused with
neither the lane nor the order changed, and null through the menu and the
tray; markers created, renamed, bound,
captioned, dragged, converting story time, unbound, refused unnamed and
deleted; drift positions (`tuple.set node`), clamping and opening; a cold
reopen; and 200 chapters dragged without calls until the drop. Physical drags,
scrolling and the floating rail are not covered.

Five cases in `native/apple/Tests/BottomTimelineAcceptance.swift`
(`--bottom-timeline-only`) drive the real dock coordinator, controller and
canvas with synthesized mouse events: rows, bands in act colours, the
current chapter following the tab and a tile click opening it, with nothing
written by showing, switching or scrolling; boundary drags (nothing until the
drop, one `field.set`, clamping, a stale drop refused and read again) and
rename, new act, deletion and colour from the rail; tile drags (a row and
slot change in one original) and 故事时间 with 未放置, 放到末尾, markers and
移出故事时间; following changes made elsewhere
and remembering per project through a cold relaunch; and 200 chapters in 3
acts and 3 rows with no main-thread pass over 100 ms (debug build) while
loading, switching, scrolling and dragging. A dock on screen, physical drags
and desktop XCTest are not covered.
