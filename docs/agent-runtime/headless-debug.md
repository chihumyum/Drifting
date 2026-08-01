# General Agent headless debug bridge

This is a development-only control path for exercising the real renderer-owned
General Agent without clicking through the Agent panel. It does **not** create a
second runtime: the mounted App still owns the production composition, current
project stores, renderer use cases, live Yjs writes, durable journal, review
ledger, provider credential, context planner, and compactor.

The local broker accepts a turn over HTTP, the DEV renderer claims it, and the
caller receives NDJSON containing every canonical journal entry plus a terminal
summary. Computer Use remains useful for a final UI smoke; it is no longer the
main tool/runtime evaluation loop.

## Start

Use three terminals:

```bash
pnpm --dir client agent:debug:server
```

```bash
VITE_DRIFTING_AGENT_DEBUG_URL=http://127.0.0.1:4317 \
  VITE_DRIFTING_AGENT_DEBUG_PROJECT_ID=synthetic-project-0001 \
  pnpm --dir client tauri:dev
```

The optional project variable routes the DEV renderer directly to the target;
no setup click is needed. The bridge starts only after that project's real
renderer boot has completed. Without it, open the target project once in the
App as usual.

Two optional DEV-only overrides make boundary cases reproducible without
changing production behavior:

```bash
VITE_DRIFTING_AGENT_DEBUG_CONTEXT_WINDOW_TOKENS=60000 \
VITE_DRIFTING_AGENT_DEBUG_RESULT_BUDGET_CHARS=5000 \
VITE_DRIFTING_AGENT_DEBUG_URL=http://127.0.0.1:4317 \
VITE_DRIFTING_AGENT_DEBUG_PROJECT_ID=<project-id> \
pnpm --dir client tauri:dev
```

The context override forces compaction at a smaller window. The result-budget
override can only lower the normal read-result budget, forcing the same durable
artifact paging path used by oversized production results. Both are ignored
outside Vite DEV or when the loopback debug bridge is disabled.

```bash
pnpm --dir client agent:debug:turn -- \
  --project synthetic-project-0001 \
  --prompt 'READ ONLY. List the project overview and the tools you called.'
```

The client prints tool arguments/results, context-window and compaction
snapshots, per-iteration usage, the terminal outcome, and the final assistant
text. Add `--raw` to retain the complete NDJSON journal.

## Reversible write matrix

After copying the active SQLite database, run every provider-exposed write
through the real renderer and immediately reject its durable review:

```bash
pnpm --dir client agent:debug:writes -- --project <project-id>
```

Use `--list` or repeated `--only <scenario-id>` flags while diagnosing one
tool. The matrix stops if a committed write cannot be reverted; keep the
pre-run database copy until the final domain readback has passed.

Useful options:

```bash
--conversation <id>                 # resume a durable conversation
--permission allow_once             # automatically allow permission requests once
--permission deny                   # automatically deny permission requests
--edit-mode approve                 # keep writes pending for review in this turn
--answer 'text'                     # queued ask_user answer; repeatable
--auto-continue                     # follow the durable plan until a stable stop
--timeout-ms 900000
--prompt-file /absolute/path/prompt.txt
```

Settle a pending review through the same live product composition (including
the exact Yjs inverse on reject):

```bash
pnpm --dir client agent:debug:review -- \
  --project synthetic-project-0001 \
  --review 'agent-review:agent-write:…' \
  --decision reject \
  --note 'headless inverse smoke'
```

The raw endpoint is also curl-friendly:

```bash
curl -N http://127.0.0.1:4317/turn \
  -H 'content-type: application/json' \
  --data '{"projectId":"synthetic-project-0001","prompt":"READ ONLY. List chapters."}'
```

## Acceptance snapshot (2026-08-01)

The real `雾港纪事` test project was exercised through this bridge, with the
mounted Tauri renderer and the configured DeepSeek BYOK provider:

- ordinary model turns now see a shallow virtual workspace with
  `list_files`/`read_file`/`grep`/`edit_file`; canonical names stay visible
  while ids, Yjs versions, freshness receipts, and domain write commands stay
  inside the renderer;
