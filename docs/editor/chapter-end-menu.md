# Chapter-end menu

Every chapter page ends with `⁂`, drawn as a sand-brush mark: 三尊石, the
triad of stones in a dry garden (`stones-triad`). On desktop it is also the
chapter's end menu (`ChapterEndMenu`): moving the pointer onto it (70 ms),
clicking it, or Enter/Arrow keys on it morphs the mark into three monospace
actions, each led by its brush icon, in one column centred on the mark, top
to bottom, with the primary one on the mark's own line:

- 标为完成 / 改回草稿 toggles the chapter between finished and draft; its icon
  is the brush laid on its rest (搁笔) or lifted off it (提笔), and a finished
  chapter's `⁂` takes the accent colour.
- 新建下一章 (a sprout) inserts a chapter directly after this one.
- Agent 审阅 (the paper-doll shikigami) starts a background Agent session that
  reviews the chapter.

It works in the single-chapter editor and on every chapter of 通览全书, so the
last chapter's menu is the end-of-book insert; an empty 通览全书 offers
新建第一章. Drift pages and the touch shell keep the decorative mark.

## Interaction

Opening is armed by real pointer movement on `⁂`, so a page scrolling `⁂`
under a still pointer never opens it, and hovering gives the mark no pressed
wash. The action list overhangs `⁂`'s margins, centred on it, so opening
never shifts the layout and needs no popover. The morph is one simultaneous
cross-zoom: `⁂` fades, shrinks to 0.6 and blurs 2 px while the actions fade
in, unblur and unfold a row (22 px) up and down from it, so neither state ever
reads as an empty gap — 150 ms in, 110 ms back. The list is the area the pointer may roam: moving along it keeps the
actions, and leaving it — more than 2 px above or below, or 6 px past either
side — restores `⁂` at once, as does scrolling the page under a still pointer
or leaving the window. Because the
primary action opens beneath a pointer resting on `⁂`, clicks within 250 ms of
a hover opening are ignored. A click on `⁂` opens the row at once. The keyboard
opens on 新建下一章, arrows move along the list, Escape or Tab return to `⁂`, an
outside click dismisses it, and pointer movement never closes a
keyboard-opened row. The actions use the platform monospace stack
(`--font-prose-mono`) with no border or background; each icon sits 6 px before its label.

## Actions

Insert: `chapterOrderAfter` picks the `bookOrder` — one stride after the
predecessor when the gap allows, otherwise the midpoint, never at or past the
next chapter or the next act boundary, so the chapter stays in its
predecessor's act (also before a planned empty act). Once repeated inserts
exhaust float resolution it ties with the predecessor and uuidv7 order keeps it
after. Like the sidebar's 新章节 the chapter is 未归属 with the localized default
title, which opens selected via the one-shot `requestChapterTitleFocus` intent.
The single-chapter editor opens it as a kept tab; 通览全书 promotes the new row
to the live editor through the click queue and navigates to it.

Agent review mirrors the TODO hand-off: `buildChapterReviewTask` asks the Agent
to read the chapter and leave its points as comments on the paragraphs without
editing the prose, then summarise. The session runs read-write so it can write
comments; nothing beyond that instruction prevents prose edits. While that
session's turn runs, the action reads 审阅中 · 查看 and opens it instead of
starting a second review.

A dispatched review shows in the right sidebar (`showAgentTaskInRightSidebar`):
the first pane already on the Agent tab switches to the new session; with no
Agent tab, the focused pane becomes the Agent tab. A closed sidebar opens only
when it fits — the page keeps `MIN_DESKTOP_CONTENT_WIDTH` beside at least
`MIN_REVEALED_SIDEBAR_WIDTH` of sidebar (`sidebarFitsBeside`); otherwise the
review runs unseen until 审阅中 · 查看, which always opens it.

## Acceptance

`acceptance/chapter-end-menu.json` records source SHA-256 hashes and a headless
Chromium run of the real `VirtualChapterRow`, `ChapterEndMenu`,
`chapterOrderAfter` and styles over synthetic chapters and two acts: hover
intent, no pressed wash, a prompt switch whose mid-point shows `⁂` and the
action both partly visible (and the action still blurred) in both directions,
no opening when the page scrolls `⁂` under a still pointer, all
actions on the mark's line with the primary centred on it, monospace plain
text, roaming along the line, instant close when leaving it above, below or
past either end, the early-click guard, insert placement and act containment,
the finished toggle and accent, review dispatch states, keyboard navigation,
outside-click and scroll dismissal, and the decorative variant. `chapter-insert.test.ts` and
`chapter-agent-review.test.ts` cover ordering and the review task;
`agent-chat-views.integration.test.ts` and `layout-geometry.test.ts` cover the
sidebar reveal rules and the fit check. Database
writes, the Agent runtime, the live-editor title focus, tab opening and
WKWebView pointer behaviour are outside the harness. Regenerate with
`node scripts/run-chapter-end-menu-acceptance.mjs`; verify with `--check`.
