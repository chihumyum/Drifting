import type {
  AgentRuntimeRecoverySnapshot,
  PersistedAgentRuntimeMessage,
  PersistedAgentRuntimeSession,
  PersistedAgentRuntimeToolCall,
} from '../../../domain/agent-runtime-persistence';
import {
  canonicalAgentRuntimeJson,
  createAgentRuntimePersistenceRepository,
  type AgentRuntimePersistenceRepository,
} from '../../../sqlite-repo/agent-runtime-persistence-repo';
import type { AgentRuntimeWriteEffectRepository } from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import type {
  AgentPendingControl,
  AgentStartRoute,
} from '../protocol';
import { clonePortableData } from './portable-data';
import {
  createAgentRuntimeCheckpointContextV2,
  hashAgentRuntimeCheckpointContext,
  hashAgentRuntimeCheckpointPayload,
  recoverAgentRuntimeSnapshot,
} from './recovery';
import type {
  AgentTransportCommitTurnInput,
  AgentTransportPersistence,
  AgentTransportPrepareTurnInput,
  AgentTransportPreparedTurn,
} from './transport-persistence';
import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  type AgentModelMessage,
  type AgentRuntimeEvent,
  type AgentRuntimeJournalEntry,
} from './types';

export interface AgentRuntimeRecoveryCodec {
  recoverSnapshot(
    snapshot: AgentRuntimeRecoverySnapshot,
  ): Promise<{
    providerHistory: AgentModelMessage[];
    pendingControls?: AgentPendingControl[];
  }>;
  hashCheckpointContext(
    context: readonly AgentModelMessage[],
  ): Promise<string>;
}

export interface RepositoryAgentTransportPersistenceOptions {
  repository?: AgentRuntimePersistenceRepository;
  writeEffects?: Pick<
    AgentRuntimeWriteEffectRepository,
    'interruptSessionWrites'
  >;
  recovery?: AgentRuntimeRecoveryCodec;
  /**
   * Product-owned receipt reconciliation that runs after the saved session is
   * validated and before generic process-interruption repair.
   */
  beforeResumeSession?: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  /** Canonical catalog lookup. Unknown names fail closed before execution. */
  resolveToolAccess: (
    name: string,
    projectId: string,
  ) => 'read' | 'write' | undefined;
}

/**
 * Expected, non-secret failure that can safely cross the renderer transport
 * boundary. Raw SQLite/provider errors remain hidden from the chat transcript.
 */
export class AgentTransportPersistenceError extends Error {
  readonly publicMessage: string;

  constructor(
    readonly code:
      | 'AGENT_SESSION_ROUTE_MISMATCH'
      | 'AGENT_ROUTE_REQUIRED'
      | 'AGENT_PERSISTENCE_CORRUPT'
      | 'AGENT_PERSISTENCE_CONFLICT'
      | 'AGENT_TOOL_NOT_CERTIFIED'
      | 'AGENT_CONTROL_RESOLUTION_REQUIRED'
      | 'AGENT_CONTROL_STALE',
    publicMessage: string,
    readonly originalCause?: unknown,
  ) {
    super(publicMessage);
    this.name = 'AgentTransportPersistenceError';
    this.publicMessage = publicMessage;
  }
}

/**
 * Adapts the canonical repository to the high-level transport durability port.
 * All provider-facing history is rebuilt from complete normalized messages;
 * display caches and streamed journal deltas are never used as model context.
 */
