# Settings

设置 (app menu, ⌘,) holds the Mac lab's appearance, editor typesetting and
language preferences, following the renderer's 外观, 编辑器 and 语言 panels,
menu 快捷键 (the renderer's KeysPanel), the writing assistant's usage and
[Copilot（实验）](copilot.md).
Settings are device-local and never synchronized. Native only; no Tauri
interoperability is kept.

## Storage

- `settings.json` lives in the lab's own data directory
  (`~/Library/Application Support/<lab bundle id>/`, beside `apple-native-lab/`
  and `agent/`). No user defaults domain is used, so the production app's
  settings are never read or written. Values are read one by one: an unknown
  or out-of-range value falls back to its default (size 12–28 pt, line height
  1.0–2.0); an unreadable file means defaults and a message in 设置.
- The same file keeps each project's 写作计划 under `writingPlans`, edited in
  项目资料 ([whole book](whole-book.md)); saving a plan applies nothing else.
- Copilot's choices are under `copilot`, read value by value like the rest
  (an unknown model is the provider's first, the delay is clamped to
  5–300 seconds); saving them applies nothing else.
- 快捷键 are under `shortcuts`, keyed by menu command (`file.print`) as
  `{key, modifiers}`; an empty key removes the default and a command without
  an entry keeps its default. An unreadable or reserved entry is dropped
  alone; a shortcut two entries claim stays with the first command in menu
  order; entries of unknown commands are kept.
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
  size × 行距 − the face's natural line height); 段首缩进 indents top-level body
  paragraphs by one or two characters. 还原推荐样式 restores serif, 17 pt, 1.5 and
  no indent. A preview shows the result. Only bodies (chapter, element,
  storyline, drift) use the prose font; page headers and all UI keep the system
  font.
- 打字机滚动 (编辑器 › 书写, default off) keeps the caret line about 40% down
  the visible prose while typing, in every body editor. It aligns after the
  text system finishes an input (typing, composition, undo and redo, keyboard
  caret moves; not clicks), and once more after the input's reply restyles
  the text. Only the scroll position changes: text, selection, marked text
  and history are untouched, and scrolling by hand stays until the next
  keystroke. Own-scroll editors gain room below the text (a taller container
  inset under an unchanged top origin, not a scroll view inset, which the text
  system would treat as covered); the 全书长卷 aligns its long scroll without
  extra room, so near the end of the book the line sits lower.
- 自动保存 is shown read-only: every committed input is saved at once, so there
  is no idle interval to set. Versions are captured on save at most every
  15 minutes and on close ([history](history.md)).
- 语言: 拼写检查 (default on) toggles continuous spell checking in every body;
  手稿默认语言 (zh-CN, zh-TW, en, ja, ko, fr) sets CoreText's language attribute
  on prose: glyph forms, fallback fonts and line breaking.
- 写作助手: two tabs. 用量 of the open project's conversations and Copilot's
  requests (read only, stored beside the conversations, not in
  `settings.json`; [agent](agent.md)) and 管理 API Key…; MCP 扩展, the open
  project's MCP servers (`mcpServers` in `settings.json`, secrets in the
  Keychain; [agent](agent.md#mcp-扩展)).
- Copilot（实验）: off by default; 模型服务 and 模型 from the writing assistant's
  catalog with its Keychain keys (shown masked; 管理 API Key… opens the same
  sheet), 设定抽取 and 补丁建议, 停笔后自动 after N seconds (default 20) or
  仅手动, 输出语言 and 在灵感中启用, with a note that the analysed paragraphs go to
  the chosen provider and that costs and retention follow it
  ([copilot](copilot.md)).
- 快捷键: the installed main menu's commands grouped by menu (应用, 文件, 项目,
  编辑, 格式, 视图, 帮助) with their shortcuts; one layout builds the menu and
  this list (defaults include ⌘P 打印…, ⇧⌘P 项目书架…, ⇧⌘I Copilot 分析 and
  ⌥⌘I 项目资料…). Clicking a shortcut records the next key press, which the
  menus do not see; Esc cancels and ⌫ removes it. A combination without ⌘ or
  ⌃, one the system reserves (⌘Q, ⌘W, ⌘H, ⌥⌘H, ⌘M, ⌘Tab, ⌘`, ⌘Space,
  ⌃⌘F, ⇧⌘3–5 and others) or one another command uses is refused in Chinese,
  naming it, and recording continues. The system's text-editing commands
  (撤销, 重做, 剪切, 复制, 粘贴, 全选) and 退出 are listed but fixed. 还原 returns a
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
reserved and text-editing shortcuts and ones without ⌘ or ⌃ while
recording continues, cancels with Esc, removes with ⌫, refuses a reset onto a
default in use, resets one and all, and relaunches the store, a new menu and
the settings window with the shortcuts applied; a hand-edited file falls back
entry by entry. Physical key presses are not covered.
The Copilot pane, its storage and relaunch are covered by the
[Copilot cases](copilot.md#acceptance). `--editor-extras-only` checks
打字机滚动: the caret line at 40% after typing at the end and in the middle of
a long chapter and in an element page, marked text unpublished and one undo
exact, a hand scroll kept until the next keystroke, nothing aligned once off,
and the choice in `settings.json` and the 设置 checkbox.
