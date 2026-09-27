# Element overview (设定总览)

The 设定总览 lays the book's chapters out as a band across the middle and every
category as a box of element cards above and below it, with the curated
relations between cards drawn as edges. Native only; no Tauri
interoperability is kept. No SQLite migration is added.

## Domain contract

- `workspaceElements categoryLayouts` returns every live category's placement
  (`auto`, or `pinned` at `gridX`/`gridY`) with the library.
  `setCategoryLayout` with both cells pins a category; without them it returns
  to `auto`. Changed fields are `field.set` `layoutMode`, `gridX` and `gridY`
  of `element-category` in one original; an unchanged placement writes
  nothing ([categories](categories.md)).
- Relations go through the project's shared relation library
  ([relations](relations.md)): add (`entity.create`), retype and swap (the
  endpoint fields as `field.set`) and remove (`entity.purge`). Rust refuses a
  self relation (“关系的两端不能是同一个实体”) and a reversed direction.
- The canvas reads the outline, storylines, `workspaceMetadata nodes` (every
  chapter's and drift's summary and status in one read), drifts and timeline
  markers. Opening, panning and zooming write nothing to the journal. The
  viewport (the world point at the centre, the zoom and whether the 漂流 row
  is shown) is kept per project in the lab's `settings.json`
  (`elementOverviewViewports`) when the panel closes, never in user defaults.

## Layout

The renderer's geometry and solver (`solveSuperElementLayout`) are ported to
`native/apple/Shared/ElementOverviewLayout.swift`:

- **Boxes.** One element card per 96 × 56 cell. A box is √n cells wide,
  clamped to 1–6 (at least 2 with several groups). Named groups come first,
  sorted, then the ungrouped; header strips appear only with several groups.
  Heights round up to whole cells. An empty category is a 2 × 1 box marked 空.
  Elements without a live category share a 未分类 box, which is never pinned.