export function createRepositoryAgentTransportPersistence(
  options: RepositoryAgentTransportPersistenceOptions,
): AgentTransportPersistence {
  const repository =
    options.repository ?? createAgentRuntimePersistenceRepository();
  const recovery = options.recovery ?? defaultRecoveryCodec;
  const pendingTools = new Map<string, PendingToolProjection>();

  const loadAndRecover = async (
    sessionId: string,
  ): Promise<{
    snapshot: AgentRuntimeRecoverySnapshot;
    providerHistory: AgentModelMessage[];
    pendingControls: AgentPendingControl[];
  } | null> => {
    const snapshot = await repository.loadRecoverySnapshot(sessionId);
    if (!snapshot) return null;
    try {
      const result = await recovery.recoverSnapshot(snapshot);
      return {
        snapshot,
        providerHistory: result.providerHistory.map(clonePortableData),
        pendingControls: (result.pendingControls ?? []).map(clonePortableData),
      };
    } catch (cause) {
      throw new AgentTransportPersistenceError(
        'AGENT_PERSISTENCE_CORRUPT',
        'The saved Agent session is inconsistent and was not resumed.',
        cause,
      );
    }
  };

  return {
    async prepareTurn(
      input,
      signal,
    ): Promise<AgentTransportPreparedTurn> {
      throwIfAborted(signal);
      assertDurableRoute(input.route);
      let session = await resolveSession(repository, input);
      throwIfAborted(signal);
      let recoveredSnapshot = session
        ? await loadAndRecover(session.id)
        : null;
      throwIfAborted(signal);
      if (session) {
        await options.beforeResumeSession?.(session.id, signal);
        throwIfAborted(signal);
      }
      let recovered = false;
      if (
        session &&
        recoveredSnapshot &&
        recoveredSnapshot.pendingControls.length > 0
      ) {
        throw new AgentTransportPersistenceError(
          'AGENT_CONTROL_RESOLUTION_REQUIRED',
          'The Agent session has a pending control that must be inspected or cancelled before continuing.',
        );
      }
      if (
        session &&
        recoveredSnapshot &&
        needsInterruption(recoveredSnapshot.snapshot)
      ) {
        // `loadAndRecover` above is the fail-closed validation pass. Only after
        // it succeeds may this transaction materialize the recovery plan's
        // process-interrupted transitions for session/turn/message/tool rows.
        throwIfAborted(signal);
        await options.writeEffects?.interruptSessionWrites(
          session.id,
          input.acceptedAt,
        );
        throwIfAborted(signal);
        await repository.interruptSession(session.id, input.acceptedAt);
        throwIfAborted(signal);
        recovered = true;
        session = await repository.getSession(session.id);
        throwIfAborted(signal);
        if (!session) {
          throw new AgentTransportPersistenceError(
            'AGENT_PERSISTENCE_CORRUPT',
            'The saved Agent session disappeared during recovery.',
          );
        }
        recoveredSnapshot = await loadAndRecover(session.id);
        if (!recoveredSnapshot) {
          throw new AgentTransportPersistenceError(
            'AGENT_PERSISTENCE_CORRUPT',
            'The saved Agent session disappeared during recovery.',
          );
        }
        throwIfAborted(signal);
      }
      if (
        recoveredSnapshot &&
        hasInterruptedState(recoveredSnapshot.snapshot)
      ) {
        const repaired = await repairInterruptedToolProjections(
          repository,
          recoveredSnapshot.snapshot,
          options.resolveToolAccess,
        );
        throwIfAborted(signal);
        if (repaired) {
          recoveredSnapshot = await loadAndRecover(
            recoveredSnapshot.snapshot.session.id,
          );
          if (!recoveredSnapshot) {
            throw new AgentTransportPersistenceError(
              'AGENT_PERSISTENCE_CORRUPT',
              'The saved Agent session disappeared during recovery.',
            );
          }
          throwIfAborted(signal);
        }
      }

      const snapshot = recoveredSnapshot?.snapshot ?? null;
      const history = recoveredSnapshot?.providerHistory ?? [];
      const nextTurnOrdinal =
        (snapshot?.turns[snapshot.turns.length - 1]?.ordinal ?? -1) + 1;
      const nextMessageOrdinal =
        (snapshot?.messages[snapshot.messages.length - 1]?.ordinal ?? -1) + 1;
      const durableSession = buildSession(input, session);
      const promptMessageId = runtimeMessageId(input.turnId, 0);

      try {
        await repository.acceptTurn({
          session: durableSession,
          turn: {
            id: input.turnId,
            sessionId: durableSession.id,
            ordinal: nextTurnOrdinal,
            status: 'accepted',
            promptMessageId,
            acceptedAt: input.acceptedAt,
            startedAt: null,
            endedAt: null,
            errorCode: null,
            errorMessage: null,
            updatedAt: input.acceptedAt,
          },
          promptMessage: {
            id: promptMessageId,
            sessionId: durableSession.id,
            turnId: input.turnId,
            ordinal: nextMessageOrdinal,
            role: 'user',
            status: 'complete',
            content: input.prompt,
            createdAt: input.acceptedAt,
            completedAt: input.acceptedAt,
          },
        });
        throwIfAborted(signal);
      } catch (cause) {
        if (isRouteConflict(cause)) {
          throw new AgentTransportPersistenceError(
            'AGENT_SESSION_ROUTE_MISMATCH',
            'The Agent session belongs to a different project or conversation.',
            cause,
          );
        }
        throw new AgentTransportPersistenceError(
          'AGENT_PERSISTENCE_CONFLICT',
          'The Agent turn conflicted with newer durable state.',
          cause,
        );
      }

      return {
        sessionId: durableSession.id,
        history: history.map(clonePortableData),
        recovered,
      };
    },

    async appendJournal(
      entry: AgentRuntimeJournalEntry,
      signal,
    ): Promise<void> {
      throwIfAborted(signal);
      await repository.appendEvent({
        eventId: entry.eventId,
        sessionId: entry.sessionId,
        turnId: entry.turnId,
        seq: entry.seq,
        schemaVersion: entry.schemaVersion,
        eventType: entry.event.type,
        payload: {
          route: clonePortableData(entry.route),
          event: clonePortableData(entry.event),
        },
        wallTimeMs: entry.wallTimeMs,
        createdAt: new Date(entry.wallTimeMs).toISOString(),
      });
      throwIfAborted(signal);
      if (entry.event.type === 'turn_started') {
        await repository.markTurnRunning(
          entry.sessionId,
          entry.turnId,
          new Date(entry.wallTimeMs).toISOString(),
        );
        throwIfAborted(signal);
      }
      await projectToolLifecycleEvent(
        repository,
        pendingTools,
        options.resolveToolAccess,
        entry,
      );
      throwIfAborted(signal);
    },

    async commitTurn(
      input: AgentTransportCommitTurnInput,
      signal,
    ): Promise<void> {
      throwIfAborted(signal);
      const recoveredSnapshot = await loadAndRecover(input.sessionId);
      throwIfAborted(signal);
      if (!recoveredSnapshot) {
        throw new AgentTransportPersistenceError(
          'AGENT_PERSISTENCE_CORRUPT',
          'The saved Agent session disappeared before the turn committed.',
        );
      }
      const { snapshot, providerHistory } = recoveredSnapshot;
      const turn = snapshot.turns.find((candidate) => candidate.id === input.turnId);
      const prompt = turn?.promptMessageId
        ? snapshot.messages.find((message) => message.id === turn.promptMessageId)
        : null;
      const accepted = input.turnMessages[0];
      if (
        !turn ||
        !prompt ||
        prompt.role !== 'user' ||
        prompt.status !== 'complete' ||
        accepted?.role !== 'user' ||
        accepted.content !== prompt.content
      ) {
        throw new AgentTransportPersistenceError(
          'AGENT_PERSISTENCE_CORRUPT',
          'The accepted Agent prompt does not match the completed turn.',
        );
      }

      const completionMessages = input.turnMessages
        .slice(1)
        .map(clonePortableData);
      const firstOrdinal =
        (snapshot.messages[snapshot.messages.length - 1]?.ordinal ?? -1) + 1;
      const rows: PersistedAgentRuntimeMessage[] = completionMessages.map(
        (message, index) => ({
          id: runtimeMessageId(input.turnId, index + 1),
          sessionId: input.sessionId,
          turnId: input.turnId,
          ordinal: firstOrdinal + index,
          role: message.role,
          status: 'complete',
          content: clonePortableData(message.content),
          createdAt: input.endedAt,
          completedAt: input.endedAt,
        }),
      );
      // A budget boundary is a completed, resumable work slice: every tool
      // result before the boundary is canonical and must survive into the next
      // "continue" turn. Failed/aborted turns remain excluded from history.
      const resumableSlice =
        input.outcome === 'completed' ||
        input.outcome === 'budget_exceeded';
      const terminalStatus =
        resumableSlice
          ? 'completed'
          : input.outcome === 'aborted'
            ? 'aborted'
            : 'failed';

      let checkpoint:
        | Parameters<AgentRuntimePersistenceRepository['createCheckpoint']>[0]
        | undefined;
      if (resumableSlice) {
        const context = [
          ...providerHistory,
          ...input.turnMessages.map(clonePortableData),
        ];
        const durableContext = input.contextCheckpointV2
          ? await createAgentRuntimeCheckpointContextV2({
              canonicalHistory: context,
              canonicalSourceRows:
                input.contextCheckpointV2.canonicalSourceRows,
              providerEnvelope:
                input.contextCheckpointV2.providerEnvelope,
            })
          : context.map(clonePortableData);
        throwIfAborted(signal);
        checkpoint = {
          id: runtimeCheckpointId(input.sessionId, turn.ordinal),
          sessionId: input.sessionId,
          throughTurnOrdinal: turn.ordinal,
          messageCount: context.length,
          context: durableContext,
          contextHash: input.contextCheckpointV2
            ? await hashAgentRuntimeCheckpointPayload(durableContext)
            : await recovery.hashCheckpointContext(context),
          createdAt: input.endedAt,
        };
        throwIfAborted(signal);
      }

      await repository.commitTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        messages: rows,
        ...(checkpoint ? { checkpoint } : {}),
        terminalStatus,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        endedAt: input.endedAt,
      });
      throwIfAborted(signal);
    },

    async listPendingControls(input, signal) {
      throwIfAborted(signal);
      const recovered = await loadAndRecover(input.sessionId);
      throwIfAborted(signal);
      return (recovered?.pendingControls ?? []).map(clonePortableData);
    },

    async cancelPendingControl(input, signal) {
      throwIfAborted(signal);
      const recovered = await loadAndRecover(input.sessionId);
      throwIfAborted(signal);
      const pending = recovered?.pendingControls.find(
        (control) =>
          control.turnId === input.turnId &&
          (control.permissionRequest?.requestId === input.requestId ||
            control.userInputRequest?.requestId === input.requestId),
      );
      if (!recovered || !pending) {
        throw new AgentTransportPersistenceError(
          'AGENT_CONTROL_STALE',
          'The pending Agent control no longer matches durable state.',
        );
      }
      const turn = recovered.snapshot.turns.find(
        (candidate) => candidate.id === input.turnId,
      );
      if (!turn) {
        throw new AgentTransportPersistenceError(
          'AGENT_CONTROL_STALE',
          'The pending Agent control no longer matches durable state.',
        );
      }
      const journalState = (
        await recoverAgentRuntimeSnapshot(recovered.snapshot)
      ).turns.find((candidate) => candidate.turnId === input.turnId)?.journalState;
      if (!journalState) {
        throw new AgentTransportPersistenceError(
          'AGENT_PERSISTENCE_CORRUPT',
          'The pending Agent control has no canonical journal state.',
        );
      }
      const at = new Date().toISOString();
      let seq = journalState.lastSeq;
      const route = routeFromSession(recovered.snapshot.session);
      const append = async (event: AgentRuntimeEvent): Promise<void> => {
        seq += 1;
        await repository.appendEvent({
          eventId: `${input.turnId}:${String(seq).padStart(8, '0')}`,
          sessionId: input.sessionId,
          turnId: input.turnId,
          seq,
          schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
          eventType: event.type,
          payload: { route: clonePortableData(route), event },
          wallTimeMs: Date.parse(at) + seq,
          createdAt: new Date(Date.parse(at) + seq).toISOString(),
        });
      };
      if (pending.permissionRequest) {
        await append({
          type: 'permission_resolved',
          resolution: {
            requestId: pending.permissionRequest.requestId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            callId: pending.permissionRequest.callId,
            argumentsHash: pending.permissionRequest.argumentsHash,
            revision: pending.permissionRequest.revision,
            decision: 'deny',
            scope: 'once',
            reason: input.reason ?? 'Recovered permission request cancelled.',
          },
        });
      }
      const request =
        pending.permissionRequest ?? pending.userInputRequest;
      if (!request) {
        throw new AgentTransportPersistenceError(
          'AGENT_PERSISTENCE_CORRUPT',
          'The pending Agent control has no request provenance.',
        );
      }
      await append({
        type: 'cancellation_requested',
        reason: input.reason ?? 'Recovered control cancelled by user.',
      });
      await append({
        type: 'tool_result',
        callId: request.callId,
        name:
          pending.permissionRequest?.toolName ??
          journalState.tools[request.callId]?.name ??
          'user_input',
        ok: false,
        content: 'The pending control was cancelled after process restart.',
        source: 'runtime',
        errorCode: 'RECOVERED_CONTROL_CANCELLED',
      });
      throwIfAborted(signal);
      await options.writeEffects?.interruptSessionWrites(
        input.sessionId,
        at,
      );
      await repository.interruptSession(input.sessionId, at);
      throwIfAborted(signal);
    },
  };
}

