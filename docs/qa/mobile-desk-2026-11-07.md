# Mobile desk — Simulator acceptance, 2026-11-07

The rebuilt phone workspace (`docs/mobile-ui-foundation.md`,
`docs/design-system/touch.md`) driven in the iOS Simulator through the
frontend debug bridge. Input is `synthetic-dom` (pointer events dispatched in
the WebView); screenshots are device pixels from `xcrun simctl io screenshot`.
This is not physical-device acceptance.

## Setup

- Simulator: iPhone 17 Pro class, iOS 26.5 (`Drifting QA 20260923`), system
  language 简体中文, light and dark appearance.
- Build: `pnpm mobile:ios:debug -- --device <udid>` with
  `APPLE_DEVELOPMENT_TEAM` set builds the simulator app. On this Xcode the Tauri
  CLI then treats the booted simulator as a connected device and fails at
  "archive"; the built `Drifting.app` in DerivedData was installed with
  `xcrun simctl install` and launched against a Vite dev server started with
  the same renderer environment and the frontend debug daemon. A simulator
  whose name prefix-matches a paired physical iPhone (for example
  "iPhone 17 Pro" beside a physical "iPhone 17 Pro Max") makes the CLI pick the
  phone; give the simulator a unique name.
- Data: the built-in sample book 阿Q正传（示例） (local-only mode).

## Results

| Area | Checked | Result |
| --- | --- | --- |
| Shelf | desktop shelf in one column: title, account and bell, import / 最近删除, writing year, book cards with contour covers | pass |
| Opening a book | picks up the paper last open (第四章), reading: coming back from the shelf the prose does not take focus | pass |
| Paper | folio, title, summary, prose with sand underlines on names; fore-edge with the current chapter and reading grain; paper toolbar in the lower-right without the immersive and reference buttons; the prose fades out under the toolbar and dock | pass |
| Dock | moons, current pill with mark and name, marks for other papers, plus; tapping a mark turns to it; a second paper opened from the left desk joins the dock | pass |
| Left desk | 书架 / 章节 要素 构想 / 搜索 tab row with the glass block; panel header with whole-book entries; chapters by storyline with seals and dates; the open chapter framed in sand; elements in category sand frames; account cell at the foot | pass |
| Right desk | 审阅 素材库 统计 帮手; the desktop Agent panel with its connect step; composer placeholder without a keyboard shortcut | pass |
| Holding a thing | holding a chapter cell 650ms opens its card (word count, storylines, summary, 写作状态, 编辑故事线, 删除节点) with 44px rows | pass |
| Tapping a name | reading, a tap on 阿Q opens the element card with 打开; the prose does not take focus | pass |
| Writing | focusing the prose hides the dock, toolbar and fore-edge and shows the keyboard bar; with a selection the bar adds comment, patch and Agent | pass |
| Agent hand-off | the bar's Agent button opens the right desk on 帮手 | pass |
| Bottom Panel | the timeline toggle lifts the paper's foot onto the Bottom Timeline (书序/叙事时, acts, lanes, clips); storyline names on one line with the count under them | pass |
| Project Home | the desktop Project Home on the paper: title, readouts, 继续写, 全书, 新建 without ⌘N; the plus floats the create row over the dock | pass |
| Super View | 要素全景 from the element panel's header, 叙事结构图 from Project Home; the head fits a phone (back and switcher, then the view's controls on a second row), its ground reaches under the status bar; the legend is hidden; the story graph's rail is 104px so a whole chapter card shows | pass |
| ⋯ menu | the paper toolbar's menu with share, export, storylines, writing status and delete | pass |
| Settings | index with the desktop rail's brush icons, no shortcut section, round glass back; the editor panel | pass |
| Dark | shelf, desks, paper, cards and menus in dark | pass |

## Not covered here

- The system keyboard: the Simulator wrote with a hardware keyboard, so the
  bar's ride on the keyboard's top edge (`visualViewport`, native geometry
  event) was not seen.
- Real touch: holds, pans and flicks were dispatched as synthetic pointer
  events; finger feel, velocity and multi-touch need a device.
- Frame rate of flowing glass and sand frames on a phone GPU.
- The first run on a fresh library (the guide had already been dismissed).
- An Agent turn with a connected model (no model was connected), including
  whether a selection rides along as context.
