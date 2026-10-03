import { estimateAgentContextTextTokens } from './context-planner';
import type {
  AgentModelDriver, AgentModelMessage, AgentModelRequest, AgentModelStreamEvent,
  AgentModelToolDefinition, AgentToolDefinition, AgentToolExecutionResult,
} from './types';

export const TOOL_SEARCH = 'tool_search';
export const CALL_TOOL = 'call_tool';
const CONTROL_NAMES = new Set([TOOL_SEARCH, CALL_TOOL]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A per-turn snapshot of the authorized catalog, never an intent-based lease. */
export class AgentToolDiscovery {
  readonly definitions: AgentToolDefinition[];
  readonly providerTools: AgentModelToolDefinition[];
  private readonly catalog: readonly AgentToolDefinition[];

  constructor(definitions: readonly AgentToolDefinition[]) {
    if (definitions.some((tool) => CONTROL_NAMES.has(tool.name))) {
      throw new Error('Tool discovery control names are reserved');
    }
    this.catalog = [...definitions].sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const search: AgentToolDefinition = {
      name: TOOL_SEARCH,
      access: 'read',
      description: 'Look up missing tool schemas for call_tool. Reuse schemas already in context; request related missing tools together. Use exact names from the complete directory below, or search by query; an empty query browses every tool. Results are appended to conversation context. Search again only when a needed schema is absent or has changed; omitted schemas do not mean a tool is unavailable.\nTool directory (name, access, description; no parameter schemas):\n'
        + this.catalog.map(({ name, access, description }) => JSON.stringify({ name, access, description })).join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Exact tool names from the directory. Takes precedence over query.' },
          query: { type: 'string', description: 'Search names and descriptions. Empty or omitted browses the entire catalog.' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Page size, default 5. Use nextOffset to retrieve more schemas.' },
        },
        additionalProperties: false,
      },
      validateInput: (input) => {
        if (Object.keys(input).some((key) => !['names', 'query', 'offset', 'limit'].includes(key))
          || (input.query !== undefined && typeof input.query !== 'string')
          || (input.names !== undefined && (!Array.isArray(input.names) || input.names.length < 1 || input.names.length > 20 || input.names.some((name) => typeof name !== 'string' || !name.trim())))
          || (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || (input.offset as number) < 0))
          || (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 20))) {
          return { ok: false, error: 'Use names (1–20 exact names) or query, with a nonnegative integer offset and limit 1–20.' };
        }
        return { ok: true, value: input };
      },
    };
    const call: AgentToolDefinition = {
      name: CALL_TOOL,
      access: 'read', // Valid calls are decoded to the real definition before authorization.
      description: 'Execute a tool from the directory using the exact name and arguments matching its schema returned by tool_search. This dispatches the original tool with its existing validation and permissions.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          arguments: { type: 'object', additionalProperties: true },
        },
        required: ['name', 'arguments'],
        additionalProperties: false,
      },
      validateInput: () => ({ ok: false, error: 'call_tool requires {name: an exact non-control tool name, arguments: an object}. Retrieve its schema with tool_search.' }),
    };
    this.definitions = [search, call];
    this.providerTools = this.definitions.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  search(input: Record<string, unknown>): AgentToolExecutionResult {
    const names = input.names as string[] | undefined;
    const query = String(input.query ?? '').normalize('NFKC').toLocaleLowerCase('en-US');
    const terms = query.match(/[a-z0-9_]+|\p{Script=Han}/gu) ?? [];
    const candidates = this.catalog.map((tool) => {
      const text = `${tool.name} ${tool.description}`.normalize('NFKC').toLocaleLowerCase('en-US');
      return { tool, score: (query.includes(tool.name) ? 1000 : 0) + terms.filter((term) => text.includes(term)).length };
    }).filter(({ tool, score }) => names ? names.includes(tool.name) : !query || score > 0)
      .sort((a, b) => names ? names.indexOf(a.tool.name) - names.indexOf(b.tool.name) : b.score - a.score);
    const offset = Number(input.offset ?? 0);
    const limit = Number(input.limit ?? (names ? names.length : 5));
    const selected = candidates.slice(offset, offset + limit);
    return { ok: true, data: {
      tools: selected.map(({ tool: { name, description, access, inputSchema } }) => ({ name, description, access, inputSchema })),
      total: candidates.length,
      nextOffset: offset + selected.length < candidates.length ? offset + selected.length : null,
      ...(names ? { unavailableNames: names.filter((name) => !this.catalog.some((tool) => tool.name === name)) } : {}),
    } };
  }
}

