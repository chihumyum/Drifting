# Copilot（实验）

Copilot reads what the author has just written and proposes new elements
(设定抽取) and element state changes (补丁建议) as suggestions in 审阅. It
never writes prose; every suggestion waits for 接受 or 拒绝. Native only: no
Tauri interoperability is kept, and the renderer's inline popover, bottom
menu, summaries and hosted tiers are not ported.

## Settings

设置 › Copilot（实验） (see [settings](settings.md)), stored under `copilot` in
the lab's `settings.json`; off by default.

- 模型服务: the writing assistant's providers and models
  ([agent](agent.md)), without thinking. Keys are the assistant's Keychain
  items (管理 API Key… opens the same sheet); nothing new is stored.
- 任务: 设定抽取 and 补丁建议, each with its own switch (both on).
- 触发: 停笔后自动 after N seconds without typing (5–300, default 20), or 仅手动.
  编辑 › Copilot 分析 (⇧⌘I) and the prose context menu always work.
- 输出语言: 跟随手稿, 简体中文, 繁體中文, English, 日本語, 한국어, Français.
- 在灵感中启用 (default off): drift bodies are analysed too.
- The pane says plainly that the analysed paragraphs, element names,
  categories and patch titles go to the chosen provider, and that costs,
  privacy and retention follow that provider.

`项目资料…` moved to ⌥⌘I so that ⇧⌘I is Copilot's, as in the renderer.

## Runs

- A chapter tab (and, when allowed, a drift tab) reports each edit; the
  全书长卷 does not. The first edit records the body's paragraphs as the
  baseline, and each completed run moves it. A run sends the blocks added or
  changed since the baseline, at most the last 12 and 6,000 characters, never
  the whole book. By hand, with nothing changed, the paragraphs the selection
  touches (or the caret's) are sent instead.
- 设定抽取 sends the categories, every live name and alias and the names of
  rejected element suggestions (`suggestionActions`), and asks for
  `{name, category, summary, evidence}`. Names already in the library, open or
  rejected are dropped again locally; an unknown category becomes 未分类.
- 补丁建议 runs when the paragraphs name live elements (by name or alias, at
  most 12): each with its category, summary and valid patch titles, plus the
  rejected patch suggestions, asking for `{elementId, title, body, evidence}`.
  A proposal repeating a valid patch's title or body, a rejected or open one,
  or naming an element not sent is dropped.
- Each remaining proposal is anchored to its evidence, found verbatim in the
  analysed blocks first, then anywhere in the body; not found, it is dropped.
  The suggestion is `documentCreateComment` with `suggestion.metadata`
  (`type` element or patch, the proposal, evidence, provider, model, and the
  evidence's block for a patch) through the body's owner, once that owner has
  no input in flight. Its body is 新设定「名称」（分类） or 设定补丁「设定」：标题
  with the summary or patch body.
- One request at a time per project; runs never hold typing. Closing the
  body's last tab stops its run (the request is cancelled; nothing more is
  added). Turning Copilot or 在灵感中启用 off stops a run it no longer allows.
  A run that came due during another starts after it.
- Requests are complete (non-streamed) replies through the assistant's
  drivers with its retry policy (network, 429 and 5xx up to three times; 401,
  403, 404 and 400 not). Usage is recorded per request in
  `agent/<projectId>/copilot-usage.json` and listed as a Copilot row in
  设置 › 写作助手 › 用量.
- A failed run keeps its paragraphs for the next one. The status beside
  历史版本… reads Copilot 正在分析…, Copilot 已提出 N 条建议, Copilot 没有新建议 or
  Copilot 出错：….

## Review

Suggestions are listed in 审阅 (全部 and the Copilot filter; not 批注) and in
the chapter's 批注 panel, with 定位, 接受 and 拒绝 ([review](review.md)).

- 接受 on an element suggestion creates the element in its category with the
  summary (`createElement`); for 未分类 or a category no longer in the library,
  接受 offers the live categories to choose from. On a patch suggestion it
  creates the patch anchored to the evidence (`workspacePatches createPatch`
  with source: the live anchor in an open body, else the recorded block and
  quote). Then `resolveSuggestion accepted:true` records `{elementId}` or
  `{patchId}`.
- 拒绝 records `resolveSuggestion accepted:false`; later runs send and drop the
  rejected name or change.
- A refused create (a name taken meanwhile, a trashed element) leaves the
  suggestion open with the reason on its card and writes nothing.
- Decided suggestions are `converted` and leave the open lists; the 批注 panel
  shows them under 显示已解决.

## Known gap

Rust anchors suggestions in chapters only: `documentCreateComment` on a drift
owner is refused (`Chapter is not available in this project`), so with
在灵感中启用 on, drift paragraphs are analysed but their suggestions are not
stored; the status says so. The Swift path is the chapter's.

## Acceptance

Six programmatic AppKit cases in `native/apple/Tests/CopilotAcceptance.swift`
(`--copilot-only`; [binding report](acceptance/p2b-binding.json)) drive the real
tab host, editors, 审阅 and 批注 panels, settings pane and store, Rust
workspace and SQLite with a `URLProtocol` stub of synthetic JSON replies and
in-memory synthetic keys: off by default, settings and relaunch, the idle and
manual triggers, changed-paragraph requests, exclusions, evidence anchoring
and drops, element and patch acceptance with journal assertions, rejection,
refused creates, typing during a request, cancellation on close, retries and
errors, and the drift switch. Live providers, physical input and panels on
screen are not covered.
