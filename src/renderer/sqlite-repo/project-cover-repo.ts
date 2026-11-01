import { and, asc, eq, getTableName, isNull, sql } from 'drizzle-orm';
import type { ProjectCover } from '../domain/project-summary';
import { getDb, type DbExecutor } from '../lib/db';
import { BookNodeTable, NodeStorylineLinkTable, ProjectTable, StorylineTable } from '../schema/drizzle';

/** The shelf draws at most this many storylines on a cover. */
export const COVER_MAX_STORYLINES = 6;

/**
 * What a shelf cover is drawn from: the storylines in the author's order, each
 * one's colour and the chapters it runs through as indexes in reading order
 * (book order), and every chapter's words in that order. One statement, one row
 * per storyline (one row for a book without storylines), never the node inventory.
 */
export async function readProjectCover(
  projectId: string,
  db: DbExecutor = getDb(),
): Promise<ProjectCover> {
  // Names in the subqueries are spelt out with their tables, so they never
  // resolve against the outer select.
  const col = (table: string, column: string) => sql`${sql.identifier(table)}.${sql.identifier(column)}`;
  const storylines = getTableName(StorylineTable);
  const links = getTableName(NodeStorylineLinkTable);
  const nodes = getTableName(BookNodeTable);
  const readingOrder = sql`select ${col(nodes, BookNodeTable.id.name)} as id,
      ${col(nodes, BookNodeTable.wordCount.name)} as words,
      row_number() over (order by ${col(nodes, BookNodeTable.bookOrder.name)}, ${col(nodes, BookNodeTable.id.name)}) - 1 as idx
    from ${sql.identifier(nodes)}
    where ${col(nodes, BookNodeTable.projectId.name)} = ${projectId}
      and ${col(nodes, BookNodeTable.kind.name)} = 'chapter'
      and ${col(nodes, BookNodeTable.deletedAt.name)} is null`;
  const rows = await db.select({
    color: StorylineTable.color,
    chapters: sql<string | null>`(select group_concat(shelf_chapter.idx) from ${sql.identifier(links)}
      inner join (${readingOrder}) as shelf_chapter
        on shelf_chapter.id = ${col(links, NodeStorylineLinkTable.nodeId.name)}
      where ${col(links, NodeStorylineLinkTable.storylineId.name)} = ${col(storylines, StorylineTable.id.name)})`,
    words: sql<string | null>`(select group_concat(shelf_words.idx || ':' || shelf_words.words)
      from (${readingOrder}) as shelf_words)`,
  })
    .from(ProjectTable)
    .leftJoin(StorylineTable, and(eq(StorylineTable.projectId, ProjectTable.id), isNull(StorylineTable.deletedAt)))
    .where(eq(ProjectTable.id, projectId))
    .orderBy(asc(StorylineTable.orderKey), asc(StorylineTable.id))
    .limit(COVER_MAX_STORYLINES);
  // group_concat keeps no order, so words come as `index:words` and are sorted here.
  const words = (rows[0]?.words?.split(',') ?? [])
    .map((pair) => pair.split(':').map(Number))
    .filter(([index, count]) => Number.isInteger(index) && Number.isFinite(count))
    .sort((a, b) => a[0] - b[0])
    .map(([, count]) => count);
  return {
    storylines: rows.flatMap((row) => (row.color === null ? [] : [{
      color: row.color,
      chapters: row.chapters
        ? row.chapters.split(',').map(Number).filter(Number.isInteger).sort((a, b) => a - b)
        : [],
    }])),
    words,
  };
}
