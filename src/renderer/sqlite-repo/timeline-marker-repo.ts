/**
 * Local SQLite repo for timeline markers — narrative-axis time pins that can
 * bind a drift node as content (see domain/timeline-marker.ts). Thin CRUD;
 * the unbind cascade for drift delete / drift→chapter conversion is invoked
 * from the usecases via unbindForDrift (FKs aren't enforced in this app).
 */
import { asc, eq } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import { TimelineMarkerTable } from '../schema/drizzle';
import type { TimelineMarker } from '../domain/timeline-marker';

export type TimelineMarkerUpdateData = Partial<
  Omit<TimelineMarker, 'id' | 'projectId' | 'createdAt'>
> & {
  updatedAt: string;
};

export interface TimelineMarkerRepository {
  findById(id: string): Promise<TimelineMarker | null>;
  /** All markers for the project, ascending narrativeOrder. */
  findAll(): Promise<TimelineMarker[]>;
  /** Markers currently bound to the given drift node. */
  findByDrift(driftNodeId: string): Promise<TimelineMarker[]>;
  create(input: TimelineMarker): Promise<TimelineMarker>;
  update(id: string, data: TimelineMarkerUpdateData): Promise<TimelineMarker | null>;
  delete(id: string): Promise<boolean>;
  /**
   * Clear the binding on every marker pointing at a drift (the drift is
   * being deleted or converted to a chapter). `fallbackLabel` — usually the
   * drift's current title — keeps the pin captioned. Returns affected rows.
   */
  unbindForDrift(driftNodeId: string, fallbackLabel: string, now: string): Promise<TimelineMarker[]>;
}

function toDomain(record: typeof TimelineMarkerTable.$inferSelect): TimelineMarker {
  return {
    id: record.id,
    projectId: record.projectId,
    narrativeOrder: record.narrativeOrder,
    label: record.label,
    driftNodeId: record.driftNodeId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createTimelineMarkerRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): TimelineMarkerRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<TimelineMarker | null> => {
    const rows = await dbProvider()
      .select()
      .from(TimelineMarkerTable)
      .where(eq(TimelineMarkerTable.id, id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const findByDrift = async (driftNodeId: string): Promise<TimelineMarker[]> => {
    const rows = await dbProvider()
      .select()
      .from(TimelineMarkerTable)
      .where(eq(TimelineMarkerTable.driftNodeId, driftNodeId));
    return rows.map(toDomain);
  };

  return {
    findById,
    findByDrift,

    findAll: async () => {
      const rows = await dbProvider()
        .select()
        .from(TimelineMarkerTable)
        .where(eq(TimelineMarkerTable.projectId, projectId))
        .orderBy(asc(TimelineMarkerTable.narrativeOrder));
      return rows.map(toDomain);
    },

    create: async (input) => {
      await dbProvider().insert(TimelineMarkerTable).values({
        id: input.id,
        projectId: input.projectId,
        narrativeOrder: input.narrativeOrder,
        label: input.label,
        driftNodeId: input.driftNodeId,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      return (await findById(input.id))!;
    },

    update: async (id, data) => {
      const values: Partial<typeof TimelineMarkerTable.$inferInsert> = {
        updatedAt: data.updatedAt,
      };
      if (data.narrativeOrder !== undefined) values.narrativeOrder = data.narrativeOrder;
      if (data.label !== undefined) values.label = data.label;
      if (data.driftNodeId !== undefined) values.driftNodeId = data.driftNodeId;
      await dbProvider()
        .update(TimelineMarkerTable)
        .set(values)
        .where(eq(TimelineMarkerTable.id, id));
      return findById(id);
    },

    delete: async (id) => {
      await dbProvider().delete(TimelineMarkerTable).where(eq(TimelineMarkerTable.id, id));
      return true;
    },

    unbindForDrift: async (driftNodeId, fallbackLabel, now) => {
      const bound = await findByDrift(driftNodeId);
      if (bound.length === 0) return [];
      const updated: TimelineMarker[] = [];
      for (const marker of bound) {
        // Keep an existing user label; only fall back to the drift title when
        // the marker had no caption of its own.
        const label = marker.label.trim() ? marker.label : fallbackLabel;
        await dbProvider()
          .update(TimelineMarkerTable)
          .set({ driftNodeId: null, label, updatedAt: now })
          .where(eq(TimelineMarkerTable.id, marker.id));
        updated.push({ ...marker, driftNodeId: null, label, updatedAt: now });
      }
      return updated;
    },
  };
}
