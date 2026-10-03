import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from './runtime';
import { CompositeAgentToolRuntime, DynamicAgentToolRegistry } from './dynamic-tool-runtime';
import { AgentToolDiscovery, discoveryWireOverheadTokens } from './tool-discovery';
import type { AgentModelDriver, AgentModelRequest, AgentModelStreamEvent, AgentRuntimeRunInput, AgentToolDefinition, AgentToolRuntime } from './types';

const schema = { type: 'object', properties: { element: { type: 'string' }, replacement: { type: 'string' } }, required: ['element'], additionalProperties: false };
function definition(name: string, access: 'read' | 'write' = 'read'): AgentToolDefinition {
  return { name, access, description: `Read or update an element using ${name}.`, inputSchema: schema,
    validateInput: (args) => typeof args.element === 'string' ? { ok: true, value: args } : { ok: false, error: 'element is required' } };
}
const catalog = [definition('read_element'), definition('revise_element', 'write'), definition('read_tool_result')];
const input: AgentRuntimeRunInput = { sessionId: 'session', turnId: 'turn', route: { kind: 'test' }, prompt: '继续改', systemPrompt: 'Follow the author.' };
const usage: AgentModelStreamEvent = { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } };
const done = (): AgentModelStreamEvent[] => [{ type: 'text_delta', text: 'Done.' }, usage, { type: 'finish', reason: 'end_turn' }];
function call(name: string, args: unknown, id = name): AgentModelStreamEvent[] {
  return [{ type: 'tool_call_start', callId: id, name }, { type: 'tool_args_delta', callId: id, delta: JSON.stringify(args) }, { type: 'tool_call_end', callId: id }, usage, { type: 'finish', reason: 'tool_use' }];
}
function harness(script: AgentModelStreamEvent[][], definitions = catalog, denyWrites = false) {
  const requests: AgentModelRequest[] = [];
  const driver: AgentModelDriver = { id: 'discovery-test', async *stream(request) { requests.push(request); yield* script[requests.length - 1] ?? done(); } };
  const execute = vi.fn<AgentToolRuntime['execute']>(async () => ({ ok: true, data: 'saved' }));
  const decide = vi.fn(({ access }: { access: 'read' | 'write' }) => denyWrites && access === 'write'
    ? { decision: 'deny' as const, reason: 'write denied' } : { decision: 'allow' as const });
  const runtime = new AgentRuntime({ driver, tools: { listDefinitions: () => definitions, execute },
    toolDiscovery: () => true, permissionPolicy: { decide } });
  return { runtime, requests, execute, decide };
}

