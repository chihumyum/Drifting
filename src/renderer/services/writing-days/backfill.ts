/**
 * Once per library, the device's writing history from before the table
 * (localStorage `writing-stats-storage`, kept since a book was first opened
 * on this device) becomes writing days, so the heatmap starts with it
 * (docs/writing-days.md). Only books in this library are read; days before
 * today only, since the recorder owns today. Idempotent: days this device
 * already has a row for are left alone, and the library remembers it ran.
 */
import { v7 as uuidv7 } from 'uuid';

import { getDb, type DbExecutor } from '../../lib/db';
import { ProjectTable } from '../../schema/drizzle';
import { createLibraryStateRepository } from '../../sqlite-repo/library-state-repo';
import { insertWritingDay, readDeviceWritingDays } from '../../sqlite-repo/writing-day-repo';
import { todayKey, useWritingStatsStore, type ProjectHistory } from '../../store/writing-stats-store';
import { withAtomicSyncTransaction } from '../../usecase/sync-helpers';
import { getWritingDeviceKey } from './device-key';

export const WRITING_DAYS_BACKFILL_KEY = 'writing-days-backfill';
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export function writingDaysFromHistory(history: ProjectHistory | undefined, today: string): [string, number][] {
  return Object.entries(history ?? {})
    .filter(([day]) => DAY.test(day) && day < today)
    .map(([day, snapshot]): [string, number] => [day, Math.max(0, Math.floor(snapshot.latestTotal - snapshot.startTotal))])
    .filter(([, words]) => words > 0)
    .sort(([left], [right]) => left.localeCompare(right));
}

let running: Promise<number> | null = null;

/** Days written into the table; 0 once the library has been backfilled. */
export function backfillWritingDays(db: DbExecutor = getDb()): Promise<number> {
  running ??= run(db).finally(() => {
    running = null;
  });
  return running;
}

async function run(db: DbExecutor): Promise<number> {
  const state = createLibraryStateRepository(db);
  if (await state.read(WRITING_DAYS_BACKFILL_KEY)) return 0;
  const history = useWritingStatsStore.getState().history;
  const today = todayKey();
  const deviceKey = await getWritingDeviceKey();
  const projects = await db.select({ id: ProjectTable.id }).from(ProjectTable);
  let written = 0;
  for (const { id: projectId } of projects) {
    const days = writingDaysFromHistory(history[projectId], today);
    if (days.length === 0) continue;
    const existing = await readDeviceWritingDays(projectId, deviceKey, db);
    const missing = days.filter(([day]) => !existing.has(day));
    if (missing.length === 0) continue;
    const at = new Date().toISOString();
    await withAtomicSyncTransaction(projectId, async (tx, sync) => {
      for (const [day, words] of missing) {
        const row = { id: uuidv7(), projectId, day, deviceKey, words, createdAt: at, updatedAt: at };
        await insertWritingDay(row, tx);
        await sync('writingDay', 'create', row.id, projectId, { day, deviceKey, words, createdAt: at, updatedAt: at });
      }
    });
    written += missing.length;
  }
  const at = new Date().toISOString();
  await state.write(WRITING_DAYS_BACKFILL_KEY, { at, days: written }, at);
  return written;
}
