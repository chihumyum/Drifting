import type {
  ShadowDeps,
  ReviewContext,
  RuleSpec,
  SemanticViolation,
  Finding,
  ShadowDecision,
} from './types';

// Invokes a named renderer-side handler over the agent bridge (callRenderer).
export type RendererCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;

// Real deps: every read/write bridges to the renderer, which owns the SQLite DB,
// the Yjs prose, the LLM substrate, and the comment + status usecases. The graph
// stays pure orchestration — these calls are its only contact with the world,
// and only clearComments/writeComment/setStatus mutate anything (advise-not-block).
export function createShadowDeps(call: RendererCall): ShadowDeps {
  return {
    async readChapterSnapshot(chapterId: string): Promise<ReviewContext> {
      return (await call('shadow_read_chapter_snapshot', { chapterId })) as ReviewContext;
    },
    async readRules(projectId: string, chapterId: string): Promise<RuleSpec[]> {
      return (await call('shadow_read_rules', { projectId, chapterId })) as RuleSpec[];
    },
    async evaluateSemanticBatch(
      assertions: string[],
      ctx: ReviewContext,
    ): Promise<SemanticViolation[][]> {
      return (await call('shadow_eval_semantic_batch', {
        assertions,
        chapterId: ctx.chapterId,
        projectId: ctx.projectId,
        // Ground deep rules: hand the judge the whole-book (project) facts (POV,
        // person, character setup) + the chapter summary. The renderer further
        // warm-starts it with chapter identity + scene entities + prior chapter +
        // the chapter's own storyline summary/facts.
        facts: ctx.rulesKv,
        summary: ctx.summary,
      })) as SemanticViolation[][];
    },
    async clearComments(chapterId: string): Promise<void> {
      await call('shadow_clear_comments', { chapterId });
    },
    async writeComment(chapterId: string, finding: Finding): Promise<void> {
      await call('shadow_write_comment', { chapterId, finding });
    },
    async setStatus(chapterId: string, status: ShadowDecision): Promise<void> {
      await call('shadow_set_status', { chapterId, status });
    },
  };
}
