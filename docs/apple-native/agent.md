# Native writing assistant (写作助手)

A Mac-only writing Agent in the native lab. It reads the project through the
Rust workspace and proposes prose and chapter changes that the author accepts
or rejects in the conversation.

## Scope

- This is a native design. Its wire protocol, conversation files, history and
  review records are not compatible or interoperable with the Tauri/renderer
  Agent (2026-09-27 scope decision).
- Providers and models follow `agent-provider-contract.ts`:
  - DeepSeek (default): `deepseek-v4-flash`, `deepseek-v4-pro` over Chat
    Completions. Thinking sends `thinking` and `reasoning_effort` (high/max)
    and omits `tool_choice`.
  - Anthropic: `claude-sonnet-5` (adaptive thinking, effort low–max) and
    `claude-haiku-4-5-20251001` (no thinking) over Messages.
  - OpenAI: `gpt-5.6-sol`, `terra` and `luna` over Responses with
    `store: false`. Thinking uses reasoning summaries and encrypted reasoning
    replay.
- Request and stream shapes follow the renderer drivers. Provider reasoning
  state (DeepSeek `reasoning_content`, Anthropic thinking blocks, OpenAI output
  items) is replayed only inside the current turn's tool loop.
- Not ported:
  - the ChatGPT-subscription `openai-codex` route (needs OAuth);
  - MCP and plugin tools, long tasks and checklists;
  - Working Memory and standing guidance;
  - context compaction, so a very long conversation can exceed the context
    window;
  - automatic retries.

## Tools

The registry is `AgentToolRegistry` (`native/apple/Shared/AgentTools.swift`).
Each tool has a name, a Chinese description, a JSON schema and its access.

| Access | Tool | Rust path |
| --- | --- | --- |
| read | `list_chapters` (id, title, order, status, words, summary) | `workspaceChapters`, `workspaceMetrics`, `workspaceMetadata` |
| read | `read_chapter` (id or exact title) | `workspaceAgent readProse`: live text of an open owner, else stored |
| read | `search_prose` | `workspaceSearch` |
| read | `list_elements` (with every category), `read_element` (aliases, category, facts, body) | `workspaceElements`, `readProse` |
| read | `read_category` (members, 模板字段, element template, body) | `workspaceElements elementTemplate`, `readProse` |
| read | `list_storylines` | `workspaceStorylines` |
| read | `list_drifts`, `read_drift` | `workspaceDrifts`, `readProse` |
| read | `project_overview` (name, summary, facts, counts) | `workspaceMetadata`, `workspaceMetrics` |
| write | `revise_chapter`, `revise_element`, `revise_category`, `revise_drift` (replace existing text) | `workspaceAgent applyChanges` |
| write | `append_to_body` (new paragraphs at the end of a chapter, element, category or drift body, including an empty one) | `applyChanges` with one `append` change |
| write | `create_chapter` (title and optional opening text) | `workspaceCreateChapter`, then one `append` |
| write | `set_chapter_summary` | `workspaceMetadata setNodeSummary` |

The loop is model → tool calls → results → model until the model finishes.
It stops after 24 tool rounds. 停止 cancels the stream and keeps the partial
reply. A tool that is already running finishes, and the remaining calls are
recorded as not run. Each turn's user message is preceded by a runtime note
(【运行提示】) with the page the author has open (作者当前打开：《…》) and
proposal outcomes that have not yet been reported.

## Review model

- A write tool never writes. It checks the target and its input, then adds a
  pending proposal. Missing, ambiguous, overlapping or empty originals, and a
  blank append, are refused at once. The card shows the before and after text
  of each change, the appended paragraphs, the new chapter title with its
  opening text, or the summary.
- 接受 applies the proposal. A revision goes through `applyChanges` with the
  Agent identity: the conversation ID is `sessionId`, the proposing turn is
  `turnId`, and the tool call ID is `callId`.
  - Rust saves the author's pending edits as the author's, then commits each
    change as one Agent undo step with `yjs_document_revision_provenance`
    `source_kind='agent'`.
  - An open editor adopts the returned document state through the same path
    as a remote receipt.
- An append is one Rust change (`currentText` empty, `append: true`). Each line
  becomes a new paragraph, and an empty body takes the text in its seed
  paragraph. It is one undo step.
- An accepted `create_chapter` creates the chapter, then appends its opening
  text under the same proposal identity. If only the append fails, the
  proposal is accepted as 已接受 · 正文未写入, and the model is told the
  chapter exists without text.
- 拒绝 records the rejection.
- A Rust refusal (for example, the original text is no longer present) marks
  the proposal as failed and shows the message on the card. Queued input or a
  pending save leaves the proposal pending, with the reason shown.
- The author's next message tells the model each outcome once: accepted,
  rejected, or failed with the message.

## Persistence

- Conversations are stored per project under
  `<Application Support>/<bundle>/agent/<projectId>/<conversationId>.json`,
  beside the `apple-native-lab` workspace directory.
- Each file holds the messages, tool calls and results, provider reasoning
  replay, proposals and their states, and the provider, model, thinking and
  effort choice.
- Writes run on a serial queue: a temporary file is written, then renamed
  over the old one.
- A new conversation is written after its first message. The panel can create,
  rename, delete (after confirmation) and switch conversations.
- A proposal that was being applied when the app stopped reopens as pending.

## Credentials

- 设置… stores one API key per provider in the macOS Keychain as a generic
  password. The service is `Drifting Native Lab` and the account is
  `byok.<provider>`, distinct from the production `Drifting` service. The
  unsigned lab uses the file keychain.
- Keys go only into the provider's auth header (`authorization` or
  `x-api-key`). They are never written to conversation files, errors or logs.
- The sheet shows only `已保存 ····<last four>`.
- Missing keys, HTTP 401/403/404/429/5xx, network failures and broken streams
  map to Chinese messages. Error bodies are not shown for 401/403, because they
  can echo a masked key.

## Acceptance

`native/apple/Tests/AgentAcceptance.swift` runs in the P2b binding report
(`node scripts/apple-binding-acceptance.mjs`; `--agent-only` runs the cases
alone) through the real panel, tab host and Rust workspace:

- A `URLProtocol` stub serves synthetic SSE for each provider. Nothing reaches
  a real provider.
- Keys come from an in-memory store and never touch the Keychain.

It covers:

- one streamed reply per provider, including the request shape, the rendering
  and where the key is sent;
- a DeepSeek thinking tool loop with `reasoning_content` replay and the
  24-round bound;
- accept with Agent provenance, one undo step and the open editor updated;
- an append into the open chapter, with undo and redo;
- reject, a Rust refusal, and outcome reporting;
- 停止 mid-stream;
- a missing key, 401, 429 and offline errors;
- `create_chapter` with opening text, and `set_chapter_summary`;
- cold-reopen persistence, rename, delete and the key sheet.

Physical keyboard input and live providers are not exercised.