const defaultRecoveryCodec: AgentRuntimeRecoveryCodec = {
  recoverSnapshot: recoverAgentRuntimeSnapshot,
  hashCheckpointContext: hashAgentRuntimeCheckpointContext,
};

async function resolveSession(
  repository: AgentRuntimePersistenceRepository,
  input: AgentTransportPrepareTurnInput,
): Promise<PersistedAgentRuntimeSession | null> {
  if (input.newConversation) return null;
  if (input.resumeSessionId) {
    const resumed = await repository.getSession(input.resumeSessionId);
    if (resumed) {
      if (!sameRoute(resumed, input.route)) {
        throw new AgentTransportPersistenceError(
          'AGENT_SESSION_ROUTE_MISMATCH',
          'The Agent session belongs to a different project or conversation.',
        );
      }
      if (resumed.status !== 'closed' && resumed.status !== 'aborted') {
        return resumed;
      }
    }
  }
  return repository.findSessionForRoute(routeLookup(input.route));
}

function needsInterruption(
  snapshot: AgentRuntimeRecoverySnapshot,
): boolean {
  const session = snapshot.session;
  if (
    session.status === 'pending' ||
    session.status === 'running' ||
    session.status === 'recovering'
  ) {
    return true;
  }
  return snapshot.turns.some(
    (turn) =>
      turn.status === 'accepted' ||
      turn.status === 'running' ||
      turn.status === 'recovering',
  );
}

