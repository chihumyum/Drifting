# Shadow eval

Headless eval for the shadow review engine. It **clones a golden project in
memory**, applies fault / dependency mutations to the clone, runs the **real**
evaluator chain (`src/main/shadow/evaluators.ts` → `evaluateRules`, incl. the FC
judge), and **captures `Finding[]` directly — bypassing the DB, the LangGraph
wrapper, and the IPC bridge**. No app, no Electron.

## The idea

You provide a polished golden project (exported to the `EvalProject` shape). The
eval clones it per case, a mutation injects a **known** fault, and the expected
verdict is **true by construction**:

- clean variant the judge flags → **false positive**
- injected-fault variant it misses → **false negative**

so precision / recall fall out with no human labeling. "Changing a dependency" =
editing an element fact on the clone; the chapters whose prose asserted the old
value should now fire (regression), an unrelated fact-change must stay clean (FP
guard).

## Run

```bash
pnpm eval:shadow                                   # mechanical path only — exact, NO key
VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:shadow   # + semantic / dependency cases + 《雾港纪事》
EVAL_REPEAT=3 VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:shadow   # + verdict stability
pnpm eval:shadow:smoke                             # judge-loop plumbing (canned client)
```

Every chapter review prints a `▶`/`✓` progress line (with elapsed seconds and a
running `n/total`), streamed live — a long run is visibly moving, and a stalled
chapter shows up as a `▶` with no matching `✓`. Knobs (env):

- `EVAL_CONCURRENCY` — simultaneous chapter reviews (default **6**). Reviews are
  independent (each mutation runs on its own clone), so this is a straight speedup
  bounded by your DeepSeek rate limit.
- `EVAL_CALL_TIMEOUT_MS` — abort a chapter that outruns this (default **480000** =
  8 min; `0` = off), so a hung call fails fast instead of waiting out the SDK's
  10-minute default.
- `EVAL_FP_SWEEP=1` — for 《雾港纪事》, add the heavy clean-prose false-positive
  sweep over all 4 chapters × 2 rules (8 long-prose judge calls). Default runs only
  the fast targeted injections.

## Real golden — 《雾港纪事》

`golden.fog-harbor.ts` is the user's manuscript as a real golden: chapter **prose is
read at runtime** from the Obsidian vault (never committed), elements/facts come
from `主要角色.md`, and the mutations are faithful — a head-hop in 奥伦's single-POV
act, 米拉 using her mind power with no hand contact (contradicts canon), 莉薇 acting
socially deft (contradicts her naivety), a dependency change flipping 米拉's ability
fact, and an irrelevant-change FP guard. Override the path with `FOG_HARBOR_DIR`
(default points at `…/雾港纪事/book-1`). **Default run = the 5 targeted injections**
(each one chapter × one rule, run concurrently → finishes in roughly one chapter's
time). The clean-prose false-positive sweep (`cleanBaseline` over 4 chapters × 2
rules — many long-prose judge calls) is the heavy periodic acceptance pass; opt in
with `EVAL_FP_SWEEP=1`.

Mechanical rules (word-count / must-appear / banned-words) run with **no LLM**, so
that slice is a real headless regression gate even without a key (it asserts
`FP==0 && FN==0`). The semantic + dependency cases need a key; without one they
self-skip (green). The report is a confusion matrix + precision/recall; it does
**not** hard-gate the probabilistic verdicts — tighten into a gate once a baseline
is trusted (commented `expect(...FP...)` in `shadow-eval.eval.ts`).

## Files

- `model.ts` — `EvalProject` (in-memory model), `cloneProject` (deep clone =
  the "copy"), `toReviewContext`, and a **model-backed `runTool`** so the judge
  CONSULTS canon from the clone the way it does in prod (not inlined).
- `golden.sample.ts` — a small real-shaped golden + its labeled mutation set.
  Replace with your exported novel.
- `mutations.ts` — deterministic operators (banned-word / head-hop / prose-vs-canon
  / **dependency-change** contradicting & irrelevant) → labeled `Mutation`s.
- `review.ts` — `reviewChapter`: the real `evaluateRules` + FC-judge adapter
  (takes a `signal` for timeouts + a `ruleIds` filter so a mutation reviews only the
  rule it scores); `realJudgeClient()` (env key) / `mockCleanClient()`.
- `score.ts` — flattens (mutation × repeat × chapter) into independent tasks, runs
  them with bounded concurrency + per-chapter timeout + live ▶/✓ progress, then
  votes → confusion matrix (+ repeat/stability).
- `shadow-eval.eval.ts` — Vitest entry. `smoke.eval.ts` — judge-loop plumbing.

## Bringing your own golden

Export your in-app project to the `EvalProject` shape (chapters as `{id,text}`
block arrays, elements with `facts`, compiled `rules`). Drop it in alongside
`golden.sample.ts` and point the eval at it. The export bridge (in-app dev button
or a node DB-reader) is the next piece to build.

## Where AI fits

`mutations.ts` is where AI-generated faults plug in: a generator proposes the same
`{apply, expect}` shape over the real golden. **Caveat — circularity:** an LLM that
both writes and judges the fault makes the ground truth an LLM guess. So generated
faults must pass a **certification gate** (a stronger/independent pass confirms the
fault is unambiguous) before they're frozen into the labeled set. Pure FP
measurement needs no AI faults at all — run the judge on the certified-clean
golden; any flag is a false positive.

## Why headless (no Electron)

`shadow-rules`' import graph's only Electron coupling is the LLM-client factory's
subtree (BYOK keychain + capture interceptor). The eval `vi.mock`s that one module
— the FC path takes its `client` as an argument — and builds a client directly:
`new LLMClient(new DeepSeekProvider({ apiKey }))`. `evaluators.ts` is
framework-agnostic (pure types), so it imports and runs in node as-is.

## v1 limits / next

- Tiny sample golden (swap in the real one).
- Scope per mutation is hardcoded to the affected chapters; a fuller version takes
  it from the **staleness selector** (`useStaleReviews`) — which also tests the dep
  graph end-to-end. Extract its pure core to use it here.
- The **in-app full-pipeline tier** (run real shadow, eval from `traceJson` +
  comments) is the higher-fidelity complement — cheap to add since the logging
  already exists; use it for periodic acceptance, this for fast iteration.
