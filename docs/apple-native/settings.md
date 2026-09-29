# Settings

设置 (app menu, ⌘,) holds the Mac lab's appearance, editor typesetting and
language preferences, following the renderer's 外观, 编辑器 and 语言 panels,
menu 快捷键 (the renderer's KeysPanel), 模型服务 (provider keys and 语音转写),
the writing assistant's usage and [Copilot（实验）](copilot.md).
Settings are device-local and never synchronized. Native only; no Tauri
interoperability is kept.

## Storage

- `settings.json` lives in the lab's own data directory
  (`~/Library/Application Support/<lab bundle id>/`, beside `apple-native-lab/`
  and `agent/`). No user defaults domain is used, so the production app's
  settings are never read or written. Values are read one by one: an unknown
  or out-of-range value falls back to its default or is clamped (size 12–28 pt,
  line height 1.0–2.0, 段间距 0–2.5, 版心宽度 480–1280 pt, 打字机位置 25–75%);
  an unreadable file means defaults and a message in 设置.
- The same file keeps each project's 写作计划 under `writingPlans`, edited in
  项目资料 ([whole book](whole-book.md)); saving a plan applies nothing else.
- Each page's 情节规划格 dock (shown and height) is under `plotPlanners`
  ([plot planner](plot-planner.md)).
- The page kinds whose 大纲轨道 is hidden (视图 › 大纲轨道) are under
  `outlineRails` as `{kind: false}` (`chapter`, `drift`, `element`,
  `storyline`, `category`); a kind without an entry shows it, and each
  page's 便笺栏 under `stickyNotes` as `{pinned, expanded}` per project and
  page ([page statistics](page-stats.md)).
- 今日字数 days are under `dailyWords` ([whole book](whole-book.md)), and each
  project's last ten opened pages under `recentPages` as `{kind, id}`
  ([project home](project-home.md)); an unreadable entry is dropped alone.
- Storyline and category pages' list filters are under `listFilters`, per
  project and page (`storyline:<id>`, `category:<id>`; 全部 has no entry),
  and the 全书长卷's reading position under `wholeBookPositions` as `{row,
  offset}` per project ([whole book](whole-book.md)); an unreadable entry is
  dropped alone.
- Each project's tabs are under `tabSessions` (per pane: `tabs` as
  `{kind, id}`, the shown `active` tab, `home` and `homeShown`, then
  `activePane`; two panes are the split) and the project selected last under
  `lastProject` ([tabs and split](tabs-and-split.md#restoring-tabs)); an
  unreadable tab or project entry is dropped alone.
- Copilot's choices are under `copilot`, read value by value like the rest
  (an unknown model is the provider's first, the delay is clamped to
  5–300 seconds); saving them applies nothing else.
- 快捷键 are under `shortcuts`, keyed by menu command (`file.print`) as
  `{key, modifiers}`; an empty key removes the default and a command without
  an entry keeps its default. An unreadable entry, or one the rules below
  now refuse, is dropped alone and the command keeps its default; a
  shortcut two entries claim stays with the first command in menu order;
  entries of unknown commands are kept. Entries resolve before defaults: a
  default an entry already holds (⌘F kept for 项目搜索 from before 查找… had
  it) leaves its command without a shortcut rather than taking it away.
- An imported font is copied to `fonts/<uuid>.ttf|otf` in the same directory and
  registered with CTFontManager for this process only; nothing is installed.
  Prose is set from the copy's own descriptor, so a re-registered font never
  waits for the system font list. 替换 and 移除 delete the previous copy.

## Behaviour

- 外观: 主题 浅色, 深色 or 跟随系统 (the default, as Mac apps do; the renderer
  defaults to light) sets the application appearance, so every window and panel
  follows at once. 界面强调色 (default: the system accent) tints the selected
  text, the selected tab and panel selection washes; never the caret.
- 编辑器: 创作内容字体 is 系统衬线 (default: New York, with CJK in Songti SC or TC,
  Hiragino Mincho or AppleMyungjo by manuscript language), 系统无衬线, 系统等宽, an
  installed family (picked from the list or typed, localized names accepted) or
  one imported TTF/OTF (at most 64 MB, validated by CoreText). 字号 scales headings
  (28, 24, 20 pt at 17); 行距 is a multiple of the size as in CSS (line spacing =
  size × 行距 − the face's natural line height); 段间距 is the space after each
  paragraph in multiples of the size (default 0.7, the earlier 12 pt at 17 pt;
  also in printing); 段首缩进 indents top-level body paragraphs by one or two
  characters. 版心宽度 (default 760 pt, the 全书长卷's earlier column) is the
  widest the prose column grows: a wider pane centres it with equal side
  insets, a narrower one keeps the 20-point margins; the 全书长卷 sets its
  column the same way. 还原推荐样式 restores serif, 17 pt, 1.5, no indent, 段间距
  0.7 and 版心宽度 760. A preview shows the result. Only bodies (chapter, element,
  storyline, drift) use the prose font; page headers and all UI keep the system
  font.
- 打字机滚动 (编辑器 › 书写, default off) keeps the caret line at 打字机位置
  (default 40% down the visible prose, 25–75%) while typing, in every body
  editor. It aligns after the
  text system finishes an input (typing, composition, undo and redo, keyboard
  caret moves; not clicks), and once more after the input's reply restyles
  the text. Only the scroll position changes: text, selection, marked text
  and history are untouched, and scrolling by hand stays until the next
  keystroke. Own-scroll editors gain room below the text (a taller container
  inset under an unchanged top origin, not a scroll view inset, which the text
  system would treat as covered); the 全书长卷 aligns its long scroll without
  extra room, so near the end of the book the line sits lower.
- 自动链接设定名称 (编辑器 › 书写, default on): the [link pass](entity-links.md)
  after settled typing, on opening a body and after names change. Off, no pass
  runs, so typed names, new names and names inserted with the @ picker (which
  relies on a pass) get no link; links already in the prose stay. Turned on
  again, the next settled input links the body's unlinked names.
- 自动保存 is shown read-only: every committed input is saved at once, so there
  is no idle interval to set. Versions are captured on save at most every
  15 minutes and on close ([history](history.md)).
- 语言: 拼写检查 (default on) toggles continuous spell checking in every body;
  手稿默认语言 (zh-CN, zh-TW, en, ja, ko, fr) sets CoreText's language attribute
  on prose: glyph forms, fallback fonts and line breaking.
- 模型服务: each provider's key state (已保存 ····末四位 or 未设置) with 管理
  API Key… (the writing assistant's key sheet), and 语音转写: the DashScope
  (阿里云百炼) key for Qwen3-ASR that the composer's 听写 uses, saved, shown
  masked and cleared in the Keychain (`Drifting Native Lab`,
  `byok.dashscope`), with a note of what dictation sends
  ([agent](agent.md#听写)). Nothing of it is in `settings.json`.
- 写作助手: two tabs. 用量 of the open project's conversations and Copilot's
  requests (read only, stored beside the conversations, not in
  `settings.json`; [agent](agent.md)) and 管理 API Key…; MCP 扩展, the open
  project's MCP servers (`mcpServers` in `settings.json`, secrets in the
  Keychain; [agent](agent.md#mcp-扩展)).
- Copilot（实验）: off by default; 模型服务 and 模型 from the writing assistant's
  catalog with its Keychain keys (shown masked; 管理 API Key… opens the same
  sheet), 设定抽取 and 补丁建议, 停笔后自动 after N seconds (default 20) or
  仅手动, 输出语言 and 在灵感中启用, with a note listing everything that goes to
  the chosen provider and that costs and retention follow it
  ([copilot](copilot.md#settings)).
- 快捷键: the installed main menu's commands grouped by menu (应用, 文件, 项目,
  编辑, 格式, 视图, 帮助) with their shortcuts; one layout builds the menu and
  this list. Defaults include ⌘P 打印…, ⇧⌘P 项目书架…, ⇧⌘I Copilot 分析, ⌃⌘I
  Copilot 修改…,
  ⌥⌘I 项目资料…, ⌘F 查找…, ⌘G 查找下一个, ⇧⌘G 查找上一个, ⌘E 用所选内容查找, and
  for [格式](formatting.md) ⌘U 下划线, ⌘K 链接… and the macOS ⌘{ ⌘| ⌘} for
  左对齐, 居中 and 右对齐, pressed and shown with ⇧ (⇧⌘{). 故事图谱 is ⌃⌘G, so
  ⇧⌘G finds as in every Mac app. 删除线, 正文, 标题 1–3, 增加缩进, 减少缩进 and
  移除链接 start without one: indent is Tab and ⇧Tab in the prose. 引用, 无序列表
  and 有序列表 start without one too, since Mac apps disagree (Notes' ⇧⌘7 is a
  bulleted list, the renderer's a numbered one, and the renderer's quote key
  ⇧⌘B is the 全书长卷 here); typing “> ”, “- ” or “1. ” starts them. For
  [tabs](tabs-and-split.md) 视图 has ⌘[ 后退, ⌘] 前进, ⌥⌘← 上一个标签 and ⌥⌘→
  下一个标签, and 文件 › 关闭标签 is ⌘W. Clicking a shortcut records the next key press, which the
  menus do not see; Esc cancels and ⌫ removes it. A combination the system
  reserves (⌘Q, ⌘W, ⌘H, ⌥⌘H, ⌘M, ⌘Tab, ⌘`, ⌘Space, ⌃⌘F, the screenshots
  ⇧⌘3–5, which arrive as the shifted characters and are also compared on
  the key, the input sources ⌃Space and ⌃⌥Space, Mission Control and Spaces
  on ⌃ with an arrow, and others), one the text editor uses (⌘ or ⌥ alone with an
  arrow, with or without ⇧, ⌘⌫, ⌥⌫ and the Emacs keys ⌃A, ⌃E, ⌃K, ⌃B, ⌃F,
  ⌃N, ⌃P, ⌃D, ⌃H, ⌃T, ⌃O, ⌃Y and ⌃V), one without ⌘ or ⌃, or one another
  command uses is refused in Chinese naming why (由系统保留 / 由文本编辑使用 and
  what for), and recording continues. The system's text-editing commands
  (撤销, 重做, 剪切, 复制, 粘贴, 全选), 退出 and 关闭标签 (⌘W, which closes the
  window when no tab is open) are listed but fixed. A command whose default
  the author gave another command shows 无 with “默认快捷键 ⌘F 已用于“编辑 ›
  项目搜索”” under its name. 还原 returns a
  command to its default unless another command now uses it; 全部还原 returns
  all. A change applies to the menu items at once; at launch the stored
  shortcuts apply as the menu is installed. A shifted letter is set as an
  uppercase key equivalent, so the unshifted press does not trigger it.
