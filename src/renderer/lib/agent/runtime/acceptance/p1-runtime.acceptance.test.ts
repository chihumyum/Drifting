import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_READ_TOOLS } from '../../tool-registry';
import {
  DriftingReadToolRuntime,
  type TruncatedAgentToolResult,
} from '../drifting-read-tool-runtime';
import { replayAgentRuntimeJournal } from '../reducer';
import { AgentRuntime } from '../runtime';
import { ScriptedFakeDriver, type ScriptedDriverStep } from '../testing';
import type {
  AgentModelDriver,
  AgentModelRequest,
  AgentModelStreamEvent,
  AgentRuntimeContext,
  AgentRuntimeJournalEntry,
  AgentToolExecutionRequest,
} from '../types';

const toolHandlerMocks = vi.hoisted(() => ({
  getActiveAgentToolContext: vi.fn(),
  runAgentTool: vi.fn(),
}));

vi.mock('../../tool-handlers', () => ({
  getActiveAgentToolContext: toolHandlerMocks.getActiveAgentToolContext,
  runAgentTool: toolHandlerMocks.runAgentTool,
}));

const PROJECT_ID = 'p1-acceptance-project';
const ROUTE = {
  kind: 'chat',
  projectId: PROJECT_ID,
  conversationId: 'p1-acceptance-conversation',
} as const;
const ZERO_COST_USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
} as const;

class ConcurrentIsolationDriver implements AgentModelDriver {
  readonly id = 'p1-concurrent-isolation';
  readonly requestKeys = new Set<string>();
  activeStreams = 0;
  maxActiveStreams = 0;

  async *stream(
    request: AgentModelRequest,
  ): AsyncIterable<AgentModelStreamEvent> {
    const key = `${request.sessionId}/${request.turnId}`;
    const latestMessage = request.messages[request.messages.length - 1];
    if (this.requestKeys.has(key)) {
      throw new Error(`duplicate request key ${key}`);
    }
    this.requestKeys.add(key);
    this.activeStreams += 1;
    this.maxActiveStreams = Math.max(
      this.maxActiveStreams,
      this.activeStreams,
    );

    try {
      // Two yields force streams from different sessions to overlap.
      await Promise.resolve();
      await Promise.resolve();
      yield {
        type: 'text_delta',
        text: `answer:${key}:${latestMessage?.role === 'user' ? latestMessage.content : ''}`,
      };
      yield { type: 'usage', usage: ZERO_COST_USAGE };
      yield { type: 'finish', reason: 'end_turn' };
    } finally {
      this.activeStreams -= 1;
    }
  }
}

class TenThousandEventDriver implements AgentModelDriver {
  readonly id = 'p1-10k-journal';

  async *stream(): AsyncIterable<AgentModelStreamEvent> {
    // turn_started + model_iteration_started + 9,995 deltas + usage
    // + model_iteration_completed + turn_finished = exactly 10,000 entries.
    for (let index = 0; index < 9_995; index += 1) {
      yield { type: 'text_delta', text: String(index % 10) };
    }
    yield { type: 'usage', usage: ZERO_COST_USAGE };
    yield { type: 'finish', reason: 'end_turn' };
  }
}

const VALID_ARGUMENTS_BY_TOOL: Record<string, Record<string, unknown>> = {
  get_overview: {},
  get_project_brief: {},
  list_nodes: {},
  list_elements: {},
  read_element: { element: '林😀' },
  get_element_patches: { element: '林默' },
  read_node: { node: '第一章', prose: false },
  read_block: { node: '第一章', blockId: 'block-1' },
  lookup_block: { node: '第一章', ordinal: 1 },
  get_storyline: { storyline: '主线' },
  get_entity_relations: { kind: 'element', name: '林默' },
  where_does_entity_appear: { kind: 'element', name: '林默' },
  search_prose: { query: '雨夜😀', limit: 3 },
  search_project: { query: '雨夜' },
  list_comments: { onlyTodos: true },
  list_memory: {},
  list_materials: {},
  read_material: { material: '世界观素材' },
};

const EMPTY_ARGUMENT_TOOLS = new Set([
  'get_overview',
  'get_project_brief',
  'list_nodes',
  'list_elements',
  'list_comments',
  'list_memory',
  'list_materials',
]);

function toolCallSteps(
  callId: string,
  name: string,
  argumentsJson: string,
): ScriptedDriverStep[] {
  return [
    { op: 'emit', event: { type: 'tool_call_start', callId, name } },
    {
      op: 'emit',
      event: {
        type: 'tool_args_delta',
        callId,
        delta: argumentsJson,
      },
    },
    { op: 'emit', event: { type: 'tool_call_end', callId } },
  ];
}

