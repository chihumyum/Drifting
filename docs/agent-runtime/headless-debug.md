# General Agent headless debug bridge

The dated acceptance snapshot below is historical evidence. Current capability
counts and milestone boundaries live in
[`acceptance/agent-capabilities.md`](acceptance/agent-capabilities.md) and
[`acceptance/CURRENT_STATUS.md`](acceptance/CURRENT_STATUS.md).

This is a development-only control path for exercising the real renderer-owned
General Agent without clicking through the Agent panel. It does **not** create a
second runtime: the mounted App still owns the production composition, current
project stores, renderer use cases, live Yjs writes, durable journal, review
ledger, provider credential, context planner, and compactor.

The repository-level [`Drifting developer CLI`](../dev-cli/README.md) wraps
this bridge as `pnpm drifting agent turn|review` and separately provides safe
offline workspace CRUD, server requests, generated model coverage, and
versioned scenarios. Offline `workspace call` also reuses the production Agent
domain runtime, but it requires the App to be closed and creates a SQLite
backup before every mutation.

The local broker accepts a turn over HTTP, the DEV renderer claims it, and the
caller receives NDJSON containing every canonical journal entry plus a terminal
summary. Computer Use remains useful for a final UI smoke; it is no longer the
main tool/runtime evaluation loop.

If Vite reloads or the mounted renderer disconnects during a turn, the broker
fails that lease immediately and frees the worker. It must not leave an
`active` debug request until the original 10/15-minute deadline. The runtime's
SQLite recovery path remains responsible for reconciling the interrupted turn
when that conversation is resumed.

For provider-independent tool protocol regression, no App or credential is
needed:

```bash
pnpm --dir client eval:agent:tool-reliability
```

This deterministic gate replays fragmented and interleaved provider events,
schema repair, unknown tools, aliases, definition drift, concurrent scheduling,
durable idempotency/recovery and post-compaction tool continuity. It writes the
machine report to
[`acceptance/milestone-b-tool-reliability.json`](acceptance/milestone-b-tool-reliability.json).
Use the live bridge below for product-data and real-provider behavior.

For durable turn/write/review regression, including real file SQLite, Yjs,
localStorage loss, partial block decisions and injected acknowledgement faults:

```bash
pnpm --dir client eval:agent:durability
```

The machine report is written to
[`acceptance/milestone-c-durable-review.json`](acceptance/milestone-c-durable-review.json),
and its normative state/fault matrix lives in
[`durable-commit-review-protocol.md`](durable-commit-review-protocol.md).

For complete node/entity/comment/TODO/relation/storyline-membership/memory CRUD,
guarded inverse, real file SQLite/Yjs, migration, restart and transaction-fault
regression:

```bash
pnpm --dir client eval:agent:crud
```

The machine report is written to
[`acceptance/milestone-d-domain-crud.json`](acceptance/milestone-d-domain-crud.json),
and the natural workspace, authority, trust and approval contract lives in
[`domain-crud-transaction-protocol.md`](domain-crud-transaction-protocol.md).

For durable whole-book plans, manifest drift/reconciliation, safe Stop, exact
Steer, renderer reauthorization, invisible continuation prompts, unlimited
progressing slices, stagnation protection, and restart regression:

```bash
pnpm --dir client eval:agent:long-task
```

The machine report is written to
[`acceptance/milestone-e-long-task.json`](acceptance/milestone-e-long-task.json),
and the normative execution state machine lives in
[`long-task-execution-protocol.md`](long-task-execution-protocol.md).

For the project-level, cross-chat General Agent handoff boundary:

```bash
pnpm --dir client eval:agent:handoff
```

This deterministic, offline gate uses the complete product SQLite migrations.
It verifies current-session, deleted-chat and foreign-project isolation; strips
transcript text, prose, raw arguments and internal IDs; excludes reverted
writes; preserves bounded task/constraint/name/write orientation across a file
database reopen; and checks that tool selection exposes the read-only handoff
only for explicit pickup requests. It does not prove desktop visual quality or
any mobile Agent interaction.

For provider-aware Standard 200k/Max 1M budgeting, bounded same-turn literary
compaction, malformed-output fallback, exact author-constraint retention, ranked
search, artifact paging, multi-slice restart and compactor-fault regression:

```bash
pnpm --dir client eval:agent:context
```

The machine report is written to
[`acceptance/milestone-f-context-engineering.json`](acceptance/milestone-f-context-engineering.json).
Private manuscript prose is read only inside the test process; the report keeps
only availability, file count and byte count. The normative contract lives in
[`context-engineering-protocol.md`](context-engineering-protocol.md).

The Agent-specific checkpoint/fork gate was retired. Product migrations now
assert that its tables and branch columns are absent while entity snapshot
history remains. See
[`entity-snapshot-history.md`](entity-snapshot-history.md).

For the author-owned writing-policy boundary, arbitrary in-project entity
writes and stale-editor-focus regression:

```bash
pnpm --dir client eval:agent:writing
```

