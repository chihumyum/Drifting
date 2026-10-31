import { v7 as uuidv7 } from 'uuid';

import type { AgentChatMessage } from '../../renderer/domain/agent-conversation';
import type { PersistedAgentRuntimeSession } from '../../renderer/domain/agent-runtime-persistence';
import type { DbClient } from '../../renderer/lib/db';
import { applyAgentChatJournalEntry, finalizeAgentChatStreaming } from '../../renderer/lib/agent/runtime/chat-journal-projection';
import { createAgentRuntimeCheckpointContextV4, hashAgentRuntimeCheckpointPayload, recoverAgentRuntimeSnapshot } from '../../renderer/lib/agent/runtime/recovery';
import type { AgentModelMessage, AgentRuntimeEvent, AgentRuntimeJournalEntry } from '../../renderer/lib/agent/runtime/types';
import { createAgentConversationRepository } from '../../renderer/sqlite-repo/agent-conversation-repo';
import { createAgentRuntimePersistenceRepository } from '../../renderer/sqlite-repo/agent-runtime-persistence-repo';
import { allocateSeedLengths, type SeedPreset } from '../../renderer/services/sample-project/presets';
import { createSeedMarkdown, createSeedProse, seedProsePlainText } from '../../renderer/services/sample-project/prose';

const topics = ['开篇节奏', '三线交织', '人物动机', '灯塔空间', '证词矛盾', '伏笔回收', '对白精简', '潮汐时间线', '场景转场', '全书修订', '素材整理', '结尾余韵'];
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

/**
 * Bulk synthetic history through the canonical repository's accept/journal/
 * commit paths. One final V4 digest covers all rounds. Avoid resuming and
 * rehashing the entire growing history for every imported fixture round.
 * No provider or domain tool is called; read-tool results are labelled fiction.
 */