- **Band.** An act strip (each act's name on a wash of its colour over its
  chapters; the renderer's band has no acts), then one lane per storyline in
  authored order and 未归属 for chapters without a primary (本书 without
  storylines). Pills sit in book order, 110 wide on a 120 slot, in their
  primary's lane; a dashed transit joins pills of a storyline that is not both
  their primaries. The band is centred on the anchor and reserves whole grid
  rows plus one for the gap on either side.
- **Solver.** Pinned boxes are placed first and become obstacles; one that
  would cross the band snaps to the nearer side. Automatic boxes are packed
  largest first (ties by identity) at the lowest slot nearest the anchor on
  each side, on the side whose resulting extent plus √(area imbalance) is
  smaller. The result does not depend on input order.
- **Edges.** A relation is drawn when one end is an element card and the other
  a card, a chapter pill or, with the 漂流 row shown, a drift card. Symmetric
  types are S-curves; directed ones end in an arrow at the target's side.
  Colours follow the renderer's hash of the type over the story hues.

## Native interaction

视图 › 设定总览 (⌥⌘E) or 总览 in the 设定库 opens a large panel over the window,
as the 故事图谱 does. Its toolbar shows “N 类 · M 设定 · K 条关系”, 漂流 · N
(drifts not bound to an act or a timeline marker, with their edges), −, the
zoom, +, 重置 and 关闭. The status line gives guidance and refusals.

- **Pan and zoom.** Drag empty canvas, the band or a pill, or scroll with two
  fingers. Pinch, ⌘-scroll, ⌘+ and ⌘− zoom around the pointer or the centre
  within 40%–200%; ⌘0 and 重置 centre the band at 100%. After a pause, cards in
  view are redrawn at the zoom's resolution.
- **Opening.** A click on an element card opens its page and a click on a
  drift card its drift page; a double-click on a pill opens the chapter; a
  click on a box's legend opens the 分类页. Each opens as a tab and closes the
  panel, which sits over the editor.
- **Pinning.** Dragging a box (by its legend, its free area or a card) moves
  the box with its cards; the drop pins it to the cell under it. A drop across
  the band snaps to the nearer side; a drop in place or a click-sized drag
  writes nothing. A pinned box's menu offers 恢复自动排列 beside 打开分类页.
  未分类 cannot be pinned, so dragging it pans.
- **Card menus.** An element card offers 打开, 从此设定新建关系… and 移到回收站
  (through the tab host, which closes its pages); pills and drift cards offer
  打开 and 从此章节/漂流新建关系….
- **Relations.** A click on an edge selects it and shows a bar with its ends,
  a type popup of the author types that fit (marked 交换两端 where the ends
  would swap), 交换方向 and 删除关系; its context menu has the same actions.
  The current type writes nothing. Escape or a click on empty canvas clears
  the selection. ⌥-drag from one card to another, Shift-click two cards, or
  从此…新建关系… and a click open 新建关系 with the direction, 交换方向, the
  fitting types, 新建关系类型… and 添加. A type that fits only the other way is
  explained before anything is sent; Rust's refusals stay in the sheet.
- **Live refresh.** Libraries returned by the 设定库, pages and trash,
  relation replies from any page, chapters created, renamed, moved, trashed
  or received, act changes, lane changes, statuses, summaries and drifts reach
  the open canvas. It also reads everything again when it becomes key and
  after a remote original. A read that overlaps newer data from elsewhere is
  read again rather than adopted.

## Not ported

- The renderer's element and drift popovers (two-tier editors); native opens
  the pages instead.
- 粘带 (a band that sticks to the viewport edge), 聚焦 (edges only for cards in
  view), hidden relation types, hover and click-focus highlights, and the
  mobile link mode.
- Stored act colours: acts cycle the story hues by position, as in the
  [whole book](whole-book.md).
- Cards are drawn layers; VoiceOver reads the canvas as one element.

## Acceptance

Bridge tests cover `categoryLayouts`, `setCategoryLayout` (pin, both cells
required, auto), `moveChapter` and `nodes`. Seven cases in
`native/apple/Tests/ElementOverviewAcceptance.swift`
(`--element-overview-only`; [binding report](acceptance/p2b-binding.json))
drive the real controller, canvas, tab host, Rust workspace and SQLite with
synthesized mouse, scroll and key events:

- **Solver.** Two boxes above and below the anchor, routing around a pin,
  band crossings snapping to the nearer side, largest first, balance, no
  overlaps, the same placements for shuffled input, and box sizes and groups.
- **Layout.** Book order, act strip, lanes by primary and transits; boxes on
  both sides, off the band and apart, with grouped cards, 空 and 未分类; the
  设定库's 总览; panning by drag and scroll and zooming by ⌘-scroll, ⌘+, ⌘−,
  pinch and ⌘0 within 40%–200%, writing nothing.
- **Pinning.** One original of `field.set` placements per pin, snapping across
  the band, automatic boxes around the pins, nothing for a drop in place or a
  click, 恢复自动排列 offered only when pinned, and pins and the viewport
  (`settings.json`) through a cold relaunch.
- **Edges.** Selection, retype, the current type writing nothing, swap and
  removal with a page's 关系 section following; ⌥-drag, Shift-click and the
  card menu opening 新建关系; a reversed type refused before writing, Rust's
  self-relation refusal in the sheet, and cancelled sheets writing nothing.
- **Opening.** Element, 分类页 and chapter tabs; a single click on a pill opens
  nothing; 移到回收站 removes the card and its edges.
- **Live refresh.** The changes listed above, including drifts with their
  edges and a remote chapter original, without reopening.
- **Performance.** 60 chapters in three acts and lanes, 20 categories, 300
  elements and 400 relations: the solver takes about 5 ms, the opening pass
  about 40 ms and later passes (pan, zoom, sharpen, refresh) under 20 ms on
  the development machine in a debug build, all under the 100 ms budget, and nothing
  but the one rename is written to the journal.

The menu item and panel hosting in `AppDelegate` are built but not driven by
these cases. Physical trackpad input, desktop XCTest and a visible panel on
screen are not covered.
