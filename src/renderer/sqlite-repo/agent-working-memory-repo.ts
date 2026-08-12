import { and, eq } from 'drizzle-orm';
import type { AgentWorkingMemory } from '../domain/agent-working-memory';
import { getDb, type DbExecutor } from '../lib/db';
import { AgentWorkingMemoryTable } from '../schema/drizzle';

export type AgentWorkingMemoryCreateData = AgentWorkingMemory;
export type AgentWorkingMemoryCasData = Omit<
  AgentWorkingMemory,
  'projectId' | 'createdAt' | 'revision'
> & { revision: number };

export interface AgentWorkingMemoryRepository {
  find(): Promise<AgentWorkingMemory | null>;
  create(input: AgentWorkingMemoryCreateData): Promise<AgentWorkingMemory>;
  updateCas(
    expectedRevision: number,
    input: AgentWorkingMemoryCasData,
  ): Promise<AgentWorkingMemory | null>;
}

function toDomain(row: typeof AgentWorkingMemoryTable.$inferSelect): AgentWorkingMemory {
  return {
    projectId: row.projectId,
    contentMd: row.contentMd,
    revision: row.revision,
    approxTokens: row.approxTokens,
    updatedBy: row.updatedBy as AgentWorkingMemory['updatedBy'],
    lastCompactedAt: row.lastCompactedAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createAgentWorkingMemoryRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): AgentWorkingMemoryRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const find = async (): Promise<AgentWorkingMemory | null> => {
    const rows = await dbProvider()
      .select()
      .from(AgentWorkingMemoryTable)
      .where(eq(AgentWorkingMemoryTable.projectId, projectId))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  return {
    find,

    create: async (input) => {
      const rows = await dbProvider().insert(AgentWorkingMemoryTable).values(input).returning();
      if (!rows[0]) throw new Error('Working Memory create did not persist.');
      return toDomain(rows[0]);
    },

    updateCas: async (expectedRevision, input) => {
      const rows = await dbProvider()
        .update(AgentWorkingMemoryTable)
        .set(input)
        .where(
          and(
            eq(AgentWorkingMemoryTable.projectId, projectId),
            eq(AgentWorkingMemoryTable.revision, expectedRevision),
          ),
        )
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },
  };
}
