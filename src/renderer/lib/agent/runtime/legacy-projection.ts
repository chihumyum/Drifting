import type { AgentEvent } from '../protocol';
import type { AgentRuntimeJournalEntry } from './types';

interface ToolProjectionState {
  name: string;
  exposed: boolean;
}

/**
 * Projects the canonical runtime journal onto the existing renderer protocol.
 *
 * The journal remains the source of truth. This stateful compatibility layer is
 * intentionally lossy and can be removed once the chat UI consumes canonical
 * entries directly.
 */
export class LegacyAgentEventProjector {
  private readonly tools = new Map<string, ToolProjectionState>();

  constructor(private readonly sessionId: string) {}

  project(entry: AgentRuntimeJournalEntry): AgentEvent[] {
    const event = entry.event;
    switch (event.type) {
      case 'turn_started':
        return [{ type: 'session', id: this.sessionId }];

      case 'text_delta':
        return event.text ? [{ type: 'assistant_delta', text: event.text }] : [];

      case 'thinking_delta':
        return event.text ? [{ type: 'thinking_delta', text: event.text }] : [];

      case 'tool_call_started':
        this.tools.set(event.callId, { name: event.name, exposed: false });
        return [];

      case 'tool_call_ready': {
        const tool = this.tools.get(event.callId);
        if (tool) tool.exposed = true;
        return [
          {
            type: 'tool_use',
            id: event.callId,
            name: event.name,
            input: event.arguments,
          },
        ];
      }

      case 'tool_result': {
        const projected: AgentEvent[] = [];
        const tool = this.tools.get(event.callId);
        if (!tool?.exposed) {
          projected.push({
            type: 'tool_use',
            id: event.callId,
            name: tool?.name ?? event.name,
          });
          if (tool) tool.exposed = true;
        }
        projected.push({
          type: 'tool_result',
          id: event.callId,
          ok: event.ok,
          text: event.content,
        });
        return projected;
      }

      case 'turn_finished': {
        const projected: AgentEvent[] = [
          {
            type: 'usage',
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cacheReadTokens: event.usage.cacheReadTokens,
            cacheCreationTokens: event.usage.cacheWriteTokens,
            costUsd: event.usage.costUsd,
            turns: event.modelIterations,
            durationMs: event.durationMs,
            durationApiMs: event.durationMs,
          },
        ];
        if (event.outcome === 'completed') {
          projected.push({ type: 'result', ok: true, text: '' });
        } else if (event.outcome !== 'aborted') {
          projected.push({
            type: 'error',
            message: event.message ?? `Agent turn ${event.outcome}`,
          });
        }
        projected.push({ type: 'done' });
        return projected;
      }

      case 'tool_args_delta':
      case 'tool_execution_started':
      case 'model_iteration_started':
      case 'model_usage':
      case 'model_iteration_completed':
        return [];
    }
  }
}
