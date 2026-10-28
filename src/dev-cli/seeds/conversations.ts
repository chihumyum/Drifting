import { v7 as uuidv7 } from 'uuid';

import type { AgentChatMessage } from '../../renderer/domain/agent-conversation';
import type { DbClient } from '../../renderer/lib/db';
import { applyAgentChatJournalEntry, finalizeAgentChatStreaming } from '../../renderer/lib/agent/runtime/chat-journal-projection';
import { createRepositoryAgentTransportPersistence } from '../../renderer/lib/agent/runtime/repository-transport-persistence';
import type { AgentRuntimeEvent, AgentRuntimeJournalEntry } from '../../renderer/lib/agent/runtime/types';
import { createAgentConversationRepository } from '../../renderer/sqlite-repo/agent-conversation-repo';
import { createAgentRuntimePersistenceRepository } from '../../renderer/sqlite-repo/agent-runtime-persistence-repo';
import { DEVELOPMENT_SEED_COUNTS, SEED_STORYLINES } from './default-project';

const topics = ['开篇节奏', '三线交织', '人物动机', '灯塔空间', '证词矛盾', '伏笔回收', '对白精简', '潮汐时间线', '场景转场', '全书修订', '素材整理', '结尾余韵'];
const questions = ['先整理可观察到的事实。', '哪些地方适合留白？', '列出三个修订方向。', '怎样避免提前揭晓答案？', '再检查人物视角是否一致。', '整理下一次写作的检查清单。'];

/** Real local runtime history/checkpoints, generated without a model or network. */
export async function seedConversations(database: DbClient, projectId: string): Promise<void> {
  const conversations = createAgentConversationRepository();
  const runtime = createAgentRuntimePersistenceRepository(database);
  const persistence = createRepositoryAgentTransportPersistence({ repository: runtime, resolveToolAccess: () => 'read' });
  const baseTime = Date.now() - topics.length * 86_400_000;
  for (const [index, topic] of topics.entries()) {
    const conversationId = uuidv7();
    const sessionId = uuidv7();
    const startedAt = new Date(baseTime + index * 86_400_000).toISOString();
    let display: AgentChatMessage[] = [];
    await conversations.create({
      id: conversationId, projectId, title: `示例讨论 · ${topic}`, mode: 'byok', messages: [],
      createdAt: startedAt, updatedAt: startedAt,
    });
    for (let turn = 0; turn < DEVELOPMENT_SEED_COUNTS.turnsPerConversation; turn++) {
      const turnId = uuidv7();
      const atMs = baseTime + index * 86_400_000 + turn * 60_000;
      const at = new Date(atMs).toISOString();
      const route = { kind: 'chat' as const, projectId, conversationId };
      const prompt = `围绕“${topic}”讨论“${SEED_STORYLINES[index % 3]}”。${questions[turn]}`;
      const thinking = `这是一段离线合成的示例对话。第${turn + 1}轮先区分人物已知的信息与读者能看到的细节，再整理${topic}。`;
      const reply = [
        `### ${topic} · 第${turn + 1}轮`,
        `围绕“${SEED_STORYLINES[index % 3]}”，可以让林潮先看到物证，再听到相互矛盾的解释。灯光每九秒扫过一次，是这一轮讨论的稳定参照。`,
        `1. 检查第${(index * 7 + turn * 3) % 100 + 1}章的入场信息，只保留当前视角可以确认的部分。\n2. 把老船长没有回答的问题记下来，交给后续场景承接。\n3. 在下一次修订中核对时间、位置与人物动机。`,
        `关于“${questions[turn]}”，先保留一个具体的动作：林潮把记录翻回上一页，却没有划掉原来的时间。这样能让${topic}落在可见的细节上。`,
        '（开发样本：以上内容为预先编写的虚构讨论，未调用模型，也未产生费用。）',
      ].join('\n\n');
      const prepared = await persistence.prepareTurn({
        candidateSessionId: sessionId, newConversation: turn === 0, route,
        provider: 'development-seed', model: null, turnId, prompt, acceptedAt: at,
      });
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
      display.push({ kind: 'user', text: prompt, at, context: [{ kind: 'project', projectId, label: '潮汐灯塔（示例）' }] });
      const events: AgentRuntimeEvent[] = [
        { type: 'turn_started', prompt },
        { type: 'model_iteration_started', iteration: 1, driverId: 'development-seed' },
        { type: 'thinking_delta', iteration: 1, text: thinking, consolidated: true },
        { type: 'text_delta', iteration: 1, text: reply },
        { type: 'model_usage', iteration: 1, usage },
        { type: 'model_iteration_completed', iteration: 1, stopReason: 'end_turn' },
        { type: 'turn_finished', outcome: 'completed', usage, modelIterations: 1, durationMs: 0 },
      ];
      for (const [eventIndex, event] of events.entries()) {
        const entry: AgentRuntimeJournalEntry = {
          schemaVersion: 1, route, event, sessionId: prepared.sessionId, turnId,
          seq: eventIndex + 1, eventId: `${turnId}:${String(eventIndex + 1).padStart(8, '0')}`,
          wallTimeMs: atMs + eventIndex,
        };
        await persistence.appendJournal(entry);
        display = applyAgentChatJournalEntry(display, entry);
      }
      await persistence.commitTurn({
        sessionId: prepared.sessionId, turnId,
        turnMessages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: [{ type: 'thinking', text: thinking }, { type: 'text', text: reply }] },
        ],
        outcome: 'completed', errorCode: null, errorMessage: null, endedAt: at,
      });
      display = finalizeAgentChatStreaming(display);
      await conversations.update(conversationId, { messages: display, runtimeSessionId: prepared.sessionId, updatedAt: at });
    }
  }
}
