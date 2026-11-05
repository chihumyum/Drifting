# Organize card

Status: shipped 2026-10-30 as organize on return (Tauri desktop); since
2026-11-05 a Project Home task card the author opens.

Project Home offers to fold the prose the author wrote since the last
organize into the project's elements, element changes and relations. The
offer is a task card beside the check-in's (`project-checkin.md`); nothing
runs until the author opens it. The notification bell at the foot of the left
sidebar reports a run and leads to Project Home, which shows the result.

## When the card appears

`useOrganizeOffer` (`src/renderer/usecase/useProjectOrganize.ts`, mounted by
Project Home through `useHomeAgent`) works the card out on Home mount, on
every window focus while Home is mounted, when Home's 主动建议 switch changes
and after a run settles. It reads local history only; no model is asked.

- Home's 主动建议 switch (`useProjectCheckinStore.enabled`) covers this card
  as it covers the check-in. Off, there is no card.
- No card while the selected Agent provider cannot run (`canAgentProviderRun`,
  the answer the check-in and the Agent panel's connect rows use) or while a
  pass holds the project in this window.
- The card covers the author's own chapter and idea prose (`user` revision
  provenance) changed since the horizon. The first card looks back one day;
  prose older than seven days is never offered (`organizeSince`,
  `src/renderer/store/project-organize-store.ts`).
- Changes that are only formatting move the horizon without a card.
- × skips the card: the horizon moves to now, so the card returns only after
  the author writes again.

The horizon and the latest run are device-local renderer state
(`localStorage`, `project-organize` v2; v1's automatic switch and failure
backoff are dropped on load). The card itself is transient and recomputed.
Each device offers the prose written on it: Agent and remote revisions never
count, so the Agent's own writes cannot loop and two devices never organize
the same prose.

## What opening the card does

`startProjectOrganize` claims the project, reads the changes again (the
author may have written more since the card appeared) and hands them to one
background read-write General Agent conversation:

- The change digest is the check-in's (`checkin-delta.ts`), filtered to `user`
  revisions of chapters and ideas, at most 12 documents. Digests are excerpts;
  the Agent reads the full text where it needs to.
- The conversation is titled `整理：…` and carries a short task
  (`lib/agent/organize/organize-task.ts`) that states principles only: check
  existing elements and Project Memory first and recognize renamed people,
  places or objects; create elements for new lasting ones; update existing
  elements; record an element change at the chapter where a state changes;
  record relations the prose states; leave uncertain matters to the author;
  never edit prose or delete anything; finish in one pass without opening a
  durable task plan; close with a short report.
- Writes go through the ordinary domain tools and commit directly with unread
  markers (`durable-commit-review-protocol.md`).
- The pass settles when its conversation has no running turn and no scheduled
  automatic continuation. A completed session moves the horizon to the run's
  start. A failed or interrupted one keeps the horizon, so the card offers that
  prose again. A session that does not start leaves the card in place with the
  error under it.

## Notification and Project Home

- The bell carries one row per run (source *Agent*): running, then completed
  with the counts of created and updated elements, element changes and
  relations, or failed or stopped. Clicking the row opens that project's Home.
- Home's Agent section shows the latest run above the task cards: the prose
  it read, its state, the Agent's closing reply (Markdown emphasis removed, at
  most eight lines; the counts when the reply is empty) and links to every
  object the session created or changed. Clicking the run card opens the
  conversation; × hides it. The organize card is the first task card; the
  floating Agent set shows each as one pill.

## Check-in coordination

A pass claims its project synchronously, before any read. A check-in that
comes up while it runs waits, and the pass runs the check-in when it settles;
after a completed pass that check-in skips the 90-minute cooldown, so its
cards see the organized records. The check-in prompt leaves general element
upkeep to this card.

## Acceptance

```bash
pnpm exec vitest run src/renderer/lib/agent/organize \
  src/renderer/store/project-organize-store.test.ts \
  src/renderer/usecase/useProjectOrganize.test.ts \
  src/renderer/usecase/useProjectCheckin.test.ts \
  src/renderer/store/project-checkin-store.test.ts
```

These cover the horizon, the card and its skip, the task and transcript
summary, the session hand-off and settlement, notifications and check-in
deferral with synthetic stores.

The 2026-10-30 live check (then started automatically on return; DeepSeek,
isolated `pnpm dev:seed:lite --frontend-debug` instance, desktop debug bridge)
confirmed the session, the bell, Home's result card and that a second pass
covers only prose written since the first and reuses existing elements. One
pass that opened a durable task plan stalled on its step evidence and left
element changes unsaved, which is why the task asks for a single pass.
