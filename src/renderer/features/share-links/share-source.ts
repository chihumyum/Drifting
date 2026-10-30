import { and, count, eq, inArray, isNull, lt } from 'drizzle-orm';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { countWordsInPmJson } from '@drifting/prose-metrics';
import { getDb, type DbExecutor } from '../../lib/db';
import { hydrateProseJson } from '../../lib/agent/prose-hydrate-client';
import { resolveEntityLinkTargetColor } from '../../lib/entity-link-appearance';
import { getLiveYDoc } from '../../lib/yjs-doc-registry';
import { proseDocId } from '../../lib/yjs-doc-id';
import type { EntityKind } from '../../domain/entity-kinds';
import {
  BookElementTable, BookNodeTable, DriftGroupTable, ElementCategoryTable, NodeContentTable,
  NodeStorylineLinkTable, StorylineTable,
} from '../../schema/drizzle';
import { readPersistedYjsDocuments } from '../../sqlite-repo/yjs-repo';
import { useDataStore } from '../../store/data-store';
import { useProjectStore } from '../../store/project-store';
import { useSettingsStore } from '../../store/settings-store';
import {
  proseEntityLinks, proseJsonToShareDocument, shareEntity,
  type ShareDocument, type ShareDocumentKind, type ShareEntity, type ShareFolio, type ShareLinkedKind,
} from '../../../shared/share-document';
import type { ShareEntityKind } from './share-link-api';

export interface ShareTarget {
  projectId: string;
  entityKind: ShareEntityKind;
  entityId: string;
}

interface SourceEntity {
  title: string;
  kind: ShareDocumentKind;
  seed: string | null;
  bookOrder: number | null;
  driftGroupId: string | null;
  categoryId: string | null;
}

/**
 * The reader copy of one entity, from its live Yjs body when an editor holds
 * it, else from persisted Yjs state, else its seed. Linked entities carry
 * their name, summary and link colour; the folio is the editor page's header.
 * Null when the entity is gone or in the trash. A local read only: no flush,
 * write or network call.
 */
export async function readShareDocument(target: ShareTarget): Promise<ShareDocument | null> {
  const docId = proseDocId(target.entityKind, target.entityId);
  const source = await getDb().transaction(async tx => {
    let entity: SourceEntity;
    if (target.entityKind === 'node') {
      const [node] = await tx.select({
        title: BookNodeTable.title, kind: BookNodeTable.kind, seed: NodeContentTable.contentJson,
        bookOrder: BookNodeTable.bookOrder, driftGroupId: BookNodeTable.driftGroupId,
      }).from(BookNodeTable).leftJoin(NodeContentTable, eq(BookNodeTable.id, NodeContentTable.nodeId))
        .where(and(eq(BookNodeTable.id, target.entityId), eq(BookNodeTable.projectId, target.projectId), isNull(BookNodeTable.deletedAt)));
      if (!node) return null;
      entity = { title: node.title, kind: node.kind === 'drift' ? 'drift' : 'chapter', seed: node.seed,
        bookOrder: node.bookOrder, driftGroupId: node.driftGroupId, categoryId: null };
    } else if (target.entityKind === 'element') {
      const [element] = await tx.select({ name: BookElementTable.name, contentJson: BookElementTable.contentJson, categoryId: BookElementTable.categoryId })
        .from(BookElementTable)
        .where(and(eq(BookElementTable.id, target.entityId), eq(BookElementTable.projectId, target.projectId), isNull(BookElementTable.deletedAt)));
      if (!element) return null;
      entity = { title: element.name, kind: 'element', seed: element.contentJson, bookOrder: null, driftGroupId: null, categoryId: element.categoryId };
    } else {
      const table = target.entityKind === 'category' ? ElementCategoryTable : StorylineTable;
      const [row] = await tx.select({ name: table.name, contentJson: table.contentJson }).from(table)
        .where(and(eq(table.id, target.entityId), eq(table.projectId, target.projectId), isNull(table.deletedAt)));
      if (!row) return null;
      entity = { title: row.name, kind: target.entityKind, seed: row.contentJson, bookOrder: null, driftGroupId: null, categoryId: null };
    }
    // The live CRDT is captured before yielding; an empty one is authoritative too.
    const doc = getLiveYDoc(docId);
    const live = doc ? yDocToProsemirrorJSON(doc, 'default') : null;
    const persisted = live ? null : (await readPersistedYjsDocuments(tx, [docId])).get(docId) ?? null;
    return { entity, live, persisted };
  });
  if (!source) return null;
  let prose: unknown = source.live;
  if (!prose) {
    const json = source.persisted && (source.persisted.snapshot || source.persisted.updates.length)
      ? await hydrateProseJson(source.persisted.snapshot, source.persisted.updates)
      : source.entity.seed ?? '{}';
    try { prose = JSON.parse(json); } catch { prose = {}; }
  }
  const context = await getDb().transaction(async tx => ({
    entities: await readLinkedEntities(tx, target.projectId, proseEntityLinks(prose)),
    folio: await readFolio(tx, target, source.entity, prose),
  }));
  return proseJsonToShareDocument(prose, source.entity.title, source.entity.kind, {
    resolveEntity: (kind, id) => context.entities.get(`${kind}:${id}`) ?? null,
    folio: context.folio,
  });
}