function projectMessage(message: AgentModelMessage): AgentModelMessage {
  if (message.role === 'user') return message;
  if (message.role === 'tool') return { ...message, content: message.content.map((result) =>
    CONTROL_NAMES.has(result.name) ? result : { ...result, name: CALL_TOOL }) };
  return { ...message, content: message.content.map((block) => {
    if (block.type !== 'tool_call' || CONTROL_NAMES.has(block.name)) return block;
    const args = { name: block.name, arguments: block.arguments };
    return { ...block, name: CALL_TOOL, arguments: args, rawArguments: JSON.stringify(args) };
  }) };
}

/** Reserve wire framing before compaction; counting all history is conservative. */
export function discoveryWireOverheadTokens(messages: readonly AgentModelMessage[]): number {
  return messages.reduce((total, message) => total + Math.max(0,
    estimateAgentContextTextTokens(JSON.stringify(projectMessage(message)))
      - estimateAgentContextTextTokens(JSON.stringify(message))), 0);
}

/** Wire translation only: journals, permissions and durable receipts keep real tool names. */
export async function* streamDiscoveredTools(
  driver: AgentModelDriver,
  request: AgentModelRequest,
  maxArgumentBytes: number,
): AsyncIterable<AgentModelStreamEvent> {
  const context = { ...request.context, messages: request.context.messages.map((entry) =>
    entry.type === 'model_message' ? { ...entry, message: projectMessage(entry.message) } : entry) };
  type PendingCall = { raw: string; bytes: number; overflow: boolean; frames?: AgentModelStreamEvent[] };
  const pending = new Map<string, PendingCall>();
  const queue: Array<AgentModelStreamEvent | PendingCall> = [];
  const encoder = new TextEncoder();
  for await (const event of driver.stream({ ...request, context })) {
    if (event.type === 'tool_call_start' && event.name === CALL_TOOL) {
      if (pending.has(event.callId)) throw new Error('Duplicate call_tool id');
      const call = { raw: '', bytes: 0, overflow: false };
      pending.set(event.callId, call);
      queue.push(call);
    } else if (event.type === 'tool_args_delta' && pending.has(event.callId)) {
      const call = pending.get(event.callId)!;
      call.bytes += encoder.encode(event.delta).byteLength;
      if (call.bytes > maxArgumentBytes) call.overflow = true;
      else call.raw += event.delta;
    } else if (event.type === 'tool_call_end' && pending.has(event.callId)) {
      const call = pending.get(event.callId)!;
      pending.delete(event.callId);
      let value: unknown;
      try { value = call.overflow ? null : JSON.parse(call.raw); } catch { value = null; }
      const valid = object(value) && typeof value.name === 'string' && value.name.trim().length > 0
        && !CONTROL_NAMES.has(value.name) && object(value.arguments)
        && Object.keys(value).every((key) => key === 'name' || key === 'arguments');
      const invocation = valid ? value as { name: string; arguments: Record<string, unknown> } : null;
      call.frames = [
        { type: 'tool_call_start', callId: event.callId, name: invocation?.name ?? CALL_TOOL },
        { type: 'tool_args_delta', callId: event.callId, delta: invocation ? JSON.stringify(invocation.arguments) : '{}' },
        event,
      ];
    } else {
      if (event.type === 'finish' && pending.size > 0) throw new Error('Incomplete call_tool stream');
      queue.push(event);
    }
    // Parallel provider calls may finish out of order. Preserve start order,
    // especially for writes, while bounding each buffered argument payload.
    while (queue.length > 0) {
      const next = queue[0]!;
      if ('type' in next) { queue.shift(); yield next; }
      else if (next.frames) { queue.shift(); yield* next.frames; }
      else break;
    }
  }
  if (pending.size > 0 || queue.length > 0) throw new Error('Incomplete call_tool stream');
}