function buildSession(
  input: AgentTransportPrepareTurnInput,
  existing: PersistedAgentRuntimeSession | null,
): PersistedAgentRuntimeSession {
  const providerEpochChanged = Boolean(
    existing &&
      (existing.provider !== input.provider || existing.model !== input.model),
  );
  return {
    id: existing?.id ?? input.candidateSessionId,
    projectId: input.route.projectId,
    routeKind: input.route.kind,
    conversationId:
      input.route.kind === 'chat'
        ? input.route.conversationId ?? null
        : null,
    goalRunId:
      input.route.kind === 'goal' ? input.route.goalRunId ?? null : null,
    chapterId:
      input.route.kind === 'goal' ? input.route.chapterId ?? null : null,
    provider: input.provider,
    model: input.model,
    providerEpoch:
      (existing?.providerEpoch ?? 0) + (providerEpochChanged ? 1 : 0),
    status: 'running',
    createdAt: existing?.createdAt ?? input.acceptedAt,
    updatedAt: input.acceptedAt,
    endedAt: null,
  };
}

function routeLookup(route: AgentStartRoute): Parameters<
  AgentRuntimePersistenceRepository['findSessionForRoute']
>[0] {
  return route.kind === 'chat'
    ? {
        projectId: route.projectId,
        routeKind: 'chat',
        conversationId: route.conversationId ?? null,
      }
    : {
        projectId: route.projectId,
        routeKind: 'goal',
        goalRunId: route.goalRunId ?? null,
        chapterId: route.chapterId ?? null,
      };
}