/**
 * The colour the author's editor gives a link, from the open workspace and the
 * link colour preference. Without the project open there is none, and the
 * reader falls back to the kind's colour.
 */
function linkColor(projectId: string, kind: ShareLinkedKind, id: string): string | null {
  if (useProjectStore.getState().currentProject?.id !== projectId) return null;
  const settings = useSettingsStore.getState();
  return resolveEntityLinkTargetColor(kind as EntityKind, id, useDataStore.getState(),
    settings.entityLinkColorMode, settings.entityLinkKindColors);
}

/** Name and summary of every live linked entity; trashed, deleted and patch targets stay plain text. */
async function readLinkedEntities(
  tx: DbExecutor,
  projectId: string,
  links: readonly { kind: string; id: string }[],
): Promise<Map<string, ShareEntity>> {
  const ids = (kind: string) => [...new Set(links.filter(link => link.kind === kind).map(link => link.id))];
  const result = new Map<string, ShareEntity>();
  // An untitled target has nothing to show on hover; its link stays plain text.
  const add = (kind: ShareLinkedKind, id: string, name: string, summary: string | null) => {
    if (name.trim()) result.set(`${kind}:${id}`, shareEntity(kind, name, summary, linkColor(projectId, kind, id)));
  };
  const elementIds = ids('element');
  if (elementIds.length) {
    for (const row of await tx.select({ id: BookElementTable.id, name: BookElementTable.name, summary: BookElementTable.summary })
      .from(BookElementTable)
      .where(and(eq(BookElementTable.projectId, projectId), inArray(BookElementTable.id, elementIds), isNull(BookElementTable.deletedAt)))) {
      add('element', row.id, row.name, row.summary);
    }
  }
  const nodeIds = ids('node');
  if (nodeIds.length) {
    for (const row of await tx.select({ id: BookNodeTable.id, title: BookNodeTable.title, summary: BookNodeTable.summary })
      .from(BookNodeTable)
      .where(and(eq(BookNodeTable.projectId, projectId), inArray(BookNodeTable.id, nodeIds), isNull(BookNodeTable.deletedAt)))) {
      add('node', row.id, row.title, row.summary);
    }
  }
  const storylineIds = ids('storyline');
  if (storylineIds.length) {
    for (const row of await tx.select({ id: StorylineTable.id, name: StorylineTable.name, summary: StorylineTable.summary })
      .from(StorylineTable)
      .where(and(eq(StorylineTable.projectId, projectId), inArray(StorylineTable.id, storylineIds), isNull(StorylineTable.deletedAt)))) {
      add('storyline', row.id, row.name, row.summary);
    }
  }
  const categoryIds = ids('category');
  if (categoryIds.length) {
    for (const row of await tx.select({ id: ElementCategoryTable.id, name: ElementCategoryTable.name })
      .from(ElementCategoryTable)
      .where(and(eq(ElementCategoryTable.projectId, projectId), inArray(ElementCategoryTable.id, categoryIds), isNull(ElementCategoryTable.deletedAt)))) {
      add('category', row.id, row.name, null);
    }
  }
  return result;
}

/** The editor page's folio: chapter number and storyline, a drift's group or an element's category. */
async function readFolio(tx: DbExecutor, target: ShareTarget, entity: SourceEntity, prose: unknown): Promise<ShareFolio | undefined> {
  const folio: ShareFolio = {};
  if (entity.kind === 'chapter') {
    if (entity.bookOrder !== null) {
      const [before] = await tx.select({ value: count() }).from(BookNodeTable)
        .where(and(eq(BookNodeTable.projectId, target.projectId), eq(BookNodeTable.kind, 'chapter'),
          isNull(BookNodeTable.deletedAt), lt(BookNodeTable.bookOrder, entity.bookOrder)));
      folio.chapter = (before?.value ?? 0) + 1;
    }
    const [storyline] = await tx.select({ name: StorylineTable.name, color: StorylineTable.color })
      .from(NodeStorylineLinkTable).innerJoin(StorylineTable, eq(StorylineTable.id, NodeStorylineLinkTable.storylineId))
      .where(and(eq(NodeStorylineLinkTable.nodeId, target.entityId), eq(NodeStorylineLinkTable.isPrimary, true), isNull(StorylineTable.deletedAt)));
    if (storyline) folio.line = { name: storyline.name, color: storyline.color };
  } else if (entity.kind === 'drift' && entity.driftGroupId) {
    const [group] = await tx.select({ name: DriftGroupTable.name, color: DriftGroupTable.color }).from(DriftGroupTable)
      .where(eq(DriftGroupTable.id, entity.driftGroupId));
    if (group) folio.line = { name: group.name, color: group.color ?? undefined };
  } else if (entity.kind === 'element' && entity.categoryId) {
    const [category] = await tx.select({ name: ElementCategoryTable.name, color: ElementCategoryTable.color }).from(ElementCategoryTable)
      .where(and(eq(ElementCategoryTable.id, entity.categoryId), isNull(ElementCategoryTable.deletedAt)));
    if (category) folio.line = { name: category.name, color: category.color };
  }
  if (target.entityKind === 'node') folio.words = countWordsInPmJson(JSON.stringify(prose));
  return folio;
}

/** Hash of the copy as the service stores it (docs/share-links.md). */
export async function shareDocumentSha256(document: ShareDocument): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
