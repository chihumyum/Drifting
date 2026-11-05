import type { RetryConfig } from '../../../ai/client/retry';
import { AgentModelDriverError } from '../errors';
import {
  serializeAgentContextNoteBudgetPayload,
  serializeAgentContextSummaryProviderPayload,
} from '../context-planner';
import {
  DEFAULT_PROVIDER_ATTEMPT_RETRY,
  retryAfterMsFromHeader,
  streamProviderAttemptWithRetry,
} from './provider-attempt-retry';
import type {
  AgentModelDriver,
  AgentModelMessage,
  AgentModelRequest,
  AgentModelStopReason,
  AgentModelStreamEvent,
  AgentRuntimeUsage,
} from '../types';
import {
  agentProviderModelOption,
  defaultAgentProviderModel,
  resolveAgentProviderContextProfile,
} from '../agent-provider-contract';

type FetchLike = typeof fetch;

/**
 * Prompt-cache breakpoints are placed at the three stability boundaries of the
 * rendered request: the last tool schema, the system tail, and the newest
 * canonical history message. The runtime keeps everything before those
 * boundaries byte-stable between iterations; volatile rows (runtime notes,
 * summaries re-pinned behind new history) stay after the last breakpoint.
 */
const ANTHROPIC_EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' } as const;

/**
 * Anthropic's server-side web search, offered with every tool-bearing request
 * except a `required` choice (which a search alone could otherwise satisfy).
 * It stays listed through forced calls and the `none` synthesis boundary, so
 * the tool set — part of both the prompt-cache prefix and the conversation a
 * thinking signature is bound to — never changes inside a turn. The basic
 * version searches directly; the dynamic-filtering versions route searches
 * through code execution containers this driver does not manage. `max_uses`
 * bounds the cost of one response and keeps the server-side loop short.
 */
const ANTHROPIC_WEB_SEARCH_TOOL = Object.freeze({
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5,
});

/** A long search turn is resumed at most this many times before failing. */
const MAX_PAUSE_TURN_CONTINUATIONS = 4;

/**
 * Key/model pairs whose request was rejected because of the web search tool
 * (an organization administrator disabled it, or the model lacks it). They
 * are sent without it until the app restarts.
 */
const webSearchUnavailable = new Set<string>();

export interface AnthropicMessagesAgentDriverOptions {
  apiKey: string;
  defaultModel?: string;
  endpoint?: string;
  fetch?: FetchLike;
  /** Bounded pre-effect retry lease shared with every Agent driver. */
  providerAttemptRetry?: RetryConfig;
}

interface AnthropicBlockState {
  type:
    | 'text'
    | 'thinking'
    | 'redacted_thinking'
    | 'tool_use'
    | 'server_tool_use'
    | 'web_search_tool_result';
  /** A block type this driver does not know; it is never replayed. */
  unknown?: boolean;
  callId?: string;
  name?: string;
  text?: string;
  citations?: unknown[];
  rawInput?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  result?: AnthropicContentBlock;
}

type AnthropicContentBlock = Record<string, unknown>;

type AnthropicReasoningReplayBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

/**
 * The assistant content of a tool-use response that used a server tool, one
 * array per streamed response (a `pause_turn` adds one per resumption).
 * `tool_use` blocks carry only their id and name: the canonical arguments are
 * filled in when the active tool loop is replayed.
 */
type AnthropicExactReplay = ReadonlyArray<readonly AnthropicContentBlock[]>;

interface AnthropicResponseResult {
  stopReason: string;
  usage: Omit<AgentRuntimeUsage, 'costUsd'>;
  content: AnthropicContentBlock[];
  reasoningReplay: AnthropicReasoningReplayBlock[];
  toolCallIds: string[];
  usedServerTool: boolean;
}

/** Native Anthropic Messages adapter; no Claude Agent SDK or Node host needed. */
export class AnthropicMessagesAgentDriver implements AgentModelDriver {
  readonly id = 'anthropic-messages-stream';
  readonly capabilities;

  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly providerAttemptRetry: RetryConfig;
  private readonly reasoningReplayByCallId = new Map<
    string,
    readonly AnthropicReasoningReplayBlock[]
  >();
  private readonly nonReasoningCallIds = new Set<string>();
  private readonly exactReplayByCallId = new Map<string, AnthropicExactReplay>();
  /** Queries of server searches, for results reported in a later response. */
  private readonly webSearchQueries = new Map<string, string>();

