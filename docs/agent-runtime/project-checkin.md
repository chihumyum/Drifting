# Project Home Agent entry and check-in

Status: shipped 2026-10-12 (Tauri client, desktop and mobile Project Home).

Project Home carries a General Agent entry for project-level discussion and a
small set of check-in cards prepared from recent changes. The check-in is the
first step of proactive project awareness: it runs when the author arrives,
not continuously.

## Agent entry

- Desktop: the Agent section of Project Home, after the work and the create
  row; it floats at the foot of the page when Home is reached any way but the
  dock's `+` (see `design-system/components.md`, 「作品主页」). The check-in
  cards sit above the conversation box. Sending opens a new General Agent
  conversation in the right sidebar with the author's text as an ordinary
  author turn. Turning the check-in on or off lives in Home's 设定 view.
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
stored by an earlier attempt is cleared. *Check in now* still runs and shows
why it cannot.

`decideCheckin` (`src/renderer/store/project-checkin-store.ts`) runs one
macrotask after Home mount and window focus, and when an organize pass settles:

0. Never while an organize pass (`project-organize.md`) holds the project,
   unless forced; the pass runs the check-in when it settles and, after a
   completed pass, skips the cooldown below.
1. Never while disabled (unless forced) or already running, and at most once
   per 90 minutes per project and device unless the author presses *Check in
   now*.
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
- Output: up to four cards, plus optional memory upkeep — new, revised or
  deleted Project Memory entries and passage edits to Working Memory
  (revision CAS; a concurrent edit wins, and a passage that no longer matches
  leaves the document untouched). Working Memory above 20,000 tokens is left
  out of the request. Unknown refs and memory ids are dropped; an invalid
  result writes nothing.
- The check-in never edits the manuscript or project objects.

## Cards

There is one card kind (decided 2026-10-12). A card is something the Agent
wants to ask or do: its title is the question itself or the intended work, an
optional detail gives the evidence, and its instruction is a self-contained
task. The card itself is the control: clicking it starts a background
read-write General Agent session with that task; the Agent chooses its own tools — asking the author, updating
records, adding notes or TODOs, or a mix — and prose edits commit directly and retain ordinary unread indicators.
The check-in never decides which tool runs.

Clicking a started card reopens its conversation. A new check-in replaces
unopened cards. The × in the corner dismisses a card; check-ins can be turned off from the
same section. Stored v1 cards (question/action/todo) migrate to this shape; a
v1 TODO card becomes a task to record that TODO.

## Acceptance

```bash
pnpm exec vitest run src/renderer/lib/agent/checkin \
  src/renderer/store/project-checkin-store.test.ts \
  src/renderer/features/agent/project-agent-home.render.test.ts \
  src/renderer/app/project-home.acceptance.test.ts
```
