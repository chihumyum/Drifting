import { AgentChatTranscript } from '../../../domain/agent-chat-transcript';
import type { AgentChatMessage } from '../../../domain/agent-conversation';
import type { AgentRuntimeJournalEntry } from './types';

interface MessageOps<T> {
  length(list: T): number;
  findLastIndex(list: T, predicate: (message: AgentChatMessage) => boolean): number;
  get(list: T, index: number): AgentChatMessage | undefined;
  replace(list: T, index: number, message: AgentChatMessage): T;
  append(list: T, ...messages: AgentChatMessage[]): T;
}
const arrayOps: MessageOps<AgentChatMessage[]> = {
  length: list => list.length, get: (list, index) => list[index],
  findLastIndex: (list, predicate) => { for (let index = list.length - 1; index >= 0; index--) if (predicate(list[index])) return index; return -1; },
  replace: (list, index, message) => { const copy = list.slice(); copy[index] = message; return copy; },
  append: (list, ...messages) => [...list, ...messages],
};
const transcriptOps: MessageOps<AgentChatTranscript> = {
  length: list => list.length, get: (list, index) => list.at(index),
  findLastIndex: (list, predicate) => list.findLastIndex(predicate),
  replace: (list, index, message) => list.replace(index, message),
  append: (list, ...messages) => list.append(...messages),
};

export const finalizeAgentChatStreaming = (list: AgentChatMessage[]) => finalize(list, arrayOps);
export const finalizeAgentChatTranscript = (list: AgentChatTranscript) => finalize(list, transcriptOps);
export const applyAgentChatJournalEntry = (list: AgentChatMessage[], entry: AgentRuntimeJournalEntry) => fold(list, entry, arrayOps);
export const applyAgentChatTranscriptEntry = (list: AgentChatTranscript, entry: AgentRuntimeJournalEntry) => fold(list, entry, transcriptOps);

/** Mark any trailing still-streaming assistant/thinking message as finished. */
function finalize<T>(list: T, ops: MessageOps<T>): T {
  const last = ops.get(list, ops.length(list) - 1);
  if (last && (last.kind === 'assistant' || last.kind === 'thinking') && last.streaming) {
    return ops.replace(list, ops.length(list) - 1, { ...last, streaming: false });
  }
  return list;
}

function updateNewestTool<T>(
  list: T,
  callId: string,
  update: (
    tool: Extract<AgentChatMessage, { kind: 'tool' }>,
  ) => Extract<AgentChatMessage, { kind: 'tool' }>,
  ops: MessageOps<T>,
): T {
  const index = ops.findLastIndex(list, message => message.kind === 'tool' && message.id === callId);
  const message = ops.get(list, index);
  return message?.kind === 'tool' ? ops.replace(list, index, update(message)) : list;
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
function fold<T>(list: T, entry: AgentRuntimeJournalEntry, ops: MessageOps<T>): T {
  const ev = entry.event;
  switch (ev.type) {
    case 'text_delta': {
      const last = ops.get(list, ops.length(list) - 1);
      if (last?.kind === 'assistant' && last.streaming) {
        return ops.replace(list, ops.length(list) - 1, { ...last, text: last.text + ev.text });
      }
      return ops.append(finalize(list, ops),
        { kind: 'assistant', text: ev.text, streaming: true },
      );
    }
    case 'thinking_delta': {
      const last = ops.get(list, ops.length(list) - 1);
      if (ev.consolidated) {
        // One durable row per thinking run. Live, transient entries already
        // streamed this exact text into a still-streaming message, so replace
        // instead of appending; on replay it materializes the whole run. The
        // run is over either way, so finish the message here — otherwise an
        // adjacent later run would replace this one's text.
        if (last?.kind === 'thinking' && last.streaming) {
          return ops.replace(list, ops.length(list) - 1, { ...last, text: ev.text, streaming: false });
        }
        return ops.append(finalize(list, ops),
          { kind: 'thinking', text: ev.text, streaming: false },
        );
      }
      if (last?.kind === 'thinking' && last.streaming) {
        return ops.replace(list, ops.length(list) - 1, { ...last, text: last.text + ev.text });
      }
      return ops.append(finalize(list, ops),
        { kind: 'thinking', text: ev.text, streaming: true },
      );
    }
    case 'tool_call_started':
      return ops.append(finalize(list, ops),
        {
          kind: 'tool',
          id: ev.callId,
          name: ev.name,
          inputText: '',
          phase: 'arguments',
          status: 'running',
        },
      );
    case 'tool_args_delta':
      return updateNewestTool(list, ev.callId, (tool) => ({
        ...tool,
        inputText: `${tool.inputText ?? ''}${ev.delta}`,
        phase: 'arguments',
      }), ops);
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
      }, ops);
    case 'tool_execution_started':
      return updateNewestTool(list, ev.callId, (tool) => ({
        ...tool,
        name: ev.name,
        phase: 'executing',
      }), ops);
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
      }), ops);
    }
    case 'steering_received':
      return ops.append(finalize(list, ops),
        { kind: 'user', text: ev.text, at: new Date(entry.wallTimeMs).toISOString() },
      );
    case 'user_input_received':
      return ops.append(finalize(list, ops),
        {
          kind: 'user',
          text: ev.response.text,
          at: new Date(entry.wallTimeMs).toISOString(),
        },
      );
    case 'model_iteration_completed':
    case 'commit_started':
      return finalize(list, ops);
    case 'turn_finished': {
      let next = ops.append(finalize(list, ops),
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
      );
      if (ev.outcome !== 'completed' && ev.outcome !== 'aborted') {
        next = ops.append(next,
          {
            kind: 'error',
            text: ev.message ?? `Agent turn ${ev.outcome}`,
          },
        );
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