  constructor(options: AnthropicMessagesAgentDriverOptions) {
    if (!options.apiKey.trim()) throw new Error('Anthropic API key is empty');
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel ?? defaultAgentProviderModel('anthropic');
    this.capabilities = {
      reasoning: true,
      context: resolveAgentProviderContextProfile('anthropic', this.defaultModel),
    } as const;
    this.endpoint = options.endpoint ?? 'https://api.anthropic.com/v1/messages';
    // Never store the global fetch as a method: WebKit rejects it unless it is
    // called on the window ("Can only call Window.fetch on instances of Window").
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.providerAttemptRetry = options.providerAttemptRetry ?? DEFAULT_PROVIDER_ATTEMPT_RETRY;
  }

  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelStreamEvent> {
    if (request.tools.length === 0 || request.toolChoice === 'none') {
      // Tool-free synthesis keeps true progressive text streaming. Once
      // visible output escapes, automatically replaying it would duplicate
      // author-facing prose, so this path intentionally has no retry lease.
      yield* this.streamAttempt(request);
      return;
    }
    // A tool-capable provider attempt is transactional: the complete stream is
    // buffered and validated before any Agent event is published, so transient
    // transport failures, rate limits, and invalid samples are safely
    // resampleable — no tool call, usage, or UI activity has escaped yet.
    const events = await streamProviderAttemptWithRetry(
      () => this.streamAttempt(request),
      this.providerAttemptRetry,
      request.signal,
    );
    for (const event of events) yield event;
  }

