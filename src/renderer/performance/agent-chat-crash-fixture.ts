import type { AgentChatMessage } from '../domain/agent-conversation';
import type { AgentModelMessage, AgentRuntimeEvent, AgentRuntimeJournalEntry } from '../lib/agent/runtime/types';
import { AGENT_RUNTIME_DURABLE_COMMIT_FAILURE_MESSAGE, AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE } from '../lib/agent/runtime/types';

export const CHAT_CRASH_PROJECT = 'synthetic-chat-crash-project';
export const CHAT_CRASH_CONVERSATION = 'synthetic-chat-crash-conversation';
export const CHAT_CRASH_SESSION = 'synthetic-chat-crash-session';
export const CHAT_CRASH_TIME = '2026-09-13T00:00:00.000Z';

/** Synthetic provider output only. No tool implementation or external service runs. */
export function createAgentChatCrashFixture(seed: number, mixed: boolean) {
  const turnId = mixed ? `mixed-turn-${seed}` : 'completed-prior-turn';
  const prompt = mixed ? `Synthetic mixed request ${seed}` : 'Synthetic prior request';
  const preface = `Inspecting synthetic fixture ${seed}.`;
  const answer = mixed ? `Synthetic final answer ${seed}.` : 'Prior complete answer.';
  const usage = { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  const totalUsage = { ...usage, inputTokens: mixed ? 6 : 3, outputTokens: mixed ? 8 : 4 };
  const arguments_ = { seed };
  const raw = JSON.stringify(arguments_);
  const calls = ['ok', 'failed'].map(result => ({ id: `${turnId}-${result}`, name: 'read_synthetic_fixture' }));
  const events: AgentRuntimeEvent[] = [
    { type: 'turn_started', prompt },
    { type: 'model_iteration_started', iteration: 1, driverId: 'synthetic-provider' },
  ];
  if (mixed) events.push(
    { type: 'thinking_delta', iteration: 1, text: `Synthetic reasoning ${seed}.`, consolidated: true },
    { type: 'text_delta', iteration: 1, text: preface },
    { type: 'tool_call_started', iteration: 1, callId: calls[0].id, name: calls[0].name },
    { type: 'tool_args_delta', iteration: 1, callId: calls[0].id, delta: raw.slice(0, 4) },
    { type: 'tool_args_delta', iteration: 1, callId: calls[0].id, delta: raw.slice(4) },
    { type: 'tool_call_ready', iteration: 1, callId: calls[0].id, name: calls[0].name, arguments: arguments_, rawArguments: raw },
    { type: 'tool_call_started', iteration: 1, callId: calls[1].id, name: calls[1].name },
    { type: 'tool_args_delta', iteration: 1, callId: calls[1].id, delta: raw },
    { type: 'tool_call_ready', iteration: 1, callId: calls[1].id, name: calls[1].name, arguments: arguments_, rawArguments: raw },
    { type: 'model_usage', iteration: 1, usage },
    { type: 'model_iteration_completed', iteration: 1, stopReason: 'tool_use' },
    { type: 'tool_execution_started', callId: calls[0].id, name: calls[0].name, access: 'read' },
    { type: 'tool_result', callId: calls[0].id, name: calls[0].name, ok: true, content: `Synthetic result ${seed}.`, source: 'executor' },
    { type: 'tool_execution_started', callId: calls[1].id, name: calls[1].name, access: 'read' },
    { type: 'tool_result', callId: calls[1].id, name: calls[1].name, ok: false, content: `Synthetic failure ${seed}.`, source: 'executor', errorCode: 'SYNTHETIC_FAILURE' },
    { type: 'model_iteration_started', iteration: 2, driverId: 'synthetic-provider' },
    { type: 'thinking_delta', iteration: 2, text: `Synthetic conclusion ${seed}.`, consolidated: true },
    { type: 'text_delta', iteration: 2, text: answer.slice(0, 10) },
    { type: 'text_delta', iteration: 2, text: answer.slice(10) },
  );
  else events.push({ type: 'text_delta', iteration: 1, text: answer });
  const iteration = mixed ? 2 : 1;
  events.push(
    { type: 'model_usage', iteration, usage },
    { type: 'model_iteration_completed', iteration, stopReason: 'end_turn' },
    { type: 'commit_started', outcome: 'completed' },
    { type: 'turn_finished', outcome: 'completed', usage: totalUsage, modelIterations: iteration, durationMs: 30 },
  );
  const acceptedAt = new Date(Date.parse(CHAT_CRASH_TIME) + (mixed ? 1000 : 0)).toISOString();
  const entries: AgentRuntimeJournalEntry[] = events.map((event, index) => ({
    schemaVersion: 1, sessionId: CHAT_CRASH_SESSION, turnId,
    route: { kind: 'chat', projectId: CHAT_CRASH_PROJECT, conversationId: CHAT_CRASH_CONVERSATION },
    seq: index + 1, eventId: `${turnId}:${String(index + 1).padStart(8, '0')}`,
    wallTimeMs: Date.parse(acceptedAt) + index + 1, event,
  }));
  const history: AgentModelMessage[] = [{ role: 'user', content: prompt }];
  if (mixed) history.push(
    { role: 'assistant', content: [{ type: 'thinking', text: `Synthetic reasoning ${seed}.` }, { type: 'text', text: preface },
      ...calls.map(call => ({ type: 'tool_call' as const, callId: call.id, name: call.name, arguments: arguments_, rawArguments: raw }))] },
    { role: 'tool', content: calls.map((call, i) => ({ callId: call.id, name: call.name,
      content: i === 0 ? `Synthetic result ${seed}.` : `Synthetic failure ${seed}.`, ok: i === 0 })) },
  );
  history.push({ role: 'assistant', content: [...(mixed ? [{ type: 'thinking' as const, text: `Synthetic conclusion ${seed}.` }] : []), { type: 'text', text: answer }] });
  const user: AgentChatMessage = { kind: 'user', text: prompt, at: acceptedAt };
  const usageMessage: AgentChatMessage = { kind: 'usage', inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens,
    cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, turns: iteration, durationMs: 30, at: new Date(entries[entries.length - 1].wallTimeMs).toISOString() };
  // Literal display oracle, independent of both live and recovery folds.
  const expected = (through: number, committed: boolean): AgentChatMessage[] => {
    if (!mixed) return [user, { kind: 'assistant', text: answer, streaming: false }, usageMessage];
    const messages: AgentChatMessage[] = [user, { kind: 'thinking', text: `Synthetic reasoning ${seed}.`, streaming: false },
      { kind: 'assistant', text: preface, streaming: false }];
    if (through === 6) messages.push({ kind: 'tool', ...calls[0], inputText: raw.slice(0, 4), phase: 'arguments', status: 'error', result: AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE });
    else {
      messages.push({ kind: 'tool', ...calls[0], input: arguments_, phase: 'executing', status: through < 15 ? 'error' : 'ok',
        result: through < 15 ? AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE : `Synthetic result ${seed}.` });
      messages.push({ kind: 'tool', ...calls[1], input: arguments_, phase: through < 16 ? 'ready' : 'executing', status: 'error',
        result: through < 17 ? AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE : `Synthetic failure ${seed}.` });
    }
    if (through >= 21) messages.push({ kind: 'thinking', text: `Synthetic conclusion ${seed}.`, streaming: false }, { kind: 'assistant', text: answer, streaming: false });
    if (through === 25) messages.push(usageMessage);
    if (!committed) messages.push({ kind: 'error', text: through === 25 ? AGENT_RUNTIME_DURABLE_COMMIT_FAILURE_MESSAGE : AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE });
    return messages;
  };
  return { turnId, prompt, acceptedAt, entries, history, expected, user };
}
