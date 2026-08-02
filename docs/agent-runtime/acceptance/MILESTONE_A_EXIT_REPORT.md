# Milestone A exit report — capability truth

Date: 2026-08-02

## Result

Milestone A is complete. Current Agent capability claims now have one generated
source derived from pure production contracts and are checked against the final
runtime composition under Vitest. Hand-maintained tool counts were removed from
current README and repository guidance.

The current machine-readable and human-readable inventories are:

- [`agent-capabilities.json`](agent-capabilities.json)
- [`agent-capabilities.md`](agent-capabilities.md)

## Implemented boundary

- Workspace provider verbs and hidden domain commands live in a pure contract
  consumed by the production workspace runtime and the generator.
- Long-task tool names/access and the product context window live in pure
  contracts consumed by production composition and the generator.
- The final built-in composition has one canonical access resolver.
- The manifest records installed definitions, exact runtime owner, surface,
  access, certification, direct unavailable writes, workspace hidden
  operations, context window and deferred product capabilities.
- A composition test proves every generated installed tool exists in the final
  product runtime, has exactly one executable built-in owner, and agrees with
  the production access resolver.
- `agent:capabilities:check` rejects stale JSON/Markdown evidence and missing
  documentation links or milestone rules.
- Historical P5/P6/headless snapshots are clearly marked historical instead of
  silently competing with current status.

During the inventory extraction, the unused `edit_blocks` workspace hidden
command admission was removed. `edit_blocks` remains a certified direct tool;
the workspace facade never produced that hidden command.

## Acceptance evidence

Commands executed from `client`:

```bash
pnpm agent:capabilities:generate
pnpm agent:capabilities:check
pnpm exec vitest run \
  src/renderer/lib/agent/runtime/drifting-workspace-tool-runtime.test.ts \
  src/renderer/lib/agent/runtime/drifting-product-composition.integration.test.ts \
  src/renderer/lib/agent/runtime/long-task-runtime.integration.test.ts \
  --reporter=dot
pnpm typecheck
pnpm test -- --reporter=dot
pnpm exec eslint <milestone-A-files>
```

Observed results:

- capability composition: 1 file / 2 tests passed;
- related workspace/product/long-task integration: 3 files / 25 tests passed;
- full Core suite: 120 files / 774 tests passed;
- TypeScript: passed;
- targeted ESLint: passed after correcting the test-only driver stub.

The tests intentionally exercise fault paths that print expected SQLite,
checkpoint, keychain and Yjs errors; the suite exit and assertions passed.

## Explicitly not claimed

- No hosted provider call was needed to prove composition/ownership equality.
- This milestone does not prove semantic success for every concrete project
  mutation; write behavior remains covered by its own durable acceptance suites
  and the later reliability/domain milestones.
- No native visual smoke was run because this milestone changes contracts,
  generation and documentation rather than UI behavior.

The next milestone is B: tool-call reliability and real-provider replay.
