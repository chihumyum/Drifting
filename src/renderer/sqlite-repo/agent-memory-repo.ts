/**
 * Local SQLite repo for Agent Memory — the small, evolving store of author-level
 * guidance that BOTH the General agent and the Shadow review engine read as
 * auxiliary context (see domain/agent-memory.ts for the model + boundaries).
 *
 * Local-only for now: like agent_conversation, not wired to the sync outbox yet.
 * The schema is sync-ready (projectId + updatedAt + deletedAt) for when the
 * outbox/server routes land. Soft-delete via deletedAt keeps a row around for
 * provenance after it's removed.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import { AgentMemoryTable } from '../schema/drizzle';
import type {
  AgentMemory,
  AgentMemoryKind,
  AgentMemorySource,
  AgentMemoryStatus,
} from '../domain/agent-memory';
import type { StructuralEntityKind } from '../domain/entity-kinds';

export type AgentMemoryCreateData = AgentMemory;
export type AgentMemoryUpdateData = Partial<
  Omit<AgentMemory, 'id' | 'projectId' | 'createdAt'>
> & {
  updatedAt: string;
};

export interface AgentMemoryRepository {
  findById(id: string): Promise<AgentMemory | null>;
  /** Every memory for the project (incl. soft-deleted), newest first. */
  findAll(): Promise<AgentMemory[]>;
  /** Live (not soft-deleted) memories, newest first. */
  listLive(): Promise<AgentMemory[]>;
  /** Live memories with the given status — newest first. Pass 'active' to get
   *  the ONLY set that may be injected into an agent/judge prompt. */
  listByStatus(status: AgentMemoryStatus): Promise<AgentMemory[]>;
  /** Live memories anchored to a structural entity (both target columns set). */
  findByTarget(
    targetKind: StructuralEntityKind,
    targetId: string,
  ): Promise<AgentMemory[]>;
  create(input: AgentMemoryCreateData): Promise<AgentMemory>;
  update(id: string, data: AgentMemoryUpdateData): Promise<AgentMemory | null>;
  /** Soft-delete: stamp deletedAt; the row survives for provenance. */
  softDelete(id: string, deletedAt: string): Promise<void>;
  /** Hard delete — drop the row entirely. */
  delete(id: string): Promise<boolean>;
}

function toDomain(record: typeof AgentMemoryTable.$inferSelect): AgentMemory {
  return {
    id: record.id,
    projectId: record.projectId,
    kind: record.kind as AgentMemoryKind,
    body: record.body,
    targetKind: (record.targetKind as StructuralEntityKind | null) ?? null,
    targetId: record.targetId,
    targetBlockId: record.targetBlockId,
    source: record.source as AgentMemorySource,
    originRef: record.originRef,
    status: record.status as AgentMemoryStatus,
    supersedesId: record.supersedesId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt,
  };
}

export function createAgentMemoryRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): AgentMemoryRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<AgentMemory | null> => {
    const rows = await dbProvider()
      .select()
      .from(AgentMemoryTable)
      .where(
        and(
          eq(AgentMemoryTable.id, id),
          eq(AgentMemoryTable.projectId, projectId),
        ),
      )
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  return {
    findById,

    findAll: async () => {
      const rows = await dbProvider()
        .select()
        .from(AgentMemoryTable)
        .where(eq(AgentMemoryTable.projectId, projectId))
        .orderBy(desc(AgentMemoryTable.updatedAt));
      return rows.map(toDomain);
    },

    listLive: async () => {
      const rows = await dbProvider()
        .select()
        .from(AgentMemoryTable)
        .where(
          and(
            eq(AgentMemoryTable.projectId, projectId),
            isNull(AgentMemoryTable.deletedAt),
          ),
        )
        .orderBy(desc(AgentMemoryTable.updatedAt));
      return rows.map(toDomain);
    },

    listByStatus: async (status) => {
      const rows = await dbProvider()
        .select()
        .from(AgentMemoryTable)
        .where(
          and(
            eq(AgentMemoryTable.projectId, projectId),
            eq(AgentMemoryTable.status, status),
            isNull(AgentMemoryTable.deletedAt),
          ),
        )
        .orderBy(desc(AgentMemoryTable.updatedAt));
      return rows.map(toDomain);
    },

    findByTarget: async (targetKind, targetId) => {
      const rows = await dbProvider()
        .select()
        .from(AgentMemoryTable)
        .where(
          and(
            eq(AgentMemoryTable.projectId, projectId),
            eq(AgentMemoryTable.targetKind, targetKind),
            eq(AgentMemoryTable.targetId, targetId),
            isNull(AgentMemoryTable.deletedAt),
          ),
        )
        .orderBy(desc(AgentMemoryTable.updatedAt));
      return rows.map(toDomain);
    },

    create: async (input) => {
      const row: typeof AgentMemoryTable.$inferInsert = {
        id: input.id,
        projectId: input.projectId,
        kind: input.kind,
        body: input.body,
        targetKind: input.targetKind,
        targetId: input.targetId,
        targetBlockId: input.targetBlockId,
        source: input.source,
        originRef: input.originRef,
        status: input.status,
        supersedesId: input.supersedesId,
        deletedAt: input.deletedAt,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
      await dbProvider().insert(AgentMemoryTable).values(row);
      return (await findById(input.id))!;
    },

    update: async (id, data) => {
      const updateValues: Partial<typeof AgentMemoryTable.$inferInsert> = {
        updatedAt: data.updatedAt,
      };
      if (data.kind !== undefined) updateValues.kind = data.kind;
      if (data.body !== undefined) updateValues.body = data.body;
      if (data.targetKind !== undefined) updateValues.targetKind = data.targetKind;
      if (data.targetId !== undefined) updateValues.targetId = data.targetId;
      if (data.targetBlockId !== undefined)
        updateValues.targetBlockId = data.targetBlockId;
      if (data.source !== undefined) updateValues.source = data.source;
      if (data.originRef !== undefined) updateValues.originRef = data.originRef;
      if (data.status !== undefined) updateValues.status = data.status;
      if (data.supersedesId !== undefined)
        updateValues.supersedesId = data.supersedesId;
      if (data.deletedAt !== undefined) updateValues.deletedAt = data.deletedAt;

      await dbProvider()
        .update(AgentMemoryTable)
        .set(updateValues)
        .where(
          and(
            eq(AgentMemoryTable.id, id),
            eq(AgentMemoryTable.projectId, projectId),
          ),
        );
      return findById(id);
    },

    softDelete: async (id, deletedAt) => {
      await dbProvider()
        .update(AgentMemoryTable)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(
          and(
            eq(AgentMemoryTable.id, id),
            eq(AgentMemoryTable.projectId, projectId),
          ),
        );
    },

    delete: async (id) => {
      await dbProvider()
        .delete(AgentMemoryTable)
        .where(
          and(
            eq(AgentMemoryTable.id, id),
            eq(AgentMemoryTable.projectId, projectId),
          ),
        );
      return true;
    },
  };
}