function runtimeContext(): AgentRuntimeContext {
  return { route: ROUTE };
}

function executionRequest(
  overrides: Partial<AgentToolExecutionRequest> = {},
): AgentToolExecutionRequest {
  return {
    sessionId: 'oversized-session',
    turnId: 'oversized-turn',
    callId: 'oversized-call',
    idempotencyKey: 'oversized-session:oversized-turn:oversized-call',
    name: 'get_project_brief',
    arguments: {},
    access: 'read',
    context: runtimeContext(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function toolResultEntries(
  entries: readonly AgentRuntimeJournalEntry[],
): Array<
  AgentRuntimeJournalEntry & {
    event: Extract<
      AgentRuntimeJournalEntry['event'],
      { type: 'tool_result' }
    >;
  }
> {
  return entries.filter(
    (
      entry,
    ): entry is AgentRuntimeJournalEntry & {
      event: Extract<
        AgentRuntimeJournalEntry['event'],
        { type: 'tool_result' }
      >;
    } => entry.event.type === 'tool_result',
  );
}

describe('P1 deterministic Agent runtime acceptance', () => {
  beforeEach(() => {
    toolHandlerMocks.getActiveAgentToolContext.mockReset();
    toolHandlerMocks.runAgentTool.mockReset();
    toolHandlerMocks.getActiveAgentToolContext.mockReturnValue({
      projectId: PROJECT_ID,
      write: {},
    });
  });

  it('isolates 50 concurrent sessions across 20 turns each with zero crosstalk', async () => {
    const driver = new ConcurrentIsolationDriver();
    const runtime = new AgentRuntime({ driver });
    const sessionCount = 50;
    const turnsPerSession = 20;

    const sessionResults = await Promise.all(
      Array.from({ length: sessionCount }, async (_, sessionIndex) => {
        const sessionId = `session-${String(sessionIndex).padStart(2, '0')}`;
        const results = [];
        for (let turnIndex = 0; turnIndex < turnsPerSession; turnIndex += 1) {
          const turnId = `turn-${String(turnIndex).padStart(2, '0')}`;
          const prompt = `prompt:${sessionId}/${turnId}`;
          results.push(
            await runtime.runTurn({
              sessionId,
              turnId,
              route: {
                kind: 'chat',
                projectId: PROJECT_ID,
                conversationId: sessionId,
              },
              prompt,
            }),
          );
        }
        return results;
      }),
    );

    const flatResults = sessionResults.flat();
    expect(flatResults).toHaveLength(sessionCount * turnsPerSession);
    expect(driver.requestKeys).toHaveLength(sessionCount * turnsPerSession);
    expect(driver.maxActiveStreams).toBe(sessionCount);
    expect(driver.activeStreams).toBe(0);

    const observedJournalKeys = new Set<string>();
    for (const result of flatResults) {
      const { sessionId, turnId } = result.state;
      const key = `${sessionId}/${turnId}`;
      observedJournalKeys.add(key);
      expect(result.state.status).toBe('completed');
      expect(result.state.prompt).toBe(`prompt:${key}`);
      expect(result.state.assistantText).toBe(
        `answer:${key}:prompt:${key}`,
      );
      expect(result.entries.every((entry) => entry.sessionId === sessionId)).toBe(
        true,
      );
      expect(result.entries.every((entry) => entry.turnId === turnId)).toBe(
        true,
      );
      expect(result.entries.map((entry) => entry.seq)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
    }
    expect(observedJournalKeys).toHaveLength(sessionCount * turnsPerSession);
  }, 30_000);

  it('replays a 10k-entry journal to the exact live state without seq gaps or duplicates', async () => {
    const result = await new AgentRuntime({
      driver: new TenThousandEventDriver(),
    }).runTurn({
      sessionId: 'journal-session',
      turnId: 'journal-turn',
      route: { kind: 'test', projectId: PROJECT_ID },
      prompt: '10k replay',
    });

    expect(result.entries).toHaveLength(10_000);
    expect(result.state.journalEntries).toBe(10_000);
    expect(result.state.lastSeq).toBe(10_000);
    expect(result.state.assistantText).toHaveLength(9_995);

    const sequenceNumbers = result.entries.map((entry) => entry.seq);
    expect(sequenceNumbers.every((seq, index) => seq === index + 1)).toBe(true);
    expect(new Set(sequenceNumbers)).toHaveLength(10_000);
    expect(new Set(result.entries.map((entry) => entry.eventId))).toHaveLength(
      10_000,
    );

    const portableJournal = JSON.parse(
      JSON.stringify(result.entries),
    ) as AgentRuntimeJournalEntry[];
    expect(replayAgentRuntimeJournal(portableJournal)).toEqual(result.state);
  }, 30_000);

  it('covers normal, empty, and invalid schemas for every registered read tool and never executes invalid calls', async () => {
    const tools = new DriftingReadToolRuntime();
    const definitions = tools
      .listDefinitions(runtimeContext())
      .filter((definition) => definition.name !== 'read_tool_result');

    expect(definitions.map((definition) => definition.name)).toEqual(
      AGENT_READ_TOOLS.map((tool) => tool.name),
    );
    expect(Object.keys(VALID_ARGUMENTS_BY_TOOL).sort()).toEqual(
      definitions.map((definition) => definition.name).sort(),
    );

    for (const definition of definitions) {
      expect(
        definition.validateInput(VALID_ARGUMENTS_BY_TOOL[definition.name]),
        `${definition.name}: normal args`,
      ).toEqual(
        expect.objectContaining({
          ok: true,
          value: VALID_ARGUMENTS_BY_TOOL[definition.name],
        }),
      );

      expect(
        definition.validateInput({}),
        `${definition.name}: empty args`,
      ).toEqual(
        expect.objectContaining({
          ok: EMPTY_ARGUMENT_TOOLS.has(definition.name),
        }),
      );

      expect(
        definition.validateInput({ __unexpected: true }),
        `${definition.name}: invalid args`,
      ).toEqual(expect.objectContaining({ ok: false }));
    }

    const invalidToolSteps = definitions.flatMap((definition, index) =>
      toolCallSteps(
        `invalid-${String(index).padStart(2, '0')}`,
        definition.name,
        '{"__unexpected":true}',
      ),
    );
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...invalidToolSteps,
            { op: 'emit', event: { type: 'usage', usage: ZERO_COST_USAGE } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'rejected' } },
            { op: 'emit', event: { type: 'usage', usage: ZERO_COST_USAGE } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const result = await new AgentRuntime({ driver, tools }).runTurn({
      sessionId: 'invalid-schema-session',
      turnId: 'invalid-schema-turn',
      route: ROUTE,
      prompt: 'reject every invalid call',
    });

    expect(result.state.status).toBe('completed');
    expect(toolHandlerMocks.runAgentTool).not.toHaveBeenCalled();
    const invalidResults = toolResultEntries(result.entries);
    expect(invalidResults).toHaveLength(definitions.length);
    expect(
      invalidResults.every(
        (entry) =>
          entry.event.ok === false &&
          entry.event.source === 'runtime' &&
          entry.event.errorCode === 'INVALID_TOOL_ARGUMENTS',
      ),
    ).toBe(true);
  });

  it('returns explicit truncation metadata and reuses resultRef for deterministic rereads', async () => {
    const tools = new DriftingReadToolRuntime();
    const source = '序😀'.repeat(6_001);
    const sourceCodePoints = [...source];
    toolHandlerMocks.runAgentTool.mockResolvedValue(source);

    const first = await tools.execute(executionRequest());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const truncated = first.data as TruncatedAgentToolResult;

    expect(truncated).toEqual(
      expect.objectContaining({
        truncated: true,
        resultRef:
          'agent-result:oversized-session:oversized-turn:oversized-call',
        totalChars: sourceCodePoints.length,
        reread: {
          tool: 'read_tool_result',
          arguments: {
            resultRef:
              'agent-result:oversized-session:oversized-turn:oversized-call',
            offset: 4_000,
            limit: 12_000,
          },
        },
      }),
    );
    expect([...truncated.preview]).toHaveLength(4_000);

    const reread = await tools.execute(
      executionRequest({
        callId: 'reread-call',
        name: truncated.reread.tool,
        arguments: {
          ...truncated.reread.arguments,
          limit: 17,
        },
      }),
    );
    expect(reread.ok).toBe(true);
    if (!reread.ok) throw new Error(reread.error);
    expect(reread.data).toEqual(
      expect.objectContaining({
        resultRef: truncated.resultRef,
        sourceTool: 'get_project_brief',
        offset: 4_000,
        nextOffset: 4_017,
        totalChars: sourceCodePoints.length,
        content: sourceCodePoints.slice(4_000, 4_017).join(''),
        truncated: true,
      }),
    );
    expect(toolHandlerMocks.runAgentTool).toHaveBeenCalledTimes(1);
  });
});
