/**
 * Local SQLite repo for writing days (`writing_day`, migration 0016,
 * docs/writing-days.md). Thin reads and writes; the recorder in
 * services/writing-days owns when a row is written and journals it.
 */
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import { ProjectTable, WritingDayTable } from '../schema/drizzle';
import type { ISODate, WritingDayTotal } from '../store/writing-stats-store';

export interface WritingDayRow {
  id: string;
  projectId: string;
  day: ISODate;
  deviceKey: string;
  words: number;
  createdAt: string;
  updatedAt: string;
}

/** One device's row for a book and day, if it has written one. */
export async function findDeviceWritingDay(
  projectId: string,
  day: ISODate,
  deviceKey: string,
  db: DbExecutor = getDb(),
): Promise<WritingDayRow | null> {
  const [row] = await db
    .select()
    .from(WritingDayTable)
    .where(
      and(
        eq(WritingDayTable.projectId, projectId),
        eq(WritingDayTable.day, day),
        eq(WritingDayTable.deviceKey, deviceKey),
      ),
    )
    .orderBy(WritingDayTable.id)
    .limit(1);
  return row ?? null;
}

/** Days this device already has a row for, for one book. */
export async function readDeviceWritingDays(
  projectId: string,
  deviceKey: string,
  db: DbExecutor = getDb(),
): Promise<Set<ISODate>> {
  const rows = await db
    .select({ day: WritingDayTable.day })
    .from(WritingDayTable)
    .where(and(eq(WritingDayTable.projectId, projectId), eq(WritingDayTable.deviceKey, deviceKey)));
  return new Set(rows.map((row) => row.day));
}

export async function insertWritingDay(row: WritingDayRow, db: DbExecutor = getDb()): Promise<void> {
  await db.insert(WritingDayTable).values(row);
}

export async function updateWritingDayWords(
  id: string,
  projectId: string,
  words: number,
  updatedAt: string,
  db: DbExecutor = getDb(),
): Promise<void> {
  await db
    .update(WritingDayTable)
    .set({ words, updatedAt })
    .where(and(eq(WritingDayTable.id, id), eq(WritingDayTable.projectId, projectId)));
}

/**
 * The shelf's heatmap: words per book and day since `since`, summed over
 * devices, for every book not in Recently Deleted. One statement for the
 * whole shelf, at most one row per book and day.
 */
export async function readShelfWritingDays(
  since: ISODate,
  db: DbExecutor = getDb(),
): Promise<WritingDayTotal[]> {
  const rows = await db
    .select({
      projectId: WritingDayTable.projectId,
      day: WritingDayTable.day,
      words: sql<number>`sum(${WritingDayTable.words})`.mapWith(Number),
    })
    .from(WritingDayTable)
    .innerJoin(ProjectTable, eq(ProjectTable.id, WritingDayTable.projectId))
    .where(and(isNull(ProjectTable.deletedAt), gte(WritingDayTable.day, since)))
    .groupBy(WritingDayTable.projectId, WritingDayTable.day);
  return rows;
}
