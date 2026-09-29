# Copilot（实验）

Copilot reads what the author has just written and proposes new elements
(设定抽取) and element state changes (补丁建议) as suggestions in 审阅. It
never writes prose on its own; every suggestion waits for 接受 or 拒绝, and
[Copilot 修改](#copilot-修改) rewrites, answers or summarises only when the
author asks and writes only on 接受. Native only: no Tauri interoperability is
kept; the renderer's bottom menu, rolling section summaries, 本次执行 of
refused new content and hosted tiers are not ported.

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
- The pane lists everything sent to the chosen provider and says that
  costs, privacy and retention follow that provider (Copilot 修改 included:
  the text, its neighbours and the instruction or questions, or the body for
  a summary): the analysed paragraphs
  (at most 12 and 6,000 characters); for 设定抽取 every live element name and
  alias, every category name and the rejected element names; for 补丁建议 the
  mentioned elements' identities, names, aliases, categories and summaries
  (cut to 80 characters), their valid patch titles (or the first 30
  characters of an untitled body; at most 10 each) and the rejected patches'
  element names and titles.

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

## Copilot 修改

编辑 › Copilot 修改… (⌃⌘I, since ⇧⌘I is Copilot 分析) and the prose context
menu of a chapter or drift open a popover at the selection, or at the
caret's paragraph, while Copilot is on (`CopilotInline.swift`,
`MacCopilotInline.swift`). Requests use Copilot's provider, model, key, retry
policy and usage record, answered whole.

- **局部修改**: the instruction, the text and about 600 characters of the
  paragraphs above and below go to the model, which returns only the
  rewritten text (same language and paragraph count, no new story content).
  The target never starts or ends with white space: a selected paragraph
  break or a paragraph's indent (U+3000) stays outside the rewrite, and an
  inner line's indent that a rewrite with as many lines dropped is put back.
  A reply that differs only by white space is 没有修改. A plain request to
  continue the story is refused without a request. The
  preview marks removed text struck on a red wash and added text on a green
  one. 接受 applies it through the body's live owner with
  `workspaceAgent applyChanges` (Copilot's Agent identity, one undo step
  that ⌘Z undoes). When the popover opens, the target is widened with its
  neighbours until it is unique; 接受 needs exactly that text once and is
  otherwise refused, writing nothing, even if the original text alone
  occurs once elsewhere. 重写 asks again with the same instruction; 放弃
  writes nothing.
- **问**: the question, the text and its neighbours (with earlier questions
  and answers of the popover) go to the model; the answer shows in the
  popover and nothing is written.
- **生成章节摘要** (生成摘要 for a drift): the title and body (over 16,000
  characters, its start and end) go to the model; the proposal shows beside
  the current summary. 接受 writes it with `setNodeSummary` (one `field.set`
  original), unless the stored summary is no longer the one shown: then it
  is refused, writing nothing, and the proposal stays. 放弃 writes nothing.

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
- These are two commits. What the create made is remembered per suggestion
  (`agent/<projectId>/copilot-accepted.json`) until the decision is
  recorded. If recording fails, the card says 设定「…」已创建，但这条建议的状态没有
  更新…, and 接受 again (also after a relaunch) only records the decision with
  that identity; it never creates a second element or patch.
- 拒绝 records `resolveSuggestion accepted:false`; later runs send and drop the
  rejected name or change. After a 接受 whose decision was not recorded, 拒绝
  is refused while the element or patch it created is live (设定「…」已创建。
  再点“接受”记录这条建议；如果不需要它，请先删除它再拒绝。) and writes nothing;
  once the element is in the trash or deleted (for a patch: the patch
  deleted or its element trashed), 拒绝 records the rejection and forgets
  what was created.
- A refused create (a name taken meanwhile, a trashed element) leaves the
  suggestion open with the reason on its card and writes nothing.
- Decided suggestions are `converted` and leave the open lists; the 批注 panel
  shows them under 显示已解决.

## Drifts

With 在灵感中启用, drift paragraphs are analysed and their suggestions are
anchored in the drift body exactly as in chapters: Rust accepts anchored
notes and suggestions on any live chapter or drift body.

## Acceptance

Eight programmatic AppKit cases in `native/apple/Tests/CopilotAcceptance.swift`
(`--copilot-only`; [binding report](acceptance/p2b-binding.json)) drive the real
tab host, editors, 审阅 and 批注 panels, settings pane and store, Rust
workspace and SQLite with a `URLProtocol` stub of synthetic JSON replies and
in-memory synthetic keys: off by default, settings and relaunch, the idle and
manual triggers, changed-paragraph requests, exclusions, evidence anchoring
and drops, element and patch acceptance with journal assertions, rejection,
refused creates, a failed decision retried (also after a relaunch) without a
second create, 拒绝 refused while what that 接受 created is live and
recorded once it is in the trash, typing during a request, cancellation on
close, retries and errors, the privacy note's list and the drift switch.
Live providers, physical input and panels on screen are not covered.
Copilot 修改 is covered by three cases in
`native/apple/Tests/AssistantExtrasAcceptance.swift` (`--assistant-extras-only`):
off by default, the menu (⌃⌘I) and context item, the edit request (text,
neighbours, key only in the auth header), the diff preview, 重写, 接受 with
Agent provenance and one undo, a changed target refused writing nothing,
放弃, a refused continuation, 问 with a follow-up writing nothing; paragraph
breaks and U+3000 indents kept outside the rewrite, a white-space-only reply
as 没有修改, a moved target applied to its own copy and a changed one refused
although its text occurs once elsewhere; and the summary's 放弃 and 接受 (one
`field.set node`) shown on the chapter page, 接受 refused with the preview
kept after the stored summary changed, with every request's usage recorded.