describe('Model-directed tool discovery', () => {
  it('executes named and empty-query discovery locally through the composite runtime read scheduler', async () => {
    const names = ['get_project_overview', 'list_author_rules', 'list_elements', 'list_chapters', 'read_task_plan'];
    const definitions = names.map((name) => definition(name));
    const execute = vi.fn<AgentToolRuntime['execute']>(async () => ({ ok: true, data: 'Synthetic overview' }));
    const requests: AgentModelRequest[] = [];
    const script = [
      call('tool_search', { names, limit: 5 }, 'named-search'),
      call('tool_search', { query: '', limit: 1 }, 'browse-search'),
      call('call_tool', { name: names[0], arguments: { element: 'Synthetic project' } }, 'overview'),
      done(),
    ];
    const runtime = new AgentRuntime({
      driver: { id: 'composite-discovery-regression', async *stream(request) {
        requests.push(request);
        yield* script[requests.length - 1] ?? done();
      } },
      tools: new CompositeAgentToolRuntime([{ listDefinitions: () => definitions, execute }], new DynamicAgentToolRegistry()),
      toolDiscovery: () => true,
    });
    const result = await runtime.runTurn(input);
    const results = result.messages.flatMap((message) => message.role === 'tool' ? message.content : []);
    expect(result.state.status).toBe('completed');
    expect(results.map(({ name, ok }) => ({ name, ok }))).toEqual([
      { name: 'tool_search', ok: true }, { name: 'tool_search', ok: true }, { name: names[0], ok: true },
    ]);
    expect(JSON.parse(results[0]!.content)).toMatchObject({ tools: names.map((name) => ({ name, inputSchema: schema })), total: 5 });
    expect(JSON.parse(results[1]!.content)).toMatchObject({ total: 5, nextOffset: 1 });
    expect(execute.mock.calls.map(([request]) => request.name)).toEqual([names[0]]);
    expect(requests.every((request) => JSON.stringify(request.tools) === JSON.stringify(requests[0]!.tools))).toBe(true);
  });

  it('keeps a complete directory and fixed tools while schemas arrive only in tool results', async () => {
    const h = harness([
      call('tool_search', { names: ['read_element', 'revise_element'] }),
      call('call_tool', { name: 'read_element', arguments: { element: 'Synthetic character' } }, 'read'),
      call('call_tool', { name: 'revise_element', arguments: { element: 'Synthetic character', replacement: 'New setting' } }, 'write'), done(),
    ]);
    const result = await h.runtime.runTurn(input);
    expect(result.state.status).toBe('completed');
    expect(h.requests).toHaveLength(4);
    const front = JSON.stringify(h.requests[0]!.tools);
    expect(h.requests.every((request) => JSON.stringify(request.tools) === front)).toBe(true);
    expect(h.requests[0]!.tools.map((tool) => tool.name)).toEqual(['tool_search', 'call_tool']);
    expect(front).toContain('revise_element');
    expect(front).not.toContain('replacement');
    expect(JSON.stringify(h.requests[0]!.context)).not.toContain('replacement');
    expect(JSON.stringify(h.requests[1]!.context)).toContain('replacement');
    expect(h.execute.mock.calls.map(([request]) => request.name)).toEqual(['read_element', 'revise_element']);
    expect(h.decide.mock.calls.map(([request]) => request.access)).toEqual(['read', 'write']);
    expect(result.messages.flatMap((message) => message.role === 'tool' ? message.content.map((item) => item.name) : [])).toEqual(['tool_search', 'read_element', 'revise_element']);
    expect(result.completedContextCheckpoint).toBeDefined();
    expect(discoveryWireOverheadTokens(result.messages)).toBeGreaterThan(0);
    // Provider history uses the same fixed dispatch identity; durable history stays semantic.
    const providerHistory = h.requests[3]!.context.messages.flatMap((entry) => entry.type === 'model_message' && entry.message.role === 'assistant' ? entry.message.content : []);
    expect(providerHistory).toContainEqual(expect.objectContaining({ name: 'call_tool', arguments: { name: 'revise_element', arguments: { element: 'Synthetic character', replacement: 'New setting' } } }));
  });

  it('retains the same directory across vague followups and restored history', async () => {
    const h = harness([call('tool_search', { names: ['read_element', 'revise_element'] }), done(), done()]);
    const previous = await h.runtime.runTurn(input);
    const resumed = await h.runtime.runTurn({ ...input, turnId: 'second', prompt: '我觉得应该有工具。', history: previous.messages });
    expect(resumed.state.status).toBe('completed');
    expect(h.requests[2]!.tools).toEqual(h.requests[0]!.tools);
    expect(JSON.stringify(h.requests[2]!.context)).toContain('replacement');
  });

  it('discovers tools beyond the old selection cap and paginates every schema', () => {
    const discovery = new AgentToolDiscovery(Array.from({ length: 140 }, (_, index) => definition(`mcp__fixture__tool_${index}`)));
    expect(discovery.providerTools[0]!.description).toContain('mcp__fixture__tool_139');
    expect(discovery.search({ names: ['mcp__fixture__tool_139'] })).toMatchObject({ ok: true, data: { tools: [{ name: 'mcp__fixture__tool_139', inputSchema: schema }], nextOffset: null } });
    expect(discovery.search({ offset: 120, limit: 20 })).toMatchObject({ ok: true, data: { total: 140, nextOffset: null } });
    expect(discovery.search({ query: '', limit: 1 })).toMatchObject({ ok: true, data: { total: 140, nextOffset: 1 } });
  });

  it('filters the directory, search results and dispatcher for read-only turns', async () => {
    const h = harness([call('tool_search', { names: ['revise_element'] }), call('call_tool', { name: 'revise_element', arguments: { element: 'Synthetic' } }), done()]);
    const result = await h.runtime.runTurn({ ...input, toolAccess: 'read_only' });
    expect(result.state.status).toBe('completed');
    expect(h.requests[0]!.tools[0]!.description).not.toContain('revise_element');
    expect(h.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(h.requests[1]!.context)).toContain('unavailableNames');
    expect(JSON.stringify(h.requests[2]!.context)).toContain('Unknown tool');
  });

  it('authorizes the real write and never grants authority through the read-only dispatcher', async () => {
    const h = harness([call('call_tool', { name: 'revise_element', arguments: { element: 'Synthetic' } }), done()], catalog, true);
    const result = await h.runtime.runTurn(input);
    expect(result.state.status).toBe('completed');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.decide).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'revise_element', access: 'write', arguments: { element: 'Synthetic' } }));
  });

  it.each([null, [], { name: 'tool_search', arguments: {} }, { name: 'read_element', arguments: [] }, { name: 'read_element', arguments: {}, extra: true }])('rejects malformed dispatcher arguments without executing (%j)', async (args) => {
    const h = harness([call('call_tool', args), done()]);
    expect((await h.runtime.runTurn(input)).state.status).toBe('completed');
    expect(h.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(h.requests[1]!.context)).toContain('Invalid arguments');
  });

  it('keeps input validation and repair on the original tool without changing tools', async () => {
    const h = harness([call('call_tool', { name: 'revise_element', arguments: {} }, 'invalid'), call('tool_search', { names: ['revise_element'] }), call('call_tool', { name: 'revise_element', arguments: { element: 'Synthetic' } }, 'fixed'), done()]);
    expect((await h.runtime.runTurn(input)).state.status).toBe('completed');
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.requests[1]!.context)).toContain('element is required');
    expect(h.requests.every((request) => JSON.stringify(request.tools) === JSON.stringify(h.requests[0]!.tools))).toBe(true);
  });

  it('keeps the prefix during the final synthesis boundary and disables invocation', async () => {
    const h = harness([call('tool_search', { names: ['read_element'] }), done()]);
    const result = await h.runtime.runTurn({ ...input, limits: { maxModelIterations: 2 } });
    expect(result.state.status).toBe('completed');
    expect(h.requests[1]!.toolChoice).toBe('none');
    expect(h.requests[1]!.tools).toEqual(h.requests[0]!.tools);
    expect(h.requests[1]!.context.systemPrompt).toBe(h.requests[0]!.context.systemPrompt);
  });

  it('preserves provider start order when parallel dispatches finish out of order', async () => {
    const events: AgentModelStreamEvent[] = [
      { type: 'tool_call_start', callId: 'first', name: 'call_tool' },
      { type: 'tool_call_start', callId: 'second', name: 'call_tool' },
      { type: 'tool_args_delta', callId: 'second', delta: JSON.stringify({ name: 'revise_element', arguments: { element: 'Second' } }) },
      { type: 'tool_call_end', callId: 'second' },
      { type: 'tool_args_delta', callId: 'first', delta: JSON.stringify({ name: 'revise_element', arguments: { element: 'First' } }) },
      { type: 'tool_call_end', callId: 'first' }, usage, { type: 'finish', reason: 'tool_use' },
    ];
    const h = harness([events, done()]);
    expect((await h.runtime.runTurn(input)).state.status).toBe('completed');
    expect(h.execute.mock.calls.map(([request]) => request.arguments.element)).toEqual(['First', 'Second']);
  });

  it('bounds argument buffering and rejects incomplete streams before dispatch', async () => {
    const h = harness([call('call_tool', { name: 'revise_element', arguments: { element: 'x'.repeat(500) } }), done()]);
    expect((await h.runtime.runTurn({ ...input, limits: { maxToolArgumentBytes: 128 } })).state.status).toBe('completed');
    expect(h.execute).not.toHaveBeenCalled();
    const broken = harness([[{ type: 'tool_call_start', callId: 'broken', name: 'call_tool' }, { type: 'finish', reason: 'tool_use' }]]);
    expect((await broken.runtime.runTurn(input)).state.status).toBe('failed');
    expect(broken.execute).not.toHaveBeenCalled();
  });

  it('does not change full-schema mode at synthesis either', async () => {
    const requests: AgentModelRequest[] = [];
    const driver: AgentModelDriver = { id: 'full-schema', async *stream(request) {
      requests.push(request);
      yield* requests.length === 1 ? call('read_element', { element: 'Synthetic' }) : done();
    } };
    const runtime = new AgentRuntime({ driver, toolDiscovery: () => false, tools: { listDefinitions: () => catalog, execute: async () => ({ ok: true, data: 'Read' }) } });
    expect((await runtime.runTurn({ ...input, limits: { maxModelIterations: 2 } })).state.status).toBe('completed');
    expect(requests[1]!.tools).toEqual(requests[0]!.tools);
    expect(requests[1]!.toolChoice).toBe('none');
  });

  it('can switch to full schemas and back without invalidating discovered history', async () => {
    let enabled = true;
    const requests: AgentModelRequest[] = [];
    const driver: AgentModelDriver = { id: 'mode-switch', async *stream(request) {
      requests.push(request);
      yield* requests.length === 1 ? call('tool_search', { names: ['read_element'] }) : done();
    } };
    const runtime = new AgentRuntime({ driver, toolDiscovery: () => enabled, tools: { listDefinitions: () => catalog, execute: async () => ({ ok: true, data: 'Read' }) } });
    const first = await runtime.runTurn(input);
    enabled = false;
    const second = await runtime.runTurn({ ...input, turnId: 'full', history: first.messages });
    expect(second.state.status, JSON.stringify(second.state.terminal)).toBe('completed');
    expect(requests[2]!.tools.map((tool) => tool.name)).toEqual(catalog.map((tool) => tool.name));
    enabled = true;
    const third = await runtime.runTurn({ ...input, turnId: 'discovery', history: second.messages });
    expect(third.state.status).toBe('completed');
    expect(requests[3]!.tools).toEqual(requests[0]!.tools);
  });
});