The deterministic gate needs no App, network or API key. It stores aggregate
local-corpus metrics but no private prose in
[`acceptance/milestone-h-writing-intelligence.json`](acceptance/milestone-h-writing-intelligence.json).
Its normative contract lives in
[`author-owned-writing-policy.md`](author-owned-writing-policy.md).

The optional paid provider canary uses only a synthetic chapter and an explicit
author instruction:

```bash
pnpm --dir client eval:agent:writing:live
```

It reads `DEEPSEEK_AI_API_KEY` from `private-service/.env` through the isolated
launcher and verifies read-before-edit plus the requested mutation. It is not
part of the network-free milestone gate.

To exercise two paid DeepSeek General Agent sessions against the same
synthetic chapter and one real file-backed Yjs/SQLite product composition:

```bash
pnpm --dir client eval:agent:concurrency:live
```

The harness forces both sessions to finish the same-revision read before their
first write request, then verifies one model-visible `other-agent` conflict,
one reread/retry, both final edits, and exact per-session Yjs revision
provenance. It never opens or mutates an author's project database and does not
print or persist the API key, prompts, provider answers, or synthetic prose.
The latest recorded run is
[`acceptance/concurrent-agent-deepseek-live-2026-08-05.json`](acceptance/concurrent-agent-deepseek-live-2026-08-05.json).

For multi-provider wire conformance, concrete MCP stdio/Streamable HTTP,
generation replacement, durable exact grants, native bridge contracts and
real-file SQLite restart/fault regression:

```bash
pnpm --dir client eval:agent:extensions
```

This gate does not read a credential or make a paid network call. It launches a
temporary Node MCP child and a loopback HTTP server, verifies the native request
host contract and writes
[`acceptance/milestone-i-provider-extension.json`](acceptance/milestone-i-provider-extension.json).
The security, lifecycle, permission and data-flow rules are normative in
[`provider-extension-protocol.md`](provider-extension-protocol.md).

To spend one explicit live request against a selected provider, set its key and
run `DRIFTING_AGENT_LIVE_PROVIDER=<deepseek|anthropic|openai> pnpm --dir
client eval:agent:extensions:live`. This canary is deliberately separate
from the network-free exit gate.

Native artifact verification and resumable endurance commands are:

```bash
pnpm --dir client eval:agent:native:verify
pnpm --dir client eval:agent:endurance:4h
pnpm --dir client eval:agent:endurance:12h
```

See [`native-endurance-acceptance.md`](native-endurance-acceptance.md) for the
build commands, accelerated logical-time semantics and explicit device/manual
boundary.

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
VITE_DRIFTING_AGENT_DEBUG_DISABLE_HMR=1 \
VITE_DRIFTING_AGENT_DEBUG_URL=http://127.0.0.1:4317 \
VITE_DRIFTING_AGENT_DEBUG_PROJECT_ID=<project-id> \
pnpm --dir client tauri:dev
```

The context override forces compaction at a smaller window. The result-budget
override can only lower the normal read-result budget, forcing the same durable
artifact paging path used by oversized production results. The HMR override
keeps the mounted renderer fixed during a long canary so an unrelated source
save cannot reload the page and invalidate the run. The context and result
overrides are ignored outside Vite DEV or when the loopback debug bridge is
disabled; the HMR override affects only this local Vite process.

```bash
pnpm --dir client agent:debug:turn -- \
  --project synthetic-project-0001 \
  --prompt 'READ ONLY. List the project overview and the tools you called.'
```

The client prints tool arguments/results, context-window and compaction
snapshots, per-iteration usage, the terminal outcome, and the final assistant
text. Add `--show-thinking` to group and print each complete reasoning pass;
this is the required observation mode when evaluating whether the model is
wasting reasoning on paths, schemas, JSON escaping or persistence details. Add
`--raw` to retain the complete NDJSON journal.

At every terminal outcome, `--show-thinking` also prints one aggregate line:

```text
[thinking-audit] passes=2 chars=2100 longest=1916 mechanics_hits=0 runtime_meta_hits=0 character_match_hits=0 reread_intent_hits=0 oversized_passes=0 duplicate_tool_calls=0
```

`mechanics_hits` scans for path/schema/tool/transport vocabulary;
`runtime_meta_hits` covers provider, persistence, revision and review internals;
`character_match_hits` catches quote/escape/byte-matching fixation.
`reread_intent_hits` is a diagnostic text heuristic, not a count of actual
reads; compare it with the printed calls. `oversized_passes` counts reasoning
passes above 8,000 characters and `duplicate_tool_calls` counts exact
name-plus-argument repeats. The audit prints bounded examples for every
non-zero family. `SIGINT`, `SIGTERM` and `SIGHUP` print the partial audit before
cancelling the renderer lease, so a runaway paid run still leaves evidence.

Named missing chapters are returned as ordinary writable manuscript state. If
a matching outline paragraph exists, the bridge gives that complete paragraph
in the same result. The model should not need to inventory the whole project or
learn any storage name before creating the chapter and its summary.

## Reversible write matrix

After copying the active SQLite database, run every provider-exposed write
through the real renderer and immediately reject its durable review:

```bash
pnpm --dir client agent:debug:writes -- \
  --project <project-id> \
  --disposable-db
