// The release screenshot library (docs/release-screenshots.md): a fresh local
// library with one open book worth looking at and a shelf of others, dated
// relative to the run so the shelf's statuses and its year of writing days
// read as an author's. Every write goes through the built-in sample's writer
// and the app's journaled paths, so the library is an ordinary current-format
// one; the screenshot run reseeds it each time.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import type { ProjectAssetVariant } from '../../../renderer/domain/project-asset';
import { ProjectTable } from '../../../renderer/schema/drizzle';
import { A_Q_PROJECT_NAME, A_Q_ZHENGZHUAN } from '../../../renderer/services/built-in-sample/a-q';
import { BOOK_ILLUSTRATIONS } from '../../../renderer/services/built-in-sample/book';
import { PRIDE_AND_PREJUDICE, type SampleBook } from '../../../renderer/services/built-in-sample/sample-book';
import { SAMPLE_PROJECT_NAME } from '../../../renderer/services/built-in-sample/showcase';
import { writeBookSample, type ImportedSampleAsset } from '../../../renderer/services/built-in-sample/write-sample';
import { seedRandom } from '../../../renderer/services/sample-project/presets';
import { insertWritingDay } from '../../../renderer/sqlite-repo/writing-day-repo';
import { createProjectRepository } from '../../../renderer/sqlite-repo/project-repo';
import { createProjectInTransaction } from '../../../renderer/usecase/project-create';
import { installHeadlessRendererGlobals } from '../../headless-globals';
import { OfflineProductDatabase } from '../../offline-database';
import { createAtomicRunner } from '../../offline-workspace';
import { writeSeedAsset } from '../materials';
import { SHELF_BOOKS, shelfBookDefinition, type ShelfBook, type ShowcaseLocale } from './shelf';
import { SLOW_CLOCK, SLOW_CLOCK_NAME } from './slow-clock';

export type { ShowcaseLocale } from './shelf';

/** The local-only library: `store/auth`'s LOCAL_USER_ID and its database file. */
const LIBRARY_USER_ID = 'drifting-library.db';
/** The writing days were "written" on another of the author's Macs. */
export const SHOWCASE_DEVICE_KEY = `device-${createHash('sha256').update('drifting.release-screenshots').digest('hex').slice(0, 24)}`;
const DAY_MS = 86_400_000;
const HEATMAP_DAYS = 371;

export interface ShowcaseLibrary {
  locale: ShowcaseLocale;
  /** The book the workspace and element screenshots open, and its chapters in reading order. */
  main: { projectId: string; name: string; chapters: { id: string; title: string }[]; elements: number };
  projects: { projectId: string; name: string }[];
  writingDays: number;
  /** 阿Q正传（示例）, when asked for (`withAQ`): first on the shelf, its chapters in reading order. */
  aq?: { projectId: string; name: string; chapters: { id: string; title: string }[] };
}

const bookDirectory = new URL('../../../renderer/services/built-in-sample/pride-and-prejudice/', import.meta.url);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function bundledBytes(file: string, expected: string): Promise<Uint8Array> {
  const bytes = await readFile(new URL(file, bookDirectory));
  if (sha256(bytes) !== expected) throw new Error(`Sample file ${file} failed its integrity check`);
  return bytes;
}

/** Pride and Prejudice's illustrations, imported into the profile's asset store as the app does. */
async function importIllustrations(
  database: OfflineProductDatabase, appLocalDataDirectory: string, projectId: string,
): Promise<Map<string, ImportedSampleAsset>> {
  const imported = new Map<string, ImportedSampleAsset>();
  for (const illustration of BOOK_ILLUSTRATIONS) {
    const source = await bundledBytes(illustration.source, illustration.sha256);
    const variants = await Promise.all(Object.entries(illustration.variants).map(async ([variant, metadata]) => ({
      variant: variant as ProjectAssetVariant,
      bytes: metadata.file === illustration.source ? source : await bundledBytes(metadata.file, metadata.sha256),
    })));
    const { asset, abandon } = await writeSeedAsset(database.client, appLocalDataDirectory, projectId, {
      kind: 'image', sourceMime: illustration.mime, sourceExtension: 'jpg', source, sha256: illustration.sha256,
      width: illustration.width, height: illustration.height, variants,
    });
    imported.set(illustration.name, { asset, commit: async () => undefined, abandon });
  }
  return imported;
}

