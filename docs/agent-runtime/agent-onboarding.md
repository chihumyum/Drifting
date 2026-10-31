# Agent panel first run

Status: shipped 2026-10-31 (Tauri desktop). The author chose candidate A,
"connect in place", from the prototype at
<https://claude.ai/artifact/TYQURpDfLKmJXngVotnV2J>.

A new author who opens the right sidebar's Agent panel should be able to
connect a model, send a first useful request and see what an Agent change
looks like without leaving the panel. The empty conversation is the guide.
There is no overlay, tour or extra panel.

## What the empty conversation shows

`resolveAgentOnboardingView` (`src/renderer/features/agent/onboarding/agent-onboarding.ts`)
decides from the stored step, whether the selected route can run
(`isGeneralAgentUsable`) and whether the shown conversation is empty (no
messages, nothing starting or running):

| Selected route can run | Step | Empty conversation shows |
| --- | --- | --- |
| not yet answered | any | nothing new |
| no | any | **Connect a model** |
| yes | `new` | **Try**: three requests |
| yes | `change` / `done` | the ordinary one-line empty state |

A conversation that has started is never covered. When a started
conversation can no longer run, the old line and 「前往设置」 link above the
transcript remain.

### Connect a model

One section of sidebar cells, all expanded because the choices are fixed:
ChatGPT subscription (marked experimental), DeepSeek, Anthropic and OpenAI.
Each cell carries the provider seal (solid when it can already run, hollow
when not), the name and, in index type, where the credential comes from.

- A provider that can already run (a Keychain key, a development `.env` key or
  a ChatGPT sign-in; `src/renderer/lib/agent/agent-provider-readiness.ts`,
  which the Project Home check-in and organize passes also read) is chosen
  with one click. This fixes the trap where a key
  was stored for one provider while the composer still pointed at another.
- A hollow cell opens in place: a password field, the primary 「连接」 and a
  text button that opens the provider's key page outside Drifting. 「连接」
  stores the key, runs the same connection test as Settings and keeps the key
  only if the test passes (`connectAgentProviderKey`,
  `src/renderer/lib/agent/connect-agent-provider.ts`). The composer then routes
  to that provider (`setAgentProvider` keeps a valid model or takes the
  provider's default). A failed test removes the key and says why in the
  danger ink.
- The ChatGPT cell opens to the device-code sign-in. Once the account is
  signed in, the composer routes to `openai-codex`.

Opening a cell is not choosing it, so the open cell's ring leaves with the
pointer, as the hover-card sections do.

### Try

Right after connecting, a line names the provider and model that were
reached. Below it are three requests built from the open book
(`buildAgentStarterPrompts`):

1. Leave two comments on a chapter: the most recently opened chapter that has
   words, else the first such chapter in reading order.
2. Tighten that chapter's opening paragraph. This small edit usually makes the
   first turn show what an Agent change looks like.
3. Sort out how the two elements most linked to other elements relate (ties go
   to the older element). With one element it asks
   to fill that element in; with none it asks to extract people and places
   from the chapter.

A book with no written chapter gets an outline, an interview and three main
characters instead. A click puts the request in the composer and sends it as
the author's own words. Nothing is hidden from the transcript.

### The first change

Agent writes commit directly (see `durable-commit-review-protocol.md`). The
panel shows that with the first real change instead of explaining it. When the
step is `change`, the latest finished turn's 「本轮改动」 links use the
accent's waiting glass (`glass--waiting`, drifting until the pointer rests on
it). Beside them is a 「版本历史」 text button that opens the entity snapshot
history of the first changed entity. Opening a link shows the change in the
editor's colored ink and marks the sidebar entry unread, as on any turn.
Either action moves the step to `done`.

## One time only

`agentOnboardingStep` is a device-local setting (`settings-storage`,
version 33):

- `new`: nothing has been sent from the panel. Any send from the composer, a
  picked suggestion included, moves it to `change`.
- `change`: the next turn that changes something waits for the author once.
- `done`: nothing more.

Fresh installations start at `new`. The v33 migration marks an existing
installation `done` when the Agent was already used on it (any remembered last
conversation), so returning authors are not shown the guide. An existing
installation that never used the Agent sees only the three requests (and the
connect cells if it has no model). Settings → General Agent → 对话配置 has
「重新显示首次引导」, which resets the step to `new`; the button is disabled
while the step is already `new`.

Sends started from Project Home do not advance the step; that conversation is
not empty, so it shows no suggestions.

## Credential ownership

Settings → 模型与 API remains the place that edits, retests, reveals the source
of and removes credentials (`ai-provider-settings.md`). The first run may only
add a key that passes its connection test, choose a route that can already
run, or start a ChatGPT sign-in.

## Machine acceptance

```bash
pnpm exec vitest run \
  src/renderer/features/agent/onboarding \
  src/renderer/lib/agent/connect-agent-provider.test.ts \
  src/renderer/store/settings-store-agent.test.ts \
  src/renderer/lib/ai/provider-settings.acceptance.test.ts
```

- `agent-onboarding.test.ts`: the step machine, the view table above, the
  one-time wait on the first change and the starter requests.
- `connect-agent-provider.test.ts`: a key is kept only after its test passes;
  rejected, failed and unsaved keys leave the selection alone.
- `agent-onboarding.render.test.ts`: the connect and try sections render as
  sidebar cells with no new material.
- `agent-onboarding.acceptance.test.ts`: the panel, transcript, chip and
  Settings wiring, and the credential boundary.
- `settings-store-agent.test.ts`: fresh and migrated installations, and the
  repair of an unknown stored step.

Desktop UI acceptance through the frontend debug bridge is recorded in
[`acceptance/agent-onboarding-desktop.md`](acceptance/agent-onboarding-desktop.md).
Paid provider endpoints and a real ChatGPT device sign-in are not part of
these checks.
