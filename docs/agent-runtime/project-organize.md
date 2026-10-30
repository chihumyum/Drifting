# Organize on return

Status: shipped 2026-10-30 (Tauri desktop).

When the author comes back to Drifting, a background General Agent folds the
prose they wrote last time into the project's elements, element changes and
relations. The notification bell at the foot of the left sidebar reports the
run and leads to Project Home, which shows the result. It is the second
proactive Agent pass beside the check-in (`project-checkin.md`) and runs
before it.

## When it runs

`useOrganizeOnReturn` (`src/renderer/usecase/useProjectOrganize.ts`, mounted
by the desktop workspace) treats these as a return:

- the first open of a project in an app run;
- the first focus, pointer or key input after 30 minutes away, whether the
  window was in the background or simply received no input.

`decideOrganize` (`src/renderer/store/project-organize-store.ts`) then:

1. Never while disabled (Home's 设定 view, 自动整理) or while a pass already
   holds the project in this window.
2. Waits 6 hours after a failed run.
3. Runs only when the author's own chapter or idea prose (`user` revision
   provenance) changed since the horizon. The first run looks back one day;
   prose older than seven days is never organized automatically.
4. Skips quietly, without counting as a failure, while no Agent provider is
   connected.

Changes that are only formatting move the horizon without starting a session.
The horizon and the latest run are device-local renderer state
(`localStorage`), like the check-in. Each device organizes the prose written
on it: Agent and remote revisions never start a pass, so the Agent's own
writes cannot loop and two devices never organize the same prose.

## What it does

- The change digest is the check-in's (`checkin-delta.ts`), filtered to `user`
  revisions of chapters and ideas, at most 12 documents. Digests are excerpts;
  the Agent reads the full text where it needs to.
- It starts one background read-write General Agent conversation titled
  `整理：…` with a short task (`lib/agent/organize/organize-task.ts`) that
  states principles only: check existing elements and Project Memory first and
  recognize renamed people, places or objects; create elements for new lasting
  ones; update existing elements; record an element change at the chapter where
  a state changes; record relations the prose states; leave uncertain matters to
  the author; never edit prose or delete anything; finish in one pass without
  opening a durable task plan; close with a short report.
- Writes go through the ordinary domain tools and commit directly with unread
  markers (`durable-commit-review-protocol.md`).
- The pass settles when its conversation has no running turn and no scheduled
  automatic continuation. A completed session moves the horizon to the run's
  start. A failed one keeps the horizon and starts the 6-hour wait. One cut off
  by a quit, reload or project switch is recorded as interrupted and keeps the
  horizon, so the next return organizes that prose again.

## Notification and Project Home

- The bell carries one row per run (source *Agent*): running, then completed
  with the counts of created and updated elements, element changes and
  relations, or failed or stopped. Clicking the row opens that project's Home.
- Home's Agent section shows the latest run above the check-in cards: the prose
  it read, its state, the Agent's closing reply (Markdown emphasis removed, at
  most eight lines; the counts when the reply is empty) and links to every
  object the session created or changed. Clicking the card opens the
  conversation; × hides it. The floating Agent set shows the run as one pill.

## Check-in coordination

A pass claims its project synchronously, before any read. A check-in started
by the same return — Home schedules its open and focus check-ins one macrotask
later — waits, and the pass runs the check-in when it settles. After a
completed pass that check-in skips the 90-minute cooldown, so its cards see the
organized records. *Check in now* is never deferred.

## Acceptance

```bash
pnpm exec vitest run src/renderer/lib/agent/organize \
  src/renderer/store/project-organize-store.test.ts \
  src/renderer/usecase/useProjectOrganize.test.ts \
  src/renderer/usecase/useProjectCheckin.test.ts \
  src/renderer/store/project-checkin-store.test.ts
```

These cover the decision, the task and transcript summary, the session hand-off
and settlement, notifications and check-in deferral with synthetic stores.

Live check, 2026-10-30, in an isolated `pnpm dev:seed:lite --frontend-debug`
instance with a DeepSeek key, driven through the desktop debug bridge: prose
written into a chapter and a simulated 31-minute absence started a pass; the
bell showed it running and then the counts; its row opened Home, whose card
showed the reply and links for the created and changed elements; the check-in
ran right after. A second return organized only the prose written since the
first pass and reused the existing elements. One pass that opened a durable
task plan stalled on its step evidence and left element changes unsaved, which
is why the task now asks for a single pass.
