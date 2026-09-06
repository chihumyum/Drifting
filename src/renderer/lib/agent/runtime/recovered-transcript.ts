import type { AgentChatMessage } from '../../../domain/agent-conversation';
import type { AgentRuntimeRecoverySnapshot } from '../../../domain/agent-runtime-persistence';
import {
  createAgentRuntimePersistenceRepository,
  type AgentRuntimePersistenceRepository,
} from '../../../sqlite-repo/agent-runtime-persistence-repo';
import { applyAgentChatJournalEntry, finalizeAgentChatStreaming } from './chat-journal-projection';
import { recoverAgentRuntimeSnapshot } from './recovery';
import {
  AGENT_RUNTIME_DURABLE_COMMIT_FAILURE_MESSAGE,
  AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE,
  AGENT_RUNTIME_SCHEMA_VERSION,
  type AgentContextUsageSnapshot,
  type AgentRuntimeEvent,
  type AgentRuntimeJournalEntry,
  type AgentRuntimeOutcome,
  type AgentRuntimeRoute,
} from './types';

export interface CanonicalAgentChatProjection {
  messages: AgentChatMessage[];
  /** Durable ids already represented by `messages`; used to dedupe live replay. */
  eventIds: string[];
  lastTerminal: {
    turnId: string;
    outcome: AgentRuntimeOutcome;
    message?: string;
  } | null;
  /** Latest verified provider-input estimate, restored from the canonical journal. */
  latestContextUsage: AgentContextUsageSnapshot | null;
}

interface CachedVisibleUserBundle {
  text: string;
  at?: string;
  /**
   * Only an immediately-following cached error belongs to a user prompt that
   * never reached the canonical runtime. Assistant/tool rows remain excluded:
   * the journal is authoritative for those.
   */
  notices: Extract<AgentChatMessage, { kind: 'error' }>[];
}

function cachedVisibleUserBundles(
  visibleCache: readonly AgentChatMessage[],
): CachedVisibleUserBundle[] {
  const bundles: CachedVisibleUserBundle[] = [];
  for (let index = 0; index < visibleCache.length; index += 1) {
    const message = visibleCache[index];
    if (message?.kind !== 'user') continue;
    const notices: Extract<AgentChatMessage, { kind: 'error' }>[] = [];
    for (let next = index + 1; next < visibleCache.length; next += 1) {
      const adjacent = visibleCache[next];
      if (adjacent?.kind !== 'error') break;
      notices.push(adjacent);
    }
    bundles.push({ text: message.text, ...(message.at ? { at: message.at } : {}), notices });
  }
  return bundles;
}

export async function findCanonicalAgentChatSessionId(
  projectId: string,
  conversationId: string,
  repository: AgentRuntimePersistenceRepository = createAgentRuntimePersistenceRepository(),
): Promise<string | null> {
  const session = await repository.findSessionForRoute({
    projectId,
    routeKind: 'chat',
    conversationId,
  });
  return session?.id ?? null;
}

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
  repository: AgentRuntimePersistenceRepository = createAgentRuntimePersistenceRepository(),
  visibleCache?: readonly AgentChatMessage[],
): Promise<AgentChatMessage[] | null> {
  const projection = await loadCanonicalAgentChatProjection(sessionId, repository, visibleCache);
  return projection?.messages ?? null;
}