function routeFromSession(
  session: PersistedAgentRuntimeSession,
): AgentStartRoute {
  return session.routeKind === 'chat'
    ? {
        kind: 'chat',
        projectId: session.projectId,
        ...(session.conversationId
          ? { conversationId: session.conversationId }
          : {}),
      }
    : {
        kind: 'goal',
        projectId: session.projectId,
        ...(session.goalRunId ? { goalRunId: session.goalRunId } : {}),
        ...(session.chapterId ? { chapterId: session.chapterId } : {}),
      };
}

function sameRoute(
  session: PersistedAgentRuntimeSession,
  route: AgentStartRoute,
): boolean {
  if (
    session.projectId !== route.projectId ||
    session.routeKind !== route.kind
  ) {
    return false;
  }
  return route.kind === 'chat'
    ? session.conversationId === (route.conversationId ?? null) &&
        session.goalRunId === null &&
        session.chapterId === null
    : session.conversationId === null &&
        session.goalRunId === (route.goalRunId ?? null) &&
        session.chapterId === (route.chapterId ?? null);
}

function runtimeMessageId(turnId: string, index: number): string {
  return `agent-message:${turnId}:${index}`;
}

function runtimeCheckpointId(sessionId: string, turnOrdinal: number): string {
  return `agent-checkpoint:${sessionId}:${turnOrdinal}`;
}

