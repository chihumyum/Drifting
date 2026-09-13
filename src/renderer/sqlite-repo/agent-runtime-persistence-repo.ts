import { events } from '../lib/events';
import { fullAgentCheckpointPredicate } from '../schema/agent-checkpoint-retention';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  max,
  or,
} from 'drizzle-orm';
import type {
  AgentRuntimeToolCallStatus,
  AgentRuntimeMessageRole,
  AgentRuntimeMessageStatus,
  AgentRuntimeRecoverySnapshot,
  AgentRuntimeSessionStatus,
  AgentRuntimeTurnStatus,
  PersistedAgentRuntimeCheckpoint,
  PersistedAgentRuntimeEvent,
  PersistedAgentRuntimeMessage,
  PersistedAgentRuntimeSession,
  PersistedAgentRuntimeToolCall,
  PersistedAgentRuntimeTurn,
} from '../domain/agent-runtime-persistence';
import { getDb, type DbExecutor } from '../lib/db';
import {
  AgentConversationTable,
  AgentRuntimeCheckpointTable,
  AgentRuntimeEventTable,
  AgentRuntimeMessageTable,
  AgentRuntimeSessionTable,
  AgentRuntimeToolCallTable,
  AgentRuntimeTurnTable,
} from '../schema/drizzle';

export class AgentRuntimePersistenceConflictError extends Error {
  constructor(
    readonly code:
      | 'EVENT_ID_CONFLICT'
      | 'EVENT_SEQ_CONFLICT'
      | 'EVENT_SEQ_GAP'
      | 'EVENT_SESSION_MISMATCH'
      | 'SESSION_IDENTITY_CONFLICT'
      | 'ROUTE_OWNERSHIP_MISMATCH'
      | 'TURN_ID_CONFLICT'
      | 'TURN_ORDINAL_CONFLICT'
      | 'MESSAGE_ID_CONFLICT'
      | 'MESSAGE_ORDINAL_CONFLICT'
      | 'INVALID_TURN_STATE'
      | 'TOOL_CALL_CONFLICT'
      | 'CHECKPOINT_CONFLICT'
      | 'INVALID_JSON_PAYLOAD',
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimePersistenceConflictError';
  }
}

export interface UpdateAgentRuntimeSession {
  status?: AgentRuntimeSessionStatus;
  provider?: string;
  model?: string | null;
  providerEpoch?: number;
  updatedAt: string;
  endedAt?: string | null;
}

export interface UpdateAgentRuntimeTurn {
  status?: AgentRuntimeTurnStatus;
  promptMessageId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  updatedAt: string;
}

export interface UpdateAgentRuntimeMessage {
  status?: AgentRuntimeMessageStatus;
  content?: unknown;
  completedAt?: string | null;
}

export interface UpdateAgentRuntimeToolCall {
  status?: AgentRuntimeToolCallStatus;
  result?: unknown | null;
  errorCode?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface AcceptAgentRuntimeTurnInput {
  session: PersistedAgentRuntimeSession;
  turn: PersistedAgentRuntimeTurn;
  promptMessage: PersistedAgentRuntimeMessage;
}

export interface CommitAgentRuntimeTurnInput {
  sessionId: string;
  turnId: string;
  messages: PersistedAgentRuntimeMessage[];
  checkpoint?: PersistedAgentRuntimeCheckpoint;
  terminalStatus: Extract<
    AgentRuntimeTurnStatus,
    'completed' | 'failed' | 'aborted'
  >;
  errorCode?: string | null;
  errorMessage?: string | null;
  endedAt: string;
}

export type IdempotentPersistenceOutcome = 'inserted' | 'duplicate';

export type AppendAgentRuntimeEventResult =
  | { outcome: 'inserted'; event: PersistedAgentRuntimeEvent }
  | { outcome: 'duplicate'; event: PersistedAgentRuntimeEvent };

export interface AgentRuntimePersistenceRepository {
  loadPortableDisplay?(sessionId: string): Promise<{ turnId: string; messages: import('../domain/agent-conversation').AgentChatMessage[] } | null>;
  preparePortableHistory?(input: { conversationId: string; projectId: string; provider: string; model: string | null }): Promise<void>;
  createSession(session: PersistedAgentRuntimeSession): Promise<void>;
  getSession(id: string): Promise<PersistedAgentRuntimeSession | null>;
  updateSession(id: string, patch: UpdateAgentRuntimeSession): Promise<void>;
  listRecoverableSessions(projectId?: string): Promise<PersistedAgentRuntimeSession[]>;
  findSessionForRoute(input: {
    projectId: string;
    routeKind: 'chat' | 'goal';
    conversationId?: string | null;
    goalRunId?: string | null;
    chapterId?: string | null;
  }): Promise<PersistedAgentRuntimeSession | null>;

  createTurn(turn: PersistedAgentRuntimeTurn): Promise<void>;
  getTurn(id: string): Promise<PersistedAgentRuntimeTurn | null>;
  updateTurn(id: string, patch: UpdateAgentRuntimeTurn): Promise<void>;
  listTurns(sessionId: string): Promise<PersistedAgentRuntimeTurn[]>;

  createMessage(message: PersistedAgentRuntimeMessage): Promise<void>;
  getMessage(id: string): Promise<PersistedAgentRuntimeMessage | null>;
  updateMessage(id: string, patch: UpdateAgentRuntimeMessage): Promise<void>;
  listMessages(sessionId: string): Promise<PersistedAgentRuntimeMessage[]>;

  appendEvent(event: PersistedAgentRuntimeEvent): Promise<AppendAgentRuntimeEventResult>;
  listEvents(sessionId: string): Promise<PersistedAgentRuntimeEvent[]>;

  createToolCall(toolCall: PersistedAgentRuntimeToolCall): Promise<IdempotentPersistenceOutcome>;
  /**
   * Point lookup for the hot execution path. Long Agent turns can accumulate
   * hundreds of tool results, so callers that already know the durable id must
   * not load and JSON-decode the entire session tool ledger.
   */
  getToolCall?(id: string): Promise<PersistedAgentRuntimeToolCall | null>;
  updateToolCall(id: string, patch: UpdateAgentRuntimeToolCall): Promise<void>;
  listToolCalls(sessionId: string): Promise<PersistedAgentRuntimeToolCall[]>;

