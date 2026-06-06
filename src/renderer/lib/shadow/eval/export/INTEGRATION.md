# In-app integration

## Export a golden from a live project (works today, no IPC)

The export bridge runs in the renderer and **downloads** the golden — no `fs`, no
new IPC channel. Wire a dev button to `downloadProjectGolden`:

```tsx
import { downloadProjectGolden } from '@/renderer/lib/shadow/eval/export/wire';

// project = the active Project (has .id and .kvJson)
<button onClick={() => downloadProjectGolden('my-novel', project.id, project.kvJson)}>
  导出 eval golden
</button>
```

Pass a selection to narrow it: `downloadProjectGolden(id, project.id, project.kvJson,
{ chapterIds: [...], elementIds: [...] })` (omit = whole project). Then drop the
downloaded `my-novel.golden.json` into `corpus/goldens/`, add a dataset + a suite
pointing at it, and run `pnpm eval:corpus` from the CLI.

- prose is read via `getChapterContentJson` (the **Yjs source of truth**), not the
  stale `node_content.contentJson` seed cache.
- element `facts` = the element's `kvJson` (what the judge consults), not its body.
- `assembleGolden` validates with `zGolden` — an unloadable export fails here.

## Running the eval inside the app (deliberate follow-up)

The runner is `fs`-based (reads `corpus/`, writes artifacts) — correct for CLI/CI,
but the **context-isolated renderer has no `fs`**, so it can't run as-is in-app.
Two clean options when we build the in-app run loop:

1. **Main-process bridge** (recommended): a `shadow-eval:run` IPC handler in main
   (which has `fs`) that calls `runSuite(...)` and streams `▶/✓` progress + the final
   report back to the renderer. The judge client comes from `buildDefaultLLMClient()`
   (the app's configured BYOK key) instead of the env-key `realJudgeClient()`.
2. **Bundler-imported corpus**: replace the runner's `readFileSync` with
   `import.meta.glob` so the corpus is bundled and the run is renderer-only (still
   writes artifacts via option 1's IPC or a download).

The dashboard (trend from `history.jsonl`, per-run confusion matrix from
`run.json`) reuses `OpsSummary`'s aggregation and reads those artifacts via the same
bridge. This piece needs the running app to build safely — it's not landed here.