export async function seedConversations(
  database: DbClient, projectId: string, preset: SeedPreset, progress?: (message: string) => void,
): Promise<void> {
  const conversations = createAgentConversationRepository();
  const lengths = allocateSeedLengths(preset.conversations, 109);
  const baseTime = Date.now() - lengths.length * 86_400_000;
  for (const [index, rounds] of lengths.entries()) {
    const conversationId = uuidv7(), sessionId = uuidv7();
    const startedAt = new Date(baseTime + index * 86_400_000).toISOString();
    const title = `示例讨论 · ${topics[index % topics.length]} · ${index + 1}`;
    await conversations.create({ id: conversationId, projectId, title, mode: 'byok', messages: [], createdAt: startedAt, updatedAt: startedAt });
    let display: AgentChatMessage[] = [];
    const history: AgentModelMessage[] = [];
    let messageOrdinal = 0;
    const session: PersistedAgentRuntimeSession = {
      id: sessionId, projectId, routeKind: 'chat', conversationId, goalRunId: null, chapterId: null,
      provider: 'development-seed', model: null, providerEpoch: 0, status: 'idle',
      createdAt: startedAt, updatedAt: startedAt, endedAt: null,
    };
    await database.transaction(async tx => {
      const runtime = createAgentRuntimePersistenceRepository(tx);
      for (let turn = 0; turn < rounds; turn++) {
        const turnId = uuidv7();
        const atMs = baseTime + index * 86_400_000 + turn * 60_000;
        const at = new Date(atMs).toISOString();
        const route = { kind: 'chat' as const, projectId, conversationId };
        const corpusSeed = index * 1_000 + turn;
        const heavy = preset.name === 'stress';
        const prompt = seedProsePlainText(createSeedProse(heavy ? 100 + corpusSeed % 500 : 40 + corpusSeed % 50, 10_000 + corpusSeed));
        const thinking = seedProsePlainText(createSeedProse(heavy ? 100 + corpusSeed % 400 : 40, 40_000 + corpusSeed));
        const reply = createSeedMarkdown(heavy ? 600 + corpusSeed % 1_800 : 150 + corpusSeed % 250, 70_000 + corpusSeed);
        const hasTool = turn % 3 === 1;
        const callId = `${turnId}:read`, name = 'search_project';
        const args = { query: topics[index % topics.length] };
        const toolContent = JSON.stringify({ synthetic: true, notice: '合成性能样本，未执行真实工具',
          excerpts: seedProsePlainText(createSeedProse(heavy ? 1_000 + corpusSeed % 11_000 : 100 + corpusSeed % 400, 100_000 + corpusSeed)) });
        const turnMessages: AgentModelMessage[] = hasTool ? [
          { role: 'user', content: prompt },
          { role: 'assistant', content: [{ type: 'thinking', text: thinking }, { type: 'tool_call', callId, name, arguments: args, rawArguments: JSON.stringify(args) }] },
          { role: 'tool', content: [{ callId, name, ok: true, content: toolContent }] },
          { role: 'assistant', content: [{ type: 'text', text: reply }] },
        ] : [
          { role: 'user', content: prompt },
          { role: 'assistant', content: [{ type: 'thinking', text: thinking }, { type: 'text', text: reply }] },
        ];
        await runtime.acceptTurn({
          session, turn: {
            id: turnId, sessionId, ordinal: turn, status: 'accepted', promptMessageId: `${turnId}:0`,
            acceptedAt: at, startedAt: null, endedAt: null, errorCode: null, errorMessage: null, updatedAt: at,
          },
          promptMessage: { id: `${turnId}:0`, sessionId, turnId, ordinal: messageOrdinal++, role: 'user', status: 'complete', content: prompt, createdAt: at, completedAt: at },
        });
        await runtime.markTurnRunning(sessionId, turnId, at);
        display.push({ kind: 'user', text: prompt, at });
        const events: AgentRuntimeEvent[] = [
          { type: 'turn_started', prompt },
          { type: 'model_iteration_started', iteration: 1, driverId: 'development-seed' },
          { type: 'thinking_delta', iteration: 1, text: thinking, consolidated: true },
        ];
        if (hasTool) {
          events.push(
            { type: 'tool_call_started', iteration: 1, callId, name },
            { type: 'tool_args_delta', iteration: 1, callId, delta: JSON.stringify(args) },
            { type: 'tool_call_ready', iteration: 1, callId, name, arguments: args, rawArguments: JSON.stringify(args) },
            { type: 'model_usage', iteration: 1, usage },
            { type: 'model_iteration_completed', iteration: 1, stopReason: 'tool_use' },
            { type: 'tool_execution_started', callId, name, access: 'read' },
            { type: 'tool_result', callId, name, ok: true, content: toolContent, source: 'executor' },
            { type: 'model_iteration_started', iteration: 2, driverId: 'development-seed' },
          );
          await runtime.createToolCall({
            id: `${sessionId}:${callId}`, sessionId, turnId, callId, name, access: 'read', status: 'completed',
            idempotencyKey: `${sessionId}:${turnId}:${callId}`, arguments: args,
            result: { ok: true, content: toolContent, source: 'executor' }, errorCode: null,
            createdAt: at, startedAt: at, completedAt: at,
          });
        }
        const iterations = hasTool ? 2 : 1;
        events.push(
          { type: 'text_delta', iteration: iterations, text: reply },
          { type: 'model_usage', iteration: iterations, usage },
          { type: 'model_iteration_completed', iteration: iterations, stopReason: 'end_turn' },
          { type: 'turn_finished', outcome: 'completed', usage, modelIterations: iterations, durationMs: 0 },
        );
        for (const [eventIndex, event] of events.entries()) {
          const entry: AgentRuntimeJournalEntry = {
            schemaVersion: 1, route, event, sessionId, turnId, seq: eventIndex + 1,
            eventId: `${turnId}:${String(eventIndex + 1).padStart(8, '0')}`, wallTimeMs: atMs + eventIndex,
          };
          await runtime.appendEvent({ ...entry, eventType: event.type, payload: { route, event }, createdAt: at });
          display = applyAgentChatJournalEntry(display, entry);
        }
        history.push(...turnMessages);
        const context = turn === rounds - 1
          ? await createAgentRuntimeCheckpointContextV4({ canonicalHistory: history, durableSummaries: [] }) : null;
        await runtime.commitTurn({
          sessionId, turnId, terminalStatus: 'completed', errorCode: null, errorMessage: null, endedAt: at,
          messages: turnMessages.slice(1).map((message, ordinal) => ({
            id: `${turnId}:${ordinal + 1}`, sessionId, turnId, ordinal: messageOrdinal++,
            role: message.role, status: 'complete', content: message.content, createdAt: at, completedAt: at,
          })),
          ...(context ? { checkpoint: {
            id: `agent-checkpoint:${sessionId}:${turn}`, sessionId, throughTurnOrdinal: turn,
            messageCount: history.length, context, contextHash: await hashAgentRuntimeCheckpointPayload(context), createdAt: at,
          } } : {}),
        });
      }
    }, { behavior: 'immediate' });
    const runtime = createAgentRuntimePersistenceRepository(database);
    await recoverAgentRuntimeSnapshot((await runtime.loadRecoverySnapshot(sessionId))!);
    await conversations.update(conversationId, { messages: finalizeAgentChatStreaming(display), runtimeSessionId: sessionId,
      updatedAt: new Date(baseTime + index * 86_400_000 + (rounds - 1) * 60_000).toISOString() });
    progress?.(`Agent fixture ${index + 1}/${lengths.length}: ${rounds} rounds committed and recovered.`);
  }
}
