import { and, eq } from 'drizzle-orm';
import type { DbClient } from '../../lib/db';
import { AgentChatBindingTable, AgentRuntimeSessionTable } from '../../schema/drizzle';
import { AgentConversationSyncRepository } from './repository';
import type {
  PersistedAgentRuntimeResultArtifact,
  ReadAgentRuntimeResultArtifact,
} from '../../domain/agent-runtime-result-artifact';
import { hashText } from './protocol';

async function importedHistory(db: DbClient, sessionId: string, expectedProjectId?: string) {
  const [session] = await db
    .select()
    .from(AgentRuntimeSessionTable)
    .where(eq(AgentRuntimeSessionTable.id, sessionId));
  if (!session?.conversationId || (expectedProjectId && session.projectId !== expectedProjectId))
    return null;
  const [binding] = await db
    .select()
    .from(AgentChatBindingTable)
    .where(
      and(
        eq(AgentChatBindingTable.conversationId, session.conversationId),
        eq(AgentChatBindingTable.sessionId, sessionId),
      ),
    );
  if (!binding?.seededThrough) return null;
  const repository = new AgentConversationSyncRepository(db);
  return {
    repository,
    session,
    history: await repository.history(session.projectId, binding.seededThrough),
  };
}
export async function loadImportedChatDisplay(db: DbClient, sessionId: string) {
  const imported = await importedHistory(db, sessionId);
  return imported
    ? {
        turnId: `${sessionId}:history`,
        messages: imported.history.flatMap((entry) => entry.payload.display),
      }
    : null;
}

/** Historic result access is confined to this local session's imported ancestry. */
export async function readImportedChatArtifact(
  db: DbClient,
  input: ReadAgentRuntimeResultArtifact,
): Promise<PersistedAgentRuntimeResultArtifact | null> {
  const imported = await importedHistory(db, input.sessionId, input.projectId);
  if (!imported) return null;
  for (const { turn, payload } of imported.history) {
    const artifact = payload.artifacts.find((candidate) => candidate.ref === input.ref);
    if (!artifact) continue;
    const serialized = await imported.repository.text(artifact.payloadIds, input.projectId);
    return {
      ref: artifact.ref,
      projectId: input.projectId,
      sessionId: input.sessionId,
      turnId: `${input.sessionId}:history`,
      toolCallId: `history:${turn.id}:${artifact.callId}`,
      callId: artifact.callId,
      toolName: artifact.toolName,
      idempotencyKey: `history:${turn.id}:${artifact.callId}`,
      arguments: artifact.arguments ?? {},
      contentHash: await hashText(serialized),
      byteCount: new TextEncoder().encode(serialized).byteLength,
      charCount: [...serialized].length,
      serialized,
      createdAt: turn.createdAt,
    };
  }
  return null;
}
