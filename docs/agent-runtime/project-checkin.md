# Project Home Agent entry and check-in

Status: shipped 2026-10-12 (Tauri client, desktop and mobile Project Home).

Project Home carries a General Agent entry for project-level discussion and a
small set of task cards: the check-in's, prepared from recent changes, and the
organize card (`project-organize.md`). The check-in is the only proactive
Agent work: it runs when the author arrives, not continuously, and nothing on
a card runs until the author opens it.

## The 主动建议 switch

One switch, 主动建议 (`projectHome.settings.proactive`,
`useProjectCheckinStore.enabled`, default on), controls all proactive Agent
work in every book: the check-in and the organize card. It shows in Home's 设定
view and in the shelf's settings under 智能, so it can be changed with no book
open. It replaced
the separate 每日签到 and 自动整理 switches on 2026-11-05; author-facing text
no longer says 签到. Code and docs keep the name check-in.

## Agent entry

- Desktop: the Agent section of Project Home, after the work and the create
  row; it floats at the foot of the page when Home is reached any way but the
  dock's `+` (see `design-system/components.md`, 「作品主页」). The check-in
  cards sit above the conversation box. Sending opens a new General Agent
  conversation in the right sidebar with the author's text as an ordinary
  author turn.
- Mobile: the first section of the Home flow. It opens the full-screen voice
  Agent surface, which is the mobile Agent conversation surface.
- The entry uses the ordinary read-write General Agent and its tools. There is
  no Project-Home-only Agent; project facts and Project Memory tools are
  available in every conversation.

## When a check-in runs

A check-in needs a model. While the selected Agent provider cannot run (no
Keychain or development `.env` key for a key provider, no ChatGPT sign-in for
the subscription route; `canAgentProviderRun` in
`src/renderer/lib/agent/agent-provider-readiness.ts`, shared with the Agent
panel's connect rows), nothing runs automatically and nothing is recorded, so
the first open after a model is connected checks in. A missing-key failure
stored by an earlier attempt is cleared.

The check-in is automatic; Home has no button that starts one (removed
2026-11-05). `decideCheckin` (`src/renderer/store/project-checkin-store.ts`)
is asked one macrotask after Project Home mounts, on every window focus while
Home is mounted — once visited, Home stays mounted behind the open tabs for
the rest of the book session — and when an organize pass settles:

0. Never while an organize pass (`project-organize.md`) holds the project;
   the pass runs the check-in when it settles and, after a completed pass,
   skips the cooldown below.
1. Never while disabled or already running, and at most once per 90 minutes
   per project and device.
2. Prose changed since the last check-in horizon (or the last 7 days) by the
   author, the Agent or another device: check in over those changes.
3. Otherwise, after at least 6 hours away from the project with no unanswered
   card, check in over the last 7 days to help the author pick up the work.

The last open, last attempt, change horizon and cards are device-local
renderer state (`localStorage`). They are not authored data and do not sync.

## What a check-in reads and writes

- Changed prose documents come from `yjs_document_revision_provenance`
  (`user`, `agent`, `remote`); the baseline is the newest local
  `entity_snapshot_history` row at or before the horizon; the current text is
  the persisted Yjs state. Digests are block-level and bounded (8 objects,
  3,000 characters each). Snapshot history is local and 30 days long, so a
  change synced without a local baseline is shown as an excerpt.
- One `single_request` model call with the author's selected Agent provider
  and model, forced to `submit_project_checkin`. The prompt states principles
  only and never prescribes story content.
- Every route receives the tool schema verbatim as a non-strict tool: OpenAI
  and the ChatGPT subscription through Responses (`strict: false`), Anthropic
  as `input_schema`, DeepSeek as Chat Completions `parameters`. The schema
  therefore carries structure only (`type`, `properties`, `required`, `items`,
  `additionalProperties`, `description`); the card count and text lengths are
  stated in descriptions and enforced while parsing. On 2026-11-05 a check-in
  failed with `/maxItems Unexpected property` (the author's app was on the
  ChatGPT subscription route, GPT-6.1 Terra): the model had returned the
  schema's old `maxItems: 4` beside `cards`. Parsing now drops fields the schema does not
  name and `null` optional fields (DeepSeek returned `"target": null`) before
  validating; a result still invalid after that is rejected whole.
- Output: up to four cards and nothing else. The request carries Project
  Memory (with memory ids) and Working Memory, but Working Memory above 20,000
  tokens is left out. Unknown refs are dropped.
- The check-in writes nothing: not the manuscript, not project objects, not
  Project Memory or Working Memory. Since 2026-11-05 memory upkeep is a card
  like any other work: when Working Memory holds lasting author context, stale
  or finished detail, or Project Memory has duplicates, the check-in proposes
  one card whose instruction names the passages and entries and says what to
  move, merge or delete. Opening it hands that to a General Agent session,
  which edits memory with its ordinary tools (`create_project_memory`,
  `update_project_memory`, `delete_project_memory`, `edit_working_memory`).
  Memory fields an older check-in result still carries are dropped while
  parsing. A live probe the same day (DeepSeek Flash and GPT-6.1 Terra, two
  requests each, a duplicate Project Memory pair and a lasting preference in
  Working Memory) returned such a card every time.

## Cards

There is one card kind (decided 2026-10-12). A card is something the Agent
wants to ask or do: its title is the question itself or the intended work, an
optional detail gives the evidence, and its instruction is a self-contained
task. The card itself is the control: clicking it starts a background
read-write General Agent session with that task; the Agent chooses its own tools — asking the author, updating
records, adding notes or TODOs, or a mix — and prose edits commit directly and retain ordinary unread indicators.
The check-in never decides which tool runs.

Clicking a started card reopens its conversation. A new check-in replaces
unopened cards. The × in the corner dismisses a card. On desktop the organize
card comes first; the check-in prompt leaves general element upkeep to it.
Stored v1 cards (question/action/todo) migrate to this shape; a v1 TODO card
becomes a task to record that TODO.

## Acceptance

```bash
pnpm exec vitest run src/renderer/lib/agent/checkin \
  src/renderer/store/project-checkin-store.test.ts \
  src/renderer/usecase/useProjectCheckin.test.ts \
  src/renderer/features/agent/project-agent-home.render.test.ts \
  src/renderer/app/project-home.acceptance.test.ts
```