  createCheckpoint(
    checkpoint: PersistedAgentRuntimeCheckpoint,
  ): Promise<IdempotentPersistenceOutcome>;
  listCheckpoints(sessionId: string): Promise<PersistedAgentRuntimeCheckpoint[]>;
  /** Full anchors and retained digest identities both witness an old commit. */
  hasCheckpointThroughTurn(sessionId: string, turnOrdinal: number): Promise<boolean>;

  /**
   * Durably accepts the user prompt before provider execution. New-session
   * creation, route ownership, turn allocation, and prompt insertion share one
   * IMMEDIATE transaction.
   */
  acceptTurn(input: AcceptAgentRuntimeTurnInput): Promise<IdempotentPersistenceOutcome>;
  markTurnRunning(sessionId: string, turnId: string, startedAt: string): Promise<void>;
  /** Atomically settles a turn; partial provider messages are never accepted. */
  commitTurn(input: CommitAgentRuntimeTurnInput): Promise<IdempotentPersistenceOutcome>;
  /** Marks in-flight state once after an unclean renderer/process restart. */
  interruptSession(sessionId: string, interruptedAt: string): Promise<void>;
  /** Commits recovered-control journal entries and interruption as one unit. */
  interruptSessionWithEvents(
    sessionId: string,
    interruptedAt: string,
    events: readonly PersistedAgentRuntimeEvent[],
  ): Promise<void>;

  loadRecoverySnapshot(sessionId: string): Promise<AgentRuntimeRecoverySnapshot | null>;
}

/**
 * Stable JSON encoding makes replay idempotency independent of object key
 * insertion order. Undefined, bigint, cycles, and non-finite numbers are
 * rejected instead of silently changing the durable payload.
 */
export function canonicalAgentRuntimeJson(value: unknown): string {
  const seen = new Set<object>();

  const normalize = (input: unknown): unknown => {
    if (
      input === null ||
      typeof input === 'string' ||
      typeof input === 'boolean'
    ) {
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        throw new AgentRuntimePersistenceConflictError(
          'INVALID_JSON_PAYLOAD',
          'Agent runtime payload contains a non-finite number.',
        );
      }
      return input;
    }
    if (typeof input !== 'object') {
      throw new AgentRuntimePersistenceConflictError(
        'INVALID_JSON_PAYLOAD',
        `Agent runtime payload contains unsupported ${typeof input}.`,
      );
    }
    if (seen.has(input)) {
      throw new AgentRuntimePersistenceConflictError(
        'INVALID_JSON_PAYLOAD',
        'Agent runtime payload contains a cycle.',
      );
    }
    seen.add(input);
    try {
      if (Array.isArray(input)) return input.map(normalize);
      const record = input as Record<string, unknown>;
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        normalized[key] = normalize(record[key]);
      }
      return normalized;
    } finally {
      seen.delete(input);
    }
  };

  return JSON.stringify(normalize(value));
}

function parseJson(json: string): unknown {
  return JSON.parse(json) as unknown;
}

function sessionToDomain(
  row: typeof AgentRuntimeSessionTable.$inferSelect,
): PersistedAgentRuntimeSession {
  return {
    ...row,
    routeKind: row.routeKind as PersistedAgentRuntimeSession['routeKind'],
    conversationId: row.conversationId ?? null,
    goalRunId: row.goalRunId ?? null,
    chapterId: row.chapterId ?? null,
    model: row.model ?? null,
    status: row.status as AgentRuntimeSessionStatus,
    endedAt: row.endedAt ?? null,
  };
}

function turnToDomain(
  row: typeof AgentRuntimeTurnTable.$inferSelect,
): PersistedAgentRuntimeTurn {
  return {
    ...row,
    status: row.status as AgentRuntimeTurnStatus,
    promptMessageId: row.promptMessageId ?? null,
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
  };
}

function messageToDomain(
  row: typeof AgentRuntimeMessageTable.$inferSelect,
): PersistedAgentRuntimeMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId ?? null,
    ordinal: row.ordinal,
    role: row.role as AgentRuntimeMessageRole,
    status: row.status as AgentRuntimeMessageStatus,
    content: parseJson(row.contentJson),
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
  };
}

function toolCallToDomain(
  row: typeof AgentRuntimeToolCallTable.$inferSelect,
): PersistedAgentRuntimeToolCall {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    callId: row.callId,
    name: row.name,
    access: row.access as PersistedAgentRuntimeToolCall['access'],
    status: row.status as AgentRuntimeToolCallStatus,
    idempotencyKey: row.idempotencyKey,
    arguments: parseJson(row.argumentsJson),
    result: row.resultJson === null ? null : parseJson(row.resultJson),
    errorCode: row.errorCode ?? null,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
  };
}

function checkpointToDomain(
  row: typeof AgentRuntimeCheckpointTable.$inferSelect,
): PersistedAgentRuntimeCheckpoint {
  return {
    id: row.id,
    sessionId: row.sessionId,
    throughTurnOrdinal: row.throughTurnOrdinal,
    messageCount: row.messageCount,
    context: parseJson(
      row.contextJson,
    ) as PersistedAgentRuntimeCheckpoint['context'],
    contextHash: row.contextHash,
    createdAt: row.createdAt,
  };
}

function eventToDomain(
  row: typeof AgentRuntimeEventTable.$inferSelect,
): PersistedAgentRuntimeEvent {
  return {
    eventId: row.eventId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    seq: row.seq,
    schemaVersion: row.schemaVersion,
    eventType: row.eventType,
    payload: parseJson(row.payloadJson),
    wallTimeMs: row.wallTimeMs,
    createdAt: row.createdAt,
  };
}

function sameSessionIdentity(
  a: PersistedAgentRuntimeSession,
  b: PersistedAgentRuntimeSession,
): boolean {
  return (
    a.id === b.id &&
    a.projectId === b.projectId &&
    a.routeKind === b.routeKind &&
    a.conversationId === b.conversationId &&
    a.goalRunId === b.goalRunId &&
    a.chapterId === b.chapterId
  );
}

function sameTurn(
  a: PersistedAgentRuntimeTurn,
  b: PersistedAgentRuntimeTurn,
): boolean {
  return canonicalAgentRuntimeJson(a) === canonicalAgentRuntimeJson(b);
}

