import type { AgentChatTranscript } from '../../../domain/agent-chat-transcript';
import type { AgentControlStatus, AgentPendingControl } from '../protocol';
import type { AgentChatJournalScope } from './chat-journal-dedup';
import type { AgentContextUsageSnapshot, AgentRuntimeJournalEntry, AgentRuntimeOutcome } from './types';
import { markAutomaticContinuationTerminal, type AgentAutomaticContinuationState, type AgentLongTaskPlanContinuationState } from './long-task-auto-continuation';
import { applyAgentChatTranscriptEntry } from './chat-journal-projection';

export interface AgentChatTerminalState {
  turnId: string;
  outcome: AgentRuntimeOutcome;
  message?: string;
}

/** One conversation owns its live projection independently of the displayed panel. */
export interface AgentChatRunState {
  /** Owning project — so a background turn doesn't pulse another project's cells. */
  projectId: string;
  transcript: AgentChatTranscript;
  /** Provider-neutral canonical runtime session used for context recovery. */
  runtimeSessionId: string | null;
  /** Opaque owner for private live/replay deduplication; never persisted. */
  journalScope: AgentChatJournalScope;
  controlStatus: AgentControlStatus | null;
  pendingControl: AgentPendingControl | null;
  lastTerminal: AgentChatTerminalState | null;
  /** Latest durable plan in this exact session; null means unchecked/read failure. */
  longTaskPlanState: AgentLongTaskPlanContinuationState | null;
  /** Latest verified provider-input projection for this conversation. */
  contextUsage: AgentContextUsageSnapshot | null;
  /** Renderer-lifetime only; never restored into unattended execution. */
  automaticContinuation: AgentAutomaticContinuationState;
}

/** Pure run projection; membership, publication and effects belong to the consumer. */
export function projectAgentChatRunEvent(run: AgentChatRunState, entry: AgentRuntimeJournalEntry): AgentChatRunState {
  const { turnId, event: ev } = entry;
  let controlStatus = run.controlStatus;
  let pendingControl = run.pendingControl;
  let lastTerminal = run.lastTerminal;
  let longTaskPlanState = run.longTaskPlanState;
  let automaticContinuation = run.automaticContinuation;
  if (ev.type === 'turn_started' || ev.type === 'model_iteration_started') {
    controlStatus = 'running';
    if (ev.type === 'turn_started') {
      lastTerminal = null;
      longTaskPlanState = null;
    }
  } else if (ev.type === 'permission_requested') {
    controlStatus = 'waiting_permission';
    // The active slice is already suspended by the runtime. Keep continuous
    // execution armed: once this exact request is resolved, the same slice
    // resumes and a later terminal may safely schedule the next durable-plan
    // slice. A renderer restart still drops the in-memory authorization.
    pendingControl = {
      sessionId: ev.request.sessionId,
      turnId: ev.request.turnId,
      status: 'waiting_permission',
      permissionRequest: ev.request,
      requiresContinuation: false,
    };
  } else if (ev.type === 'permission_resolved') {
    controlStatus = 'running';
    if (pendingControl?.permissionRequest?.requestId === ev.resolution.requestId) {
      pendingControl = null;
    }
  } else if (ev.type === 'user_input_requested') {
    controlStatus = 'waiting_user';
    // Asking a question pauses the current provider loop by construction;
    // answering it should not silently revoke an already armed continuous
    // task. It remains cancellable through the single Stop control.
    pendingControl = {
      sessionId: ev.request.sessionId,
      turnId: ev.request.turnId,
      status: 'waiting_user',
      userInputRequest: ev.request,
      requiresContinuation: false,
    };
  } else if (ev.type === 'user_input_received') {
    if (pendingControl?.userInputRequest?.requestId === ev.response.requestId) {
      pendingControl = null;
    }
    controlStatus = 'running';
  } else if (ev.type === 'cancellation_requested') {
    controlStatus = 'cancelling';
  } else if (ev.type === 'commit_started') {
    controlStatus = 'committing';
  } else if (ev.type === 'turn_finished') {
    controlStatus = null;
    pendingControl = null;
    // Hide continuation until an authoritative same-session plan read
    // completes; never infer it from a tool-result payload.
    longTaskPlanState = null;
    lastTerminal = {
      turnId,
      outcome: ev.outcome,
      ...(ev.message ? { message: ev.message } : {}),
    };
    automaticContinuation = markAutomaticContinuationTerminal(automaticContinuation, {
      turnId,
      costUsd: ev.usage.costUsd,
    });
  }
  const transcript = applyAgentChatTranscriptEntry(run.transcript, entry);
  return { ...run, transcript, runtimeSessionId: entry.sessionId, controlStatus, pendingControl, lastTerminal,
    longTaskPlanState, automaticContinuation, contextUsage: ev.type === 'context_planned' ? ev.snapshot : run.contextUsage };
}