```

Use `--list` or repeated `--only <scenario-id>` flags while diagnosing one
tool. `--disposable-db` is a mandatory operator acknowledgement: first launch
the mounted App against an explicit copy of the SQLite project database, never
the primary App database. The matrix uses a run-unique marker, accepts
semantically equivalent workspace mutations, and stops if a committed write
cannot be reverted; keep the pre-run database copy until the final domain
readback has passed.

Useful options:

```bash
--conversation <id>                 # resume a durable conversation
--permission allow_once             # automatically allow permission requests once
--permission deny                   # automatically deny permission requests
--edit-mode approve                 # keep writes pending for review in this turn
--answer 'text'                     # queued ask_user answer; repeatable
--auto-continue                     # follow the durable plan until a stable stop
--thinking adaptive                 # enable the selected provider's reasoning
--show-thinking                     # print thinking by iteration plus a terminal audit
--timeout-ms 43200000               # observer watchdog; up to 12 hours
--prompt-file /absolute/path/prompt.txt
```

For a representative reasoning run, pass `--thinking adaptive` and omit
`--effort`; the model profile then supplies its default effort. `--effort` is
only for a scenario that deliberately tests a non-default level. The timeout is
the DEV observer/client watchdog, not a runtime model-round, tool, token, cost
or continuation quota.

Settle a pending review through the same live product composition (including
the exact Yjs inverse on reject):

```bash
pnpm --dir client agent:debug:review -- \
  --project synthetic-project-0001 \
  --review 'agent-review:agent-write:…' \
  --block 'block-id' \
  --decision reject \
  --note 'headless inverse smoke'
```

Omit `--block` to settle every still-pending block. Supplying it settles only
that block through the same compare-and-set path used by the editor badge.

The raw endpoint is also curl-friendly:

```bash
curl -N http://127.0.0.1:4317/turn \
  -H 'content-type: application/json' \
  --data '{"projectId":"synthetic-project-0001","prompt":"READ ONLY. List chapters."}'
```

## Prose Markdown adapter acceptance

The virtual `prose.md` and `body.md` files expose only structures configured by
the live TipTap editor. `#`, `##`, and `###` become heading levels 1-3;
paragraphs, blockquotes, horizontal rules, `<br>`, bold, italic, strike,
`<u>`, and safe links round-trip into Yjs. The compact read protocol keeps each
block on one transport line while `<br>` represents an editor hard break.

Unsupported Markdown is deliberately style-lossy and text-preserving. H4-H6,
lists/tasks, inline or fenced code, tables, images, and arbitrary HTML are
saved as plain paragraphs; unsafe URL schemes retain only their visible label.
Acceptance must inspect the planned Yjs blocks and load their projection with
the production static TipTap schema, not merely compare rendered Markdown.

Run the focused adapter gate with:

```bash
pnpm --dir client exec vitest run \
  src/renderer/lib/agent/markdown-prose-adapter.test.ts \
  src/renderer/lib/agent/serialize.test.ts \
  src/renderer/lib/agent/runtime/workspace-prose-file.test.ts \
  src/renderer/lib/agent/runtime/drifting-domain-crud-write-strategy.integration.test.ts
```

The domain CRUD integration case additionally proves that first-write creation
of chapters/drifts, elements, storylines, and categories stores the same
formatted, stable-id TipTap seed as later authored-body edits.

## Acceptance evidence

The operator commands above are current. Dated paid-provider and real-project
results are historical checkout evidence and are indexed in
[`acceptance/MILESTONE_HISTORY.md`](acceptance/MILESTONE_HISTORY.md). Current
capability and open-boundary claims live in
[`acceptance/CURRENT_STATUS.md`](acceptance/CURRENT_STATUS.md).

Do not copy dated tool counts, test counts, session metrics, or retired
provider-facing verbs into this runbook. Record a new dated report only when a
paid provider, private fixture, native interaction, or other non-reproducible
run adds evidence that deterministic gates cannot preserve.

## Safety and fidelity

- The broker binds to `127.0.0.1`. Browser origins other than the local Vite or
  Tauri renderer are rejected.
- The renderer refuses non-loopback broker URLs, and the bridge module is loaded
  only in Vite DEV when `VITE_DRIFTING_AGENT_DEBUG_URL` is explicitly set.
- Requests run against the currently opened real project. A write prompt can
  mutate it and follows the same durable inline-review policy as the Agent panel. Back up
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
- The explicit DEV request watchdog defaults to ten minutes and accepts up to
  twelve hours. Expiry aborts the test client and is recorded as test
  infrastructure, not as an Agent task budget.
- Stop the broker and the DEV App when finished. No broker or debug service is
  bundled into a release build.