- chapter directories resolve directly to their `prose.md`, including natural
  ordinal aliases such as `第十二章`; exact file edits can span paragraphs and
  insert, delete, merge, or split them while the renderer preserves stable
  block identity and commits one live document transaction internally;
- provider-visible tool results are plain paths, prose, matches, and natural
  save confirmations. Structured review authority remains available to the
  local journal and panel without leaking review ids or synchronization fields
  back into the model conversation;
- aggregate model iterations, tool calls, input/output tokens, duration, cost,
  and automatic slices are unlimited by default. The 200k physical context
  window compacts into durable summaries and resumes the same task;
- final-response framing streams only author-facing prose. Tool-round drafts
  and the framing marker never enter the panel or canonical journal;
- all 18 production read tools returned live project data;
- all 14 provider-exposed certified writes committed in approve mode and their
  durable reviews reverted successfully;
- a 9,415-character chapter result was consumed through offsets 0, 4,000, and
  9,000 before an `edit_block` reused the original prose freshness receipt;
- editor normalization advanced the Yjs document independently after that
  write; rejection rebased the certified inverse over those unrelated changes,
  restored only the affected block, and removed the evaluation marker;
- a whole-book task froze the exact 21-chapter manifest, persisted 21 pending
  steps plus two author constraints, and recovered the same plan/session after
  renderer restart;
- a forced multi-slice task recovered after a provider-failed turn without
  repeating either accepted write, mapped physical failed-turn ordinals back to
  canonical provider-history ordinals, and completed its two exact-target steps
  with accepted review evidence at task revision 5;
- continuous execution paused after two automatic slices with no durable plan
  progress, while a progressing plan continued until its durable task reached
  `completed`;
- a provider-emitted DSML pseudo-tool call in the tool-disabled synthesis round
  was discarded before it reached the journal or UI; the runtime reported the
  unfinished slice in ordinary prose instead;
- accepted write-review decisions were supplied only through first-class pinned
  context rows, without duplicating them into subsequent user messages;
- a forced 60k context run exercised full compaction and the subsequent
  deterministic-summary projection while retaining tool-result facts and the
  author veto;
- a first Yjs Agent write racing editor navigation now uses the same
  deterministic legacy seed on both paths, so equivalent seeds merge
  idempotently instead of duplicating a chapter; a fresh `雾港纪事` chapter
  edit and review rejection restored the original at Yjs revision 2;
- a current `雾港纪事` smoke read `/chapters/12` as an ordinary directory and
  returned the exact opening sentence from plain `prose.md`; directory context
  was about 2.5k tokens before loading prose. A separate cross-paragraph file
  edit inserted an independent marker paragraph, created a durable review, and
  its exact rejection removed the marker again;
- invalid arguments, tool-call repair, queued `ask_user`, timeout, client
  disconnect cancellation, stale-turn recovery, and startup conversation
  hydration were exercised separately.

The automated gates for the same checkout were `718/718` full Core tests,
workspace TypeScript typecheck, and ESLint with zero errors.
This is runtime/tool coverage, not a substitute for the remaining native UI
smoke on each target.

## Safety and fidelity

- The broker binds to `127.0.0.1`. Browser origins other than the local Vite or
  Tauri renderer are rejected.
- The renderer refuses non-loopback broker URLs, and the bridge module is loaded
  only in Vite DEV when `VITE_DRIFTING_AGENT_DEBUG_URL` is explicitly set.
- Requests run against the currently opened real project. A write prompt can
  mutate it and follows the same soft-review policy as the Agent panel. Back up
  valuable projects or use a disposable test draft.
- A new conversation is used by default. Pass `--conversation` only when testing
  durable resume/context behavior.
- A headless turn runs exactly one slice by default. `--auto-continue` explicitly
  authorizes the same continuous execution used by the Agent panel. There is no
  aggregate model-round, tool-call, token, duration, cost, or slice quota.
  Two automatic slices without durable plan progress pause the sequence.
  Pending review, permission/user input, failure, navigation, or an explicit
  stop pauses it immediately. This authorization is renderer-memory-only and
  is never resumed automatically after an App restart.
- Stop the broker and the DEV App when finished. No broker or debug service is
  bundled into a release build.
