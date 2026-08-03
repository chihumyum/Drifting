import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';

import type { ShadowToolCall, ShadowToolStatus } from '../../domain/shadow-job';
import type { LLMClient } from '../ai/client/llm-client';
import type { AITool, AIUsage } from '../ai/types';
import {
  resolveAgentProviderContextProfile,
  type AgentProviderId,
} from '../agent/runtime/agent-provider-contract';
import {
  DriftingAgentModelDriver,
  OpenAICompatibleCompletionDriver,
} from '../agent/runtime/drivers';
import { AgentRuntime } from '../agent/runtime/runtime';
import type {
  AgentModelContextProfile,
  AgentRuntimeJournalEntry,
  AgentRuntimeRunResult,
  AgentToolDefinition,
  AgentToolRuntime,
} from '../agent/runtime/types';

const SHADOW_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_RESULT_CHARS = 2_000;
const TRACE_RESULT_CHARS = 600;

let runSequence = 0;

export interface ShadowAgentRuntimeToolOutcome {
  content: string;
  status: ShadowToolStatus;
  note?: string;
}

export interface ShadowAgentRuntimeToolRound {
  iteration: number;
  calls: ShadowToolCall[];
}

export interface RunShadowAgentRuntimeInput {
  projectId: string;
  chapterId?: string;
  operation: 'review' | 'evolve-critic' | 'evolve-edit' | 'eval';
  feature: string;
  /** Production BYOK route. Uses the same provider drivers as General Agent. */
  provider?: AgentProviderId;
  /** Hosted/test compatibility route over the legacy LLMClient seam. */
  client?: LLMClient;
  model: string;
  systemPrompt: string;
  prompt: string;
  tools: readonly AITool[];
  completionTool: string;
  maxModelIterations: number;
  /** Includes the terminal completion call. */
  maxToolCalls: number;
  reasoning?: { enabled: boolean; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  signal?: AbortSignal;
  maxToolResultChars?: number;
  executeTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ShadowAgentRuntimeToolOutcome>;
  summarizeArguments?: (name: string, args: Record<string, unknown>) => string | undefined;
  traceCompletionTool?: boolean;
  onToolRound?: (round: ShadowAgentRuntimeToolRound) => void;
  onUsage?: (usage: AIUsage) => void;
}

export interface ShadowAgentRuntimeResult {
  completion: NonNullable<AgentRuntimeRunResult['completionTool']>;
  runtime: AgentRuntimeRunResult;
}

interface MutableTraceCall {
  iteration: number;
  name: string;
  args?: string;
  status?: ShadowToolStatus;
  note?: string;
  result?: string;
}

/**
 * Shadow workload profile for the canonical AgentRuntime.
 *
 * Product policy remains Shadow-owned: a fixed tool allowlist, bounded rounds,
 * an explicit terminal tool and no conversation persistence. Provider protocol,
 * context planning, cancellation, validation, usage and the tool loop itself are
 * the same implementation used by General Agent.
 */
export async function runShadowAgentRuntime(
  input: RunShadowAgentRuntimeInput,
): Promise<ShadowAgentRuntimeResult> {
  if (input.client && !input.client.supportsTools) {
    throw new Error('The selected Shadow provider does not support the shared Agent Runtime.');
  }
  if (!input.client && !input.provider) {
    throw new Error('Shadow Agent Runtime requires a provider or compatibility client.');
  }
  if (!input.tools.some((tool) => tool.name === input.completionTool)) {
    throw new Error(`Shadow completion tool "${input.completionTool}" is not installed.`);
  }

  runSequence += 1;
  const runId = `shadow-${input.operation}-${runSequence}`;
  const outcomes = new Map<string, ShadowAgentRuntimeToolOutcome>();
  const traceCalls = new Map<string, MutableTraceCall>();
  const definitions = input.tools.map((tool) =>
    toRuntimeDefinition(tool, tool.name === input.completionTool ? 'read' : undefined),
  );
  const maxResultChars = input.maxToolResultChars ?? DEFAULT_RESULT_CHARS;

  const toolRuntime: AgentToolRuntime = {
    listDefinitions: () => definitions,
    execute: async (request) => {
      if (request.signal.aborted) throw shadowCancelled(request.signal.reason);
      if (request.name === input.completionTool) {
        const outcome: ShadowAgentRuntimeToolOutcome = {
          content: 'Structured result submitted.',
          status: 'ok',
        };
        outcomes.set(request.callId, outcome);
        return { ok: true, data: outcome.content };
      }
      let outcome: ShadowAgentRuntimeToolOutcome;
      try {
        outcome = await input.executeTool(request.name, request.arguments);
      } catch (error) {
        if (request.signal.aborted) throw shadowCancelled(request.signal.reason);
        const message = error instanceof Error ? error.message : String(error);
        outcome = { content: `Tool failed: ${message}`, status: 'error', note: message };
      }
      const content = clip(outcome.content, maxResultChars);
      const normalized = { ...outcome, content };
      outcomes.set(request.callId, normalized);
      return normalized.status === 'error'
        ? { ok: false, error: normalized.content }
        : { ok: true, data: normalized.content };
    },
  };

  const flushIteration = (iteration: number) => {
    const calls = [...traceCalls.entries()]
      .filter(([, call]) => call.iteration === iteration)
      .map(([callId, call]) => ({ callId, call }))
      .filter(
        ({ call }) => input.traceCompletionTool === true || call.name !== input.completionTool,
      )
      .map(
        ({ call }) =>
          ({
            tool: call.name,
            ...(call.args ? { args: call.args } : {}),
            status: call.status ?? 'error',
            ...(call.note ? { note: call.note } : {}),
            ...(call.result ? { result: call.result } : {}),
          }) satisfies ShadowToolCall,
      );
    if (calls.length > 0) {
      try {
        input.onToolRound?.({ iteration, calls });
      } catch {
        // Trace projection is observational and must not change runtime correctness.
      }
    }
  };

  let activeIteration = 0;
  const onEntry = (entry: AgentRuntimeJournalEntry) => {
    const event = entry.event;
    if (event.type === 'model_iteration_started') {
      if (activeIteration > 0) flushIteration(activeIteration);
      activeIteration = event.iteration;
      return;
    }
    if (event.type === 'tool_call_started') {
      traceCalls.set(event.callId, {
        iteration: event.iteration,
        name: event.name,
      });
      return;
    }
    if (event.type === 'tool_call_ready') {
      const call = traceCalls.get(event.callId);
      if (call) {
        call.args =
          input.summarizeArguments?.(event.name, event.arguments) ??
          summarizeArguments(event.arguments);
      }
      return;
    }
    if (event.type === 'tool_result') {
      const call = traceCalls.get(event.callId);
      if (!call) return;
      const outcome = outcomes.get(event.callId);
      call.status =
        outcome?.status ??
        (event.errorCode === 'UNKNOWN_TOOL' ? 'denied' : event.ok ? 'ok' : 'error');
      call.note = outcome?.note ?? (!event.ok ? event.content : undefined);
      call.result = clip(event.content, TRACE_RESULT_CHARS);
      return;
    }
    if (event.type === 'model_usage') {
      input.onUsage?.({
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        ...(event.usage.cacheReadTokens > 0 ? { cachedTokens: event.usage.cacheReadTokens } : {}),
      });
    }
  };

  const driver = input.client
    ? new OpenAICompatibleCompletionDriver({
        client: input.client,
        defaultModel: input.model,
        id: `shadow-provider:${input.feature}`,
        feature: input.feature,
        reasoningMode: input.client.providerId === 'deepseek' ? 'deepseek' : 'disabled',
      })
    : new DriftingAgentModelDriver({
        featureLabel: 'Shadow Agent',
        logTag: input.feature,
        feature: input.feature,
        defaultModel: input.model,
      });
  const contextProfile = resolveShadowContextProfile(input);
  const outputTokens = Math.min(contextProfile.maxOutputTokens, SHADOW_MAX_OUTPUT_TOKENS);
  const runtime = new AgentRuntime({
    driver,
    tools: toolRuntime,
    contextPlanning: {
      contextWindowTokens: contextProfile.contextWindowTokens,
      providerProfileId: `${contextProfile.id}:shadow-runtime-v1`,
      providerMaxOutputTokens: outputTokens,
      providerOverheadTokens: contextProfile.providerOverheadTokens,
      perToolOverheadTokens: contextProfile.perToolOverheadTokens,
    },
  });
  const result = await runtime.runTurn({
    sessionId: `${runId}:session`,
    turnId: `${runId}:turn`,
    route: {
      kind: 'shadow',
      projectId: input.projectId,
      operation: input.operation,
      ...(input.chapterId ? { chapterId: input.chapterId } : {}),
    },
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    ...(input.provider ? { provider: input.provider } : {}),
    model: input.model,
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    completionTool: {
      name: input.completionTool,
      forceOnFinalIteration: true,
      disableReasoningWhenForced: true,
      reminder: `请调用 ${input.completionTool} 提交结构化结果；普通文字回答不能结束本轮。`,
    },
    toolSearch: 'off',
    limits: {
      maxModelIterations: input.maxModelIterations,
      maxToolCalls: input.maxToolCalls,
      maxOutputTokensPerIteration: outputTokens,
    },
    ...(input.signal ? { signal: input.signal } : {}),
    onEntry,
  });
  if (activeIteration > 0) flushIteration(activeIteration);

  if (!result.completionTool) {
    const outcome = result.state.terminal?.outcome;
    if (outcome === 'aborted') throw shadowCancelled(result.state.terminal?.message);
    throw new Error(
      result.state.terminal?.message ||
        `Shadow Agent Runtime ended without ${input.completionTool}.`,
    );
  }
  return { completion: result.completionTool, runtime: result };
}

function resolveShadowContextProfile(
  input: Pick<RunShadowAgentRuntimeInput, 'client' | 'provider' | 'model'>,
): Readonly<AgentModelContextProfile> {
  if (input.provider) {
    return resolveAgentProviderContextProfile(input.provider, input.model);
  }
  if (input.client?.providerId === 'deepseek') {
    return resolveAgentProviderContextProfile('deepseek', input.model);
  }
  // Hosted proxy may route a model outside the General Agent BYOK catalog.
  // Stay conservative until that server route advertises a signed profile.
  return {
    id: `shadow-hosted-conservative:${input.model}`,
    contextWindowTokens: 200_000,
    maxOutputTokens: SHADOW_MAX_OUTPUT_TOKENS,
    providerOverheadTokens: 512,
    perToolOverheadTokens: 8,
  };
}

function toRuntimeDefinition(
  tool: AITool,
  completionAccess?: AgentToolDefinition['access'],
): AgentToolDefinition {
  const schema = tool.parametersSchema as TSchema;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parametersSchema,
    access: completionAccess ?? (tool.name.startsWith('edit_') ? 'write' : 'read'),
    validateInput: (input) => {
      const normalized = stripUnknownProperties(schema, input);
      if (Value.Check(schema, normalized)) return { ok: true, value: normalized };
      const first = Value.Errors(schema, normalized).First();
      return {
        ok: false,
        error: first ? `${first.path || '/'} ${first.message}` : 'schema validation failed',
      };
    },
  };
}

function stripUnknownProperties(
  schema: TSchema,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (!properties) return { ...input };
  return Object.fromEntries(Object.entries(input).filter(([key]) => key in properties));
}

function summarizeArguments(args: Record<string, unknown>): string | undefined {
  const values = Object.values(args)
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .map(String);
  return values.length > 0 ? values.join(' ') : undefined;
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…（截断）` : value;
}

function shadowCancelled(reason: unknown): Error {
  const error = new Error(
    typeof reason === 'string' && reason ? reason : 'Shadow review cancelled',
  );
  error.name = 'ShadowCancelledError';
  return error;
}
