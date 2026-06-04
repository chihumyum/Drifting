import type { ShadowDeps, ReviewContext, RuleSpec, Finding, ShadowDecision } from './types';
import { evaluateRules } from './evaluators';

// `lg` is the dynamically-imported @langchain/langgraph module, kept out of the
// Vite bundle (see vite.main.config.ts external list) and loaded at runtime the
// same way the Agent SDK is. Typed via `typeof import(...)` — a type-only
// reference that is erased at build, so it never pulls the package into the bundle.
type LangGraphModule = typeof import('@langchain/langgraph');

/**
 * Build + compile the shadow review graph.
 *
 * Flow: gather (read-only) → resolve rules → check (fan-out per checklist item)
 * → emit (comments) → decide (status).
 *
 * Every side effect goes through the injected `deps`; the graph never imports a
 * repo or does IPC. Only `emit` and `decide` write anything — so "advise, don't
 * block" is enforced at the graph's shape, not by convention.
 */
export function buildShadowGraph(lg: LangGraphModule, deps: ShadowDeps) {
  const { StateGraph, Annotation, START, END } = lg;

  const State = Annotation.Root({
    chapterId: Annotation<string>(),
    projectId: Annotation<string>(),
    context: Annotation<ReviewContext | null>({
      reducer: (_prev, next) => next,
      default: () => null,
    }),
    rules: Annotation<RuleSpec[]>({
      reducer: (_prev, next) => next,
      default: () => [],
    }),
    findings: Annotation<Finding[]>({
      reducer: (a, b) => a.concat(b),
      default: () => [],
    }),
    decision: Annotation<ShadowDecision | null>({
      reducer: (_prev, next) => next,
      default: () => null,
    }),
  });
  type S = typeof State.State;

  const gather = async (s: S): Promise<Partial<S>> => ({
    context: await deps.readChapterSnapshot(s.chapterId),
  });

  const resolve = async (s: S): Promise<Partial<S>> => ({
    rules: await deps.readRules(s.projectId, s.chapterId),
  });

  const check = async (s: S): Promise<Partial<S>> => ({
    findings: s.context ? await evaluateRules(s.rules, s.context, deps.evaluateSemanticBatch) : [],
  });

  // Side-effect node ①: the only place comments are written. Clear this chapter's
  // prior shadow comments first so a re-review never piles up duplicates, then
  // write one comment per finding (each anchored to its violating block).
  const emit = async (s: S): Promise<Partial<S>> => {
    await deps.clearComments(s.chapterId);
    for (const finding of s.findings) {
      await deps.writeComment(s.chapterId, finding);
    }
    return {};
  };

  // Side-effect node ②: the only place chapter status is pushed. Clean → finished;
  // any finding → back to draft (issues surface as comments; no revising tier).
  const decide = async (s: S): Promise<Partial<S>> => {
    const decision: ShadowDecision = s.findings.length > 0 ? 'draft' : 'finished';
    await deps.setStatus(s.chapterId, decision);
    return { decision };
  };

  return new StateGraph(State)
    .addNode('gather', gather)
    .addNode('resolve', resolve)
    .addNode('check', check)
    .addNode('emit', emit)
    .addNode('decide', decide)
    .addEdge(START, 'gather')
    .addEdge('gather', 'resolve')
    .addEdge('resolve', 'check')
    .addEdge('check', 'emit')
    .addEdge('emit', 'decide')
    .addEdge('decide', END)
    .compile();
}
