# Native act boundary editing

The existing whole-book outline exposes “在此开始一幕” on a chapter and rename
and “移除分界（保留章节）” on an act. Both hosts call the same Rust domain
commands. This local writing batch has no Google Drive dependency.

## Domain contract

An act is a boundary on the continuous `bookOrder` axis, not a container owning
chapters. Creation resolves the chosen chapter's current finite coordinate
inside the transaction, refuses an existing boundary at that coordinate, and
assigns the default name from its final sorted position. It does not add an
implicit first act or renumber chapters. Chapters before the first finite
boundary remain unassigned; empty acts and existing book-head anchors remain
valid.

Rename changes only the name and timestamp. Removing a boundary removes only
that act. Chapter coordinates, prose, comments and any bound drift node remain
intact. Notes binding is derived from the act row; its removal releases that
binding without deleting the note. Color and notes metadata are preserved by
rename. Create, name change and remove record canonical create, field and purge
originals with their domain writes and receipts in one transaction. A failed
receipt rolls back the command and its sequence allocation. Published SQLite
migrations are unchanged.

## Native ownership

Swift presents a per-row action menu and a rename sheet. Coordinates, default
names, membership and lifecycle rules remain in Rust. The workspace's existing
serial metadata path guards unfinished input and retains the active document
owner, selection and history. An accepted mutation reloads the shared outline
projection while retaining expanded chapters and their heading details. A
failed refresh reports that the domain command committed, rather than claiming
it was rolled back.

Global chapter spreading (打散) is not ported. Binding a drift as an act's
notes (幕笔记) from the act row's menu is described with [drifts](drifts.md).

## Moving boundaries

`workspaceMoveAct` moves an act's start to a finite book-axis coordinate
strictly between its neighbouring boundaries, so act order never changes;
at or beyond a neighbour Rust refuses (“幕的起点不能越过相邻的幕”) and writes
nothing, and an unchanged start writes nothing. A move is one `field.set
startOrder`. Chapters and prose are untouched; membership follows the
coordinate.

The 幕 rail of the [bottom timeline](timeline.md#bottom-timeline-底部时间轴)
drags a boundary between chapter slots: a boundary before a chapter takes
that chapter's coordinate (as 在此开始一幕 does), one after the last chapter
one step beyond it. Outline rows carry no coordinates, so the rail derives
each act's first chapter slot from the outline's reading order and the
chapter list's `bookOrder`. The drag is clamped to slots strictly after the
previous act's start and before the next act's; a view made stale by an act
created elsewhere is refused by Rust and reads acts again. The rail also
renames (double-click or 重命名…), starts a new act at a chapter (在此处开始新幕),
removes a boundary after confirmation (删除, chapters join the previous act)
and sets 幕颜色.

## Act colours

`workspaceSetActColor` stores an act's `#rrggbb` colour or clears it with
null in one `field.set` of `color` on the `book-act`; an unchanged colour
writes nothing and a malformed one is refused. `workspaceOutline` act rows
carry `color` when one is stored. 幕颜色 on an act row's 操作 menu in the 整书大纲
and on a 全书长卷 separator's context menu offers eight colours (the six
story hues by name, 红 and 灰), the stored one checked, and 恢复默认 while one
is stored. The outline row shows a small swatch; the 全书长卷 separators, 统计's
strip, act rows and chapter bars and the 设定总览's act strip use the stored
colour and fall back to the hue cycle by position. Each view follows the
other's change. The [review cases](review.md) accept it.

## Acceptance

This batch's active implementation and routine acceptance scope is Mac-only.
iPhone and iPad work is deferred until the Mac migration is complete and the
author discusses other platforms. Existing UIKit controls and historical mobile
results remain, but there is no current mobile exit gate. Desktop XCTest input
remains excluded from the default run.

`pnpm apple:workspace-act:acceptance` generates
[the act boundary report](acceptance/p3c-act-boundaries.json). Three bounded
core/bridge groups cover create/rename and cold outline; removing boundaries
and keeping empty acts without touching chapter data; and real receipt-failure
rollback, wrong scope and duplicate-coordinate rejection with successful retry; boundary
moves and their neighbour refusals are covered by the bridge tests.
The production TypeScript reducer receives actual native originals on independent
SQLite copies. Production act derivation checks the resulting outline.

[AppKit binding](acceptance/p2b-binding.json) exercises the shared queue, expanded
outline, live editor selection/history and reopen; the bottom timeline cases
drag, clamp, refuse, rename, create, remove and colour acts from the rail. The optional UI workflow
creates and renames a boundary, restarts, removes it and continues chapter
navigation without losing prose. Only dimensions actually executed in the
[native report](acceptance/p2b-native.json) count as evidence; current Mac-only
acceptance does not imply a desktop XCTest or mobile UI pass. Fault injection and orderly process restart do not certify
power-loss recovery, physical IME, real devices or signed distribution.