export async function loadCanonicalAgentChatProjection(
  sessionId: string,
  repository: AgentRuntimePersistenceRepository = createAgentRuntimePersistenceRepository(),
  visibleCache?: readonly AgentChatMessage[],
): Promise<CanonicalAgentChatProjection | null> {
  const snapshot = await repository.loadRecoverySnapshot(sessionId);
  if (!snapshot) return null;
  const recovered = await recoverAgentRuntimeSnapshot(snapshot);
  const imported = await repository.loadPortableDisplay?.(sessionId);
  const visibleUsers = cachedVisibleUserBundles(visibleCache ?? []);
  let visibleUserIndex = 0;
  let messages: AgentChatMessage[] = [];
  let latestContextUsage: AgentContextUsageSnapshot | null = null;
  const appendVisibleUser = (bundle: CachedVisibleUserBundle): void => {
    messages = [
      ...finalizeAgentChatStreaming(messages),
      { kind: 'user', text: bundle.text, ...(bundle.at ? { at: bundle.at } : {}) },
      ...bundle.notices,
    ];
  };
  const takeVisibleUser = (
    canonicalText: string,
    allowHiddenPrefix: boolean,
    fallbackAt?: string,
  ): Pick<Extract<AgentChatMessage, { kind: 'user' }>, 'text' | 'at'> => {
    const matchesCanonical = (visible: CachedVisibleUserBundle, index: number): boolean =>
      index >= visibleUserIndex &&
      (visible.text === canonicalText ||
        (allowHiddenPrefix && canonicalText.endsWith(`\n\n${visible.text}`)));
    // A same-text prompt carrying an adjacent preflight error is evidence of a
    // failed attempt, not the later canonical retry. Prefer the next clean
    // occurrence so the failed attempt and its error remain visible.
    const cleanMatchIndex = visibleUsers.findIndex(
      (visible, index) => visible.notices.length === 0 && matchesCanonical(visible, index),
    );
    const matchIndex =
      cleanMatchIndex >= 0
        ? cleanMatchIndex
        : visibleUsers.findIndex((visible, index) => matchesCanonical(visible, index));
    if (matchIndex === -1) {
      return { text: canonicalText, ...(fallbackAt ? { at: fallbackAt } : {}) };
    }
    // User prompts accepted by the Panel can exist without a canonical turn
    // when provider/persistence preflight fails. Preserve those rows in their
    // original position instead of consuming one as the next turn's prompt.
    for (let index = visibleUserIndex; index < matchIndex; index += 1) {
      appendVisibleUser(visibleUsers[index]!);
    }
    visibleUserIndex = matchIndex + 1;
    const matched = visibleUsers[matchIndex]!;
    const at = matched.at ?? fallbackAt;
    return { text: matched.text, ...(at ? { at } : {}) };
  };
  const eventsByTurn = new Map<string, AgentRuntimeRecoverySnapshot['events']>();
  for (const event of snapshot.events) {
    const rows = eventsByTurn.get(event.turnId) ?? [];
    rows.push(event);
    eventsByTurn.set(event.turnId, rows);
  }
  for (const rows of eventsByTurn.values()) {
    rows.sort((left, right) => left.seq - right.seq || left.eventId.localeCompare(right.eventId));
  }
  const messageById = new Map(snapshot.messages.map((message) => [message.id, message]));

  for (const turn of [...snapshot.turns].sort((left, right) => left.ordinal - right.ordinal)) {
    if (imported?.turnId === turn.id) {
      messages.push(...imported.messages);
      for (const message of imported.messages) if (message.kind === 'user') takeVisibleUser(message.text, false, message.at);
      continue;
    }
    const turnMessageStart = messages.length;
    const recoveredTurn = recovered.turns.find((candidate) => candidate.turnId === turn.id);
    const rows = eventsByTurn.get(turn.id) ?? [];
    const promptRow = turn.promptMessageId ? messageById.get(turn.promptMessageId) : undefined;
    const prompt = promptRow?.content ?? null;
    let insertedPrompt = false;
    let hasTerminal = false;
    for (const row of rows) {
      const entry = persistedJournalEntry(row);
      if (entry.event.type === 'context_planned') {
        latestContextUsage = entry.event.snapshot;
      }
      if (entry.event.type === 'turn_finished') hasTerminal = true;
      if (entry.event.type === 'turn_started') {
        if (entry.event.promptSource === 'runtime_continuation') {
          insertedPrompt = true;
          continue;
        }
        const canonicalPrompt = typeof prompt === 'string' ? prompt : entry.event.prompt;
        const visiblePrompt = takeVisibleUser(
          canonicalPrompt,
          true,
          promptRow?.createdAt ?? new Date(entry.wallTimeMs).toISOString(),
        );
        messages = [...finalizeAgentChatStreaming(messages), { kind: 'user', ...visiblePrompt }];
        insertedPrompt = true;
        continue;
      }
      if (entry.event.type === 'steering_received') {
        takeVisibleUser(entry.event.text, false);
      } else if (entry.event.type === 'user_input_received') {
        takeVisibleUser(entry.event.response.text, false);
      }
      messages = applyAgentChatJournalEntry(
        messages,
        failClosedInterruptedTerminal(entry, recoveredTurn?.recoveredStatus),
      );
    }
    if (!insertedPrompt) {
      const visiblePrompt =
        typeof prompt === 'string' ? takeVisibleUser(prompt, true, promptRow?.createdAt) : null;
      if (visiblePrompt) {
        messages = [...finalizeAgentChatStreaming(messages), { kind: 'user', ...visiblePrompt }];
      }
    }
    // A recovered renderer has no live provider iterator even if the final
    // durable entry was a delta. Preserve the partial text, but do not render a
    // false live caret after restart.
    messages = finalizeAgentChatStreaming(messages);
    if (recoveredTurn?.recoveredStatus === 'interrupted' && !hasTerminal) {
      messages = failClosedInterruptedMessages(messages, turnMessageStart);
    }
  }

  if (snapshot.events.length === 0 && recovered.transcript.length > 0) {
    messages = recovered.transcript;
    if (recovered.turns.some((turn) => turn.recoveredStatus === 'interrupted')) {
      messages = failClosedInterruptedMessages(messages, 0);
    }
  }
  for (; visibleUserIndex < visibleUsers.length; visibleUserIndex += 1) {
    appendVisibleUser(visibleUsers[visibleUserIndex]!);
  }
  const latestTerminalTurn = recovered.turns[recovered.turns.length - 1];
  const latestTerminal = latestTerminalTurn?.journalState?.terminal;
  return {
    messages,
    eventIds: snapshot.events.map((event) => event.eventId),
    latestContextUsage,
    lastTerminal:
      latestTerminalTurn?.recoveredStatus === 'interrupted'
        ? {
            turnId: latestTerminalTurn.turnId,
            outcome: 'failed',
            message: latestTerminal
              ? AGENT_RUNTIME_DURABLE_COMMIT_FAILURE_MESSAGE
              : AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE,
          }
        : latestTerminal
          ? {
              turnId: latestTerminalTurn.turnId,
              outcome: latestTerminal.outcome,
              ...(latestTerminal.message ? { message: latestTerminal.message } : {}),
            }
          : null,
  };
}

