import { and, asc, eq, isNull } from 'drizzle-orm';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { deriveActSegments } from '../../domain/book-act';
import type { WritingStatus } from '../../domain/book-node';
import { getDb, type DbTransaction } from '../../lib/db';
import { hydrateProseJson } from '../../lib/agent/prose-hydrate-client';
import { getLiveYDoc } from '../../lib/yjs-doc-registry';
import { proseDocId } from '../../lib/yjs-doc-id';
import { BookActTable, BookNodeTable, NodeContentTable, ProjectTable } from '../../schema/drizzle';
import { readPersistedYjsDocuments, YJS_DOCUMENT_READ_BATCH_SIZE, type PersistedYjsDocument } from '../../sqlite-repo/yjs-repo';
import {
  manuscriptSections, manuscriptTimestamp, proseToManuscriptBlocks,
  type Manuscript, type ManuscriptExportOptions, type ManuscriptLabels, type ManuscriptOutline,
} from './manuscript-export';

async function readOutline(tx: DbTransaction, projectId: string) {
  const [project] = await tx.select({ name: ProjectTable.name }).from(ProjectTable)
    .where(and(eq(ProjectTable.id, projectId), isNull(ProjectTable.deletedAt)));
  if (!project) throw new Error('The project is no longer available');
  const nodes = await tx.select({ id: BookNodeTable.id, title: BookNodeTable.title,
    writingStatus: BookNodeTable.writingStatus, bookOrder: BookNodeTable.bookOrder,
    seed: NodeContentTable.contentJson,
  }).from(BookNodeTable).leftJoin(NodeContentTable, eq(BookNodeTable.id, NodeContentTable.nodeId))
    .where(and(eq(BookNodeTable.projectId, projectId), isNull(BookNodeTable.deletedAt), eq(BookNodeTable.kind, 'chapter')))
    .orderBy(asc(BookNodeTable.bookOrder), asc(BookNodeTable.createdAt), asc(BookNodeTable.id));
  const acts = await tx.select().from(BookActTable).where(eq(BookActTable.projectId, projectId));
  const segments = deriveActSegments(acts, nodes);
  const actOf = new Map<string, string>();
  for (const segment of segments) for (const chapter of segment.chapters) actOf.set(chapter.id, segment.act.id);
  // Book order: chapters before the first act, then each act's chapters.
  const assigned = new Set(actOf.keys());
  const ordered = segments.length
    ? [...nodes.filter(node => !assigned.has(node.id)), ...segments.flatMap(segment => segment.chapters)]
    : nodes;
  return {
    projectTitle: project.name,
    acts: segments.map(segment => ({ id: segment.act.id, name: segment.act.name })),
    chapters: ordered.map(node => ({ id: node.id, title: node.title,
      writingStatus: node.writingStatus as WritingStatus, actId: actOf.get(node.id) ?? null, seed: node.seed })),
  };
}

/** Acts and chapters in book order, for the export picker. */
export async function readManuscriptOutline(projectId: string): Promise<ManuscriptOutline> {
  const outline = await getDb().transaction(tx => readOutline(tx, projectId));
  return { projectTitle: outline.projectTitle, acts: outline.acts,
    chapters: outline.chapters.map(({ seed: _seed, ...chapter }) => chapter) };
}

/**
 * A local read only: no flush, authored write, network call or DOM selection.
 * Live Yjs documents win over persisted state (an empty live document too);
 * `contentJson` is used only for a chapter that has never had Yjs state.
 */
export async function readManuscript(
  projectId: string,
  options: ManuscriptExportOptions,
  labels: ManuscriptLabels,
  context: { locale: string; preferredFont?: string; now?: Date },
  signal?: AbortSignal,
): Promise<Manuscript> {
  signal?.throwIfAborted();
  const source = await getDb().transaction(async tx => {
    const outline = await readOutline(tx, projectId);
    const wanted = options.chapterIds
      ? new Set(options.chapterIds)
      : new Set(outline.chapters.filter(chapter => chapter.writingStatus !== 'discarded').map(chapter => chapter.id));
    const chapters = outline.chapters.filter(chapter => wanted.has(chapter.id));
    if (!chapters.length) throw new Error('No chapters to export');
    const docIds = chapters.map(chapter => proseDocId('node', chapter.id));
    const persisted = new Map<string, PersistedYjsDocument>();
    for (let index = 0; index < docIds.length; index += YJS_DOCUMENT_READ_BATCH_SIZE) {
      signal?.throwIfAborted();
      for (const [id, state] of await readPersistedYjsDocuments(tx, docIds.slice(index, index + YJS_DOCUMENT_READ_BATCH_SIZE))) {
        persisted.set(id, state);
      }
    }
    // Capture all live bodies synchronously before yielding.
    const live = new Map<string, string>();
    for (const id of docIds) {
      const doc = getLiveYDoc(id);
      if (doc) live.set(id, JSON.stringify(yDocToProsemirrorJSON(doc, 'default')));
    }
    return { outline, chapters, persisted, live };
  });
  const chapters = [];
  for (const chapter of source.chapters) {
    signal?.throwIfAborted();
    const docId = proseDocId('node', chapter.id);
    const persisted = source.persisted.get(docId)!;
    const json = source.live.get(docId) ?? (persisted.snapshot || persisted.updates.length
      ? await hydrateProseJson(persisted.snapshot, persisted.updates)
      : chapter.seed ?? '{}');
    chapters.push({ ...chapter, blocks: proseToManuscriptBlocks(json, options.outlineHeadings) });
  }
  signal?.throwIfAborted();
  return {
    title: options.title.trim() || source.outline.projectTitle,
    author: options.author.trim(),
    identifier: projectId,
    modified: manuscriptTimestamp(context.now ?? new Date()),
    locale: context.locale,
    ...(context.preferredFont ? { preferredFont: context.preferredFont } : {}),
    ...(options.cover ? { cover: options.cover } : {}),
    sections: manuscriptSections(source.outline, chapters, options, labels),
  };
}