  private async *streamAttempt(
    request: AgentModelRequest,
  ): AsyncIterable<AgentModelStreamEvent> {
    if (request.signal.aborted) throw abortError();
    const model = request.model || this.defaultModel;
    const modelOption = agentProviderModelOption('anthropic', model);
    // Messages requires max_tokens. Use the selected model's declared maximum
    // when the caller has not requested a smaller ceiling, not a runtime default.
    const maxOutputTokens = request.maxOutputTokens ?? modelOption.context.maxOutputTokens;
    if (maxOutputTokens === null) {
      throw new AgentModelDriverError('The selected Anthropic model has no declared output maximum.');
    }
    const reasoningProfile = modelOption.reasoning;
    // The newest models reject turning thinking off and think when it is
    // omitted, so their thinking stays on and is always replayed unchanged.
    const requiresReasoning = !reasoningProfile.thinkingModes.includes('off');
    const configuredReasoningEnabled = request.reasoning?.enabled === true || requiresReasoning;
    const reasoningEnabled =
      configuredReasoningEnabled &&
      (request.executionMode !== 'required_tool_non_reasoning' || requiresReasoning);
    if (
      reasoningEnabled &&
      !reasoningProfile.thinkingModes.includes('adaptive')
    ) {
      throw new AgentModelDriverError(
        'The selected Anthropic model does not support certified thinking.',
      );
    }
    if (reasoningEnabled && request.iteration > 1) {
      assertActiveAnthropicReplay(
        request.context,
        this.reasoningReplayByCallId,
        this.nonReasoningCallIds,
      );
    }
    const effort = reasoningProfile.efforts.includes(
      request.reasoning?.effort ?? reasoningProfile.defaultEffort,
    )
      ? request.reasoning?.effort ?? reasoningProfile.defaultEffort
      : reasoningProfile.defaultEffort;
    const webSearchKey = webSearchAvailabilityKey(this.apiKey, model);
    let offerWebSearch = offersAnthropicWebSearch(request) && !webSearchUnavailable.has(webSearchKey);
    const messages = projectAnthropicMessages(
      request.context.messages,
      configuredReasoningEnabled ? this.reasoningReplayByCallId : undefined,
      this.exactReplayByCallId,
      configuredReasoningEnabled,
    );
    const requestBody = (
      webSearch: boolean,
      paused: AnthropicExactReplay,
    ): string => JSON.stringify({
      model,
      max_tokens: maxOutputTokens,
      stream: true,
      ...(request.context.systemPrompt
        ? {
            system: [
              {
                type: 'text',
                text: request.context.systemPrompt,
                cache_control: ANTHROPIC_EPHEMERAL_CACHE_CONTROL,
              },
            ],
          }
        : {}),
      // A paused search turn is resumed by sending its content back unchanged
      // as trailing assistant messages; the API continues where it stopped.
      messages: [
        ...messages,
        ...paused.map((content) => ({ role: 'assistant', content })),
      ],
      ...(reasoningEnabled
        ? { thinking: { type: 'adaptive', display: 'summarized' } }
        : {}),
      ...(reasoningProfile.efforts.length > 0 &&
      (request.executionMode !== 'required_tool_non_reasoning' || requiresReasoning)
        ? { output_config: { effort } }
        : {}),
      ...(request.tools.length
        ? {
            tools: [
              ...request.tools.map((tool, index) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
                ...(index === request.tools.length - 1
                  ? { cache_control: ANTHROPIC_EPHEMERAL_CACHE_CONTROL }
                  : {}),
              })),
              ...(webSearch ? [{ ...ANTHROPIC_WEB_SEARCH_TOOL }] : []),
            ],
            tool_choice: anthropicToolChoice(
              request.toolChoice,
              modelOption.forcedToolChoice !== false,
            ),
          }
        : {}),
    });

    const paused: AnthropicContentBlock[][] = [];
    const webSearchQueries = new Map(this.webSearchQueries);
    const usage: AgentRuntimeUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    const toolCallIds: string[] = [];
    const reasoningReplay: AnthropicReasoningReplayBlock[] = [];
    let usedServerTool = false;
    let lastContent: AnthropicContentBlock[] = [];
    let finishReason: AgentModelStopReason;
    while (true) {
      let response = await this.post(requestBody(offerWebSearch, paused), request.signal);
      if (response.status === 400 && offerWebSearch && (await rejectsWebSearch(response))) {
        // Disabled by the organization or unsupported by the model: the turn
        // goes on without web search instead of failing.
        webSearchUnavailable.add(webSearchKey);
        offerWebSearch = false;
        response = await this.post(requestBody(false, paused), request.signal);
      }
      assertAnthropicResponseOk(response);
      const result = yield* readAnthropicResponse(response, request.signal, webSearchQueries);
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.cacheReadTokens += result.usage.cacheReadTokens;
      usage.cacheWriteTokens += result.usage.cacheWriteTokens;
      toolCallIds.push(...result.toolCallIds);
      reasoningReplay.push(...result.reasoningReplay);
      usedServerTool ||= result.usedServerTool;
      lastContent = result.content;
      if (result.stopReason !== 'pause_turn') {
        finishReason = normalizeAnthropicStopReason(result.stopReason);
        break;
      }
      if (paused.length >= MAX_PAUSE_TURN_CONTINUATIONS) {
        finishReason = 'unknown';
        break;
      }
      paused.push(result.content);
      usedServerTool = true;
    }
    if (finishReason === 'tool_use' && usedServerTool) {
      // Search blocks (with their encrypted results) and any thinking around
      // them must reach the next iteration in their original order, so the
      // whole response is replayed rather than rebuilt from canonical blocks.
      const exact: AnthropicExactReplay = [...paused, lastContent];
      for (const callId of toolCallIds) this.exactReplayByCallId.set(callId, exact);
    }
    if (reasoningEnabled && finishReason === 'tool_use') {
      const exact = reasoningReplay.map((block) => ({ ...block }));
      for (const callId of toolCallIds) {
        this.nonReasoningCallIds.delete(callId);
        this.reasoningReplayByCallId.set(callId, exact);
      }
    } else if (finishReason === 'tool_use') {
      for (const callId of toolCallIds) {
        this.reasoningReplayByCallId.delete(callId);
        this.nonReasoningCallIds.add(callId);
      }
    }
    for (const [id, query] of webSearchQueries) this.webSearchQueries.set(id, query);
    yield { type: 'usage', usage };
    yield { type: 'finish', reason: finishReason };
  }

  private async post(body: string, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw abortError();
      void error;
      throw new AgentModelDriverError('Anthropic request could not be started.', true);
    }
  }
}