function failClosedInterruptedMessages(
  messages: AgentChatMessage[],
  fromIndex: number,
): AgentChatMessage[] {
  const settled = messages.map((message, index) =>
    index >= fromIndex && message.kind === 'tool' && message.status === 'running'
      ? {
          ...message,
          status: 'error' as const,
          result: AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE,
        }
      : message,
  );
  if (
    settled
      .slice(fromIndex)
      .some(
        (message) =>
          message.kind === 'error' && message.text === AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE,
      )
  ) {
    return settled;
  }
  return [
    ...finalizeAgentChatStreaming(settled),
    { kind: 'error', text: AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE },
  ];
}

function failClosedInterruptedTerminal(
  entry: AgentRuntimeJournalEntry,
  recoveredStatus: string | undefined,
): AgentRuntimeJournalEntry {
  if (recoveredStatus !== 'interrupted' || entry.event.type !== 'turn_finished') {
    return entry;
  }
  return {
    ...entry,
    event: {
      ...entry.event,
      outcome: 'failed',
      failureCode: 'INTERNAL_ERROR',
      message: AGENT_RUNTIME_DURABLE_COMMIT_FAILURE_MESSAGE,
    },
  };
}

function persistedJournalEntry(
  row: AgentRuntimeRecoverySnapshot['events'][number],
): AgentRuntimeJournalEntry {
  // `recoverAgentRuntimeSnapshot` above has already validated every payload,
  // route, schema version, event type, and sequence fail-closed.
  const payload = row.payload as {
    route: AgentRuntimeRoute;
    event: AgentRuntimeEvent;
  };
  return {
    schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    sessionId: row.sessionId,
    turnId: row.turnId,
    route: payload.route,
    seq: row.seq,
    eventId: row.eventId,
    wallTimeMs: row.wallTimeMs,
    event: payload.event,
  };
}
