import { eq } from 'drizzle-orm';
import loglevel from 'loglevel';
import { getDb } from '../lib/db';
import { events } from '../lib/events';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  ElementPatchTable,
  NodeContentTable,
  StorylineTable,
} from '../schema/drizzle';
import { createInlineMentionRepository } from '../sqlite-repo/inline-mention-repo';
import type { StructuralEntityKind } from '../domain/entity-kinds';
import { projectInlineMentionsFromJson } from './reference-projection.service';

const log = loglevel.getLogger('ReferenceIndexService');
log.setLevel(loglevel.levels.WARN);

interface ReferenceSourceDoc {
  kind: StructuralEntityKind;
  id: string;
  contentJson: string | null | undefined;
}

export interface ReferenceIndexRebuildStats {
  sources: number;
  references: number;
  skipped: number;
}

export async function rebuildProjectInlineReferenceIndex(
  projectId: string,
): Promise<ReferenceIndexRebuildStats> {
  const mentionRepo = createInlineMentionRepository();
  const sources = await loadReferenceSourceDocs(projectId);
  let references = 0;
  let skipped = 0;

  for (const source of sources) {
    const parsed = parseEditorJson(source.contentJson);
    if (!parsed.ok) {
      skipped += 1;
      continue;
    }

    const drafts = projectInlineMentionsFromJson(parsed.json);
    references += drafts.length;
    await mentionRepo.replaceMentionsFromSource(
      projectId,
      source.kind,
      source.id,
      drafts,
    );
  }

  events.emit('references:changed', { projectId });
  return { sources: sources.length, references, skipped };
}

async function loadReferenceSourceDocs(projectId: string): Promise<ReferenceSourceDoc[]> {
  const db = getDb();
  const [nodeRows, elementRows, categoryRows, storylineRows, patchRows] = await Promise.all([
    db
      .select({
        id: BookNodeTable.id,
        contentJson: NodeContentTable.contentJson,
      })
      .from(BookNodeTable)
      .leftJoin(NodeContentTable, eq(BookNodeTable.id, NodeContentTable.nodeId))
      .where(eq(BookNodeTable.projectId, projectId)),
    db
      .select({
        id: BookElementTable.id,
        contentJson: BookElementTable.contentJson,
      })
      .from(BookElementTable)
      .where(eq(BookElementTable.projectId, projectId)),
    db
      .select({
        id: ElementCategoryTable.id,
        contentJson: ElementCategoryTable.descriptionJson,
      })
      .from(ElementCategoryTable)
      .where(eq(ElementCategoryTable.projectId, projectId)),
    db
      .select({
        id: StorylineTable.id,
        contentJson: StorylineTable.descriptionJson,
      })
      .from(StorylineTable)
      .where(eq(StorylineTable.projectId, projectId)),
    db
      .select({
        id: ElementPatchTable.id,
        contentJson: ElementPatchTable.contentJson,
      })
      .from(ElementPatchTable)
      .where(eq(ElementPatchTable.projectId, projectId)),
  ]);

  return [
    ...nodeRows.map((row) => sourceDoc('node', row.id, row.contentJson)),
    ...elementRows.map((row) => sourceDoc('element', row.id, row.contentJson)),
    ...categoryRows.map((row) => sourceDoc('category', row.id, row.contentJson)),
    ...storylineRows.map((row) => sourceDoc('storyline', row.id, row.contentJson)),
    ...patchRows.map((row) => sourceDoc('patch', row.id, row.contentJson)),
  ];
}

function sourceDoc(
  kind: StructuralEntityKind,
  id: string,
  contentJson: string | null | undefined,
): ReferenceSourceDoc {
  return { kind, id, contentJson };
}

function parseEditorJson(contentJson: string | null | undefined):
  | { ok: true; json: unknown }
  | { ok: false } {
  if (!contentJson) return { ok: true, json: undefined };
  try {
    return { ok: true, json: JSON.parse(contentJson) };
  } catch (error) {
    log.warn('[references] skipping invalid editor JSON while rebuilding index:', error);
    return { ok: false };
  }
}
