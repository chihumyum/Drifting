# Story timeline and graph

The story graph (故事图谱) lays chapters out in storyline lanes along either
the book order or the story-time (narrative) order, with timeline markers on
the narrative axis and drift cards placed freely. Native only; no Tauri
interoperability is kept.

## Domain contract

- A chapter's narrative order is a finite number or `null` (not placed in story
  time). Setting it writes `field.set narrativeOrder` and advances `updated_at`
  by at least 1 ms; drifts have none. Unchanged values write nothing.
- Book-axis moves reuse chapter reordering; moving a chapter into another lane
  makes that storyline its primary (the previous primary's membership is
  dropped, others stay), through storyline membership.
- `moveChapter` is one graph drop: an optional order (`null` unplaces) and an
  optional lane (a storyline becomes primary by the same rule; `null` removes
  every link) change together in one original, or not at all, and it returns
  the moved node. An unchanged drop writes nothing.
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

故事图谱 (the sidebar's 故事图谱 beside 上移/下移, and 视图 › 故事图谱, ⇧⌘G) opens a
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
storyline library is read again after a lane change. On 成书顺序 a lane change
is sent before the book move. Each is sent only when it changes; a drop in
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

## Acceptance

Core and bridge tests cover narrative order, markers, positions, drift trash
unbinding and cold reopen.

Eight programmatic AppKit cases in the [binding report](acceptance/p2b-binding.json)
(`--timeline-only`) drive the real panel, canvas and cards with synthesized
mouse events: lanes by primary with book positions, statuses and counts; a
book drag (no Rust call or render until the drop, one `field.set node`, the
chapter list and memberships following, nothing for a drop in place); lane
drags and 移到轨道 checked against the storyline library and journal; tray
placement at neighbour midpoints, reordering, a combined lane and order drop
as one original, a drop into a storyline trashed elsewhere and a non-finite
order refused with neither the lane nor the order changed, and null through
the menu and the tray; markers created, renamed, bound,
captioned, dragged, converting story time, unbound, refused unnamed and
deleted; drift positions (`tuple.set node`), clamping and opening; a cold
reopen; and 200 chapters dragged without calls until the drop. Physical drags,
scrolling and the floating rail are not covered.
