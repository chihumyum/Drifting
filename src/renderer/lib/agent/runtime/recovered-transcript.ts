import type { AgentChatMessage } from '../../../domain/agent-conversation';
import {
  createAgentRuntimePersistenceRepository,
  type AgentRuntimePersistenceRepository,
} from '../../../sqlite-repo/agent-runtime-persistence-repo';
import { recoverAgentRuntimeSnapshot } from './recovery';

/**
 * Rebuild the visible chat from canonical runtime rows and the immutable
 * journal. `agent_conversation.messagesJson` is only a compatibility/display
 * cache once a provider-neutral runtime session exists.
 *
 * Recovery is read-only here. Status/tool repairs happen at the transport
 * durability boundary before another model turn starts.
 */
export async function loadCanonicalAgentTranscript(
  sessionId: string,
  repository: AgentRuntimePersistenceRepository =
    createAgentRuntimePersistenceRepository(),
): Promise<AgentChatMessage[] | null> {
  const snapshot = await repository.loadRecoverySnapshot(sessionId);
  if (!snapshot) return null;
  const recovered = await recoverAgentRuntimeSnapshot(snapshot);
  return recovered.transcript;
}
