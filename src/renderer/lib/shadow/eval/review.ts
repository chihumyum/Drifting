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

export interface ReviewOpts {
  // Abort the in-flight judge call(s) — lets the scorer impose a per-chapter
  // timeout instead of waiting out the SDK's 10-min default.
  signal?: AbortSignal;
  // Review ONLY these rule ids (default: all of the project's rules). A mutation
  // only scores the rules in its `expect`, so reviewing just those skips the other
  // rules' independent FC loops — roughly halving an injection's judge calls.
  ruleIds?: string[];
  // The judge's evidence trail (which canon it consulted, how it ruled) — lets the
  // scorer show whether a missed fault was a consultation gap vs a reasoning gap.
  onTrace?: (step: AgenticTraceStep) => void;
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
  const evaluateSemanticBatch = (
    assertions: string[],
    c: ReviewContext,
  ): Promise<SemanticViolation[][]> =>
    evaluateSemanticAssertionsFC(
      assertions,
      c.blocks,
      project.projectId,
      semCtx,
      client,
      READ_TOOLS,
      runTool,
      opts.signal,
      opts.onTrace,
    );
  const rules = opts.ruleIds
    ? project.rules.filter((r) => opts.ruleIds!.includes(r.id))
    : project.rules;
  return evaluateRules(rules, ctx, evaluateSemanticBatch);
}