/** Reads one streamed Messages response, publishing events as they validate. */
async function* readAnthropicResponse(
  response: Response,
  signal: AbortSignal,
  webSearchQueries: Map<string, string>,
): AsyncGenerator<AgentModelStreamEvent, AnthropicResponseResult> {
  const blocks = new Map<number, AnthropicBlockState>();
  const content: AnthropicContentBlock[] = [];
  let inputTokens: number | null = null;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens: number | null = null;
  let stopReason: string | null = null;
  let messageStarted = false;
  let messageStopped = false;
  let usedServerTool = false;
  const reasoningReplay: AnthropicReasoningReplayBlock[] = [];
  const toolCallIds: string[] = [];

  for await (const event of parseSseJson(response, signal)) {
    const type = stringField(event, 'type');
    if (type === 'ping') continue;
    if (type === 'error') {
      // Mid-stream provider errors (for example overloaded) surface here;
      // under the buffered tool-attempt lease a fresh sample is safe.
      throw new AgentModelDriverError('Anthropic stream returned an error.', true);
    }
    if (type === 'message_start') {
      if (messageStarted) throw invalidStream();
      messageStarted = true;
      const message = recordField(event, 'message');
      const usage = recordField(message, 'usage');
      inputTokens = nonNegativeInteger(usage.input_tokens, 'input_tokens');
      cacheReadTokens = optionalNonNegativeInteger(usage.cache_read_input_tokens);
      cacheWriteTokens = optionalNonNegativeInteger(usage.cache_creation_input_tokens);
      continue;
    }
    if (!messageStarted || messageStopped) throw invalidStream();
    if (type === 'content_block_start') {
      const index = nonNegativeInteger(event.index, 'content block index');
      if (blocks.has(index)) throw invalidStream();
      const block = recordField(event, 'content_block');
      const blockType = stringField(block, 'type');
      if (blockType === 'text') {
        blocks.set(index, {
          type: blockType,
          text: '',
          citations: Array.isArray(block.citations) ? structuredClone(block.citations) : [],
        });
      } else if (blockType === 'thinking') {
        blocks.set(index, {
          type: 'thinking',
          thinking: typeof block.thinking === 'string' ? block.thinking : '',
          signature: typeof block.signature === 'string' ? block.signature : '',
        });
      } else if (blockType === 'redacted_thinking') {
        blocks.set(index, {
          type: 'redacted_thinking',
          data: nonBlankString(block.data, 'redacted thinking data'),
        });
      } else if (blockType === 'tool_use') {
        const callId = nonBlankString(block.id, 'tool call id');
        const name = nonBlankString(block.name, 'tool name');
        blocks.set(index, { type: 'tool_use', callId, name });
        toolCallIds.push(callId);
        yield { type: 'tool_call_start', callId, name };
        const initialInput = block.input;
        if (
          initialInput &&
          typeof initialInput === 'object' &&
          !Array.isArray(initialInput) &&
          Object.keys(initialInput).length > 0
        ) {
          yield {
            type: 'tool_args_delta',
            callId,
            delta: JSON.stringify(initialInput),
          };
        }
      } else if (blockType === 'server_tool_use') {
        // A tool Anthropic runs itself (web search): nothing executes here.
        usedServerTool = true;
        const initialInput = block.input;
        blocks.set(index, {
          type: 'server_tool_use',
          callId: nonBlankString(block.id, 'server tool id'),
          name: nonBlankString(block.name, 'server tool name'),
          rawInput:
            initialInput &&
            typeof initialInput === 'object' &&
            !Array.isArray(initialInput) &&
            Object.keys(initialInput).length > 0
              ? JSON.stringify(initialInput)
              : '',
        });
      } else if (blockType === 'web_search_tool_result') {
        // Results arrive complete, with encrypted content that must be sent
        // back unchanged; an error is a single object instead of a list.
        usedServerTool = true;
        nonBlankString(block.tool_use_id, 'web search result id');
        const result = block.content;
        if (!result || typeof result !== 'object') throw invalidStream();
        blocks.set(index, { type: 'web_search_tool_result', result: structuredClone(block) });
      } else {
        // New Anthropic block types are ignored only if they emit no payload
        // that Drifting would need to replay for a tool loop.
        blocks.set(index, { type: 'text', unknown: true });
      }
      continue;
    }
    if (type === 'content_block_delta') {
      const index = nonNegativeInteger(event.index, 'content block index');
      const block = blocks.get(index);
      if (!block) throw invalidStream();
      const delta = recordField(event, 'delta');
      const deltaType = stringField(delta, 'type');
      if (deltaType === 'text_delta' && block.type === 'text') {
        const text = typeof delta.text === 'string' ? delta.text : '';
        block.text = (block.text ?? '') + text;
        if (text) yield { type: 'text_delta', text };
      } else if (deltaType === 'citations_delta' && block.type === 'text') {
        block.citations?.push(structuredClone(recordField(delta, 'citation')));
      } else if (deltaType === 'thinking_delta' && block.type === 'thinking') {
        const thinking = typeof delta.thinking === 'string' ? delta.thinking : '';
        block.thinking = (block.thinking ?? '') + thinking;
        if (thinking) yield { type: 'thinking_delta', text: thinking };
      } else if (deltaType === 'input_json_delta' && block.type === 'tool_use') {
        const partial = typeof delta.partial_json === 'string' ? delta.partial_json : '';
        if (partial) {
          yield { type: 'tool_args_delta', callId: block.callId!, delta: partial };
        }
      } else if (deltaType === 'input_json_delta' && block.type === 'server_tool_use') {
        const partial = typeof delta.partial_json === 'string' ? delta.partial_json : '';
        block.rawInput = (block.rawInput ?? '') + partial;
      } else if (deltaType === 'signature_delta' && block.type === 'thinking') {
        const signature = typeof delta.signature === 'string' ? delta.signature : '';
        block.signature = (block.signature ?? '') + signature;
      } else {
        throw invalidStream();
      }
      continue;
    }
    if (type === 'content_block_stop') {
      const index = nonNegativeInteger(event.index, 'content block index');
      const block = blocks.get(index);
      if (!block) throw invalidStream();
      blocks.delete(index);
      if (block.type === 'tool_use') {
        content.push({ type: 'tool_use', id: block.callId!, name: block.name! });
        yield { type: 'tool_call_end', callId: block.callId! };
      } else if (block.type === 'thinking') {
        const thinking: AnthropicReasoningReplayBlock = {
          type: 'thinking',
          thinking: block.thinking ?? '',
          signature: nonBlankString(block.signature, 'thinking signature'),
        };
        reasoningReplay.push(thinking);
        content.push({ ...thinking });
      } else if (block.type === 'redacted_thinking') {
        const redacted: AnthropicReasoningReplayBlock = {
          type: 'redacted_thinking',
          data: nonBlankString(block.data, 'redacted thinking data'),
        };
        reasoningReplay.push(redacted);
        content.push({ ...redacted });
      } else if (block.type === 'server_tool_use') {
        const input = parseServerToolInput(block.rawInput ?? '');
        content.push({ type: 'server_tool_use', id: block.callId!, name: block.name!, input });
        if (block.name === 'web_search' && typeof input.query === 'string' && input.query.trim()) {
          webSearchQueries.set(block.callId!, input.query);
        }
      } else if (block.type === 'web_search_tool_result') {
        const result = block.result!;
        content.push(result);
        const callId = result.tool_use_id as string;
        const query = webSearchQueries.get(callId);
        yield {
          type: 'provider_tool',
          callId,
          name: 'web_search',
          input: query ? { query } : {},
          ok: Array.isArray(result.content),
        };
      } else if (!block.unknown && block.text?.trim()) {
        // Blank text blocks are rejected when sent back, so they are dropped.
        content.push({
          type: 'text',
          text: block.text ?? '',
          ...(block.citations?.length ? { citations: block.citations } : {}),
        });
      }
      continue;
    }
    if (type === 'message_delta') {
      const delta = recordField(event, 'delta');
      if (typeof delta.stop_reason === 'string') {
        if (stopReason) throw invalidStream();
        stopReason = delta.stop_reason;
      }
      const usage = recordField(event, 'usage');
      outputTokens = nonNegativeInteger(usage.output_tokens, 'output_tokens');
      // Server tool iterations add input after message_start; the final
      // usage is cumulative when it reports input at all.
      if (usage.input_tokens !== undefined && usage.input_tokens !== null) {
        inputTokens = nonNegativeInteger(usage.input_tokens, 'input_tokens');
      }
      if (usage.cache_read_input_tokens !== undefined && usage.cache_read_input_tokens !== null) {
        cacheReadTokens = optionalNonNegativeInteger(usage.cache_read_input_tokens);
      }
      if (
        usage.cache_creation_input_tokens !== undefined &&
        usage.cache_creation_input_tokens !== null
      ) {
        cacheWriteTokens = optionalNonNegativeInteger(usage.cache_creation_input_tokens);
      }
      continue;
    }
    if (type === 'message_stop') {
      if (blocks.size > 0 || messageStopped) throw invalidStream();
      messageStopped = true;
      continue;
    }
    // The Messages API may add ignorable events. Unknown event types do not
    // receive authority and cannot synthesize tool calls.
  }
  if (
    !messageStarted ||
    !messageStopped ||
    inputTokens === null ||
    outputTokens === null ||
    stopReason === null
  ) {
    throw invalidStream();
  }
  return {
    stopReason,
    usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
    content,
    reasoningReplay,
    toolCallIds,
    usedServerTool,
  };
}

