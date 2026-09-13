import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type DbClient } from '../../lib/db';
import { BookNodeTable, NodeContentTable } from '../../schema/drizzle';

/** Search the persisted JSON cache, retaining the existing literal LIKE
 * prefilter. This is not an authoritative live-Yjs full-text index. */
export async function readGlobalSearchNodeBodies(projectId: string, query: string, db: DbClient = getDb()) {
  const q = query.trim();
  if (!q) return new Map<string, string>();
  const escapeLike = (value: string) => value.replace(/[\\%_]/g, match => '\\' + match);
  const pattern = `%${escapeLike(q)}%`;
  const lowerPattern = `%${escapeLike(q.toLowerCase())}%`;
  const rows = await db.select({ nodeId: NodeContentTable.nodeId, contentJson: NodeContentTable.contentJson })
    .from(BookNodeTable)
    .innerJoin(NodeContentTable, eq(NodeContentTable.nodeId, BookNodeTable.id))
    .where(and(
      eq(BookNodeTable.projectId, projectId),
      isNull(BookNodeTable.deletedAt),
      sql`(lower(${NodeContentTable.contentJson}) LIKE ${lowerPattern} ESCAPE '\\' OR ${NodeContentTable.contentJson} LIKE ${pattern} ESCAPE '\\')`,
    ));
  return new Map(rows.flatMap(row => row.contentJson ? [[row.nodeId, row.contentJson] as const] : []));
}
