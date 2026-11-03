import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { installHeadlessRendererGlobals } from '../../headless-globals';

// Renderer stores read browser storage when their modules load.
installHeadlessRendererGlobals();
const { seedShowcaseLibrary, plannedWritingDays, SHOWCASE_DEVICE_KEY } = await import('./library');
const { SHELF_BOOKS } = await import('./shelf');
const { SLOW_CLOCK, SLOW_CLOCK_NAME } = await import('./slow-clock');
const { anchorQuotation, buildProseDocument } = await import('../../../renderer/services/built-in-sample/book');
const { BOOK_ILLUSTRATIONS } = await import('../../../renderer/services/built-in-sample/book');
const { SAMPLE_PROJECT_NAME } = await import('../../../renderer/services/built-in-sample/showcase');
const { invalidateSqliteReducerStateCache } = await import('../../../renderer/sync/reducer/sqlite-materializer');

const directories: string[] = [];
const TODAY = new Date('2026-11-04T15:00:00+08:00');

afterEach(() => {
  invalidateSqliteReducerStateCache();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function seed(locale: 'en' | 'zh-CN') {
  const directory = mkdtempSync(join(tmpdir(), 'drifting-showcase-'));
  directories.push(directory);
  const databasePath = join(directory, 'databases', 'drifting-library.db');
  const appLocalDataDirectory = join(directory, 'app-local-data');
  return { databasePath, appLocalDataDirectory, result: seedShowcaseLibrary({ databasePath, appLocalDataDirectory, locale, today: TODAY }) };
}

function rows<T>(database: DatabaseSync, sql: string, ...parameters: string[]): T[] {
  return database.prepare(sql).all(...parameters) as T[];
}

describe('《慢钟》', () => {
  const keys = new Set(SLOW_CLOCK.elements.map((element) => element.key));
  let counter = 0;
  const document = (number: number) => buildProseDocument(SLOW_CLOCK.chapters[number - 1].blocks, () => `b${counter++}`);

  it('anchors every comment and patch to one plain passage', () => {
    for (const item of [...SLOW_CLOCK.comments, ...SLOW_CLOCK.elementPatches]) {
      const { chapter, quotation } = item;
      if (chapter === undefined || quotation === undefined) continue;
      expect(() => anchorQuotation(document(chapter), quotation), quotation).not.toThrow();
    }
  });

  it('ties every part to an element, a storyline or a chapter that exists', () => {
    const storylines = new Set(SLOW_CLOCK.storylines.map((line) => line.key));
    const categories = new Set(SLOW_CLOCK.categories.map((category) => category.key));
    const types = new Set(SLOW_CLOCK.relationTypes.map((type) => type.key));
    expect(SLOW_CLOCK.chapterPlans).toHaveLength(SLOW_CLOCK.chapters.length);
    for (const plan of SLOW_CLOCK.chapterPlans) for (const line of plan.storylines) expect(storylines).toContain(line);
    for (const element of SLOW_CLOCK.elements) expect(categories).toContain(element.category);
    expect(keys.size).toBe(SLOW_CLOCK.elements.length);
    for (const relation of SLOW_CLOCK.relations) {
      expect(types).toContain(relation.type);
      expect(keys).toContain(relation.from);
      if (typeof relation.to === 'number') expect(relation.to).toBeLessThanOrEqual(SLOW_CLOCK.chapters.length);
      else expect(keys).toContain(relation.to);
    }
    for (const { element } of [...SLOW_CLOCK.linkForms, ...SLOW_CLOCK.elementPatches]) if (element) expect(keys).toContain(element);
    for (const comment of SLOW_CLOCK.comments) if (comment.element) expect(keys).toContain(comment.element);
    expect(SLOW_CLOCK.volumes.map((volume) => volume.firstChapter)).toEqual([1, 9, 17]);
  });

  it('has written text where the outline says the draft has reached', () => {
    const written = SLOW_CLOCK.chapters.filter((chapter) => chapter.blocks.join('').length > 0).map((chapter) => chapter.number);
    expect(written).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(SLOW_CLOCK.chapterTitle(24)).toBe('第二十四章 开张');
  });
});

describe('writing days', () => {
  it('stay inside a book’s active months and the heatmap’s year', () => {
    const days = plannedWritingDays({ words: 60_000, startedDaysAgo: 500, lastWrittenDaysAgo: 3, diligence: 0.5 }, TODAY, 11);
    const first = days[0][0], last = days[days.length - 1][0];
    expect(first > '2025-10-27').toBe(true);
    expect(last).toBe('2026-11-01');
    expect(days.every(([, words]) => words >= 40)).toBe(true);
    expect(new Set(days.map(([day]) => day)).size).toBe(days.length);
  });
});

describe('release screenshot library', () => {
  it('writes Pride and Prejudice and six other books into a new English library', async () => {
    const { databasePath, appLocalDataDirectory, result } = seed('en');
    const library = await result;
    expect(library.main.name).toBe(SAMPLE_PROJECT_NAME);
    expect(library.projects.map((project) => project.name)).toEqual([...SHELF_BOOKS.en.map((book) => book.name), SAMPLE_PROJECT_NAME]);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const counts = rows<{ name: string; chapters: number; words: number; days: number }>(database, `
        SELECT p.name,
          (SELECT count(*) FROM book_node n WHERE n.project_id = p.id AND n.kind = 'chapter') AS chapters,
          (SELECT coalesce(sum(n.word_count), 0) FROM book_node n WHERE n.project_id = p.id AND n.kind = 'chapter') AS words,
          (SELECT count(*) FROM writing_day d WHERE d.project_id = p.id) AS days
        FROM project p ORDER BY p.updated_at`);
      const byName = new Map(counts.map((row) => [row.name, row]));
      expect(byName.get(SAMPLE_PROJECT_NAME)?.chapters).toBe(61);
      expect(byName.get(SAMPLE_PROJECT_NAME)?.days).toBe(0);
      for (const book of SHELF_BOOKS.en) {
        const row = byName.get(book.name)!;
        expect(row.chapters).toBe(book.chapters);
        expect(Math.abs(row.words - book.words)).toBeLessThan(book.words * 0.02);
        expect(row.days).toBeGreaterThan(3);
      }
      // The main book is the most recent; every date is in the past.
      expect(counts[counts.length - 1].name).toBe(SAMPLE_PROJECT_NAME);
      const dates = rows<{ updated_at: string; kv_json: string }>(database, 'SELECT updated_at, kv_json FROM project');
      expect(dates.every((row) => row.updated_at <= TODAY.toISOString())).toBe(true);
      expect(dates.filter((row) => row.kv_json.includes('体裁'))).toHaveLength(SHELF_BOOKS.en.length);
      const ages = dates.map((row) => (TODAY.getTime() - Date.parse(row.updated_at)) / 86_400_000);
      expect(ages.some((age) => age <= 7) && ages.some((age) => age > 7 && age <= 30) && ages.some((age) => age > 30)).toBe(true);

      const days = rows<{ day: string; device_key: string }>(database, 'SELECT day, device_key FROM writing_day');
      expect(days.length).toBe(library.writingDays);
      expect(new Set(days.map((row) => row.device_key))).toEqual(new Set([SHOWCASE_DEVICE_KEY]));
      const weeks = new Set(days.map((row) => Math.floor((TODAY.getTime() - Date.parse(`${row.day}T12:00:00Z`)) / (7 * 86_400_000))));
      expect(weeks.size).toBeGreaterThan(40);
      expect(rows(database, 'PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      database.close();
    }
    // The illustrations are real files in the profile's asset store.
    const assets = join(appLocalDataDirectory, 'assets', library.main.projectId);
    expect(readdirSync(assets)).toHaveLength(BOOK_ILLUSTRATIONS.length);
  }, 120_000);

  it('writes 《慢钟》 and six other books into a new Chinese library', async () => {
    const { databasePath, result } = seed('zh-CN');
    const library = await result;
    expect(library.main.name).toBe(SLOW_CLOCK_NAME);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const id = library.main.projectId;
      const count = (sql: string) => Number((database.prepare(sql).get(id) as { n: number }).n);
      expect(count("SELECT count(*) AS n FROM book_node WHERE project_id = ? AND kind = 'chapter'")).toBe(24);
      expect(count("SELECT count(*) AS n FROM book_node WHERE project_id = ? AND kind = 'drift'")).toBe(SLOW_CLOCK.ideas.length);
      expect(count('SELECT count(*) AS n FROM element WHERE project_id = ?')).toBe(SLOW_CLOCK.elements.length);
      expect(count('SELECT count(*) AS n FROM entity_relation WHERE project_id = ?')).toBe(SLOW_CLOCK.relations.length);
      expect(count('SELECT count(*) AS n FROM comment WHERE project_id = ?')).toBe(SLOW_CLOCK.comments.length);
      expect(count('SELECT count(*) AS n FROM book_act WHERE project_id = ?')).toBe(3);
      expect(count("SELECT count(*) AS n FROM book_node WHERE project_id = ? AND writing_status = 'finished'")).toBe(4);
      expect(count('SELECT count(*) AS n FROM writing_day WHERE project_id = ?')).toBeGreaterThan(20);
      expect(rows(database, 'SELECT name FROM project ORDER BY updated_at DESC LIMIT 1')).toEqual([{ name: SLOW_CLOCK_NAME }]);
      expect(rows(database, 'PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      database.close();
    }
  }, 120_000);

  it('refuses a library that already exists', async () => {
    const first = seed('zh-CN');
    await first.result;
    expect(existsSync(first.databasePath)).toBe(true);
    await expect(seedShowcaseLibrary({ databasePath: first.databasePath, appLocalDataDirectory: first.appLocalDataDirectory, locale: 'zh-CN' }))
      .rejects.toThrow('Refusing to seed');
  }, 120_000);
});
