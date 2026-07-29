import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  type AgentRuntimeEvent,
  type AgentRuntimeJournalEntry,
  type AgentRuntimeRoute,
  type AgentRuntimeState,
  type AgentRuntimeToolState,
  type AgentRuntimeUsage,
} from './types';

function zeroUsage(): AgentRuntimeUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Agent journal protocol violation: ${message}`);
}

function expectedEventId(turnId: string, seq: number): string {
  return `${turnId}:${String(seq).padStart(8, '0')}`;
}

function addUsage(a: AgentRuntimeUsage, b: AgentRuntimeUsage): AgentRuntimeUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

function assertUsageValues(usage: AgentRuntimeUsage): void {
  for (const name of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
  ] as const) {
    invariant(
      Number.isSafeInteger(usage[name]) && usage[name] >= 0,
      `invalid usage ${name}=${usage[name]}`,
    );
  }
  invariant(
    Number.isFinite(usage.costUsd) && usage.costUsd >= 0,
    `invalid usage costUsd=${usage.costUsd}`,
  );
}

function sameUsage(a: AgentRuntimeUsage, b: AgentRuntimeUsage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens &&
    a.costUsd === b.costUsd
  );
}

function sameRoute(a: AgentRuntimeRoute, b: AgentRuntimeRoute): boolean {
  if (a.kind !== b.kind || a.projectId !== b.projectId) return false;
  if (a.kind === 'chat' && b.kind === 'chat') {
    return a.conversationId === b.conversationId;
  }
  if (a.kind === 'goal' && b.kind === 'goal') {
    return (
      a.goalRunId === b.goalRunId &&
      a.chapterId === b.chapterId
    );
  }
  return a.kind === 'test' && b.kind === 'test';
}

function replaceTool(
  state: AgentRuntimeState,
  callId: string,
  update: (tool: AgentRuntimeToolState) => AgentRuntimeToolState,
): AgentRuntimeState {
  const current = state.tools[callId];
  invariant(current, `unknown tool call "${callId}"`);
  return {
    ...state,
    tools: {
      ...state.tools,
      [callId]: update(current),
    },
  };
}

function assertRunning(state: AgentRuntimeState, event: AgentRuntimeEvent): void {
  invariant(state.status === 'running', `${event.type} requires a running turn`);
}

function assertActiveIteration(state: AgentRuntimeState, iteration: number): void {
  invariant(
    state.activeIteration === iteration,
    `event for iteration ${iteration} while active iteration is ${String(state.activeIteration)}`,
  );
}

function assertNoUnfinishedTools(state: AgentRuntimeState): void {
  const unfinished = state.toolOrder.filter((id) => state.tools[id]?.status !== 'completed');
  invariant(unfinished.length === 0, `terminal event has unfinished tools: ${unfinished.join(', ')}`);
}

function applyEvent(state: AgentRuntimeState, event: AgentRuntimeEvent, wallTimeMs: number) {
  switch (event.type) {
    case 'turn_started':
      invariant(state.status === 'idle', 'turn_started must be the first event');
      return {
        ...state,
        status: 'running' as const,
        prompt: event.prompt,
        startedAtMs: wallTimeMs,
      };

    case 'model_iteration_started': {
      assertRunning(state, event);
      invariant(state.activeIteration === null, 'cannot overlap model iterations');
      invariant(
        event.iteration === state.modelIterations + 1,
        `expected model iteration ${state.modelIterations + 1}, got ${event.iteration}`,
      );
      if (state.modelIterations > 0) {
        invariant(
          state.lastStopReason === 'tool_use',
          `cannot continue after ${String(state.lastStopReason)}`,
        );
      }
      assertNoUnfinishedTools(state);
      return {
        ...state,
        activeIteration: event.iteration,
        activeIterationUsageSeen: false,
        modelIterations: event.iteration,
      };
    }

    case 'text_delta':
      assertRunning(state, event);
      assertActiveIteration(state, event.iteration);
      return { ...state, assistantText: state.assistantText + event.text };

    case 'thinking_delta':
      assertRunning(state, event);
      assertActiveIteration(state, event.iteration);
      return { ...state, thinkingText: state.thinkingText + event.text };

    case 'tool_call_started': {
      assertRunning(state, event);
      assertActiveIteration(state, event.iteration);
      invariant(!state.tools[event.callId], `duplicate tool call "${event.callId}"`);
      const tool: AgentRuntimeToolState = {
        callId: event.callId,
        name: event.name,
        iteration: event.iteration,
        argumentsText: '',
        status: 'streaming',
      };
      return {
        ...state,
        toolOrder: [...state.toolOrder, event.callId],
        tools: { ...state.tools, [event.callId]: tool },
      };
    }

    case 'tool_args_delta':
      assertRunning(state, event);
      assertActiveIteration(state, event.iteration);
      return replaceTool(state, event.callId, (tool) => {
        invariant(tool.iteration === event.iteration, 'tool args crossed model iterations');
        invariant(tool.status === 'streaming', `tool args after ${tool.status}`);
        return { ...tool, argumentsText: tool.argumentsText + event.delta };
      });

    case 'tool_call_ready':
      assertRunning(state, event);
      assertActiveIteration(state, event.iteration);
      return replaceTool(state, event.callId, (tool) => {
        invariant(tool.iteration === event.iteration, 'tool ready crossed model iterations');
        invariant(tool.status === 'streaming', `tool ready after ${tool.status}`);
        invariant(tool.name === event.name, 'tool name changed while streaming');
        invariant(tool.argumentsText === event.rawArguments, 'tool argument buffer mismatch');
        return { ...tool, arguments: event.arguments, status: 'ready' };
      });

    case 'tool_execution_started':
      assertRunning(state, event);
      invariant(state.activeIteration === null, 'tool execution started before model finished');
      return replaceTool(state, event.callId, (tool) => {
        invariant(tool.status === 'ready', `tool execution started after ${tool.status}`);
        invariant(tool.name === event.name, 'tool execution name mismatch');
        return { ...tool, status: 'executing' };
      });

    case 'tool_result':
      assertRunning(state, event);
      return replaceTool(state, event.callId, (tool) => {
        invariant(tool.status !== 'completed', `duplicate result for tool "${event.callId}"`);
        invariant(tool.name === event.name, 'tool result name mismatch');
        if (event.source === 'executor') {
          invariant(tool.status === 'executing', 'executor result without execution start');
        } else {
          invariant(
            tool.status === 'streaming' ||
              tool.status === 'ready' ||
              tool.status === 'executing',
            `runtime result after ${tool.status}`,
          );
        }
        return {
          ...tool,
          status: 'completed',
          result: {
            ok: event.ok,
            content: event.content,
            source: event.source,
            ...(event.errorCode ? { errorCode: event.errorCode } : {}),
          },
        };
      });

    case 'model_usage':
      assertRunning(state, event);
      assertActiveIteration(state, event.iteration);
      invariant(!state.activeIterationUsageSeen, 'duplicate usage for model iteration');
      assertUsageValues(event.usage);
      return {
        ...state,
        activeIterationUsageSeen: true,
        usage: addUsage(state.usage, event.usage),
      };

    case 'model_iteration_completed': {
      assertRunning(state, event);
      assertActiveIteration(state, event.iteration);
      invariant(
        state.toolOrder.every((id) => {
          const tool = state.tools[id];
          return tool.iteration !== event.iteration || tool.status !== 'streaming';
        }),
        'model iteration completed with partial tool arguments',
      );
      const toolCallCount = state.toolOrder.filter(
        (id) => state.tools[id]?.iteration === event.iteration,
      ).length;
      if (event.stopReason !== 'unknown') {
        invariant(state.activeIterationUsageSeen, 'model iteration completed without usage');
      }
      if (event.stopReason === 'tool_use') {
        invariant(toolCallCount > 0, 'tool_use stop reason requires at least one tool call');
      } else if (event.stopReason !== 'unknown') {
        invariant(toolCallCount === 0, `${event.stopReason} stop reason cannot carry tool calls`);
      }
      return {
        ...state,
        activeIteration: null,
        activeIterationUsageSeen: false,
        modelIterationsWithUsage:
          state.modelIterationsWithUsage + (state.activeIterationUsageSeen ? 1 : 0),
        lastStopReason: event.stopReason,
      };
    }

    case 'turn_finished': {
      assertRunning(state, event);
      assertUsageValues(event.usage);
      invariant(
        Number.isFinite(event.durationMs) && event.durationMs >= 0,
        `invalid terminal durationMs=${event.durationMs}`,
      );
      invariant(state.activeIteration === null, 'turn finished before model iteration was closed');
      assertNoUnfinishedTools(state);
      invariant(event.modelIterations === state.modelIterations, 'terminal iteration mismatch');
      invariant(sameUsage(event.usage, state.usage), 'terminal usage mismatch');
      if (event.outcome === 'completed') {
        invariant(!event.failureCode, 'completed turn cannot carry a failure code');
        invariant(state.modelIterations > 0, 'completed turn requires a model iteration');
        invariant(
          state.modelIterationsWithUsage === state.modelIterations,
          'completed turn has a model iteration without usage',
        );
        invariant(state.lastStopReason === 'end_turn', 'completed turn requires end_turn');
      } else if (event.outcome === 'aborted') {
        invariant(!event.failureCode, 'aborted turn cannot carry a failure code');
      } else {
        invariant(Boolean(event.failureCode), `${event.outcome} turn requires a failure code`);
      }
      return {
        ...state,
        status: event.outcome,
        endedAtMs: wallTimeMs,
        terminal: event,
      };
    }
  }
}

export function createAgentRuntimeState(
  sessionId: string,
  turnId: string,
  route: AgentRuntimeRoute,
): AgentRuntimeState {
  invariant(sessionId.length > 0, 'sessionId is required');
  invariant(turnId.length > 0, 'turnId is required');
  return {
    sessionId,
    turnId,
    route,
    status: 'idle',
    lastSeq: 0,
    lastEventId: null,
    journalEntries: 0,
    prompt: null,
    startedAtMs: null,
    endedAtMs: null,
    activeIteration: null,
    activeIterationUsageSeen: false,
    modelIterations: 0,
    modelIterationsWithUsage: 0,
    lastStopReason: null,
    assistantText: '',
    thinkingText: '',
    toolOrder: [],
    tools: {},
    usage: zeroUsage(),
    terminal: null,
  };
}

/** Pure, strict journal reducer used identically for live folding and replay. */
export function reduceAgentRuntimeJournal(
  state: AgentRuntimeState,
  entry: AgentRuntimeJournalEntry,
): AgentRuntimeState {
  invariant(
    entry.schemaVersion === AGENT_RUNTIME_SCHEMA_VERSION,
    `unsupported schema version ${entry.schemaVersion}`,
  );
  invariant(entry.sessionId === state.sessionId, 'sessionId changed inside journal');
  invariant(entry.turnId === state.turnId, 'turnId changed inside journal');
  invariant(sameRoute(entry.route, state.route), 'route changed inside journal');
  invariant(entry.seq === state.lastSeq + 1, `expected seq ${state.lastSeq + 1}, got ${entry.seq}`);
  invariant(Number.isFinite(entry.wallTimeMs), `invalid wallTimeMs=${entry.wallTimeMs}`);
  invariant(
    entry.eventId === expectedEventId(entry.turnId, entry.seq),
    `unexpected eventId "${entry.eventId}"`,
  );
  invariant(state.terminal === null, `event ${entry.event.type} arrived after terminal event`);

  const next = applyEvent(state, entry.event, entry.wallTimeMs);
  return {
    ...next,
    lastSeq: entry.seq,
    lastEventId: entry.eventId,
    journalEntries: state.journalEntries + 1,
  };
}

export function replayAgentRuntimeJournal(
  entries: readonly AgentRuntimeJournalEntry[],
): AgentRuntimeState {
  invariant(entries.length > 0, 'cannot replay an empty journal');
  let state = createAgentRuntimeState(entries[0].sessionId, entries[0].turnId, entries[0].route);
  for (const entry of entries) state = reduceAgentRuntimeJournal(state, entry);
  return state;
}

export function agentRuntimeEventId(turnId: string, seq: number): string {
  return expectedEventId(turnId, seq);
}
