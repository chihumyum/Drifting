import { v7 as uuidv7 } from 'uuid';
import { eq } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { ElementArcTable } from '../schema/drizzle';
import type { ArcMap, ElementArcJob, ElementArcStatus } from '../domain/element-arc';

// Persistence for the per-element arc derivation (one row per element = the latest
// run). Lives in its own table joined to `element` — see schema/drizzle.ts for why
// it's NOT part of shadow_job. The element editor's arc section reads/writes this.

function parseResult(json: string | null): ArcMap | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ArcMap;
  } catch {
    return null;
  }
}

function toDomain(row: typeof ElementArcTable.$inferSelect): ElementArcJob {
  return {
    id: row.id,
    projectId: row.projectId,
    elementId: row.elementId,
    status: (row.status as ElementArcStatus) ?? 'running',
    includeDrafts: !!row.includeDrafts,
    result: parseResult(row.resultJson),
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ElementArcRepository {
  findByElement(elementId: string): Promise<ElementArcJob | null>;
  // Create-or-reset the element's arc row to `running` (clears any prior result/error).
  start(projectId: string, elementId: string, includeDrafts: boolean): Promise<ElementArcJob>;
  finish(id: string, result: ArcMap): Promise<ElementArcJob | null>;
  fail(id: string, error: string): Promise<ElementArcJob | null>;
  deleteByElement(elementId: string): Promise<void>;
}

export function createElementArcRepository(): ElementArcRepository {
  const findByElement = async (elementId: string): Promise<ElementArcJob | null> => {
    const rows = await getDb()
      .select()
      .from(ElementArcTable)
      .where(eq(ElementArcTable.elementId, elementId))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const start = async (
    projectId: string,
    elementId: string,
    includeDrafts: boolean,
  ): Promise<ElementArcJob> => {
    const db = getDb();
    const now = new Date().toISOString();
    const existing = await findByElement(elementId);
    if (existing) {
      await db
        .update(ElementArcTable)
        .set({ status: 'running', includeDrafts, resultJson: null, error: null, updatedAt: now })
        .where(eq(ElementArcTable.id, existing.id));
      return {
        ...existing,
        status: 'running',
        includeDrafts,
        result: null,
        error: null,
        updatedAt: now,
      };
    }
    const row = {
      id: uuidv7(),
      projectId,
      elementId,
      status: 'running' as ElementArcStatus,
      includeDrafts,
      resultJson: null as string | null,
      error: null as string | null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(ElementArcTable).values(row);
    return toDomain(row as typeof ElementArcTable.$inferSelect);
  };

  const finish = async (id: string, result: ArcMap): Promise<ElementArcJob | null> => {
    const db = getDb();
    await db
      .update(ElementArcTable)
      .set({
        status: 'done',
        resultJson: JSON.stringify(result),
        error: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(ElementArcTable.id, id));
    const rows = await db.select().from(ElementArcTable).where(eq(ElementArcTable.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const fail = async (id: string, error: string): Promise<ElementArcJob | null> => {
    const db = getDb();
    await db
      .update(ElementArcTable)
      .set({ status: 'failed', error, updatedAt: new Date().toISOString() })
      .where(eq(ElementArcTable.id, id));
    const rows = await db.select().from(ElementArcTable).where(eq(ElementArcTable.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const deleteByElement = async (elementId: string): Promise<void> => {
    await getDb().delete(ElementArcTable).where(eq(ElementArcTable.elementId, elementId));
  };

  return { findByElement, start, finish, fail, deleteByElement };
}
