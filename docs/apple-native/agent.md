# Native writing assistant (写作助手)

A Mac-only writing Agent in the native lab. It reads the project through the
Rust workspace and proposes prose, chapter, element, patch, storyline,
relation, note/TODO, drift and project changes that the author accepts or
rejects in the conversation.

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
  - MCP and plugin tools, long tasks and checklists (`update_task_*`,
    `read_task_plan`), `ask_user` and `read_tool_result`;
  - Working Memory, author rules and standing guidance
    (`*_working_memory`, `*_author_rule`);
  - whole-body replacement (`replace_*_body`; revisions and appends cover it);
  - updating or deleting relation types, deleting comments, and trashing
    categories, storylines or drifts, although Rust has those commands: the
    tools trash only elements and chapters;
  - material writes, and file bytes of images and PDFs;
  - patches anchored to a selected passage (a patch names its source chapter
    only), and act, drift group, story-time and writing-status tools;
  - Agent authorship of notes and TODOs: `workspaceComments create` records
    the author, so an accepted `create_comment` reads as the author's;
  - context compaction, so a very long conversation can exceed the context
    window;
  - automatic retries.

## Tools

The registry is `AgentToolRegistry` (`native/apple/Shared/AgentTools.swift`,
domain tools in `AgentDomainTools.swift`, `AgentDomainReads.swift` and
`AgentDomainWrites.swift`): 53 tools, 19 reads and 34 writes. Each has a
name, a Chinese description, a strict JSON schema (`additionalProperties:
false`) and its access. Before a tool runs its arguments are checked against
the schema: unknown, missing and mistyped arguments, enums, colour patterns
and array sizes are refused in Chinese; `null` for an optional argument counts
as absent.

| Access | Tool | Rust path |
| --- | --- | --- |
| read | `list_chapters` (id, title, order, status, words, summary) | `workspaceChapters`, `workspaceMetrics`, `workspaceMetadata` |
| read | `read_chapter` (id or exact title) | `workspaceAgent readProse`: live text of an open owner, else stored |
| read | `search_prose` | `workspaceSearch` |
| read | `search_project` (chapters, then summaries, drifts, elements, categories, storylines, materials) | `workspaceSearch`, `workspaceSearchEntities` |
| read | `list_elements` (with every category), `read_element` (aliases, category, facts, body) | `workspaceElements`, `readProse` |
| read | `read_category` (members, 模板字段, element template, body) | `workspaceElements elementTemplate`, `readProse` |
| read | `get_element_patches` (valid patches; invalidated ones only counted) | `workspacePatches patches` |
| read | `find_element_appearances` (linking chapters and pages) | `workspaceElements backlinks` |
| read | `list_storylines`, `read_storyline` (facts, members, body) | `workspaceStorylines`, `readProse` |
| read | `list_drifts`, `read_drift` | `workspaceDrifts`, `readProse` |
| read | `list_relation_types`, `list_relations` (optionally of one entity) | `workspaceRelations library` |
| read | `list_comments` (notes and TODOs: target, priority, status, quote) | `workspaceComments list` |
| read | `list_materials`, `read_material` (title, kind, notes, link, text; never bytes or paths) | `workspaceLibrary library` |
| read | `project_overview` (summary, facts, chapter and word counts, element, category, storyline, drift, relation, open TODO and material counts) | `workspaceMetadata`, `workspaceMetrics` and the libraries |
| write | `revise_chapter`, `revise_element`, `revise_category`, `revise_drift`, `revise_storyline` (replace existing text) | `workspaceAgent applyChanges` |
| write | `append_to_body` (new paragraphs at the end of a chapter, element, category, drift or storyline body) | `applyChanges` with one `append` change |
| write | `create_chapter` (title and optional opening text), `set_chapter_summary` | `workspaceCreateChapter` then one `append`; `setNodeSummary` |
| write | `rename_chapter`, `trash_chapter` | `workspaceRenameChapter`; `workspaceTrashChapter` through the tab host |
| write | `create_element` (category, name, group, summary, aliases, facts, opening body) | `createElement`, then `updateElement`, `setElementFacts`, one `append` as given |
| write | `update_element` (name, summary, aliases, category, group), `set_element_facts` | `updateElement`; `setElementFacts` |
| write | `create_element_category`, `update_element_category` (name, colour) | `createCategory`; `updateCategory` |
| write | `trash_element` | `trashElement` through the tab host |
| write | `create_element_patch` (title, body, optional source chapter), `update_element_patch`, `delete_element_patch` | `workspacePatches` |
| write | `create_storyline` (name, summary), `update_storyline` (name, summary, colour), `set_chapter_storylines` (members, primary) | `workspaceStorylines` |
| write | `create_relation` (ends by kind and id or exact name, type by id or name), `update_relation` (retype, swap), `delete_relation`, `create_relation_type` | `workspaceRelations` |
| write | `create_comment` (note or TODO, floating TODO or on a page, priority), `update_comment` (body, kind, priority), `resolve_comment` | `workspaceComments` |
| write | `create_drift` (title, optional body), `rename_drift`, `set_drift_summary` | `workspaceDrifts` then one `append`; `updateDrift`; `setNodeSummary` |
| write | `update_project_facts`, `update_project_summary` | `workspaceMetadata updateProject` |