function isRouteConflict(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause.code === 'ROUTE_OWNERSHIP_MISMATCH' ||
      cause.code === 'SESSION_IDENTITY_CONFLICT')
  );
}

function assertDurableRoute(route: AgentStartRoute): void {
  if (
    !route.projectId ||
    (route.kind === 'chat' && !route.conversationId)
  ) {
    throw new AgentTransportPersistenceError(
      'AGENT_ROUTE_REQUIRED',
      'A durable chat route requires a project and conversation.',
    );
  }
}

interface PendingToolProjection {
  sessionId: string;
  turnId: string;
  callId: string;
  name: string;
  arguments: Record<string, unknown> | null;
  access: 'read' | 'write' | null;
  createdAt: string;
  startedAt: string | null;
}

async function projectToolLifecycleEvent(
  repository: AgentRuntimePersistenceRepository,
  pending: Map<string, PendingToolProjection>,
  resolveAccess: (
    name: string,
    projectId: string,
  ) => 'read' | 'write' | undefined,
  entry: AgentRuntimeJournalEntry,
): Promise<void> {
  const event = entry.event;
  if (
    event.type !== 'tool_call_started' &&
    event.type !== 'tool_call_ready' &&
    event.type !== 'tool_execution_started' &&
    event.type !== 'tool_result'
  ) {
    return;
  }
  const key = toolProjectionKey(entry.sessionId, entry.turnId, event.callId);
  let projection = pending.get(key);
  if (event.type === 'tool_call_started') {
    projection = {
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      callId: event.callId,
      name: event.name,
      arguments: null,
      access: null,
      createdAt: isoFromWallTime(entry.wallTimeMs),
      startedAt: null,
    };
    pending.set(key, projection);
    return;
  }
  projection ??= {
    sessionId: entry.sessionId,
    turnId: entry.turnId,
    callId: event.callId,
    name: event.name,
    arguments: null,
    access: null,
    createdAt: isoFromWallTime(entry.wallTimeMs),
    startedAt: null,
  };
  pending.set(key, projection);

  if (
    event.type === 'tool_result' &&
    event.source === 'runtime' &&
    projection.arguments === null &&
    projection.startedAt === null
  ) {
    // Unknown names, malformed arguments, and validation failures never
    // reached the executable catalog. Their immutable runtime rejection is
    // sufficient; the lifecycle table represents executable calls only.
    pending.delete(key);
    return;
  }

  const routeProjectId = entry.route.projectId;
  if (!routeProjectId) {
    throw new AgentTransportPersistenceError(
      'AGENT_ROUTE_REQUIRED',
      'A durable Agent tool event has no project route.',
    );
  }
  const catalogAccess = resolveAccess(projection.name, routeProjectId);
  if (!catalogAccess) {
    throw new AgentTransportPersistenceError(
      'AGENT_TOOL_NOT_CERTIFIED',
      `Agent tool "${projection.name}" is not in the certified catalog.`,
    );
  }

  if (event.type === 'tool_call_ready') {
    projection.arguments = clonePortableData(event.arguments);
    projection.access = catalogAccess;
    await convergeToolProjection(repository, projection, {
      status: 'requested',
      result: null,
      errorCode: null,
      completedAt: null,
    });
    return;
  }

  if (event.type === 'tool_execution_started') {
    if (event.access !== catalogAccess || projection.arguments === null) {
      throw new AgentTransportPersistenceError(
        'AGENT_PERSISTENCE_CORRUPT',
        `Agent tool "${projection.name}" reached execution without a matching certified request.`,
      );
    }
    projection.access = event.access;
    projection.startedAt = isoFromWallTime(entry.wallTimeMs);
    await convergeToolProjection(repository, projection, {
      status: 'running',
      result: null,
      errorCode: null,
      completedAt: null,
    });
    return;
  }

  projection.access ??= catalogAccess;
  projection.arguments ??= {};
  await convergeToolProjection(repository, projection, {
    status: event.ok ? 'completed' : 'failed',
    result: {
      ok: event.ok,
      content: event.content,
      source: event.source,
      errorCode: event.errorCode ?? null,
    },
    errorCode: event.errorCode ?? null,
    completedAt: isoFromWallTime(entry.wallTimeMs),
  });
  pending.delete(key);
}

