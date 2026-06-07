import { v7 as uuidv7 } from 'uuid';
import { desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { ShadowJobTable } from '../schema/drizzle';
import type {
  ConsultedSnapshotRef,
  ShadowConsultedKind,
  ShadowConsultedRef,
  ShadowJob,
  ShadowJobStatus,
  ShadowTraceStep,
} from '../domain/shadow-job';

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
  consulted: ShadowConsultedRef[];
  consultedCaptured: boolean;
  consultedSnapshot: ConsultedSnapshotRef[];
  chapterTitle: string;
  startedAt: string;
  finishedAt: string | null;
  archived: boolean;
}>;

export interface ShadowJobRepository {
  create(input: CreateShadowJobInput): Promise<ShadowJob>;
  update(id: string, updates: UpdateShadowJobInput): Promise<ShadowJob | null>;
  findById(id: string): Promise<ShadowJob | null>;
  listByProject(projectId: string, limit?: number): Promise<ShadowJob[]>;
  // Bound on-disk growth: keep the most recent `keep` jobs in a project, delete the
  // rest (these telemetry rows accumulate forever otherwise). Returns # deleted.
  pruneOldJobs(projectId: string, keep?: number): Promise<number>;
  // Drop a now-deleted entity from every job's consulted / consultedSnapshot dep
  // refs in this project, so a gone element can't drive staleness (a deleted dep
  // would otherwise read as "changed" forever → perpetual re-review under auto-run).
  // Returns the rows that actually changed (for the in-memory store to mirror).
  scrubEntityRefs(projectId: string, kind: ShadowConsultedKind, id: string): Promise<ShadowJob[]>;
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

function parseConsulted(json: string): ShadowConsultedRef[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as ShadowConsultedRef[]) : [];
  } catch {
    return [];
  }
}

function parseSnapshot(json: string): ConsultedSnapshotRef[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as ConsultedSnapshotRef[]) : [];
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
    consulted: parseConsulted(row.consultedJson),
    consultedCaptured: !!row.consultedCaptured,
    consultedSnapshot: parseSnapshot(row.consultedSnapshotJson),
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
      consultedJson: '[]',
      consultedCaptured: false,
      consultedSnapshotJson: '[]',
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
    if (updates.consulted !== undefined) set.consultedJson = JSON.stringify(updates.consulted);
    if (updates.consultedCaptured !== undefined) set.consultedCaptured = updates.consultedCaptured;
    if (updates.consultedSnapshot !== undefined)
      set.consultedSnapshotJson = JSON.stringify(updates.consultedSnapshot);
    if (updates.chapterTitle !== undefined) set.chapterTitle = updates.chapterTitle;
    if (updates.startedAt !== undefined) set.startedAt = updates.startedAt;
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

  const pruneOldJobs = async (projectId: string, keep = 200): Promise<number> => {
    const db = getDb();
    const rows = await db
      .select({ id: ShadowJobTable.id })
      .from(ShadowJobTable)
      .where(eq(ShadowJobTable.projectId, projectId))
      .orderBy(desc(ShadowJobTable.startedAt));
    if (rows.length <= keep) return 0;
    const stale = rows.slice(keep).map((r) => r.id);
    // Chunk to stay under SQLite's bound-parameter ceiling.
    for (let i = 0; i < stale.length; i += 500) {
      await db.delete(ShadowJobTable).where(inArray(ShadowJobTable.id, stale.slice(i, i + 500)));
    }
    return stale.length;
  };

  const scrubEntityRefs = async (
    projectId: string,
    kind: ShadowConsultedKind,
    id: string,
  ): Promise<ShadowJob[]> => {
    const jobs = await listByProject(projectId, 1000);
    const updated: ShadowJob[] = [];
    for (const j of jobs) {
      const consulted = j.consulted.filter((r) => !(r.kind === kind && r.id === id));
      const consultedSnapshot = j.consultedSnapshot.filter((r) => !(r.kind === kind && r.id === id));
      if (
        consulted.length === j.consulted.length &&
        consultedSnapshot.length === j.consultedSnapshot.length
      ) {
        continue;
      }
      const row = await update(j.id, { consulted, consultedSnapshot });
      if (row) updated.push(row);
    }
    return updated;
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
    pruneOldJobs,
    scrubEntityRefs,
    delete: deleteJob,
    deleteByProject,
  };
}
