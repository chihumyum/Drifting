/**
 * Headless review: run the REAL evaluator chain (src/main/shadow/evaluators.ts)
 * over an in-memory project, capturing Finding[] — the same findings that would
 * become comments — WITHOUT any DB write, graph wrapper, or IPC bridge. This is
 * the "横切 shadow 链路拿结果、绕过写库" interception point.
 *
 * Deterministic checklist items (word-count / must-appear / banned-words) run
 * inline with no LLM (so the mechanical path is eval-able with NO key); semantic
 * items go through the real FC judge with real consultation via the model runTool.
 */
import { evaluateRules } from '@/main/shadow/evaluators';
import type { Finding, ReviewContext, SemanticViolation } from '@/main/shadow/types';
import { evaluateSemanticAssertionsFC, type AgenticTraceStep } from '../../ai/shadow-rules';
import type { AIUsage } from '../../ai/types';
import { AGENT_READ_TOOLS, toAITools } from '../../agent/tool-registry';
import { LLMClient } from '../../ai/client/llm-client';
import { DeepSeekProvider } from '../../ai/client/providers/deepseek';
import type { AICompletionResponse } from '../../ai/types';
import {
  makeModelRunTool,
  semanticContextFor,
  toReviewContext,
  type EvalChapter,
  type EvalProject,
} from './model';

const READ_TOOLS = toAITools(AGENT_READ_TOOLS);

/** Real DeepSeek client from an env key, or null (caller skips the LLM path). */
export function realJudgeClient(): LLMClient | null {
  const key =
    process.env.VITE_DEEPSEEK_AI_API_KEY ||
    process.env.VITE_DEEPSEEK_API_KEY ||
    process.env.DEEPSEEK_API_KEY;
  return key ? new LLMClient(new DeepSeekProvider({ apiKey: key })) : null;
}

/** A no-LLM client that rules every assertion CLEAN — lets the deterministic path
 *  (and the chain/scoring plumbing) run with no key and no tokens. */
export function mockCleanClient(): LLMClient {
  const complete = async (): Promise<AICompletionResponse> => ({
    text: '',
    toolCalls: [{ id: 'c1', name: 'submit_verdicts', arguments: { verdicts: [] } }],
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  return { supportsTools: true, complete } as unknown as LLMClient;
}

// Window the chapter under review: instead of one FC pass over the whole chapter,
// judge `size`-block windows (with `overlap` carry-over) and UNION the violations.
// Raises the signal-to-noise of a diluted fault in a long chapter; the deterministic
// checks stay chapter-level (this only wraps the semantic judge). size<=0 = off.
export interface ChunkConfig {
  size: number;
  overlap: number;
}

export interface ReviewOpts {
  // Abort the in-flight judge call(s) — lets the scorer impose a per-chapter
  // timeout instead of waiting out the SDK's 10-min default.
  signal?: AbortSignal;
  // Split the semantic review into windows (see ChunkConfig). Off = whole chapter.
  chunk?: ChunkConfig;
  // Review ONLY these rule ids (default: all of the project's rules). A mutation
  // only scores the rules in its `expect`, so reviewing just those skips the other
  // rules' independent FC loops — roughly halving an injection's judge calls.
  ruleIds?: string[];
  // The judge's evidence trail (which canon it consulted, how it ruled) — lets the
  // scorer show whether a missed fault was a consultation gap vs a reasoning gap.
  onTrace?: (step: AgenticTraceStep) => void;
  // Per-judge-call token usage — the scorer aggregates it into per-case cost.
  onUsage?: (usage: AIUsage) => void;
}

/** Review one chapter of a project with the real evaluator chain → its findings. */
export async function reviewChapter(
  project: EvalProject,
  chapter: EvalChapter,
  client: LLMClient,
  opts: ReviewOpts = {},
): Promise<Finding[]> {
  const ctx = toReviewContext(project, chapter);
  const runTool = makeModelRunTool(project);
  const semCtx = semanticContextFor(project, chapter);
  // One FC pass over a given block slice. Numbering + verdict→blockId resolution are
  // internal to this call, so a windowed slice yields correct GLOBAL block ids.
  const oneCall = (
    assertions: string[],
    blocks: { id: string | null; text: string }[],
  ): Promise<SemanticViolation[][]> =>
    evaluateSemanticAssertionsFC(
      assertions,
      blocks,
      project.projectId,
      semCtx,
      client,
      READ_TOOLS,
      runTool,
      opts.signal,
      opts.onTrace,
      opts.onUsage,
    );
  const chunk = opts.chunk;
  const evaluateSemanticBatch = (
    assertions: string[],
    c: ReviewContext,
  ): Promise<SemanticViolation[][]> =>
    !chunk || chunk.size <= 0 || c.blocks.length <= chunk.size
      ? oneCall(assertions, c.blocks)
      : reviewInWindows(assertions, c.blocks, chunk, oneCall);
  const rules = opts.ruleIds
    ? project.rules.filter((r) => opts.ruleIds!.includes(r.id))
    : project.rules;
  return evaluateRules(rules, ctx, evaluateSemanticBatch);
}

/** How many windows `len` blocks split into under `chunk` (1 = no split). */
export function windowCount(len: number, chunk?: ChunkConfig): number {
  if (!chunk || chunk.size <= 0 || len <= chunk.size) return 1;
  const step = Math.max(1, chunk.size - Math.max(0, chunk.overlap));
  return Math.ceil((len - chunk.size) / step) + 1;
}

/**
 * Judge the chapter in overlapping windows and UNION the per-assertion violations.
 * Windows run SEQUENTIALLY (the outer task pool already parallelizes across chapters
 * — fanning out windows too would blow the rate limit). The global canon brief
 * (semCtx, baked into `oneCall`) rides into every window, so cross-window context
 * isn't fully lost. Overlap can surface the same span twice → dedup by (ids, reason).
 */
async function reviewInWindows(
  assertions: string[],
  blocks: { id: string | null; text: string }[],
  chunk: ChunkConfig,
  oneCall: (
    a: string[],
    b: { id: string | null; text: string }[],
  ) => Promise<SemanticViolation[][]>,
): Promise<SemanticViolation[][]> {
  const step = Math.max(1, chunk.size - Math.max(0, chunk.overlap));
  const merged: SemanticViolation[][] = assertions.map(() => []);
  const seen = assertions.map(() => new Set<string>());
  for (let i = 0; i < blocks.length; i += step) {
    const part = await oneCall(assertions, blocks.slice(i, i + chunk.size));
    for (let a = 0; a < assertions.length; a++) {
      for (const v of part[a] ?? []) {
        const key = `${v.blockIds.join(',')}|${v.reason}`;
        if (seen[a]!.has(key)) continue;
        seen[a]!.add(key);
        merged[a]!.push(v);
      }
    }
    if (i + chunk.size >= blocks.length) break;
  }
  return merged;
}