/** The writer's local calendar date `daysAgo` days before `today`, as YYYY-MM-DD. */
function localDay(today: Date, daysAgo: number): string {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Days the author wrote in a book while it was active: likelier on the day
 * after a writing day, rarer on Sundays and in a two-week summer break, with
 * words per session scaled so the year adds up to most of the book.
 */
export function plannedWritingDays(
  book: Pick<ShelfBook, 'words' | 'startedDaysAgo' | 'lastWrittenDaysAgo' | 'diligence'>,
  today: Date,
  seed: number,
): [string, number][] {
  const random = seedRandom(seed);
  const first = Math.min(book.startedDaysAgo, HEATMAP_DAYS - 1);
  const raw: [number, number][] = [];
  let wroteYesterday = false;
  for (let daysAgo = first; daysAgo >= book.lastWrittenDaysAgo; daysAgo--) {
    const weekday = new Date(today.getTime() - daysAgo * DAY_MS).getDay();
    const away = daysAgo >= 120 && daysAgo < 134;
    let chance: number = book.diligence * (weekday === 0 ? 0.55 : 1) * (wroteYesterday ? 1.3 : 0.8) * (away ? 0.08 : 1);
    if (daysAgo === book.lastWrittenDaysAgo) chance = 1;
    wroteYesterday = random() < chance;
    if (wroteYesterday) raw.push([daysAgo, 0.25 + random() ** 2 * 2.5]);
  }
  const share = book.startedDaysAgo < HEATMAP_DAYS ? 0.92 : 0.55;
  const scale = (book.words * share) / raw.reduce((sum, [, weight]) => sum + weight, 0);
  return raw.map(([daysAgo, weight]) => [localDay(today, daysAgo), Math.max(40, Math.round((weight * scale) / 10) * 10)]);
}

async function writeBook(input: {
  database: OfflineProductDatabase;
  runAtomic: ReturnType<typeof createAtomicRunner>;
  name: string;
  book: SampleBook;
  createdAt: string;
  updatedAt: string;
  assets?: Promise<ReadonlyMap<string, ImportedSampleAsset>>;
  writingDays: readonly [string, number][];
}): Promise<string> {
  const projectId = uuidv7();
  await input.runAtomic(projectId, (tx, sync, changes) =>
    createProjectInTransaction(tx, sync, changes, { projectId, userId: LIBRARY_USER_ID, name: input.name, now: input.createdAt }));
  await writeBookSample({
    database: input.database.client, projectId, userId: LIBRARY_USER_ID, runAtomic: input.runAtomic,
    now: () => input.updatedAt, newId: uuidv7, assets: input.assets ?? Promise.resolve(new Map()), book: input.book,
  });
  if (input.writingDays.length) {
    await input.runAtomic(projectId, async (tx, sync) => {
      for (const [day, words] of input.writingDays) {
        const row = { id: uuidv7(), projectId, day, deviceKey: SHOWCASE_DEVICE_KEY, words, createdAt: input.updatedAt, updatedAt: input.updatedAt };
        await insertWritingDay(row, tx);
        await sync('writingDay', 'create', row.id, projectId, { day, deviceKey: row.deviceKey, words, createdAt: row.createdAt, updatedAt: row.updatedAt });
      }
    });
  }
  // The shelf dates a book by its last edit.
  await createProjectRepository(LIBRARY_USER_ID, input.database.client).update(projectId, { updatedAt: input.updatedAt });
  return projectId;
}

/**
 * Seeds a new library at `databasePath` for one interface language. Refuses an
 * existing database: the screenshot run removes its own before reseeding.
 */
export async function seedShowcaseLibrary(input: {
  databasePath: string;
  appLocalDataDirectory: string;
  locale: ShowcaseLocale;
  today?: Date;
  /** Also write the built-in 阿Q正传 sample, last, so it leads the shelf (the promo recording opens it). */
  withAQ?: boolean;
}): Promise<ShowcaseLibrary> {
  if (existsSync(input.databasePath)) throw new Error(`Refusing to seed over ${input.databasePath}`);
  installHeadlessRendererGlobals();
  await mkdir(dirname(input.databasePath), { recursive: true, mode: 0o700 });
  const database = new OfflineProductDatabase(input.databasePath, { migrate: true });
  await database.open();
  try {
    const [existing] = await database.client.select({ id: ProjectTable.id }).from(ProjectTable).limit(1);
    if (existing) throw new Error('The screenshot library must start empty');
    const today = input.today ?? new Date();
    // Never later than the run itself, or the shelf would date a book in the future.
    const at = (daysAgo: number, minutesEarlier: number) =>
      new Date(today.getTime() - daysAgo * DAY_MS - minutesEarlier * 60_000).toISOString();
    const runAtomic = createAtomicRunner(database.client);
    const projects: ShowcaseLibrary['projects'] = [];
    let writingDays = 0;

    for (const [index, shelfBook] of SHELF_BOOKS[input.locale].entries()) {
      const days = plannedWritingDays(shelfBook, today, 7_001 + index * 97);
      writingDays += days.length;
      const projectId = await writeBook({
        database, runAtomic, name: shelfBook.name, book: shelfBookDefinition(shelfBook, input.locale, 9_001 + index * 131),
        createdAt: at(shelfBook.startedDaysAgo, 300), updatedAt: at(shelfBook.lastWrittenDaysAgo, 90 + index * 37), writingDays: days,
      });
      projects.push({ projectId, name: shelfBook.name });
    }

    // The open book is written last, so it is the most recent on the shelf.
    let main: Omit<ShowcaseLibrary['main'], 'chapters' | 'elements'>;
    if (input.locale === 'en') {
      const projectId = uuidv7();
      const assets = importIllustrations(database, input.appLocalDataDirectory, projectId);
      assets.catch(() => undefined);
      await runAtomic(projectId, (tx, sync, changes) =>
        createProjectInTransaction(tx, sync, changes, { projectId, userId: LIBRARY_USER_ID, name: SAMPLE_PROJECT_NAME, now: at(30, 300) }));
      await writeBookSample({
        database: database.client, projectId, userId: LIBRARY_USER_ID, runAtomic, now: () => at(0, 12), newId: uuidv7,
        assets, book: PRIDE_AND_PREJUDICE,
      });
      main = { projectId, name: SAMPLE_PROJECT_NAME };
    } else {
      // Started six weeks ago and written in most days since.
      const words = SLOW_CLOCK.chapters.reduce((sum, chapter) => sum + chapter.blocks.join('').length, 0);
      const days = plannedWritingDays({ words, startedDaysAgo: 44, lastWrittenDaysAgo: 0, diligence: 0.85 }, today, 4_201);
      writingDays += days.length;
      const projectId = await writeBook({
        database, runAtomic, name: SLOW_CLOCK_NAME, book: SLOW_CLOCK, createdAt: at(44, 300), updatedAt: at(0, 12), writingDays: days,
      });
      main = { projectId, name: SLOW_CLOCK_NAME };
    }
    projects.push(main);
    const sqlite = database.gateway.database;
    const chapters = sqlite
      .prepare("SELECT id, title FROM book_node WHERE project_id = ? AND kind = 'chapter' ORDER BY book_order")
      .all(main.projectId) as { id: string; title: string }[];
    const { elements } = sqlite.prepare('SELECT count(*) AS elements FROM element WHERE project_id = ?').get(main.projectId) as { elements: number };
    let aq: ShowcaseLibrary['aq'];
    if (input.withAQ) {
      const projectId = await writeBook({
        database, runAtomic, name: A_Q_PROJECT_NAME, book: A_Q_ZHENGZHUAN, createdAt: at(0, 30), updatedAt: at(0, 5), writingDays: [],
      });
      projects.push({ projectId, name: A_Q_PROJECT_NAME });
      const aqChapters = sqlite
        .prepare("SELECT id, title FROM book_node WHERE project_id = ? AND kind = 'chapter' ORDER BY book_order")
        .all(projectId) as { id: string; title: string }[];
      aq = { projectId, name: A_Q_PROJECT_NAME, chapters: aqChapters };
    }
    return { locale: input.locale, main: { ...main, chapters, elements }, projects, writingDays, ...(aq ? { aq } : {}) };
  } finally {
    await database.close();
  }
}
