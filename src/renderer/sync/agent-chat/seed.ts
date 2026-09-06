import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { DbClient } from '../../lib/db';
import {
  AgentChatBindingTable as Bindings,
  AgentChatBranchTable as Branches,
  AgentConversationTable as Conversations,
  AgentRuntimeSessionTable as Sessions,
  AgentRuntimeTurnTable as Turns,
  AgentRuntimeMessageTable as Messages,
  AgentRuntimeEventTable as Events,
  AgentRuntimeCheckpointTable as Checkpoints,
} from '../../schema/drizzle';
import { AgentConversationSyncRepository, ChatHistoryUnavailable } from './repository';
import { canonicalJson } from './protocol';
import {
  createAgentRuntimeCheckpointContextV4,
  hashAgentRuntimeCheckpointPayload,
} from '../../lib/agent/runtime/recovery';
import { agentModelMessagesToContextSources } from '../../lib/agent/runtime/context-message-adapter';
import {
  hashAgentContextSourceRows,
  type AgentContextSummaryCandidate,
} from '../../lib/agent/runtime/context-planner';
import type { AgentRuntimeEvent } from '../../lib/agent/runtime/types';

/** Create local canonical history only. No remote session/grant/receipt is imported. */
export async function seedAgentChatSession(
  db: DbClient,
  conversationId: string,
  projectId: string,
  provider: string,
  model: string | null,
): Promise<void> {
  const [binding] = await db
    .select()
    .from(Bindings)
    .where(eq(Bindings.conversationId, conversationId));
  if (!binding) return;
  const [branch] = await db
    .select()
    .from(Branches)
    .where(and(eq(Branches.id, conversationId), eq(Branches.projectId, projectId)));
  if (binding.localOwner && !branch && !binding.seededThrough) return;
  if (!branch || branch.deletedAt || !binding.localOwner)
    throw new ChatHistoryUnavailable('Agent history is not ready to continue');
  if (branch.readiness !== 'ready')
    throw new ChatHistoryUnavailable('Agent history is not ready to continue');
  if (!branch.forkTurnId || binding.sessionId) return;
  const history = await new AgentConversationSyncRepository(db).history(
    projectId,
    branch.forkTurnId,
  );
  const messages = history.flatMap((entry) => entry.payload.messages);
  if (!messages.length || messages[0]?.role !== 'user')
    throw new ChatHistoryUnavailable('This archive has no resumable model history');
  const sourceRows = agentModelMessagesToContextSources({
    systemPrompt: 'history validation',
    messages,
    resolveToolAccess: () => 'read',
  }).sourceRows;
  const summaries: AgentContextSummaryCandidate[] = [];
  for (const entry of history)
    for (const candidate of entry.payload.summaries) {
      if (
        !candidate ||
        typeof candidate.content !== 'string' ||
        typeof candidate.summaryId !== 'string' ||
        typeof candidate.sourceHash !== 'string' ||
        !Array.isArray(candidate.sourceIds)
      )
        continue;
      const rows = candidate.sourceIds.map((id) => sourceRows.find((row) => row.sourceId === id));
      if (
        rows.every((row) => row !== undefined) &&
        (await hashAgentContextSourceRows(rows)) === candidate.sourceHash
      )
        summaries.push(candidate);
    }
  const context = await createAgentRuntimeCheckpointContextV4({
    canonicalHistory: messages,
    durableSummaries: summaries,
  });
  const contextHash = await hashAgentRuntimeCheckpointPayload(context);
  const sessionId = uuidv7();
  const turnId = `${sessionId}:history`;
  const now = new Date().toISOString();
  const route = { kind: 'chat' as const, projectId, conversationId };
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  const journal: AgentRuntimeEvent[] = [
    { type: 'turn_started', prompt: messages[0].content },
    { type: 'model_iteration_started', iteration: 1, driverId: 'history-import' },
    { type: 'model_usage', iteration: 1, usage },
    { type: 'model_iteration_completed', iteration: 1, stopReason: 'end_turn' },
    { type: 'turn_finished', outcome: 'completed', usage, modelIterations: 1, durationMs: 0 },
  ];
  await db.transaction(
    async (tx) => {
      const [current] = await tx
        .select()
        .from(Bindings)
        .where(eq(Bindings.conversationId, conversationId));
      const [currentBranch] = await tx
        .select()
        .from(Branches)
        .where(eq(Branches.id, conversationId));
      if (current?.sessionId) return;
      if (
        !currentBranch ||
        currentBranch.deletedAt ||
        currentBranch.forkTurnId !== branch.forkTurnId
      )
        throw new ChatHistoryUnavailable('Agent branch changed during continuation');
      await tx.insert(Sessions).values({
        id: sessionId,
        projectId,
        routeKind: 'chat',
        conversationId,
        provider,
        model,
        providerEpoch: 0,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(Turns).values({
        id: turnId,
        sessionId,
        ordinal: 0,
        status: 'completed',
        promptMessageId: `${turnId}:0`,
        acceptedAt: now,
        startedAt: now,
        endedAt: now,
        updatedAt: now,
      });
      for (const [ordinal, message] of messages.entries())
        await tx.insert(Messages).values({
          id: `${turnId}:${ordinal}`,
          sessionId,
          turnId,
          ordinal,
          role: message.role,
          status: 'complete',
          contentJson: canonicalJson(message.content),
          createdAt: now,
          completedAt: now,
        });
      for (const [index, event] of journal.entries())
        await tx.insert(Events).values({
          eventId: `${turnId}:${String(index + 1).padStart(8, '0')}`,
          sessionId,
          turnId,
          seq: index + 1,
          schemaVersion: 1,
          eventType: event.type,
          payloadJson: canonicalJson({ route, event }),
          wallTimeMs: Date.now() + index,
          createdAt: now,
        });
      await tx.insert(Checkpoints).values({
        id: `agent-checkpoint:${sessionId}:0`,
        sessionId,
        throughTurnOrdinal: 0,
        messageCount: messages.length,
        contextJson: canonicalJson(context),
        contextHash,
        createdAt: now,
      });
      await tx
        .update(Bindings)
        .set({ sessionId, exportedOrdinal: 0, seededThrough: branch.forkTurnId })
        .where(eq(Bindings.conversationId, conversationId));
      await tx
        .update(Conversations)
        .set({ runtimeSessionId: sessionId })
        .where(eq(Conversations.id, conversationId));
    },
    { behavior: 'immediate' },
  );
}
