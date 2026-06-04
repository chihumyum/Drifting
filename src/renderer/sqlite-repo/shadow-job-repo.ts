import { v7 as uuidv7 } from 'uuid';
import { and, desc, eq, ne } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { ShadowJobTable } from '../schema/drizzle';
import type { ShadowJob, ShadowJobStatus, ShadowTraceStep } from '../domain/shadow-job';

export interface CreateShadowJobInput {
  projectId: string;
  chapterId: string;
  chapterTitle?: string;
  startedAt?: string;
}

export type UpdateShadowJobInput = Partial<{
  status: ShadowJobStatus;
  decision: 'finished' | 'draft' | null;
  findingCount: number;
  error: string | null;
  trace: ShadowTraceStep[];
  chapterTitle: string;
  finishedAt: string | null;
  archived: boolean;
}>;

export interface ShadowJobRepository {
  create(input: CreateShadowJobInput): Promise<ShadowJob>;
  update(id: string, updates: UpdateShadowJobInput): Promise<ShadowJob | null>;
  findById(id: string): Promise<ShadowJob | null>;
  listByProject(projectId: string, limit?: number): Promise<ShadowJob[]>;
  // Archive every finished/failed/stopped (i.e. non-running) job in a project.
  archiveCompleted(projectId: string): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByProject(projectId: string): Promise<void>;
}

function parseTrace(json: string): ShadowTraceStep[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as ShadowTraceStep[]) : [];
  } catch {
    return [];
  }
}

function toDomain(row: typeof ShadowJobTable.$inferSelect): ShadowJob {
  return {
    id: row.id,
    projectId: row.projectId,
    chapterId: row.chapterId,
    chapterTitle: row.chapterTitle,
    status: (row.status as ShadowJobStatus) ?? 'running',
    decision: row.decision === 'finished' ? 'finished' : row.decision === 'draft' ? 'draft' : null,
    findingCount: row.findingCount,
    error: row.error,
    trace: parseTrace(row.traceJson),
    archived: !!row.archived,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createShadowJobRepository(): ShadowJobRepository {
  const create = async (input: CreateShadowJobInput): Promise<ShadowJob> => {
    const db = getDb();
    const now = new Date().toISOString();
    const row = {
      id: uuidv7(),
      projectId: input.projectId,
      chapterId: input.chapterId,
      chapterTitle: input.chapterTitle ?? '',
      status: 'running' as ShadowJobStatus,
      decision: null as string | null,
      findingCount: 0,
      error: null as string | null,
      traceJson: '[]',
      archived: false,
      startedAt: input.startedAt ?? now,
      finishedAt: null as string | null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(ShadowJobTable).values(row);
    return toDomain(row as typeof ShadowJobTable.$inferSelect);
  };

  const update = async (id: string, updates: UpdateShadowJobInput): Promise<ShadowJob | null> => {
    const db = getDb();
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (updates.status !== undefined) set.status = updates.status;
    if (updates.decision !== undefined) set.decision = updates.decision;
    if (updates.findingCount !== undefined) set.findingCount = updates.findingCount;
    if (updates.error !== undefined) set.error = updates.error;
    if (updates.trace !== undefined) set.traceJson = JSON.stringify(updates.trace);
    if (updates.chapterTitle !== undefined) set.chapterTitle = updates.chapterTitle;
    if (updates.finishedAt !== undefined) set.finishedAt = updates.finishedAt;
    if (updates.archived !== undefined) set.archived = updates.archived;
    await db.update(ShadowJobTable).set(set).where(eq(ShadowJobTable.id, id));
    const rows = await db.select().from(ShadowJobTable).where(eq(ShadowJobTable.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const findById = async (id: string): Promise<ShadowJob | null> => {
    const rows = await getDb().select().from(ShadowJobTable).where(eq(ShadowJobTable.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const listByProject = async (projectId: string, limit = 100): Promise<ShadowJob[]> => {
    const rows = await getDb()
      .select()
      .from(ShadowJobTable)
      .where(eq(ShadowJobTable.projectId, projectId))
      .orderBy(desc(ShadowJobTable.startedAt))
      .limit(limit);
    return rows.map(toDomain);
  };

  const archiveCompleted = async (projectId: string): Promise<void> => {
    await getDb()
      .update(ShadowJobTable)
      .set({ archived: true, updatedAt: new Date().toISOString() })
      .where(
        and(eq(ShadowJobTable.projectId, projectId), ne(ShadowJobTable.status, 'running')),
      );
  };

  const deleteJob = async (id: string): Promise<void> => {
    await getDb().delete(ShadowJobTable).where(eq(ShadowJobTable.id, id));
  };

  const deleteByProject = async (projectId: string): Promise<void> => {
    await getDb().delete(ShadowJobTable).where(eq(ShadowJobTable.projectId, projectId));
  };

  return {
    create,
    update,
    findById,
    listByProject,
    archiveCompleted,
    delete: deleteJob,
    deleteByProject,
  };
}
