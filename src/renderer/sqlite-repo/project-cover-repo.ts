import { and, asc, eq, getTableName, isNull, sql } from 'drizzle-orm';
import type { ProjectCover } from '../domain/project-summary';
import { getDb, type DbExecutor } from '../lib/db';
import { BookNodeTable, NodeStorylineLinkTable, StorylineTable } from '../schema/drizzle';

/** The shelf draws at most this many storylines on a cover. */
export const COVER_MAX_STORYLINES = 6;

/**
 * The storylines a shelf cover is drawn from, in the author's order: each one's
 * colour and the chapters it runs through, as indexes in reading order (book
 * order). One statement and one row per storyline, never the node inventory.
 */
export async function readProjectCover(
  projectId: string,
  db: DbExecutor = getDb(),
): Promise<ProjectCover> {
  // A one-table select leaves column names bare, so every name in the
  // correlated subquery is spelt out with its table.
  const col = (table: string, column: string) => sql`${sql.identifier(table)}.${sql.identifier(column)}`;
  const storylines = getTableName(StorylineTable);
  const links = getTableName(NodeStorylineLinkTable);
  const nodes = getTableName(BookNodeTable);
  const rows = await db.select({
    color: StorylineTable.color,
    chapters: sql<string | null>`(select group_concat(shelf_chapter.idx) from ${sql.identifier(links)}
      inner join (select ${col(nodes, BookNodeTable.id.name)} as id,
          row_number() over (order by ${col(nodes, BookNodeTable.bookOrder.name)}, ${col(nodes, BookNodeTable.id.name)}) - 1 as idx
        from ${sql.identifier(nodes)}
        where ${col(nodes, BookNodeTable.projectId.name)} = ${projectId}
          and ${col(nodes, BookNodeTable.kind.name)} = 'chapter'
          and ${col(nodes, BookNodeTable.deletedAt.name)} is null) as shelf_chapter
        on shelf_chapter.id = ${col(links, NodeStorylineLinkTable.nodeId.name)}
      where ${col(links, NodeStorylineLinkTable.storylineId.name)} = ${col(storylines, StorylineTable.id.name)})`,
  })
    .from(StorylineTable)
    .where(and(eq(StorylineTable.projectId, projectId), isNull(StorylineTable.deletedAt)))
    .orderBy(asc(StorylineTable.orderKey), asc(StorylineTable.id))
    .limit(COVER_MAX_STORYLINES);
  return {
    storylines: rows.map((row) => ({
      color: row.color,
      chapters: row.chapters
        ? row.chapters.split(',').map(Number).filter(Number.isInteger).sort((a, b) => a - b)
        : [],
    })),
  };
}