function sameMessage(
  a: PersistedAgentRuntimeMessage,
  b: PersistedAgentRuntimeMessage,
): boolean {
  return canonicalAgentRuntimeJson(a) === canonicalAgentRuntimeJson(b);
}

function sameToolCall(
  a: PersistedAgentRuntimeToolCall,
  b: PersistedAgentRuntimeToolCall,
): boolean {
  return canonicalAgentRuntimeJson(a) === canonicalAgentRuntimeJson(b);
}

function sameCheckpoint(
  a: PersistedAgentRuntimeCheckpoint,
  b: PersistedAgentRuntimeCheckpoint,
): boolean {
  return canonicalAgentRuntimeJson(a) === canonicalAgentRuntimeJson(b);
}

const RETAINED_CHECKPOINT_DIGEST_FORMAT =
  'drifting.agent-runtime-checkpoint-digest' as const;

interface RetainedCheckpointDigest {
  schemaVersion: 1;
  format: typeof RETAINED_CHECKPOINT_DIGEST_FORMAT;
  contextHash: string;
}

function isRetainedCheckpointDigest(
  value: unknown,
): value is RetainedCheckpointDigest {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
      (value as { format?: unknown }).format ===
        RETAINED_CHECKPOINT_DIGEST_FORMAT &&
      typeof (value as { contextHash?: unknown }).contextHash ===
        'string',
  );
}

function sameCheckpointOrRetainedDigest(
  durable: PersistedAgentRuntimeCheckpoint,
  candidate: PersistedAgentRuntimeCheckpoint,
): boolean {
  const durableContext: unknown = durable.context;
  if (!isRetainedCheckpointDigest(durableContext)) {
    return sameCheckpoint(durable, candidate);
  }
  return (
    durable.id === candidate.id &&
    durable.sessionId === candidate.sessionId &&
    durable.throughTurnOrdinal === candidate.throughTurnOrdinal &&
    durable.messageCount === candidate.messageCount &&
    durable.contextHash === candidate.contextHash &&
    durableContext.contextHash === candidate.contextHash &&
    durable.createdAt === candidate.createdAt
  );
}

function checkpointCanonicalMessageCount(
  context: PersistedAgentRuntimeCheckpoint['context'],
): number | null {
  if (
    typeof context === 'object' &&
    context !== null &&
    'schemaVersion' in context &&
    context.schemaVersion === 4 &&
    'format' in context &&
    context.format === 'drifting.agent-runtime-checkpoint-digest-with-summaries' &&
    'canonicalMessageCount' in context &&
    typeof context.canonicalMessageCount === 'number' &&
    Number.isSafeInteger(context.canonicalMessageCount) &&
    context.canonicalMessageCount >= 0
  ) {
    return context.canonicalMessageCount;
  }
  if (
    typeof context !== 'object' ||
    context === null ||
    !('schemaVersion' in context) ||
    !('format' in context) ||
    !(
      (context.schemaVersion === 2 &&
        context.format === 'drifting.agent-runtime-checkpoint-context') ||
      (context.schemaVersion === 3 &&
        context.format ===
          'drifting.agent-runtime-checkpoint-context-with-summaries')
    ) ||
    !('canonicalHistory' in context) ||
    !Array.isArray(context.canonicalHistory)
  ) {
    return null;
  }
  return context.canonicalHistory.length;
}

function sameEvent(
  row: typeof AgentRuntimeEventTable.$inferSelect,
  event: PersistedAgentRuntimeEvent,
  payloadJson: string,
): boolean {
  return (
    row.sessionId === event.sessionId &&
    row.turnId === event.turnId &&
    row.seq === event.seq &&
    row.schemaVersion === event.schemaVersion &&
    row.eventType === event.eventType &&
    row.payloadJson === payloadJson &&
    row.wallTimeMs === event.wallTimeMs &&
    row.createdAt === event.createdAt
  );
}

export interface AgentRuntimeEventFingerprint {
  eventId: string;
  sessionId: string;
  turnId: string;
  seq: number;
  schemaVersion: number;
  eventType: string;
  payloadJson: string;
  wallTimeMs: number;
  createdAt: string;
}

export function classifyAgentRuntimeEventReplay(
  existing: AgentRuntimeEventFingerprint | undefined,
  event: PersistedAgentRuntimeEvent,
  payloadJson: string,
): 'new' | 'duplicate' {
  if (!existing) return 'new';
  if (sameEvent(existing, event, payloadJson)) return 'duplicate';
  throw new AgentRuntimePersistenceConflictError(
    'EVENT_ID_CONFLICT',
    `Agent runtime event ${event.eventId} was replayed with different content.`,
  );
}

export function assertAgentRuntimeEventSequence(
  turnId: string,
  seq: number,
  maxSeq: number | null,
  collisionEventId?: string,
): void {
  if (collisionEventId) {
    throw new AgentRuntimePersistenceConflictError(
      'EVENT_SEQ_CONFLICT',
      `Agent runtime turn ${turnId} already has seq ${seq} (${collisionEventId}).`,
    );
  }
  const expectedSeq = (maxSeq ?? 0) + 1;
  if (seq !== expectedSeq) {
    throw new AgentRuntimePersistenceConflictError(
      'EVENT_SEQ_GAP',
      `Agent runtime turn ${turnId} expected seq ${expectedSeq}, received ${seq}.`,
    );
  }
}

