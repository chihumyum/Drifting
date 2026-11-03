import { and, eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';

import * as database from '../../lib/db';
import { SyncChangeSetTable, SyncEntityLifecycleTable, WritingDayTable } from '../../schema/drizzle';
import { readShelfWritingDays } from '../../sqlite-repo/writing-day-repo';
import { createLibraryStateRepository } from '../../sqlite-repo/library-state-repo';
import { todayKey, useWritingStatsStore } from '../../store/writing-stats-store';
import {
  createWorkspaceProjectionFixture,
  WORKSPACE_TEST_INPUT as INPUT,
} from '../workspace-projection.test-support';
import { backfillWritingDays, WRITING_DAYS_BACKFILL_KEY } from './backfill';
import { getWritingDeviceKey, resetWritingDeviceKeyForTests } from './device-key';
import { createWritingDayRecorder } from './writing-day-recorder';

vi.mock('../../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform')>();
  return {
    ...actual,
    platform: {
      ...actual.platform,
      app: { ...actual.platform.app, getInstallationIdentity: async () => `install-${'e'.repeat(64)}` },
    },
  };
});

let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  vi.restoreAllMocks();
  resetWritingDeviceKeyForTests();
  useWritingStatsStore.setState({ history: {} });
});

async function setup() {
  fixture = await createWorkspaceProjectionFixture();
  vi.spyOn(database, 'initDatabase').mockResolvedValue(undefined);
  return fixture.db;
}

type Db = Awaited<ReturnType<typeof setup>>;
const rowsOf = (db: Db) => db.select().from(WritingDayTable).where(eq(WritingDayTable.projectId, INPUT.projectId));
const localChangeSets = (db: Db) =>
  db.select().from(SyncChangeSetTable)
    .where(and(eq(SyncChangeSetTable.projectId, INPUT.projectId), eq(SyncChangeSetTable.origin, 'local')));

function clock(start: Date) {
  let at = start.getTime();
  return { now: () => new Date(at), advance: (ms: number) => { at += ms; } };
}

it('keeps this device’s day as one journaled row, leaving another device’s words to it', async () => {
  const db = await setup();
  const time = clock(new Date(2026, 10, 3, 9, 30));
  const before = (await localChangeSets(db)).length;
  const recorder = createWritingDayRecorder(INPUT.projectId, { now: time.now, persistDelayMs: 60_000 });
  recorder.observe(1000);
  recorder.observe(1250);
  await recorder.flush();

  const [row] = await rowsOf(db);
  expect(row).toMatchObject({ day: '2026-11-03', words: 250, deviceKey: await getWritingDeviceKey() });
  expect(row.deviceKey).toMatch(/^device-[0-9a-f]{24}$/);
  expect(row.deviceKey).not.toContain('e'.repeat(24));
  expect((await localChangeSets(db)).length).toBe(before + 1);
  const lifecycle = await db.select().from(SyncEntityLifecycleTable)
    .where(and(eq(SyncEntityLifecycleTable.entityKind, 'writing-day'), eq(SyncEntityLifecycleTable.entityId, row.id)));
  expect(lifecycle).toHaveLength(1);

  // Another device's 500 words arrive; then 40 more are typed here.
  recorder.remoteChanged();
  recorder.observe(1750);
  time.advance(10_000);
  recorder.observe(1790);
  await recorder.flush();
  expect((await rowsOf(db)).map((entry) => entry.words)).toEqual([290]);

  // Nothing new to write: no further change-set.
  const settled = (await localChangeSets(db)).length;
  await recorder.flush();
  expect((await localChangeSets(db)).length).toBe(settled);
  recorder.dispose();

  // Reopening the book keeps the morning's words.
  const again = createWritingDayRecorder(INPUT.projectId, { now: time.now, persistDelayMs: 60_000 });
  again.observe(1790);
  again.observe(1800);
  await again.flush();
  again.dispose();
  expect((await rowsOf(db)).map((entry) => entry.words)).toEqual([300]);

  expect(await readShelfWritingDays('2026-01-01')).toEqual([{ projectId: INPUT.projectId, day: '2026-11-03', words: 300 }]);
  expect(await readShelfWritingDays('2026-11-04')).toEqual([]);
});

it('adds the rows of other devices on the shelf', async () => {
  const db = await setup();
  const at = '2026-11-03T08:00:00.000Z';
  await db.insert(WritingDayTable).values([
    { id: 'wd-a', projectId: INPUT.projectId, day: '2026-11-02', deviceKey: 'device-a', words: 120, createdAt: at, updatedAt: at },
    { id: 'wd-b', projectId: INPUT.projectId, day: '2026-11-02', deviceKey: 'device-b', words: 80, createdAt: at, updatedAt: at },
    { id: 'wd-c', projectId: INPUT.projectId, day: '2026-11-01', deviceKey: 'device-a', words: 40, createdAt: at, updatedAt: at },
  ]);
  const rows = await readShelfWritingDays('2026-11-01');
  expect(rows.sort((left, right) => left.day.localeCompare(right.day))).toEqual([
    { projectId: INPUT.projectId, day: '2026-11-01', words: 40 },
    { projectId: INPUT.projectId, day: '2026-11-02', words: 200 },
  ]);
});

it('writes the device’s older local history in once, before today only', async () => {
  const db = await setup();
  const today = todayKey();
  const back = (days: number) => todayKey(new Date(Date.now() - days * 86_400_000));
  useWritingStatsStore.setState({
    history: {
      [INPUT.projectId]: {
        [back(9)]: { startTotal: 100, latestTotal: 600 },
        [back(3)]: { startTotal: 600, latestTotal: 600 },
        [back(2)]: { startTotal: 600, latestTotal: 450 },
        [back(1)]: { startTotal: 450, latestTotal: 1450 },
        [today]: { startTotal: 1450, latestTotal: 1500 },
      },
      'not-in-this-library': { [back(1)]: { startTotal: 0, latestTotal: 900 } },
    },
  });

  expect(await backfillWritingDays()).toBe(2);
  const rows = (await rowsOf(db)).sort((left, right) => left.day.localeCompare(right.day));
  expect(rows.map((row) => [row.day, row.words])).toEqual([[back(9), 500], [back(1), 1000]]);
  expect(await createLibraryStateRepository().read(WRITING_DAYS_BACKFILL_KEY)).toMatchObject({ days: 2 });

  // The library remembers it ran.
  expect(await backfillWritingDays()).toBe(0);
  expect(await rowsOf(db)).toHaveLength(2);

  // Today's earlier words come from the same history the day the table arrives.
  const recorder = createWritingDayRecorder(INPUT.projectId, { persistDelayMs: 60_000 });
  recorder.observe(1500);
  recorder.observe(1520);
  await recorder.flush();
  recorder.dispose();
  expect((await rowsOf(db)).find((row) => row.day === today)?.words).toBe(70);
});
