# Mobile V2 Agent, Library/TODO, and Stats

Status: **M6 implementation and Simulator/Emulator acceptance complete**

Updated: 2026-08-23

M6 completes the non-Planning tool workspace for compact Mobile Shell. The
presentation is mobile-owned, while conversation authority, Agent execution,
Library/TODO writes, relations, and statistics remain in the shared renderer
runtime and use cases. M7 still owns the three independent Super Views; M8
still owns real-account Google Drive release acceptance.

## Mobile Agent contract

`MobileAgentPanel` is not a wrapper around Desktop Agent chrome. It composes the
shared `agent-chat-store`, General Agent transport, conversation repository,
working-memory view, message renderer, runtime control cards, and model/config
controls into the bottom vertical-rail workspace.

Every mobile turn visibly records normalized context references:

- the current Project;
- the current ordinary paper, storyline, element, category, or All Chapters;
- the current stable block id when an active editor selection provides one.

The same references are persisted on the user message before runtime execution.
They are also rendered into a bounded hidden provider note, so the visible chip
and the model context come from one normalized value. History load, new
conversation, deletion, streaming follow, stop, retry, and durable working
memory continue through shared stores rather than a mobile copy.

Mobile answer mode is a hard runtime boundary, not prompt wording alone. The
turn sends `toolAccess=read_only`; the runtime removes every definition whose
manifest access is `write` before search, selection, repair, or execution. The
system prompt also describes that boundary and does not request the write-class
Working Memory checkpoint, but the filter is authoritative. Read-only turns do
not arm the shared durable automatic-continuation scheduler, and the mobile
surface does not expose executable task continuation for an older desktop
conversation. An Agent answer therefore cannot call a prose or entity write
tool or resume itself into a write-capable turn.

Completed answers expose three author-controlled actions:

- Copy writes only after the author taps Copy and the platform clipboard
  permits it.
- Save as inspiration creates a free-floating `drift` through `useBookNode`
  and opens the resulting ordinary paper.
- Add TODO creates a durable TODO through `useComment`; when the turn context
  includes a chapter/block, the TODO keeps that stable block anchor.

Tool evidence is reduced to stable entity and optional block references. An
evidence chip opens the ordinary mobile paper through `WorkspaceNavigator` and
then scrolls/flashes the referenced block. Deleted targets degrade to a visible
label rather than becoming an invalid navigation action. No output action runs
automatically and no Agent answer directly replaces prose.

Provider readiness has explicit loading/error presentation and one 44px route
to Settings. Empty history, empty conversation, running, control-wait,
streaming, stopped, retryable error, and long scroll states share the same
single-scroll-owner panel geometry. The mobile empty-state copy explicitly says
the Agent can only read the Project and cannot rewrite prose directly.

## Library and TODO

TODO and Library are internal modes of one Library rail item, not a second
vertical rail. Both reuse the existing stores and use cases.

TODO preserves creation, entity/block relation, resolve, resolved archive,
reopen, and delete. The collapsible archive header, reopen, and delete actions
now expose ordinary 44px mobile targets. Empty and populated archives use the
same panel scroll owner.

Library preserves text, URL, image, and PDF items; Project/current-item
filters; relation chips and picker; inline title/snippet editing; in-app/system
open; create; and delete. Desktop right-click remains available, while mobile
cards additionally expose an explicit 44px More button. Its body-portaled,
fixed menu keeps relation, system-open, and delete actions at 44px without
requiring hover or context-click. Title and snippet edit surfaces have a 44px
minimum touch area and 16px text input.

## Statistics

Stats has two internal modes:

- Current paper preserves the shared `EntityStatsContent` semantics for an
  ordinary chapter/drift, storyline, element, category, or All Chapters.
- Whole book supplies the canonical All Chapters target to the same shared
  statistics component.

Project Home shows a deliberate empty explanation instead of invented entity
numbers. A Project with no chapters shows the shared whole-book empty state.
Both mode controls are 44px and the results use one vertical scroll owner;
long titles truncate in the header instead of widening the viewport.

## Deterministic evidence

- `src/renderer/lib/agent/turn-context.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-agent-model.test.ts`
- `src/renderer/lib/agent/runtime/runtime-tool-search.test.ts`
- `src/renderer/lib/agent/runtime/system-prompt.test.ts`
- `src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.test.ts`
- `src/renderer/lib/agent/runtime/acceptance/milestone-h-writing-intelligence.acceptance.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-v2-tool-workspaces.acceptance.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-v2-design.acceptance.test.ts`

The focused logic tests cover context normalization/deduplication, stable block
selection, evidence collection/jump, output prose/TODO anchoring, the read-only
definition filter under direct and searched tool selection, and generated
capability-contract drift. The source acceptance test prevents Desktop Agent
presentation reuse and records the mobile Library/TODO/Stats wiring and touch
targets.

## Native evidence and remaining boundary

The dated
[`../qa/mobile-v2-m6-agent-library-stats-simulator-2026-08-23.md`](../qa/mobile-v2-m6-agent-library-stats-simulator-2026-08-23.md)
records the reused iPhone 16e Simulator and `Persimmon_API_35` Android Emulator
runs. iOS device pixels covered dark mode, a persisted synthetic conversation,
context/evidence, author-controlled inspiration/TODO results, Library/TODO CRUD,
and current/whole-book Stats. Android device pixels covered the localized
answer-only empty/error state and compact Library/TODO/Stats reflows; real
Android hardware Back unwound full, docked, and closed tool-panel layers.

Both frontend transports declare `nativeInput=false`. Provider streaming was
not fabricated: the recorded conversation was a synthetic persisted fixture,
and provider readiness deliberately remained in its real unconfigured state.
Clipboard permission, live-provider billing/retention, native accessibility,
physical touch, lifecycle/low-memory behavior, representative large Projects,
and real-account Google Drive remain open release work.