export function createAgentRuntimePersistenceRepository(
  dbOverride?: DbExecutor,
): AgentRuntimePersistenceRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const getSession = async (
    id: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeSession | null> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeSessionTable)
      .where(eq(AgentRuntimeSessionTable.id, id))
      .limit(1);
    return rows[0] ? sessionToDomain(rows[0]) : null;
  };

  const getTurn = async (
    id: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeTurn | null> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeTurnTable)
      .where(eq(AgentRuntimeTurnTable.id, id))
      .limit(1);
    return rows[0] ? turnToDomain(rows[0]) : null;
  };

  const getMessage = async (
    id: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeMessage | null> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeMessageTable)
      .where(eq(AgentRuntimeMessageTable.id, id))
      .limit(1);
    return rows[0] ? messageToDomain(rows[0]) : null;
  };

  const listTurns = async (
    sessionId: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeTurn[]> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeTurnTable)
      .where(eq(AgentRuntimeTurnTable.sessionId, sessionId))
      .orderBy(asc(AgentRuntimeTurnTable.ordinal));
    return rows.map(turnToDomain);
  };

  const listMessages = async (
    sessionId: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeMessage[]> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeMessageTable)
      .where(eq(AgentRuntimeMessageTable.sessionId, sessionId))
      .orderBy(asc(AgentRuntimeMessageTable.ordinal));
    return rows.map(messageToDomain);
  };

  const listEvents = async (
    sessionId: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeEvent[]> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeEventTable)
      .where(eq(AgentRuntimeEventTable.sessionId, sessionId));
    const turns = await listTurns(sessionId, executor);
    const ordinalByTurn = new Map(turns.map((turn) => [turn.id, turn.ordinal]));
    return rows
      .map(eventToDomain)
      .sort(
        (a, b) =>
          (ordinalByTurn.get(a.turnId) ?? Number.MAX_SAFE_INTEGER) -
            (ordinalByTurn.get(b.turnId) ?? Number.MAX_SAFE_INTEGER) ||
          a.seq - b.seq ||
          a.eventId.localeCompare(b.eventId),
      );
  };

  const listToolCalls = async (
    sessionId: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeToolCall[]> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeToolCallTable)
      .where(eq(AgentRuntimeToolCallTable.sessionId, sessionId))
      .orderBy(
        asc(AgentRuntimeToolCallTable.createdAt),
        asc(AgentRuntimeToolCallTable.id),
      );
    return rows.map(toolCallToDomain);
  };

  const getToolCall = async (
    id: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeToolCall | null> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeToolCallTable)
      .where(eq(AgentRuntimeToolCallTable.id, id))
      .limit(1);
    return rows[0] ? toolCallToDomain(rows[0]) : null;
  };

  const listCheckpoints = async (
    sessionId: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeCheckpoint[]> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeCheckpointTable)
      .where(and(eq(AgentRuntimeCheckpointTable.sessionId, sessionId), fullAgentCheckpointPredicate(AgentRuntimeCheckpointTable)))
      .orderBy(asc(AgentRuntimeCheckpointTable.throughTurnOrdinal));
    return rows
      .map(checkpointToDomain)
      .filter(
        (checkpoint) =>
          !isRetainedCheckpointDigest(checkpoint.context),
      );
  };

  const insertMessage = async (
    executor: DbExecutor,
    message: PersistedAgentRuntimeMessage,
  ): Promise<void> => {
    await executor.insert(AgentRuntimeMessageTable).values({
      id: message.id,
      sessionId: message.sessionId,
      turnId: message.turnId,
      ordinal: message.ordinal,
      role: message.role,
      status: message.status,
      contentJson: canonicalAgentRuntimeJson(message.content),
      createdAt: message.createdAt,
      completedAt: message.completedAt,
    });
  };

  const insertToolCall = async (
    executor: DbExecutor,
    toolCall: PersistedAgentRuntimeToolCall,
  ): Promise<void> => {
    await executor.insert(AgentRuntimeToolCallTable).values({
      id: toolCall.id,
      sessionId: toolCall.sessionId,
      turnId: toolCall.turnId,
      callId: toolCall.callId,
      name: toolCall.name,
      access: toolCall.access,
      status: toolCall.status,
      idempotencyKey: toolCall.idempotencyKey,
      argumentsJson: canonicalAgentRuntimeJson(toolCall.arguments),
      resultJson:
        toolCall.result === null
          ? null
          : canonicalAgentRuntimeJson(toolCall.result),
      errorCode: toolCall.errorCode,
      createdAt: toolCall.createdAt,
      startedAt: toolCall.startedAt,
      completedAt: toolCall.completedAt,
    });
  };

  const insertCheckpoint = async (
    executor: DbExecutor,
    checkpoint: PersistedAgentRuntimeCheckpoint,
  ): Promise<void> => {
    await executor.insert(AgentRuntimeCheckpointTable).values({
      id: checkpoint.id,
      sessionId: checkpoint.sessionId,
      throughTurnOrdinal: checkpoint.throughTurnOrdinal,
      messageCount: checkpoint.messageCount,
      contextJson: canonicalAgentRuntimeJson(checkpoint.context),
      contextHash: checkpoint.contextHash,
      createdAt: checkpoint.createdAt,
    });
  };

  const compactOlderCheckpoints = async (
    executor: DbExecutor,
    checkpoint: PersistedAgentRuntimeCheckpoint,
  ): Promise<void> => {
    // Retain the new anchor and the latest actual older anchor. Failed and
    // cancelled turns need not have checkpoints, so adjacent turn ordinals
    // cannot define retention. Recovery still fails closed on corruption.
    // The partial index omits exact retained digests without loading/parsing
    // the entire historical ledger on every completed turn.
    const rows = await executor
      .select()
      .from(AgentRuntimeCheckpointTable)
      .where(
        and(
          eq(
            AgentRuntimeCheckpointTable.sessionId,
            checkpoint.sessionId,
          ),
          lt(
            AgentRuntimeCheckpointTable.throughTurnOrdinal,
            checkpoint.throughTurnOrdinal,
          ),
          fullAgentCheckpointPredicate(AgentRuntimeCheckpointTable),
        ),
      )
      .orderBy(desc(AgentRuntimeCheckpointTable.throughTurnOrdinal));
    const olderAnchors = rows.map(checkpointToDomain)
      .filter((durable) => !isRetainedCheckpointDigest(durable.context));
    for (const durable of olderAnchors.slice(1)) {
      const digest: RetainedCheckpointDigest = {
        schemaVersion: 1,
        format: RETAINED_CHECKPOINT_DIGEST_FORMAT,
        contextHash: durable.contextHash,
      };
      await executor
        .update(AgentRuntimeCheckpointTable)
        .set({ contextJson: canonicalAgentRuntimeJson(digest) })
        .where(eq(AgentRuntimeCheckpointTable.id, durable.id));
    }
  };

  const loadRecoverySnapshot = async (
    sessionId: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<AgentRuntimeRecoverySnapshot | null> => {
    const session = await getSession(sessionId, executor);
    if (!session) return null;
    // Keep operations sequential inside the native transaction. The Tauri
    // gateway binds one SQLite transaction ID and must not be driven by
    // concurrent Promise branches.
    const turns = await listTurns(sessionId, executor);
    const messages = await listMessages(sessionId, executor);
    const events = await listEvents(sessionId, executor);
    const toolCalls = await listToolCalls(sessionId, executor);
    const checkpoints = await listCheckpoints(sessionId, executor);
    return {
      session,
      turns,
      messages,
      events,
      toolCalls,
      checkpoints,
    };
  };

  return {
    async loadPortableDisplay(sessionId) {
      const { loadImportedChatDisplay } = await import('../sync/agent-chat/imported-history');
      return loadImportedChatDisplay(dbProvider() as import('../lib/db').DbClient, sessionId);
    },
    async preparePortableHistory(input) {
      const { seedAgentChatSession } = await import('../sync/agent-chat/seed');
      await seedAgentChatSession(dbProvider() as import('../lib/db').DbClient, input.conversationId, input.projectId, input.provider, input.model);
    },
    async createSession(session) {
      await dbProvider().insert(AgentRuntimeSessionTable).values(session);
    },
    getSession,
    async updateSession(id, patch) {
      await dbProvider()
        .update(AgentRuntimeSessionTable)
        .set(patch)
        .where(eq(AgentRuntimeSessionTable.id, id));
    },
    async listRecoverableSessions(projectId) {
      const recoverable = or(
        eq(AgentRuntimeSessionTable.status, 'pending'),
        eq(AgentRuntimeSessionTable.status, 'running'),
        eq(AgentRuntimeSessionTable.status, 'recovering'),
      )!;
      const where = projectId
        ? and(eq(AgentRuntimeSessionTable.projectId, projectId), recoverable)
        : recoverable;
      const rows = await dbProvider()
        .select()
        .from(AgentRuntimeSessionTable)
        .where(where)
        .orderBy(desc(AgentRuntimeSessionTable.updatedAt));
      return rows.map(sessionToDomain);
    },
    async findSessionForRoute(input) {
      const usable = or(
        eq(AgentRuntimeSessionTable.status, 'pending'),
        eq(AgentRuntimeSessionTable.status, 'idle'),
        eq(AgentRuntimeSessionTable.status, 'running'),
        eq(AgentRuntimeSessionTable.status, 'recovering'),
        eq(AgentRuntimeSessionTable.status, 'interrupted'),
        eq(AgentRuntimeSessionTable.status, 'failed'),
      )!;
      const route =
        input.routeKind === 'chat'
          ? and(
              eq(AgentRuntimeSessionTable.projectId, input.projectId),
              eq(AgentRuntimeSessionTable.routeKind, 'chat'),
              input.conversationId
                ? eq(
                    AgentRuntimeSessionTable.conversationId,
                    input.conversationId,
                  )
                : isNull(AgentRuntimeSessionTable.conversationId),
              usable,
            )
          : and(
              eq(AgentRuntimeSessionTable.projectId, input.projectId),
              eq(AgentRuntimeSessionTable.routeKind, 'goal'),
              input.goalRunId
                ? eq(AgentRuntimeSessionTable.goalRunId, input.goalRunId)
                : isNull(AgentRuntimeSessionTable.goalRunId),
              input.chapterId
                ? eq(AgentRuntimeSessionTable.chapterId, input.chapterId)
                : isNull(AgentRuntimeSessionTable.chapterId),
              usable,
            );
      const rows = await dbProvider()
        .select()
        .from(AgentRuntimeSessionTable)
        .where(route)
        .orderBy(desc(AgentRuntimeSessionTable.updatedAt))
        .limit(1);
      return rows[0] ? sessionToDomain(rows[0]) : null;
    },

    async createTurn(turn) {
      await dbProvider().insert(AgentRuntimeTurnTable).values(turn);
    },
    getTurn,
    async updateTurn(id, patch) {
      await dbProvider()
        .update(AgentRuntimeTurnTable)
        .set(patch)
        .where(eq(AgentRuntimeTurnTable.id, id));
    },
    listTurns,

    async createMessage(message) {
      await insertMessage(dbProvider(), message);
    },
    getMessage,
    async updateMessage(id, patch) {
      const values: Partial<typeof AgentRuntimeMessageTable.$inferInsert> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.content !== undefined) {
        values.contentJson = canonicalAgentRuntimeJson(patch.content);
      }
      if (patch.completedAt !== undefined) values.completedAt = patch.completedAt;
      await dbProvider()
        .update(AgentRuntimeMessageTable)
        .set(values)
        .where(eq(AgentRuntimeMessageTable.id, id));
    },
    listMessages,

    async appendEvent(event) {
      const payloadJson = canonicalAgentRuntimeJson(event.payload);
      return dbProvider().transaction(async (tx) => {
        const existingById = await tx
          .select()
          .from(AgentRuntimeEventTable)
          .where(eq(AgentRuntimeEventTable.eventId, event.eventId))
          .limit(1);
        if (
          classifyAgentRuntimeEventReplay(
            existingById[0],
            event,
            payloadJson,
          ) === 'duplicate'
        ) {
          return { outcome: 'duplicate', event: eventToDomain(existingById[0]) };
        }

        const turnRows = await tx
          .select({ sessionId: AgentRuntimeTurnTable.sessionId })
          .from(AgentRuntimeTurnTable)
          .where(eq(AgentRuntimeTurnTable.id, event.turnId))
          .limit(1);
        if (!turnRows[0] || turnRows[0].sessionId !== event.sessionId) {
          throw new AgentRuntimePersistenceConflictError(
            'EVENT_SESSION_MISMATCH',
            `Agent runtime turn ${event.turnId} does not belong to session ${event.sessionId}.`,
          );
        }

        const collision = await tx
          .select({ eventId: AgentRuntimeEventTable.eventId })
          .from(AgentRuntimeEventTable)
          .where(
            and(
              eq(AgentRuntimeEventTable.turnId, event.turnId),
              eq(AgentRuntimeEventTable.seq, event.seq),
            ),
          )
          .limit(1);
        const maxRows = await tx
          .select({ maxSeq: max(AgentRuntimeEventTable.seq) })
          .from(AgentRuntimeEventTable)
          .where(eq(AgentRuntimeEventTable.turnId, event.turnId));
        assertAgentRuntimeEventSequence(
          event.turnId,
          event.seq,
          maxRows[0]?.maxSeq ?? null,
          collision[0]?.eventId,
        );

        await tx.insert(AgentRuntimeEventTable).values({
          eventId: event.eventId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          seq: event.seq,
          schemaVersion: event.schemaVersion,
          eventType: event.eventType,
          payloadJson,
          wallTimeMs: event.wallTimeMs,
          createdAt: event.createdAt,
        });
        return { outcome: 'inserted', event };
      }, { behavior: 'immediate' });
    },
    listEvents,

    async createToolCall(toolCall) {
      return dbProvider().transaction(async (tx) => {
        const existingRows = await tx
          .select()
          .from(AgentRuntimeToolCallTable)
          .where(
            or(
              eq(AgentRuntimeToolCallTable.id, toolCall.id),
              and(
                eq(AgentRuntimeToolCallTable.turnId, toolCall.turnId),
                eq(AgentRuntimeToolCallTable.callId, toolCall.callId),
              ),
              eq(
                AgentRuntimeToolCallTable.idempotencyKey,
                toolCall.idempotencyKey,
              ),
            ),
          );
        if (existingRows.length > 0) {
          if (
            existingRows.length === 1 &&
            sameToolCall(toolCallToDomain(existingRows[0]), toolCall)
          ) {
            return 'duplicate';
          }
          throw new AgentRuntimePersistenceConflictError(
            'TOOL_CALL_CONFLICT',
            `Agent tool call ${toolCall.callId} conflicts with durable state.`,
          );
        }
        const turn = await getTurn(toolCall.turnId, tx);
        if (!turn || turn.sessionId !== toolCall.sessionId) {
          throw new AgentRuntimePersistenceConflictError(
            'EVENT_SESSION_MISMATCH',
            `Agent runtime turn ${toolCall.turnId} does not belong to session ${toolCall.sessionId}.`,
          );
        }
        await insertToolCall(tx, toolCall);
        return 'inserted';
      }, { behavior: 'immediate' });
    },
    async updateToolCall(id, patch) {
      const values: Partial<typeof AgentRuntimeToolCallTable.$inferInsert> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.result !== undefined) {
        values.resultJson =
          patch.result === null
            ? null
            : canonicalAgentRuntimeJson(patch.result);
      }
      if (patch.errorCode !== undefined) values.errorCode = patch.errorCode;
      if (patch.startedAt !== undefined) values.startedAt = patch.startedAt;
      if (patch.completedAt !== undefined) values.completedAt = patch.completedAt;
      await dbProvider()
        .update(AgentRuntimeToolCallTable)
        .set(values)
        .where(eq(AgentRuntimeToolCallTable.id, id));
    },
    getToolCall,
    listToolCalls,

    async createCheckpoint(checkpoint) {
      return dbProvider().transaction(async (tx) => {
        const existingRows = await tx
          .select()
          .from(AgentRuntimeCheckpointTable)
          .where(
            or(
              eq(AgentRuntimeCheckpointTable.id, checkpoint.id),
              and(
                eq(
                  AgentRuntimeCheckpointTable.sessionId,
                  checkpoint.sessionId,
                ),
                eq(
                  AgentRuntimeCheckpointTable.throughTurnOrdinal,
                  checkpoint.throughTurnOrdinal,
                ),
              ),
            ),
          );
        if (existingRows.length > 0) {
          if (
            existingRows.length === 1 &&
            sameCheckpointOrRetainedDigest(
              checkpointToDomain(existingRows[0]),
              checkpoint,
            )
          ) {
            return 'duplicate';
          }
          throw new AgentRuntimePersistenceConflictError(
            'CHECKPOINT_CONFLICT',
            `Agent checkpoint ${checkpoint.id} conflicts with durable state.`,
          );
        }
        await insertCheckpoint(tx, checkpoint);
        return 'inserted';
      }, { behavior: 'immediate' });
    },
    listCheckpoints,
    async hasCheckpointThroughTurn(sessionId, turnOrdinal) {
      const rows = await dbProvider().select({ id: AgentRuntimeCheckpointTable.id })
        .from(AgentRuntimeCheckpointTable)
        .where(and(eq(AgentRuntimeCheckpointTable.sessionId, sessionId), eq(AgentRuntimeCheckpointTable.throughTurnOrdinal, turnOrdinal)))
        .limit(1);
      return rows.length > 0;
    },

    async acceptTurn({ session, turn, promptMessage }) {
      return dbProvider().transaction(async (tx) => {
        const existingSession = await getSession(session.id, tx);
        if (existingSession && !sameSessionIdentity(existingSession, session)) {
          throw new AgentRuntimePersistenceConflictError(
            'SESSION_IDENTITY_CONFLICT',
            `Agent runtime session ${session.id} was reused for a different route.`,
          );
        }
        if (
          session.routeKind === 'chat'
            ? !session.conversationId ||
              session.goalRunId !== null ||
              session.chapterId !== null
            : session.conversationId !== null
        ) {
          throw new AgentRuntimePersistenceConflictError(
            'ROUTE_OWNERSHIP_MISMATCH',
            `Agent runtime session ${session.id} has an invalid ${session.routeKind} route shape.`,
          );
        }
        if (session.conversationId) {
          const conversations = await tx
            .select({
              projectId: AgentConversationTable.projectId,
              deletedAt: AgentConversationTable.deletedAt,
            })
            .from(AgentConversationTable)
            .where(eq(AgentConversationTable.id, session.conversationId))
            .limit(1);
          if (
            !conversations[0] ||
            conversations[0].projectId !== session.projectId ||
            conversations[0].deletedAt !== null
          ) {
            throw new AgentRuntimePersistenceConflictError(
              'ROUTE_OWNERSHIP_MISMATCH',
              `Conversation ${session.conversationId} does not belong to active project ${session.projectId}.`,
            );
          }
        }
        if (
          turn.sessionId !== session.id ||
          promptMessage.sessionId !== session.id ||
          promptMessage.turnId !== turn.id ||
          turn.promptMessageId !== promptMessage.id ||
          promptMessage.role !== 'user' ||
          promptMessage.status !== 'complete'
        ) {
          throw new AgentRuntimePersistenceConflictError(
            'ROUTE_OWNERSHIP_MISMATCH',
            'Accepted turn, prompt, and session ownership do not match.',
          );
        }

        const existingTurn = await getTurn(turn.id, tx);
        const existingMessage = await getMessage(promptMessage.id, tx);
        if (existingTurn || existingMessage) {
          if (
            existingTurn &&
            existingMessage &&
            sameTurn(existingTurn, turn) &&
            sameMessage(existingMessage, promptMessage)
          ) {
            return 'duplicate';
          }
          throw new AgentRuntimePersistenceConflictError(
            existingTurn ? 'TURN_ID_CONFLICT' : 'MESSAGE_ID_CONFLICT',
            `Agent turn ${turn.id} or prompt ${promptMessage.id} conflicts with durable state.`,
          );
        }

        if (!existingSession) {
          await tx.insert(AgentRuntimeSessionTable).values(session);
        }
        const maxTurnRows = await tx
          .select({ ordinal: max(AgentRuntimeTurnTable.ordinal) })
          .from(AgentRuntimeTurnTable)
          .where(eq(AgentRuntimeTurnTable.sessionId, session.id));
        const expectedTurnOrdinal = (maxTurnRows[0]?.ordinal ?? -1) + 1;
        if (turn.ordinal !== expectedTurnOrdinal) {
          throw new AgentRuntimePersistenceConflictError(
            'TURN_ORDINAL_CONFLICT',
            `Agent session ${session.id} expected turn ordinal ${expectedTurnOrdinal}, received ${turn.ordinal}.`,
          );
        }
        const maxMessageRows = await tx
          .select({ ordinal: max(AgentRuntimeMessageTable.ordinal) })
          .from(AgentRuntimeMessageTable)
          .where(eq(AgentRuntimeMessageTable.sessionId, session.id));
        const expectedMessageOrdinal = (maxMessageRows[0]?.ordinal ?? -1) + 1;
        if (promptMessage.ordinal !== expectedMessageOrdinal) {
          throw new AgentRuntimePersistenceConflictError(
            'MESSAGE_ORDINAL_CONFLICT',
            `Agent session ${session.id} expected message ordinal ${expectedMessageOrdinal}, received ${promptMessage.ordinal}.`,
          );
        }

        await tx.insert(AgentRuntimeTurnTable).values(turn);
        await insertMessage(tx, promptMessage);
        await tx
          .update(AgentRuntimeSessionTable)
          .set({
            provider: session.provider,
            model: session.model,
            providerEpoch: session.providerEpoch,
            status: 'running',
            updatedAt: turn.acceptedAt,
            endedAt: null,
          })
          .where(eq(AgentRuntimeSessionTable.id, session.id));
        if (session.conversationId) {
          await tx
            .update(AgentConversationTable)
            .set({
              runtimeSessionId: session.id,
              updatedAt: turn.acceptedAt,
            })
            .where(eq(AgentConversationTable.id, session.conversationId));
        }
        return 'inserted';
      }, { behavior: 'immediate' });
    },

    async markTurnRunning(sessionId, turnId, startedAt) {
      await dbProvider().transaction(async (tx) => {
        const turn = await getTurn(turnId, tx);
        if (!turn || turn.sessionId !== sessionId) {
          throw new AgentRuntimePersistenceConflictError(
            'EVENT_SESSION_MISMATCH',
            `Agent runtime turn ${turnId} does not belong to session ${sessionId}.`,
          );
        }
        if (turn.status !== 'accepted' && turn.status !== 'running') {
          throw new AgentRuntimePersistenceConflictError(
            'INVALID_TURN_STATE',
            `Agent runtime turn ${turnId} cannot start from ${turn.status}.`,
          );
        }
        await tx
          .update(AgentRuntimeTurnTable)
          .set({
            status: 'running',
            startedAt: turn.startedAt ?? startedAt,
            updatedAt: startedAt,
          })
          .where(eq(AgentRuntimeTurnTable.id, turnId));
        await tx
          .update(AgentRuntimeSessionTable)
          .set({ status: 'running', updatedAt: startedAt, endedAt: null })
          .where(eq(AgentRuntimeSessionTable.id, sessionId));
      }, { behavior: 'immediate' });
    },

    async commitTurn({
      sessionId,
      turnId,
      messages,
      checkpoint,
      terminalStatus,
      errorCode,
      errorMessage,
      endedAt,
    }) {
      return dbProvider().transaction(async (tx) => {
        const turn = await getTurn(turnId, tx);
        if (!turn || turn.sessionId !== sessionId) {
          throw new AgentRuntimePersistenceConflictError(
            'EVENT_SESSION_MISMATCH',
            `Agent runtime turn ${turnId} does not belong to session ${sessionId}.`,
          );
        }
        if (
          turn.status === 'completed' ||
          turn.status === 'failed' ||
          turn.status === 'aborted'
        ) {
          if (
            turn.status !== terminalStatus ||
            turn.endedAt !== endedAt ||
            turn.errorCode !== (errorCode ?? null) ||
            turn.errorMessage !== (errorMessage ?? null)
          ) {
            throw new AgentRuntimePersistenceConflictError(
              'INVALID_TURN_STATE',
              `Settled turn ${turnId} was replayed with a different terminal outcome.`,
            );
          }
          for (const message of messages) {
            const existing = await getMessage(message.id, tx);
            if (!existing || !sameMessage(existing, message)) {
              throw new AgentRuntimePersistenceConflictError(
                'MESSAGE_ID_CONFLICT',
                `Completed turn ${turnId} was replayed with different messages.`,
              );
            }
          }
          if (checkpoint) {
            const rows = await tx
              .select()
              .from(AgentRuntimeCheckpointTable)
              .where(eq(AgentRuntimeCheckpointTable.id, checkpoint.id))
              .limit(1);
            if (
              !rows[0] ||
              !sameCheckpointOrRetainedDigest(
                checkpointToDomain(rows[0]),
                checkpoint,
              )
            ) {
              throw new AgentRuntimePersistenceConflictError(
                'CHECKPOINT_CONFLICT',
                `Completed turn ${turnId} was replayed with a different checkpoint.`,
              );
            }
          }
          return 'duplicate';
        }
        if (
          turn.status !== 'accepted' &&
          turn.status !== 'running' &&
          turn.status !== 'recovering'
        ) {
          throw new AgentRuntimePersistenceConflictError(
            'INVALID_TURN_STATE',
            `Agent runtime turn ${turnId} cannot commit from ${turn.status}.`,
          );
        }
        if (terminalStatus !== 'completed' && checkpoint) {
          throw new AgentRuntimePersistenceConflictError(
            'CHECKPOINT_CONFLICT',
            `Failed or aborted turn ${turnId} cannot advance the context checkpoint.`,
          );
        }

        const maxMessageRows = await tx
          .select({ ordinal: max(AgentRuntimeMessageTable.ordinal) })
          .from(AgentRuntimeMessageTable)
          .where(eq(AgentRuntimeMessageTable.sessionId, sessionId));
        let expectedOrdinal = (maxMessageRows[0]?.ordinal ?? -1) + 1;
        for (const message of messages) {
          if (
            message.sessionId !== sessionId ||
            message.turnId !== turnId ||
            message.status !== 'complete' ||
            message.ordinal !== expectedOrdinal
          ) {
            throw new AgentRuntimePersistenceConflictError(
              'MESSAGE_ORDINAL_CONFLICT',
              `Agent turn ${turnId} received a non-canonical completion message at ordinal ${message.ordinal}.`,
            );
          }
          const existing = await getMessage(message.id, tx);
          if (existing) {
            throw new AgentRuntimePersistenceConflictError(
              'MESSAGE_ID_CONFLICT',
              `Agent message ${message.id} already exists.`,
            );
          }
          await insertMessage(tx, message);
          expectedOrdinal += 1;
        }
        if (checkpoint) {
          const checkpointMessageCount = checkpointCanonicalMessageCount(
            checkpoint.context,
          );
          if (
            checkpoint.sessionId !== sessionId ||
            checkpoint.throughTurnOrdinal !== turn.ordinal ||
            checkpointMessageCount === null ||
            checkpoint.messageCount !== checkpointMessageCount
          ) {
            throw new AgentRuntimePersistenceConflictError(
              'CHECKPOINT_CONFLICT',
              `Agent checkpoint ${checkpoint.id} does not describe committed turn ${turnId}.`,
            );
          }
          await insertCheckpoint(tx, checkpoint);
          await compactOlderCheckpoints(tx, checkpoint);
        }
        await tx
          .update(AgentRuntimeTurnTable)
          .set({
            status: terminalStatus,
            endedAt,
            errorCode: errorCode ?? null,
            errorMessage: errorMessage ?? null,
            updatedAt: endedAt,
          })
          .where(eq(AgentRuntimeTurnTable.id, turnId));
        await tx
          .update(AgentRuntimeSessionTable)
          .set({ status: 'idle', updatedAt: endedAt, endedAt: null })
          .where(eq(AgentRuntimeSessionTable.id, sessionId));
        return 'inserted';
      }, { behavior: 'immediate' }).then((outcome) => {
        // The transaction owns durability; wakeups are only an optimization.
        void getSession(sessionId).then((session) => { if (session?.conversationId) events.emit('agent:conversation-committed', { projectId: session.projectId }); }).catch(() => {});
        return outcome;
      });
    },

    async interruptSessionWithEvents(sessionId, interruptedAt, events) {
      await dbProvider().transaction(async (tx) => {
        const transactional = createAgentRuntimePersistenceRepository(tx);
        for (const event of events) {
          if (event.sessionId !== sessionId) {
            throw new AgentRuntimePersistenceConflictError(
              'EVENT_SESSION_MISMATCH',
              'Interruption events must belong to the interrupted session.',
            );
          }
          // Reuse sequence, identity and replay checks inside the outer
          // transaction. Nested repository transactions use savepoints.
          await transactional.appendEvent(event);
        }
        await transactional.interruptSession(sessionId, interruptedAt);
      }, { behavior: 'immediate' });
    },

    async interruptSession(sessionId, interruptedAt) {
      await dbProvider().transaction(async (tx) => {
        const recoverableTurnStatuses: AgentRuntimeTurnStatus[] = [
          'accepted',
          'running',
          'recovering',
        ];
        await tx
          .update(AgentRuntimeTurnTable)
          .set({
            status: 'interrupted',
            endedAt: interruptedAt,
            errorCode: 'PROCESS_INTERRUPTED',
            errorMessage: 'Agent process stopped before the turn committed.',
            updatedAt: interruptedAt,
          })
          .where(
            and(
              eq(AgentRuntimeTurnTable.sessionId, sessionId),
              inArray(AgentRuntimeTurnTable.status, recoverableTurnStatuses),
            ),
          );
        await tx
          .update(AgentRuntimeMessageTable)
          .set({ status: 'interrupted', completedAt: interruptedAt })
          .where(
            and(
              eq(AgentRuntimeMessageTable.sessionId, sessionId),
              eq(AgentRuntimeMessageTable.status, 'streaming'),
            ),
          );
        await tx
          .update(AgentRuntimeToolCallTable)
          .set({ status: 'interrupted', completedAt: interruptedAt })
          .where(
            and(
              eq(AgentRuntimeToolCallTable.sessionId, sessionId),
              or(
                eq(AgentRuntimeToolCallTable.status, 'requested'),
                and(
                  eq(AgentRuntimeToolCallTable.status, 'running'),
                  eq(AgentRuntimeToolCallTable.access, 'read'),
                ),
              ),
            ),
          );
        await tx
          .update(AgentRuntimeToolCallTable)
          .set({
            status: 'uncertain',
            completedAt: interruptedAt,
            errorCode: 'PROCESS_INTERRUPTED_AFTER_WRITE_START',
          })
          .where(
            and(
              eq(AgentRuntimeToolCallTable.sessionId, sessionId),
              eq(AgentRuntimeToolCallTable.status, 'running'),
              eq(AgentRuntimeToolCallTable.access, 'write'),
            ),
          );
        await tx
          .update(AgentRuntimeSessionTable)
          .set({ status: 'interrupted', updatedAt: interruptedAt })
          .where(
            and(
              eq(AgentRuntimeSessionTable.id, sessionId),
              inArray(AgentRuntimeSessionTable.status, [
                'pending',
                'running',
                'recovering',
              ]),
            ),
          );
      }, { behavior: 'immediate' });
    },

    async loadRecoverySnapshot(sessionId) {
      return dbProvider().transaction(async (tx) => {
        return loadRecoverySnapshot(sessionId, tx);
      });
    },
  };
}
