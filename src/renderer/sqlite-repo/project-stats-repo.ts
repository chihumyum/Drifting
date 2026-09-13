import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { ProjectStats } from '../domain/project-summary';
import { getDb, type DbExecutor } from '../lib/db';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  EntityRelationTable,
  InlineMentionTable,
  NodeStorylineLinkTable,
  StorylineTable,
} from '../schema/drizzle';

/** One statement/snapshot and one returned row, regardless of project size. */
export async function readProjectStats(
  projectId: string,
  db: DbExecutor = getDb(),
): Promise<ProjectStats> {
  // Match isProseMetricBasisHash from the portable prose-metrics contract.
  // The byte length check also rejects embedded NUL/trailing Unicode that
  // SQLite's text length/substr would otherwise stop at or count differently.
  const hash = BookNodeTable.wordCountBasisHash;
  const canonicalWords = sql`(
    ${BookNodeTable.wordCountBasisKind} is not null
    and ${BookNodeTable.wordCountBasisKind} != ''
    and length(cast(${hash} as blob)) = 71
    and substr(${hash}, 1, 7) = 'sha256:'
    and substr(${hash}, 8) not glob '*[^0-9a-f]*'
    and (${BookNodeTable.wordCountBasisKind} = 'seed'
      or ${BookNodeTable.wordCountBasisRevision} is not null
      or ${BookNodeTable.wordCountBasisServerSeq} is not null)
  )`;
  const linkedNode = alias(BookNodeTable, 'shelf_linked_node');
  const [stats] = await db.select({
    nodes: count(),
    words: sql<number>`coalesce(sum(case when ${BookNodeTable.kind} = 'chapter' and ${canonicalWords}
      then ${BookNodeTable.wordCount} else 0 end), 0)`.mapWith(Number),
    wordsReady: sql<number>`count(case when ${BookNodeTable.kind} = 'chapter'
      and not coalesce(${canonicalWords}, 0) then 1 end) = 0`.mapWith(Boolean),
    storylines: sql<number>`(select count(*) from ${StorylineTable}
      where ${StorylineTable.projectId} = ${projectId})`.mapWith(Number),
    storylineLinks: sql<number>`(select count(*) from ${NodeStorylineLinkTable}
      inner join ${BookNodeTable} as ${sql.identifier('shelf_linked_node')} on ${linkedNode.id} = ${NodeStorylineLinkTable.nodeId}
      where ${linkedNode.projectId} = ${projectId} and ${linkedNode.deletedAt} is null)`.mapWith(Number),
    elements: sql<number>`(select count(*) from ${BookElementTable}
      where ${BookElementTable.projectId} = ${projectId})`.mapWith(Number),
    categories: sql<number>`(select count(*) from ${ElementCategoryTable}
      where ${ElementCategoryTable.projectId} = ${projectId})`.mapWith(Number),
    entityRelations: sql<number>`(select count(*) from ${EntityRelationTable}
      where ${EntityRelationTable.projectId} = ${projectId})`.mapWith(Number),
    inlineMentions: sql<number>`(select count(*) from ${InlineMentionTable}
      where ${InlineMentionTable.projectId} = ${projectId})`.mapWith(Number),
  }).from(BookNodeTable).where(and(eq(BookNodeTable.projectId, projectId), isNull(BookNodeTable.deletedAt)));
  return stats;
}
