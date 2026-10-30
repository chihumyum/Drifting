import { sql } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import { BookElementTable, BookNodeTable, InlineMentionTable } from '../schema/drizzle';

// Project-wide aggregate of chapter prose @-mentions of elements: how often
// each element appears per chapter, and how many paragraphs (blocks) mention
// two elements together. Drives the element "islands" overview, whose edges
// come from prose co-occurrence rather than hand-made relations.
//
// Scope: sources are live chapters only (book_node.kind = 'chapter', not
// trashed; drifts are drafts, not the book). Targets are live elements of the
// same project. inline_mention keeps one row per (source, block, target);
// a row's span count is how many times the target is marked in that block.

/** Mentions of one element inside one chapter's prose. */
export interface ElementChapterMentionRow {
  elementId: string;
  chapterId: string;
  /** Marked spans, matching the chapter stats panel (a row counts at least once). */
  mentions: number;
}

/** One unordered element pair, reported once with `elementA < elementB` in SQLite BINARY order. */
export interface ElementPairCooccurrenceRow {
  elementA: string;
  elementB: string;
  /** Distinct chapter blocks in which both elements are mentioned. */
  blocks: number;
}

export interface ElementMentionGraphRows {
  chapterMentions: ElementChapterMentionRow[];
  pairs: ElementPairCooccurrenceRow[];
}

type GraphRow = [kind: string, a: string, b: string, n: number | bigint];

/**
 * One statement, so both halves come from the same snapshot and one gateway
 * round trip. Rows come back aggregated: one per (element, chapter) and one
 * per co-occurring pair, never one per mention.
 *
 * Pairs fold each (chapter, block) into a JSON array of its distinct elements
 * and expand only those arrays with json_each. That costs a sort of the
 * project's mentions plus k² per block. A self-join of mention rows on
 * (chapter, block) has no matching index, and without ANALYZE statistics
 * SQLite plans it as a nested scan (quadratic in the project's mentions).
 *
 * The unary `+` keeps the kind filters from steering the planner onto the
 * project-agnostic idx_mention_from / idx_mention_to ranges; every scan
 * starts from idx_mention_project instead. No extra index is needed.
 */
export async function readElementMentionGraphRows(
  projectId: string,
  db: DbExecutor = getDb(),
): Promise<ElementMentionGraphRows> {
  const mention = InlineMentionTable;
  const chapter = BookNodeTable;
  const element = BookElementTable;
  // A malformed or empty span list still records one mention, exactly like
  // the chapter stats panel. The nested CASE keeps json_type off invalid JSON.
  const rows = await db.values<GraphRow>(sql`
    with live as (
      select
        ${mention.fromId} as chapter_id,
        ${mention.fromBlockId} as block_id,
        ${mention.toId} as element_id,
        ${mention.fromSpansJson} as spans
      from ${mention}
      inner join ${chapter} on ${chapter.id} = ${mention.fromId}
        and ${chapter.projectId} = ${projectId}
        and ${chapter.kind} = 'chapter'
        and ${chapter.deletedAt} is null
      inner join ${element} on ${element.id} = ${mention.toId}
        and ${element.projectId} = ${projectId}
        and ${element.deletedAt} is null
      where ${mention.projectId} = ${projectId}
        and +${mention.fromKind} = 'node'
        and +${mention.toKind} = 'element'
    )
    select 'chapter', element_id, chapter_id, sum(
      case when json_valid(spans)
        then case when json_type(spans) = 'array' then max(1, json_array_length(spans)) else 1 end
        else 1 end
    )
    from live
    group by element_id, chapter_id
    union all
    select 'pair', member_a.value, member_b.value, count(*)
    from (
      select json_group_array(distinct element_id) as members
      from live
      group by chapter_id, block_id
      having count(distinct element_id) > 1
    ) as paragraph
    inner join json_each(paragraph.members) as member_a
    inner join json_each(paragraph.members) as member_b on member_a.value < member_b.value
    group by member_a.value, member_b.value
  `);

  const chapterMentions: ElementChapterMentionRow[] = [];
  const pairs: ElementPairCooccurrenceRow[] = [];
  for (const [kind, a, b, n] of rows) {
    if (kind === 'chapter') {
      chapterMentions.push({ elementId: String(a), chapterId: String(b), mentions: Number(n) });
    } else if (kind === 'pair') {
      pairs.push({ elementA: String(a), elementB: String(b), blocks: Number(n) });
    }
  }
  return { chapterMentions, pairs };
}