- Every change saves and applies at once. Open editors, including hidden tabs,
  restyle in place from `DocumentStyle.typography`: text, selection, history
  and Rust are untouched, and the next edit takes the usual one-block path.
- A chosen installed family that is gone, or an imported copy that is missing or
  unreadable, falls back to the system serif; the choice is kept and a Chinese
  message shows in 设置 and in the status line at launch. A typed family that is
  not installed, and a file that is not TTF/OTF, empty, too large or unreadable,
  are refused in Chinese and nothing changes.
- Without settings (the headless suites) editors keep their earlier defaults:
  the system sans at 17 pt, line spacing 6, no indent, text-system spelling.

## Acceptance

Four programmatic AppKit cases in the [binding report](acceptance/p2b-binding.json)
(`--settings-only`) drive the real settings controllers, store, tab host and
editors. They change every font source, size, line height, indent, language,
theme, accent and spelling with editors open in both panes and a hidden tab,
check fonts (also the face CoreText draws CJK with), paragraph styles, the
language attribute, appearances, selection colours and tab tint, keep text,
selection and history, and compare typing afterwards with the full style
reference; import a generated TrueType font into the data directory and use,
replace and remove it, refusing a damaged, empty and text file; relaunch the
store, window and tab host cold with the font registered again; and fall back
for an uninstalled family and a missing or damaged copy. The open and colour
panels, physical input and the menu shortcut are not covered.
`--print-keys-only` builds the menu from the same layout with probe actions
and drives the real 快捷键 pane: it lists the menu by group, records ⌥⌘P for
打印… from a synthesized key press into the item's key equivalent (the menu
performs it, ⌘P no longer does and ⇧⌘P stays 项目书架), refuses a conflict,
reserved and text-editing shortcuts (⇧⌘3–5 as “#$%” and on another layout's
character, ⌃⇧⌘3, ⌃Space, ⌃⌥Space, ⌃ arrows, ⌘ and ⌥ arrows with and without
⇧, ⌘⌫, ⌥⌫ and the thirteen Emacs keys) and ones without ⌘ or ⌃ while
recording continues, cancels with Esc, removes with ⌫, refuses a reset onto a
default in use, resets one and all, and relaunches the store, a new menu and
the settings window with the shortcuts applied; a hand-edited file falls back
entry by entry, also for values the rules now refuse; an earlier ⌘F for
项目搜索 stays its shortcut while 查找… shows 无 naming the holder, and
resetting 项目搜索 returns ⌘F to 查找…. Physical key presses are not covered.
`--small-items-only` changes 段间距, 版心宽度, 打字机位置 and 自动链接设定名称
through the 编辑器 pane's controls with pane editors, a hidden tab and the
全书长卷 open: paragraph styles, the centred column's width and insets (a
narrow pane keeps its margins), the 全书长卷's column and editors, the caret
line at 60% and 30% after typing, no new link while off (typing and a new
element's name) with an existing link kept, then linking again; the values
in `settings.json`, a cold store and hand-edited values clamped.
`--tabs-nav-only` checks that 快捷键 lists 关闭标签 (⌘W, fixed), 后退, 前进,
上一个标签 and 下一个标签 with their defaults and refuses ⌘[ for another command,
and covers `tabSessions` and `lastProject` ([tabs](tabs-and-split.md)).
The Copilot pane, its storage and relaunch are covered by the
[Copilot cases](copilot.md#acceptance). `--editor-extras-only` checks
打字机滚动: the caret line at 40% after typing at the end and in the middle of
a long chapter and in an element page, marked text unpublished and one undo
exact, a hand scroll kept until the next keystroke, nothing aligned once off,
and the choice in `settings.json` and the 设置 checkbox.