function offersAnthropicWebSearch(request: AgentModelRequest): boolean {
  return request.tools.length > 0 && request.toolChoice !== 'required';
}

/** A non-secret fingerprint of the key, so one organization's refusal sticks. */
function webSearchAvailabilityKey(apiKey: string, model: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < apiKey.length; index += 1) {
    hash ^= apiKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}:${model}`;
}

/** Whether a 400 names the web search tool (disabled, or not for this model). */
async function rejectsWebSearch(response: Response): Promise<boolean> {
  try {
    return /web[\s_-]?search/i.test(await response.text());
  } catch {
    return false;
  }
}

function assertAnthropicResponseOk(response: Response): void {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new AgentModelDriverError('Anthropic authentication failed.');
  }
  if (response.status === 429) {
    throw new AgentModelDriverError('Anthropic rate limit reached.', true, {
      retryAfterMs: retryAfterMsFromHeader(response.headers.get('retry-after')),
    });
  }
  if (response.status >= 500) {
    throw new AgentModelDriverError('Anthropic service is temporarily unavailable.', true);
  }
  throw new AgentModelDriverError('Anthropic request failed.');
}

function parseServerToolInput(raw: string): Record<string, unknown> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidStream();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidStream();
  return parsed as Record<string, unknown>;
}

function anthropicToolChoice(
  choice: AgentModelRequest['toolChoice'],
  forcedAllowed: boolean,
): { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string } {
  if (choice === 'none') return { type: 'none' };
  // Models that reject `any` / `tool` with a 400 get `auto`, which still lets
  // them call the requested tool instead of failing the whole turn.
  if (!forcedAllowed) return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice && typeof choice === 'object') return { type: 'tool', name: choice.force };
  return { type: 'auto' };
}

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
};

function projectAnthropicMessages(
  messages: AgentModelRequest['context']['messages'],
  reasoningReplayByCallId: ReadonlyMap<
    string,
    readonly AnthropicReasoningReplayBlock[]
  > | undefined,
  exactReplayByCallId: ReadonlyMap<string, AnthropicExactReplay>,
  keepThinking: boolean,
): AnthropicMessage[] {
  const projected: AnthropicMessage[] = [];
  let cacheAnchor: AnthropicMessage | undefined;
  for (const entry of messages) {
    if (entry.type === 'model_message') {
      const canonical = projectCanonicalMessage(
        entry.message,
        reasoningReplayByCallId,
        exactReplayByCallId,
        keepThinking,
      );
      projected.push(...canonical);
      if (canonical.length > 0) cacheAnchor = canonical[canonical.length - 1];
    } else if (entry.type === 'context_summary') {
      projected.push({
        role: 'user',
        content: serializeAgentContextSummaryProviderPayload(entry),
      });
    } else {
      projected.push({
        role: 'user',
        content: serializeAgentContextNoteBudgetPayload(entry),
      });
    }
  }
  if (cacheAnchor) markAnthropicCacheBreakpoint(cacheAnchor);
  return projected;
}

/**
 * The incremental history breakpoint sits on the newest canonical message,
 * not on trailing summary/runtime-note rows: canonical history is append-only
 * between iterations, so this position is a byte-stable prefix boundary of
 * the next request, while tail note rows are re-pinned behind the new
 * messages and would never be read as a prefix again.
 */
function markAnthropicCacheBreakpoint(message: AnthropicMessage): void {
  if (typeof message.content === 'string') return;
  const last = message.content[message.content.length - 1];
  if (!last) return;
  if (
    last.type === 'thinking' ||
    last.type === 'redacted_thinking' ||
    last.type === 'server_tool_use' ||
    last.type === 'web_search_tool_result'
  ) {
    return;
  }
  last.cache_control = ANTHROPIC_EPHEMERAL_CACHE_CONTROL;
}

function projectCanonicalMessage(
  message: AgentModelMessage,
  reasoningReplayByCallId: ReadonlyMap<
    string,
    readonly AnthropicReasoningReplayBlock[]
  > | undefined,
  exactReplayByCallId: ReadonlyMap<string, AnthropicExactReplay>,
  keepThinking: boolean,
): AnthropicMessage[] {
  // Canonical user text is always projected in block form so the rendered
  // bytes do not change when the cache breakpoint moves onto or off of it.
  if (message.role === 'user') {
    return [
      {
        role: 'user',
        content: [
          ...(message.images ?? []).map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.data },
          })),
          { type: 'text', text: message.content },
        ],
      },
    ];
  }
  if (message.role === 'tool') {
    return [
      {
        role: 'user',
        content: message.content.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.callId,
          content: result.content,
          is_error: !result.ok,
        })),
      },
    ];
  }
  const content: Array<Record<string, unknown>> = [];
  const toolCallIds = message.content.flatMap((block) =>
    block.type === 'tool_call' ? [block.callId] : [],
  );
  const exactReplay = resolveSharedAnthropicReplay(toolCallIds, exactReplayByCallId, 'response');
  if (exactReplay) return projectExactAnthropicReplay(exactReplay, message, keepThinking);
  const reasoningReplay = resolveSharedAnthropicReplay(
    toolCallIds,
    reasoningReplayByCallId,
    'reasoning',
  );
  if (reasoningReplay) content.push(...reasoningReplay.map((block) => ({ ...block })));
  for (const block of message.content) {
    if (block.type === 'text' && block.text) {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_call') {
      content.push({
        type: 'tool_use',
        id: block.callId,
        name: block.name,
        input: block.arguments,
      });
    }
  }
  return [{ role: 'assistant', content }];
}

/**
 * Replays a tool-use response that used a server tool as it streamed — one
 * assistant message per streamed response — with the runtime's canonical
 * arguments in each `tool_use` block.
 */
function projectExactAnthropicReplay(
  replay: AnthropicExactReplay,
  message: Extract<AgentModelMessage, { role: 'assistant' }>,
  keepThinking: boolean,
): AnthropicMessage[] {
  const calls = new Map(
    message.content.flatMap((block) => (block.type === 'tool_call' ? [[block.callId, block]] : [])),
  );
  const replayed = new Set<string>();
  const projected = replay.flatMap((segment): AnthropicMessage[] => {
    const content = segment.flatMap((block): AnthropicContentBlock[] => {
      if (block.type === 'tool_use') {
        const call = typeof block.id === 'string' ? calls.get(block.id) : undefined;
        if (!call || replayed.has(call.callId)) throw incompleteReplay('response');
        replayed.add(call.callId);
        return [{ type: 'tool_use', id: call.callId, name: call.name, input: call.arguments }];
      }
      if (!keepThinking && (block.type === 'thinking' || block.type === 'redacted_thinking')) {
        return [];
      }
      return [structuredClone(block)];
    });
    return content.length > 0 ? [{ role: 'assistant', content }] : [];
  });
  if (replayed.size !== calls.size) throw incompleteReplay('response');
  return projected;
}

function incompleteReplay(kind: 'reasoning' | 'response'): AgentModelDriverError {
  return new AgentModelDriverError(
    `Anthropic ${kind} replay state is incomplete for the active tool loop.`,
  );
}

function resolveSharedAnthropicReplay<T>(
  callIds: readonly string[],
  replayByCallId: ReadonlyMap<string, T> | undefined,
  kind: 'reasoning' | 'response',
): T | undefined {
  if (!replayByCallId || callIds.length === 0) return undefined;
  const values = callIds.flatMap((callId) => {
    const value = replayByCallId.get(callId);
    return value === undefined ? [] : [value];
  });
  if (values.length === 0) return undefined;
  if (
    values.length !== callIds.length ||
    values.some((value) => value !== values[0])
  ) {
    throw incompleteReplay(kind);
  }
  return values[0];
}

function assertActiveAnthropicReplay(
  context: AgentModelRequest['context'],
  replayByCallId: ReadonlyMap<
    string,
    readonly AnthropicReasoningReplayBlock[]
  >,
  nonReasoningCallIds: ReadonlySet<string>,
): void {
  let activeCallIds: string[] = [];
  for (const entry of context.messages) {
    if (entry.type !== 'model_message') continue;
    if (entry.message.role === 'user') {
      activeCallIds = [];
      continue;
    }
    if (entry.message.role !== 'assistant') continue;
    const callIds = entry.message.content.flatMap((block) =>
      block.type === 'tool_call' ? [block.callId] : [],
    );
    if (callIds.length > 0) activeCallIds = callIds;
  }
  // Same-turn author steering is projected as a trailing user message and
  // deliberately starts a new reasoning segment. With no active calls there
  // is nothing to require; retained calls must still fail closed when their
  // exact provider replay state is missing.
  if (
    activeCallIds.some(
      (callId) =>
        !replayByCallId.has(callId) && !nonReasoningCallIds.has(callId),
    )
  ) {
    throw new AgentModelDriverError(
      'Anthropic reasoning replay state is unavailable for the active tool loop.',
    );
  }
}

async function* parseSseJson(
  response: Response,
  signal: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  if (!response.body) throw new AgentModelDriverError('Anthropic stream has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        if (signal.aborted) throw abortError();
        void error;
        throw new AgentModelDriverError('Anthropic stream was interrupted.', true);
      }
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > 32 * 1024 * 1024) {
        throw new AgentModelDriverError('Anthropic stream exceeded the response limit.');
      }
      buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw invalidStream();
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw invalidStream();
          }
          yield parsed as Record<string, unknown>;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (buffer.trim()) throw invalidStream();
}

function normalizeAnthropicStopReason(value: string): AgentModelStopReason {
  switch (value) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'model_context_window_exceeded':
      return 'context_window_exceeded';
    case 'refusal':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!field || typeof field !== 'object' || Array.isArray(field)) throw invalidStream();
  return field as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string') throw invalidStream();
  return value[key];
}

function nonBlankString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentModelDriverError(`Anthropic stream has an invalid ${label}.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentModelDriverError(`Anthropic stream has an invalid ${label}.`);
  }
  return value as number;
}

function optionalNonNegativeInteger(value: unknown): number {
  return value === undefined ? 0 : nonNegativeInteger(value, 'cache usage');
}

function invalidStream(): AgentModelDriverError {
  // Invalid samples are retryable under the buffered tool-attempt lease,
  // matching the OpenAI-compatible driver's parse-retry policy.
  return new AgentModelDriverError('Anthropic returned an invalid model stream.', true);
}

function abortError(): AgentModelDriverError {
  return new AgentModelDriverError('Anthropic request was cancelled.');
}
