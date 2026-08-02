import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type {
  AgentChatMessage,
  AgentConvMode,
} from '../domain/agent-conversation';
import type {
  AgentUserCheckpoint,
  AgentUserCheckpointActionKind,
  AgentUserCheckpointActionStatus,
  AgentUserCheckpointEntity,
  AgentUserCheckpointEntityActionStatus,
  AgentUserCheckpointKind,
  AgentUserCheckpointSummary,
} from '../domain/agent-user-checkpoint';
import type { AgentModelMessage } from '../lib/agent/runtime/types';
import type { ProseEntityType } from '../lib/yjs-doc-id';
import { getDb, type DbExecutor } from '../lib/db';
import {
  AgentConversationTable,
  AgentUserCheckpointActionEntityTable,
  AgentUserCheckpointActionTable,
  AgentUserCheckpointEntityTable,
  AgentUserCheckpointTable,
} from '../schema/drizzle';

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Corrupt ${label} JSON`);
  }
}

function normalizeBlob(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return new Uint8Array(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (input && typeof input === 'object') {
    const maybe = input as { type?: string; data?: number[] };
    if (maybe.type === 'Buffer' && Array.isArray(maybe.data)) {
      return Uint8Array.from(maybe.data);
    }
  }
  throw new Error('Unsupported blob format in Agent user checkpoint');
}

function checkpointFromRow(
  row: typeof AgentUserCheckpointTable.$inferSelect,
): AgentUserCheckpoint {
  return {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    runtimeSessionId: row.runtimeSessionId ?? null,
    sourceTurnId: row.sourceTurnId ?? null,
    parentCheckpointId: row.parentCheckpointId ?? null,
    kind: row.kind as AgentUserCheckpointKind,
    status: row.status as AgentUserCheckpoint['status'],
    label: row.label,
    pinned: row.pinned,
    canonicalThroughTurnOrdinal: row.canonicalThroughTurnOrdinal,
    canonicalContextHash: row.canonicalContextHash ?? null,
    conversationMessages: parseJson<AgentChatMessage[]>(
      row.conversationMessagesJson,
      'checkpoint conversation',
    ),
    providerHistory: parseJson<AgentModelMessage[]>(
      row.providerHistoryJson,
      'checkpoint provider history',
    ),
    longTaskState: row.longTaskStateJson
      ? parseJson<unknown>(row.longTaskStateJson, 'checkpoint long-task state')
      : null,
    acceptedWriteEffectIds: parseJson<string[]>(
      row.acceptedWriteEffectIdsJson,
      'checkpoint accepted-write ids',
    ),
    entityCount: row.entityCount,
    createdAt: row.createdAt,
    finalizedAt: row.finalizedAt ?? null,
    deletedAt: row.deletedAt ?? null,
  };
}

function entityFromRow(
  row: typeof AgentUserCheckpointEntityTable.$inferSelect,
): AgentUserCheckpointEntity {
  return {
    checkpointId: row.checkpointId,
    ordinal: row.ordinal,
    projectId: row.projectId,
    entityKind: row.entityKind as ProseEntityType,
    entityId: row.entityId,
    displayName: row.displayName,
    documentId: row.documentId,
    yjsRevision: row.yjsRevision,
    stateVector: normalizeBlob(row.stateVector),
    stateHash: row.stateHash,
    contentHash: row.contentHash,
    stateBlob: normalizeBlob(row.stateBlob),
    metadataJson: row.metadataJson,
    metadataHash: row.metadataHash,
    capturedAt: row.capturedAt,
  };
}

export interface CreateAgentUserCheckpointInput {
  checkpoint: Omit<AgentUserCheckpoint, 'status' | 'entityCount' | 'finalizedAt' | 'deletedAt'>;
  entities: AgentUserCheckpointEntity[];
}

export interface AgentUserCheckpointActionRow {
  id: string;
  projectId: string;
  checkpointId: string;
  kind: AgentUserCheckpointActionKind;
  status: AgentUserCheckpointActionStatus;
  idempotencyKey: string;
  previewTokenHash: string;
  previewHash: string;
  expiresAt: string;
  overwriteConfirmed: boolean;
  targetConversationId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
}

export interface AgentUserCheckpointActionEntityRow {
  actionId: string;
  ordinal: number;
  projectId: string;
  entityKind: ProseEntityType;
  entityId: string;
  expectedCurrentRevision: number | null;
  expectedCurrentStateHash: string;
  expectedCurrentContentHash: string;
  expectedCurrentMetadataHash: string;
  checkpointStateHash: string;
  checkpointContentHash: string;
  checkpointMetadataHash: string;
  beforeRevision: number | null;
  beforeStateVector: Uint8Array | null;
  beforeStateBlob: Uint8Array | null;
  beforeContentHash: string | null;
  beforeMetadataJson: string | null;
  resultStateHash: string | null;
  status: AgentUserCheckpointEntityActionStatus;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export interface CreateAgentUserCheckpointActionInput {
  action: AgentUserCheckpointActionRow;
  entities: AgentUserCheckpointActionEntityRow[];
}

export interface ForkCheckpointConversationInput {
  actionId: string;
  checkpointId: string;
  conversation: {
    id: string;
    projectId: string;
    parentConversationId: string;
    title: string;
    mode: AgentConvMode;
    messages: AgentChatMessage[];
    createdAt: string;
  };
}

export interface AgentUserCheckpointRepository {
  createCheckpoint(input: CreateAgentUserCheckpointInput): Promise<AgentUserCheckpoint>;
  getCheckpoint(id: string): Promise<AgentUserCheckpoint | null>;
  getCheckpointBySourceTurn(input: {
    conversationId: string;
    sourceTurnId: string;
    kind: AgentUserCheckpointKind;
  }): Promise<AgentUserCheckpoint | null>;
  listCheckpoints(projectId: string, conversationId?: string): Promise<AgentUserCheckpointSummary[]>;
  listCheckpointEntities(checkpointId: string): Promise<AgentUserCheckpointEntity[]>;
  setPinned(id: string, pinned: boolean): Promise<void>;
  softDelete(id: string, deletedAt: string): Promise<void>;
  createAction(input: CreateAgentUserCheckpointActionInput): Promise<AgentUserCheckpointActionRow>;
  getAction(id: string): Promise<AgentUserCheckpointActionRow | null>;
  getActionByIdempotencyKey(key: string): Promise<AgentUserCheckpointActionRow | null>;
  listActionEntities(actionId: string): Promise<AgentUserCheckpointActionEntityRow[]>;
  listRecoverableActions(projectId?: string): Promise<AgentUserCheckpointActionRow[]>;
  transitionAction(input: {
    id: string;
    from: AgentUserCheckpointActionStatus | AgentUserCheckpointActionStatus[];
    to: AgentUserCheckpointActionStatus;
    now: string;
    overwriteConfirmed?: boolean;
    errorCode?: string | null;
    errorMessage?: string | null;
    completedAt?: string | null;
  }): Promise<boolean>;
  recordActionEntityBefore(input: {
    actionId: string;
    entityKind: ProseEntityType;
    entityId: string;
    beforeRevision: number;
    beforeStateVector: Uint8Array;
    beforeStateBlob: Uint8Array;
    beforeContentHash: string;
    beforeMetadataJson: string;
    now: string;
  }): Promise<void>;
  settleActionEntity(input: {
    actionId: string;
    entityKind: ProseEntityType;
    entityId: string;
    status: AgentUserCheckpointEntityActionStatus;
    resultStateHash?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    now: string;
  }): Promise<void>;
  completeConversationFork(input: ForkCheckpointConversationInput): Promise<void>;
}

function actionFromRow(
  row: typeof AgentUserCheckpointActionTable.$inferSelect,
): AgentUserCheckpointActionRow {
  return {
    ...row,
    kind: row.kind as AgentUserCheckpointActionKind,
    status: row.status as AgentUserCheckpointActionStatus,
    targetConversationId: row.targetConversationId ?? null,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    confirmedAt: row.confirmedAt ?? null,
    completedAt: row.completedAt ?? null,
  };
}

function actionEntityFromRow(
  row: typeof AgentUserCheckpointActionEntityTable.$inferSelect,
): AgentUserCheckpointActionEntityRow {
  return {
    ...row,
    entityKind: row.entityKind as ProseEntityType,
    expectedCurrentRevision: row.expectedCurrentRevision ?? null,
    beforeRevision: row.beforeRevision ?? null,
    beforeStateVector: row.beforeStateVector ? normalizeBlob(row.beforeStateVector) : null,
    beforeStateBlob: row.beforeStateBlob ? normalizeBlob(row.beforeStateBlob) : null,
    beforeContentHash: row.beforeContentHash ?? null,
    beforeMetadataJson: row.beforeMetadataJson ?? null,
    resultStateHash: row.resultStateHash ?? null,
    status: row.status as AgentUserCheckpointEntityActionStatus,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
  };
}

export function createAgentUserCheckpointRepository(
  dbOverride?: DbExecutor,
): AgentUserCheckpointRepository {
  const dbProvider = (): DbExecutor => dbOverride ?? getDb();

  return {
    async createCheckpoint(input) {
      const finalizedAt = input.checkpoint.createdAt;
      await dbProvider().transaction(async (tx) => {
        await tx.insert(AgentUserCheckpointTable).values({
          ...input.checkpoint,
          status: 'capturing',
          conversationMessagesJson: JSON.stringify(input.checkpoint.conversationMessages),
          providerHistoryJson: JSON.stringify(input.checkpoint.providerHistory),
          longTaskStateJson:
            input.checkpoint.longTaskState === null
              ? null
              : JSON.stringify(input.checkpoint.longTaskState),
          acceptedWriteEffectIdsJson: JSON.stringify(
            input.checkpoint.acceptedWriteEffectIds,
          ),
          entityCount: 0,
          finalizedAt: null,
          deletedAt: null,
        });
        if (input.entities.length > 0) {
          await tx.insert(AgentUserCheckpointEntityTable).values(
            input.entities.map((entity) => ({
              ...entity,
              stateVector: new Uint8Array(entity.stateVector),
              stateBlob: new Uint8Array(entity.stateBlob),
            })),
          );
        }
        await tx
          .update(AgentUserCheckpointTable)
          .set({
            status: 'ready',
            entityCount: input.entities.length,
            finalizedAt,
          })
          .where(eq(AgentUserCheckpointTable.id, input.checkpoint.id));
      });
      const created = await this.getCheckpoint(input.checkpoint.id);
      if (!created) throw new Error('Agent user checkpoint disappeared after creation');
      return created;
    },

    async getCheckpoint(id) {
      const rows = await dbProvider()
        .select()
        .from(AgentUserCheckpointTable)
        .where(eq(AgentUserCheckpointTable.id, id))
        .limit(1);
      return rows[0] ? checkpointFromRow(rows[0]) : null;
    },

    async getCheckpointBySourceTurn(input) {
      const rows = await dbProvider()
        .select()
        .from(AgentUserCheckpointTable)
        .where(
          and(
            eq(AgentUserCheckpointTable.conversationId, input.conversationId),
            eq(AgentUserCheckpointTable.sourceTurnId, input.sourceTurnId),
            eq(AgentUserCheckpointTable.kind, input.kind),
          ),
        )
        .limit(1);
      return rows[0] ? checkpointFromRow(rows[0]) : null;
    },

    async listCheckpoints(projectId, conversationId) {
      const clauses = [
        eq(AgentUserCheckpointTable.projectId, projectId),
        eq(AgentUserCheckpointTable.status, 'ready'),
        isNull(AgentUserCheckpointTable.deletedAt),
      ];
      if (conversationId) {
        clauses.push(eq(AgentUserCheckpointTable.conversationId, conversationId));
      }
      const rows = await dbProvider()
        .select({
          id: AgentUserCheckpointTable.id,
          conversationId: AgentUserCheckpointTable.conversationId,
          sourceTurnId: AgentUserCheckpointTable.sourceTurnId,
          kind: AgentUserCheckpointTable.kind,
          label: AgentUserCheckpointTable.label,
          pinned: AgentUserCheckpointTable.pinned,
          entityCount: AgentUserCheckpointTable.entityCount,
          createdAt: AgentUserCheckpointTable.createdAt,
        })
        .from(AgentUserCheckpointTable)
        .where(and(...clauses))
        .orderBy(desc(AgentUserCheckpointTable.createdAt));
      return rows.map((row) => ({
        ...row,
        sourceTurnId: row.sourceTurnId ?? null,
        kind: row.kind as AgentUserCheckpointKind,
      }));
    },

    async listCheckpointEntities(checkpointId) {
      const rows = await dbProvider()
        .select()
        .from(AgentUserCheckpointEntityTable)
        .where(eq(AgentUserCheckpointEntityTable.checkpointId, checkpointId))
        .orderBy(asc(AgentUserCheckpointEntityTable.ordinal));
      return rows.map(entityFromRow);
    },

    async setPinned(id, pinned) {
      await dbProvider()
        .update(AgentUserCheckpointTable)
        .set({ pinned })
        .where(eq(AgentUserCheckpointTable.id, id));
    },

    async softDelete(id, deletedAt) {
      await dbProvider()
        .update(AgentUserCheckpointTable)
        .set({ deletedAt })
        .where(eq(AgentUserCheckpointTable.id, id));
    },

    async createAction(input) {
      await dbProvider().transaction(async (tx) => {
        await tx.insert(AgentUserCheckpointActionTable).values(input.action);
        if (input.entities.length > 0) {
          await tx.insert(AgentUserCheckpointActionEntityTable).values(
            input.entities.map((entity) => ({
              ...entity,
              beforeStateVector: entity.beforeStateVector
                ? new Uint8Array(entity.beforeStateVector)
                : null,
              beforeStateBlob: entity.beforeStateBlob
                ? new Uint8Array(entity.beforeStateBlob)
                : null,
            })),
          );
        }
      });
      return input.action;
    },

    async getAction(id) {
      const rows = await dbProvider()
        .select()
        .from(AgentUserCheckpointActionTable)
        .where(eq(AgentUserCheckpointActionTable.id, id))
        .limit(1);
      return rows[0] ? actionFromRow(rows[0]) : null;
    },

    async getActionByIdempotencyKey(key) {
      const rows = await dbProvider()
        .select()
        .from(AgentUserCheckpointActionTable)
        .where(eq(AgentUserCheckpointActionTable.idempotencyKey, key))
        .limit(1);
      return rows[0] ? actionFromRow(rows[0]) : null;
    },

    async listActionEntities(actionId) {
      const rows = await dbProvider()
        .select()
        .from(AgentUserCheckpointActionEntityTable)
        .where(eq(AgentUserCheckpointActionEntityTable.actionId, actionId))
        .orderBy(asc(AgentUserCheckpointActionEntityTable.ordinal));
      return rows.map(actionEntityFromRow);
    },

    async listRecoverableActions(projectId) {
      const status = inArray(AgentUserCheckpointActionTable.status, [
        'applying',
        'compensating',
      ]);
      const where = projectId
        ? and(eq(AgentUserCheckpointActionTable.projectId, projectId), status)
        : status;
      const rows = await dbProvider()
        .select()
        .from(AgentUserCheckpointActionTable)
        .where(where)
        .orderBy(asc(AgentUserCheckpointActionTable.updatedAt));
      return rows.map(actionFromRow);
    },

    async transitionAction(input) {
      const from = Array.isArray(input.from) ? input.from : [input.from];
      const rows = await dbProvider()
        .update(AgentUserCheckpointActionTable)
        .set({
          status: input.to,
          updatedAt: input.now,
          ...(input.overwriteConfirmed !== undefined
            ? {
                overwriteConfirmed: input.overwriteConfirmed,
                confirmedAt: input.overwriteConfirmed ? input.now : null,
              }
            : {}),
          ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
          ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
          ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
        })
        .where(
          and(
            eq(AgentUserCheckpointActionTable.id, input.id),
            inArray(AgentUserCheckpointActionTable.status, from),
          ),
        )
        .returning({ id: AgentUserCheckpointActionTable.id });
      return rows.length === 1;
    },

    async recordActionEntityBefore(input) {
      await dbProvider()
        .update(AgentUserCheckpointActionEntityTable)
        .set({
          beforeRevision: input.beforeRevision,
          beforeStateVector: new Uint8Array(input.beforeStateVector),
          beforeStateBlob: new Uint8Array(input.beforeStateBlob),
          beforeContentHash: input.beforeContentHash,
          beforeMetadataJson: input.beforeMetadataJson,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(AgentUserCheckpointActionEntityTable.actionId, input.actionId),
            eq(AgentUserCheckpointActionEntityTable.entityKind, input.entityKind),
            eq(AgentUserCheckpointActionEntityTable.entityId, input.entityId),
          ),
        );
    },

    async settleActionEntity(input) {
      await dbProvider()
        .update(AgentUserCheckpointActionEntityTable)
        .set({
          status: input.status,
          resultStateHash: input.resultStateHash ?? null,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(AgentUserCheckpointActionEntityTable.actionId, input.actionId),
            eq(AgentUserCheckpointActionEntityTable.entityKind, input.entityKind),
            eq(AgentUserCheckpointActionEntityTable.entityId, input.entityId),
          ),
        );
    },

    async completeConversationFork(input) {
      await dbProvider().transaction(async (tx) => {
        await tx.insert(AgentConversationTable).values({
          id: input.conversation.id,
          projectId: input.conversation.projectId,
          title: input.conversation.title,
          mode: input.conversation.mode,
          messagesJson: JSON.stringify(input.conversation.messages),
          sdkSessionId: null,
          runtimeSessionId: null,
          forkCheckpointId: input.checkpointId,
          parentConversationId: input.conversation.parentConversationId,
          createdAt: input.conversation.createdAt,
          updatedAt: input.conversation.createdAt,
        });
        const rows = await tx
          .update(AgentUserCheckpointActionTable)
          .set({
            status: 'completed',
            targetConversationId: input.conversation.id,
            updatedAt: input.conversation.createdAt,
            completedAt: input.conversation.createdAt,
          })
          .where(
            and(
              eq(AgentUserCheckpointActionTable.id, input.actionId),
              inArray(AgentUserCheckpointActionTable.status, [
                'previewed',
                'applying',
              ]),
            ),
          )
          .returning({ id: AgentUserCheckpointActionTable.id });
        if (rows.length !== 1) {
          throw new Error('Checkpoint fork action is no longer executable');
        }
      });
    },
  };
}