interface ConvergeToolProjection {
  status: PersistedAgentRuntimeToolCall['status'];
  result: unknown | null;
  errorCode: string | null;
  completedAt: string | null;
}

async function convergeToolProjection(
  repository: AgentRuntimePersistenceRepository,
  projection: PendingToolProjection,
  target: ConvergeToolProjection,
): Promise<boolean> {
  if (!projection.access || projection.arguments === null) {
    throw new AgentTransportPersistenceError(
      'AGENT_PERSISTENCE_CORRUPT',
      `Agent tool "${projection.name}" is missing certified arguments or access.`,
    );
  }
  const existing = (await repository.listToolCalls(projection.sessionId)).find(
    (toolCall) =>
      toolCall.turnId === projection.turnId &&
      toolCall.callId === projection.callId,
  );
  if (existing) {
    if (
      existing.name !== projection.name ||
      existing.access !== projection.access ||
      !samePortableValue(existing.arguments, projection.arguments)
    ) {
      throw new AgentTransportPersistenceError(
        'AGENT_PERSISTENCE_CORRUPT',
        `Agent tool "${projection.name}" conflicts with its durable projection.`,
      );
    }
    if (
      existing.status === target.status &&
      samePortableValue(existing.result, target.result) &&
      existing.errorCode === target.errorCode &&
      existing.startedAt === projection.startedAt &&
      existing.completedAt === target.completedAt
    ) {
      return false;
    }
    await repository.updateToolCall(existing.id, {
      status: target.status,
      result: target.result,
      errorCode: target.errorCode,
      startedAt: projection.startedAt,
      completedAt: target.completedAt,
    });
    return true;
  }

  await repository.createToolCall({
    id: runtimeToolCallId(
      projection.sessionId,
      projection.turnId,
      projection.callId,
    ),
    sessionId: projection.sessionId,
    turnId: projection.turnId,
    callId: projection.callId,
    name: projection.name,
    access: projection.access,
    status: target.status,
    idempotencyKey: `${projection.sessionId}:${projection.turnId}:${projection.callId}`,
    arguments: clonePortableData(projection.arguments),
    result: clonePortableData(target.result),
    errorCode: target.errorCode,
    createdAt: projection.createdAt,
    startedAt: projection.startedAt,
    completedAt: target.completedAt,
  });
  return true;
}

function hasInterruptedState(snapshot: AgentRuntimeRecoverySnapshot): boolean {
  return (
    snapshot.session.status === 'interrupted' ||
    snapshot.turns.some((turn) => turn.status === 'interrupted')
  );
}

