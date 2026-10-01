import { and, asc, eq, isNull } from 'drizzle-orm';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { deriveActSegments } from '../../domain/book-act';
import { getDb } from '../../lib/db';
import { hydrateProseJson } from '../../lib/agent/prose-hydrate-client';
import { getLiveYDoc } from '../../lib/yjs-doc-registry';
import { proseDocId } from '../../lib/yjs-doc-id';
import {
  BookActTable, BookElementTable, BookNodeTable, ElementCategoryTable,
  NodeContentTable, ProjectTable, StorylineTable,
} from '../../schema/drizzle';
import { readPersistedYjsDocuments, YJS_DOCUMENT_READ_BATCH_SIZE, type PersistedYjsDocument } from '../../sqlite-repo/yjs-repo';
import { markdownShareFilename, markdownShareHeading, proseToShareMarkdown,
  type MarkdownShareDocument, type MarkdownShareTarget } from './markdown-share';

interface ShareSection {
  title: string;
  level: number;
  docId?: string;
  seed?: string | null;
}

/** A local read only. No flush, authored write, network call or DOM selection. */
export async function readMarkdownShare(
  target: MarkdownShareTarget,
  signal?: AbortSignal,
): Promise<MarkdownShareDocument> {
  signal?.throwIfAborted();
  const source = await getDb().transaction(async tx => {
    const [project] = await tx.select({ name: ProjectTable.name }).from(ProjectTable)
      .where(eq(ProjectTable.id, target.projectId));
    if (!project) throw new Error('The project is no longer available');
    let title = project.name;
    let sections: ShareSection[] = [];
    if (target.kind === 'book' || target.kind === 'node') {
      const nodes = await tx.select({ id: BookNodeTable.id, title: BookNodeTable.title,
        bookOrder: BookNodeTable.bookOrder, seed: NodeContentTable.contentJson,
      }).from(BookNodeTable).leftJoin(NodeContentTable, eq(BookNodeTable.id, NodeContentTable.nodeId))
        .where(and(eq(BookNodeTable.projectId, target.projectId), isNull(BookNodeTable.deletedAt),
          target.kind === 'book' ? eq(BookNodeTable.kind, 'chapter') : eq(BookNodeTable.id, target.id)))
        .orderBy(asc(BookNodeTable.bookOrder), asc(BookNodeTable.createdAt), asc(BookNodeTable.id));
      if (target.kind === 'node') {
        if (!nodes[0]) throw new Error('The document is no longer available');
        title = nodes[0].title;
        sections = [{ title, level: 1, docId: proseDocId('node', nodes[0].id), seed: nodes[0].seed }];
      } else {
        const acts = await tx.select().from(BookActTable).where(eq(BookActTable.projectId, target.projectId));
        const segments = deriveActSegments(acts, nodes);
        const chapter = (node: typeof nodes[number]): ShareSection => ({ title: node.title,
          level: acts.length ? 3 : 2, docId: proseDocId('node', node.id), seed: node.seed });
        sections.push({ title, level: 1 });
        if (!segments.length) sections.push(...nodes.map(chapter));
        else {
          const assigned = new Set(segments.flatMap(segment => segment.chapters.map(node => node.id)));
          sections.push(...nodes.filter(node => !assigned.has(node.id)).map(chapter));
          for (const segment of segments) {
            sections.push({ title: segment.act.name, level: 2 }, ...segment.chapters.map(chapter));
          }
        }
      }
    } else {
      const table = target.kind === 'element' ? BookElementTable
        : target.kind === 'category' ? ElementCategoryTable : StorylineTable;
      const [entity] = await tx.select({ name: table.name, contentJson: table.contentJson }).from(table)
        .where(and(eq(table.id, target.id), eq(table.projectId, target.projectId), isNull(table.deletedAt)));
      if (!entity) throw new Error('The document is no longer available');
      title = entity.name;
      sections = [{ title, level: 1, docId: proseDocId(target.kind, target.id), seed: entity.contentJson }];
    }
    const docIds = sections.flatMap(section => section.docId ? [section.docId] : []);
    const persisted = new Map<string, PersistedYjsDocument>();
    for (let index = 0; index < docIds.length; index += YJS_DOCUMENT_READ_BATCH_SIZE) {
      signal?.throwIfAborted();
      for (const [id, state] of await readPersistedYjsDocuments(tx, docIds.slice(index, index + YJS_DOCUMENT_READ_BATCH_SIZE))) {
        persisted.set(id, state);
      }
    }
    // Capture all live bodies synchronously before yielding. Empty live CRDTs
    // are authoritative too; a stale cache must not resurrect deleted prose.
    const live = new Map<string, string>();
    for (const id of docIds) {
      const doc = getLiveYDoc(id);
      if (doc) live.set(id, JSON.stringify(yDocToProsemirrorJSON(doc, 'default')));
    }
    return { title, sections, persisted, live, documentCount: docIds.length };
  });
  const parts: string[] = [];
  for (const section of source.sections) {
    signal?.throwIfAborted();
    parts.push(markdownShareHeading(section.title, section.level));
    if (!section.docId) continue;
    const persisted = source.persisted.get(section.docId)!;
    const json = source.live.get(section.docId) ?? (persisted.snapshot || persisted.updates.length
      ? await hydrateProseJson(persisted.snapshot, persisted.updates)
      : section.seed ?? '{}');
    const body = proseToShareMarkdown(json, section.level);
    if (body) parts.push(body);
  }
  signal?.throwIfAborted();
  return { title: source.title, filename: markdownShareFilename(source.title),
    markdown: `${parts.join('\n\n')}\n`, documentCount: source.documentCount };
}
