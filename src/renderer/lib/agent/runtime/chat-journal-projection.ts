import type { AgentChatMessage } from '../../../domain/agent-conversation';
import type { AgentRuntimeJournalEntry } from './types';

/** Mark any trailing still-streaming assistant/thinking message as finished. */
export function finalizeAgentChatStreaming(list: AgentChatMessage[]): AgentChatMessage[] {
  const last = list[list.length - 1];
  if (last && (last.kind === 'assistant' || last.kind === 'thinking') && last.streaming) {
    const copy = list.slice();
    copy[copy.length - 1] = { ...last, streaming: false };
    return copy;
  }
  return list;
}

function updateNewestTool(
  list: AgentChatMessage[],
  callId: string,
  update: (
    tool: Extract<AgentChatMessage, { kind: 'tool' }>,
  ) => Extract<AgentChatMessage, { kind: 'tool' }>,
): AgentChatMessage[] {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.kind !== 'tool' || message.id !== callId) continue;
    const copy = list.slice();
    copy[index] = update(message);
    return copy;
  }
  return list;
}

function reviewFromToolResult(
  content: string,
  entry: AgentRuntimeJournalEntry,
  callId: string,
  toolName: string,
): NonNullable<Extract<AgentChatMessage, { kind: 'tool' }>['review']> | undefined {
  try {
    const value: unknown = JSON.parse(content);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('review' in value) ||
      typeof value.review !== 'object' ||
      value.review === null ||
      !('id' in value.review) ||
      typeof value.review.id !== 'string' ||
      !('status' in value.review) ||
      typeof value.review.status !== 'string'
    ) {
      return undefined;
    }
    return {
      id: value.review.id,
      status: value.review.status,
      provenance: {
        sessionId: entry.sessionId,
        turnId: entry.turnId,
        callId,
        toolName,
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Fold one canonical runtime journal entry into the visible transcript.
 *
 * Tool cards exist from `tool_call_started`, raw arguments update on every
 * `tool_args_delta`, and completion comes only from `turn_finished`. There is
 * no synthetic assistant/result/done path.
 */
export function applyAgentChatJournalEntry(
  list: AgentChatMessage[],
  entry: AgentRuntimeJournalEntry,
): AgentChatMessage[] {
  const ev = entry.event;
  switch (ev.type) {
    case 'text_delta': {
      const last = list[list.length - 1];
      if (last?.kind === 'assistant' && last.streaming) {
        const copy = list.slice();
        copy[copy.length - 1] = { ...last, text: last.text + ev.text };
        return copy;
      }
      return [
        ...finalizeAgentChatStreaming(list),
        { kind: 'assistant', text: ev.text, streaming: true },
      ];
    }
    case 'thinking_delta': {
      const last = list[list.length - 1];
      if (ev.consolidated) {
        // One durable row per thinking run. Live, transient entries already
        // streamed this exact text into a still-streaming message, so replace
        // instead of appending; on replay it materializes the whole run. The
        // run is over either way, so finish the message here — otherwise an
        // adjacent later run would replace this one's text.
        if (last?.kind === 'thinking' && last.streaming) {
          const copy = list.slice();
          copy[copy.length - 1] = { ...last, text: ev.text, streaming: false };
          return copy;
        }
        return [
          ...finalizeAgentChatStreaming(list),
          { kind: 'thinking', text: ev.text, streaming: false },
        ];
      }
      if (last?.kind === 'thinking' && last.streaming) {
        const copy = list.slice();
        copy[copy.length - 1] = { ...last, text: last.text + ev.text };
        return copy;
      }
      return [
        ...finalizeAgentChatStreaming(list),
        { kind: 'thinking', text: ev.text, streaming: true },
      ];
    }
    case 'tool_call_started':
      return [
        ...finalizeAgentChatStreaming(list),
        {
          kind: 'tool',
          id: ev.callId,
          name: ev.name,
          inputText: '',
          phase: 'arguments',
          status: 'running',
        },
      ];
    case 'tool_args_delta':
      return updateNewestTool(list, ev.callId, (tool) => ({
        ...tool,
        inputText: `${tool.inputText ?? ''}${ev.delta}`,
        phase: 'arguments',
      }));
    case 'tool_call_ready':
      return updateNewestTool(list, ev.callId, (tool) => {
        const withoutRawInput = { ...tool };
        delete withoutRawInput.inputText;
        return {
          ...withoutRawInput,
          name: ev.name,
          input: ev.arguments,
          phase: 'ready',
        };
      });
    case 'tool_execution_started':
      return updateNewestTool(list, ev.callId, (tool) => ({
        ...tool,
        name: ev.name,
        phase: 'executing',
      }));
    case 'tool_result': {
      const review = ev.review
        ? {
            ...ev.review,
            provenance: {
              sessionId: entry.sessionId,
              turnId: entry.turnId,
              callId: ev.callId,
              toolName: ev.name,
            },
          }
        : reviewFromToolResult(ev.content, entry, ev.callId, ev.name);
      return updateNewestTool(list, ev.callId, (tool) => ({
        ...tool,
        name: ev.name,
        status: ev.ok ? 'ok' : 'error',
        result: ev.content,
        ...(review ? { review } : {}),
      }));
    }
    case 'steering_received':
      return [
        ...finalizeAgentChatStreaming(list),
        { kind: 'user', text: ev.text, at: new Date(entry.wallTimeMs).toISOString() },
      ];
    case 'user_input_received':
      return [
        ...finalizeAgentChatStreaming(list),
        {
          kind: 'user',
          text: ev.response.text,
          at: new Date(entry.wallTimeMs).toISOString(),
        },
      ];
    case 'model_iteration_completed':
    case 'commit_started':
      return finalizeAgentChatStreaming(list);
    case 'turn_finished': {
      let next: AgentChatMessage[] = [
        ...finalizeAgentChatStreaming(list),
        {
          kind: 'usage',
          inputTokens: ev.usage.inputTokens,
          outputTokens: ev.usage.outputTokens,
          cacheReadTokens: ev.usage.cacheReadTokens,
          cacheCreationTokens: ev.usage.cacheWriteTokens,
          costUsd: ev.usage.costUsd,
          turns: ev.modelIterations,
          durationMs: ev.durationMs,
          at: new Date(entry.wallTimeMs).toISOString(),
        },
      ];
      if (ev.outcome !== 'completed' && ev.outcome !== 'aborted') {
        next = [
          ...next,
          {
            kind: 'error',
            text: ev.message ?? `Agent turn ${ev.outcome}`,
          },
        ];
      }
      return next;
    }
    case 'turn_started':
    case 'model_iteration_started':
    case 'context_planned':
    case 'permission_requested':
    case 'permission_resolved':
    case 'user_input_requested':
    case 'steering_applied':
    case 'stop_after_tool_requested':
    case 'cancellation_requested':
    case 'model_usage':
    case 'completion_tool_accepted':
      return list;
  }
}