async function repairInterruptedToolProjections(
  repository: AgentRuntimePersistenceRepository,
  snapshot: AgentRuntimeRecoverySnapshot,
  resolveAccess: (
    name: string,
    projectId: string,
  ) => 'read' | 'write' | undefined,
): Promise<boolean> {
  const projections = new Map<
    string,
    PendingToolProjection & {
      result: Extract<AgentRuntimeEvent, { type: 'tool_result' }> | null;
    }
  >();
  for (const row of snapshot.events) {
    const event = persistedRuntimeEvent(row.payload);
    if (
      !event ||
      (event.type !== 'tool_call_started' &&
        event.type !== 'tool_call_ready' &&
        event.type !== 'tool_execution_started' &&
        event.type !== 'tool_result')
    ) {
      continue;
    }
    const key = toolProjectionKey(row.sessionId, row.turnId, event.callId);
    let projection = projections.get(key);
    if (!projection) {
      projection = {
        sessionId: row.sessionId,
        turnId: row.turnId,
        callId: event.callId,
        name: event.name,
        arguments: null,
        access: null,
        createdAt: row.createdAt,
        startedAt: null,
        result: null,
      };
      projections.set(key, projection);
    }
    if (event.type === 'tool_call_ready') {
      projection.arguments = clonePortableData(event.arguments);
    } else if (event.type === 'tool_execution_started') {
      projection.access = event.access;
      projection.startedAt = row.createdAt;
    } else if (event.type === 'tool_result') {
      projection.result = event;
    }
  }

  let changed = false;
  for (const projection of projections.values()) {
    if (
      projection.result?.source === 'runtime' &&
      projection.arguments === null &&
      projection.startedAt === null
    ) {
      continue;
    }
    const persistedAccess = snapshot.toolCalls.find(
      (toolCall) =>
        toolCall.sessionId === projection.sessionId &&
        toolCall.turnId === projection.turnId &&
        toolCall.callId === projection.callId &&
        toolCall.name === projection.name,
    )?.access;
    projection.access ??= persistedAccess ?? null;
    const catalogAccess = resolveAccess(
      projection.name,
      snapshot.session.projectId,
    );
    if (
      (catalogAccess &&
        projection.access &&
        projection.access !== catalogAccess) ||
      (!catalogAccess && !projection.access)
    ) {
      throw new AgentTransportPersistenceError(
        'AGENT_TOOL_NOT_CERTIFIED',
        `Agent tool "${projection.name}" is not in the certified catalog.`,
      );
    }
    projection.access ??= catalogAccess ?? null;
    if (!projection.access) {
      throw new AgentTransportPersistenceError(
        'AGENT_TOOL_NOT_CERTIFIED',
        `Agent tool "${projection.name}" has no durable access classification.`,
      );
    }
    projection.arguments ??= {};
    const result = projection.result;
    const turn = snapshot.turns.find(
      (candidate) => candidate.id === projection.turnId,
    );
    const interruptedAt =
      turn?.endedAt ?? snapshot.session.updatedAt;
    const status: PersistedAgentRuntimeToolCall['status'] = result
      ? result.ok
        ? 'completed'
        : 'failed'
      : projection.startedAt && projection.access === 'write'
        ? 'uncertain'
        : 'interrupted';
    changed =
      (await convergeToolProjection(repository, projection, {
        status,
        result: result
          ? {
              ok: result.ok,
              content: result.content,
              source: result.source,
              errorCode: result.errorCode ?? null,
            }
          : null,
        errorCode:
          result?.errorCode ??
          (status === 'uncertain'
            ? 'PROCESS_INTERRUPTED_AFTER_WRITE_START'
            : 'PROCESS_INTERRUPTED'),
        completedAt: result
          ? findEventCreatedAt(snapshot, projection.turnId, result)
          : interruptedAt,
      })) || changed;
  }
  return changed;
}

function persistedRuntimeEvent(payload: unknown): AgentRuntimeEvent | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('event' in payload) ||
    typeof payload.event !== 'object' ||
    payload.event === null ||
    !('type' in payload.event) ||
    typeof payload.event.type !== 'string'
  ) {
    return null;
  }
  return payload.event as AgentRuntimeEvent;
}

function findEventCreatedAt(
  snapshot: AgentRuntimeRecoverySnapshot,
  turnId: string,
  event: AgentRuntimeEvent,
): string {
  const row = snapshot.events.find(
    (candidate) =>
      candidate.turnId === turnId &&
      samePortableValue(persistedRuntimeEvent(candidate.payload), event),
  );
  return row?.createdAt ?? snapshot.session.updatedAt;
}

function runtimeToolCallId(
  sessionId: string,
  turnId: string,
  callId: string,
): string {
  return `agent-tool:${sessionId}:${turnId}:${callId}`;
}

function toolProjectionKey(
  sessionId: string,
  turnId: string,
  callId: string,
): string {
  return `${sessionId}\u0000${turnId}\u0000${callId}`;
}

function samePortableValue(a: unknown, b: unknown): boolean {
  return canonicalAgentRuntimeJson(a) === canonicalAgentRuntimeJson(b);
}

function isoFromWallTime(wallTimeMs: number): string {
  return new Date(wallTimeMs).toISOString();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('Agent persistence operation was aborted.');
}