References resolve the way chapter titles do: an identity, else an exact name
(an element also by alias, 《》 and 「」 stripped). An ambiguous name is refused
with every candidate's identity. Chapter, drift, element and storyline names
are already unique in Rust, so ambiguity arises from bracketed variants and
from categories and materials. Names Rust would number or reject (a taken
chapter or drift title, an element name or alias, a category, storyline or
relation type name) are refused before a proposal, so the card shows what will
be stored.

The loop is model → tool calls → results → model until the model finishes.
It stops after 24 tool rounds. 停止 cancels the stream and keeps the partial
reply. A tool that is already running finishes, and the remaining calls are
recorded as not run. Each turn's user message is preceded by a runtime note
(【运行提示】) with the page the author has open (作者当前打开：《…》) and
proposal outcomes that have not yet been reported.

## Review model

- A write tool never writes. It checks the target and its input, then adds a
  pending proposal. Missing, ambiguous, overlapping or empty originals, a
  blank append, and a change that would change nothing are refused at once.
  The card shows the before and after text of each change, the appended
  paragraphs, the new chapter title with its opening text, or the summary. A
  domain proposal's card lists each field it writes with its value before
  (struck) and after, and notes side effects such as the relations a trash
  removes or a first storyline becoming every chapter's primary.
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
- An accepted domain proposal runs its Rust command with the stored,
  resolved identities: one original, except `create_element`,
  `create_storyline` and `create_drift`, which create first and then write
  the given summary, aliases, facts or opening text as further originals. If
  only a later step fails, the proposal is 已接受 · 部分未写入 and the model
  is told what was not written. Trash goes through the tab host, which closes
  the page's tabs once Rust commits. Libraries, relation sections, patches,
  chapter lists, 审阅 and open pages follow the returned state.
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

- one streamed reply per provider, including the request shape, all 53 tools,
  the rendering and where the key is sent;
- a DeepSeek thinking tool loop with `reasoning_content` replay and the
  24-round bound;
- accept with Agent provenance, one undo step and the open editor updated;
- an append into the open chapter, with undo and redo;
- reject, a Rust refusal, and outcome reporting;
- 停止 mid-stream;
- a missing key, 401, 429 and offline errors;
- `create_chapter` with opening text, and `set_chapter_summary`;
- cold-reopen persistence, rename, delete and the key sheet.

`native/apple/Tests/AgentToolsAcceptance.swift` (`--agent-tools-only`) covers
the domain tools through the same panel, host and stub:

- every schema is strict and every tool refuses unknown, missing and mistyped
  arguments before it runs;
- every read returns the synthetic project and writes nothing to the journal;
- for every write tool (and `revise_storyline`, `append_to_body` on a
  storyline): a schema violation, a resolution or validation refusal
  (ambiguous names list the candidates), the card text, 接受 writing exactly
  the expected originals (journal assertions) and the stored result, 拒绝
  writing nothing, and each outcome reported to the model once;
- Rust refusals after the target changed (trashed, taken, deleted), pending
  input keeping a rename pending, and every write tool failing without
  writing after the project is deleted;
- the element page's page sources in 被引用 and the act rail's stored
  boundaries.

Physical keyboard input and live providers are not exercised.
