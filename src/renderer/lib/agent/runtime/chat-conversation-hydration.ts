import { AgentChatTranscript } from '../../../domain/agent-chat-transcript';
import { createAgentConversationRepository } from '../../../sqlite-repo/agent-conversation-repo';
import { createAgentRuntimeLongTaskRepository } from '../../../sqlite-repo/agent-runtime-long-task-repo';
import type { AgentContextUsageSnapshot } from './types';
import type { AgentChatRunState, AgentChatTerminalState as RunTerminalState } from './chat-run-projection';
import { createAgentChatJournalScope } from './chat-journal-dedup';
import { findCanonicalAgentChatSessionId, loadCanonicalAgentChatProjection } from './recovered-transcript';
import { createInactiveAgentAutomaticContinuation, summarizeLongTaskPlanForContinuation, type AgentLongTaskPlanContinuationState as RunLongTaskPlanState } from './long-task-auto-continuation';

const repo = createAgentConversationRepository();
const longTaskRepo = createAgentRuntimeLongTaskRepository();

/** Hydrate a display run under a navigation lease. Never publishes to a store. */
export async function hydrateAgentConversationRun(id: string, projectId: string, isCurrent: () => boolean): Promise<AgentChatRunState | null> {
  if (!isCurrent()) return null;
  const conv = await repo.get(id);
  if (!isCurrent() || !conv || conv.projectId !== projectId) {
    return null;
  }
  let messages = conv.messages;
  let journalScope = createAgentChatJournalScope();
  let lastTerminal: RunTerminalState | null = null;
  let runtimeSessionId = conv.runtimeSessionId;
  let longTaskPlanState: RunLongTaskPlanState | null = null;
  let contextUsage: AgentContextUsageSnapshot | null = null;
  if (!runtimeSessionId) {
    try {
      runtimeSessionId = await findCanonicalAgentChatSessionId(conv.projectId, conv.id);
    } catch {
      runtimeSessionId = null;
    }
    if (!isCurrent()) return null;
  }
  if (runtimeSessionId) {
    try {
      const projection = await loadCanonicalAgentChatProjection(
        runtimeSessionId,
        undefined,
        conv.messages,
      );
      if (projection) {
        messages = projection.messages;
        journalScope = createAgentChatJournalScope(projection.eventIds);
        lastTerminal = projection.lastTerminal;
        contextUsage = projection.latestContextUsage;
      }
    } catch {
      // A corrupt/unavailable canonical session must never be fed back to
      // the model. The display cache is still useful as a read-only
      // fallback while the transport refuses that resume.
    }
    if (!isCurrent()) return null;
  }
  if (runtimeSessionId && runtimeSessionId !== conv.runtimeSessionId) {
    try {
      await repo.update(id, { runtimeSessionId });
    } catch {
      // Route lookup will recover the binding again on the next launch.
    }
    if (!isCurrent()) return null;
  }
  if (runtimeSessionId) {
    try {
      const latestPlan = await longTaskRepo.getLatestPlan({
        projectId: conv.projectId,
        sessionId: runtimeSessionId,
      });
      if (!isCurrent()) return null;
      const manifestState = latestPlan
        ? await longTaskRepo.getChapterManifestState(
            {
              projectId: conv.projectId,
              sessionId: runtimeSessionId,
            },
            latestPlan.task.id,
          )
        : null;
      longTaskPlanState = summarizeLongTaskPlanForContinuation(
        runtimeSessionId,
        latestPlan,
        manifestState,
      );
    } catch {
      longTaskPlanState = null;
    }
    if (!isCurrent()) return null;
  }
  return {
    projectId: conv.projectId,
    transcript: AgentChatTranscript.from(messages), runtimeSessionId, journalScope,
    controlStatus: null, pendingControl: null, lastTerminal, longTaskPlanState,
    contextUsage, automaticContinuation: createInactiveAgentAutomaticContinuation(),
  };
}
