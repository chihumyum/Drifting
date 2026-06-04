/**
 * Chapter → canon dependency index, the spine of the incremental-review engine.
 *
 * A chapter "depends on" every entity its prose inline-mentions (elements,
 * settings/drift nodes). We read those edges straight from the `inline_mention`
 * projection table (fromKind = 'node'). The reverse — which chapters a changed
 * entity affects — falls out by inverting this forward map.
 *
 * Storyline membership is a dependency too, but it lives in the data-store
 * (nodeStorylineMapping), so the staleness selector folds it in there; this
 * loader only covers the prose-mention edges.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../lib/db';
import { InlineMentionTable } from '../../schema/drizzle';

export interface DependencyRef {
  kind: 'element' | 'node';
  id: string;
}

export type ChapterDependencyIndex = Map<string, DependencyRef[]>; // chapterId → deps

/** Load the forward dependency map for a project from the inline_mention table. */
export async function loadChapterDependencies(
  projectId: string,
): Promise<ChapterDependencyIndex> {
  const index: ChapterDependencyIndex = new Map();
  if (!projectId) return index;

  const rows = await getDb()
    .select({
      fromId: InlineMentionTable.fromId,
      toKind: InlineMentionTable.toKind,
      toId: InlineMentionTable.toId,
    })
    .from(InlineMentionTable)
    .where(
      and(eq(InlineMentionTable.projectId, projectId), eq(InlineMentionTable.fromKind, 'node')),
    );

  for (const r of rows) {
    if (r.toKind !== 'element' && r.toKind !== 'node') continue; // only canon-bearing kinds
    const list = index.get(r.fromId) ?? [];
    // Dedup (a chapter can mention the same entity in many blocks).
    if (!list.some((d) => d.kind === r.toKind && d.id === r.toId)) {
      list.push({ kind: r.toKind as DependencyRef['kind'], id: r.toId });
      index.set(r.fromId, list);
    }
  }
  return index;
}
