import { and, eq, isNull } from 'drizzle-orm';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { getDb } from '../../lib/db';
import { hydrateProseJson } from '../../lib/agent/prose-hydrate-client';
import { getLiveYDoc } from '../../lib/yjs-doc-registry';
import { proseDocId } from '../../lib/yjs-doc-id';
import {
  BookElementTable, BookNodeTable, ElementCategoryTable, NodeContentTable, StorylineTable,
} from '../../schema/drizzle';
import { readPersistedYjsDocuments } from '../../sqlite-repo/yjs-repo';
import { proseJsonToShareDocument, type ShareDocument, type ShareDocumentKind } from '../../../shared/share-document';
import type { ShareEntityKind } from './share-link-api';

export interface ShareTarget {
  projectId: string;
  entityKind: ShareEntityKind;
  entityId: string;
}

/**
 * The reader copy of one entity, from its live Yjs body when an editor holds
 * it, else from persisted Yjs state, else its seed. Null when the entity is
 * gone or in the trash. A local read only: no flush, write or network call.
 */
export async function readShareDocument(target: ShareTarget): Promise<ShareDocument | null> {
  const docId = proseDocId(target.entityKind, target.entityId);
  const source = await getDb().transaction(async tx => {
    let title: string;
    let kind: ShareDocumentKind;
    let seed: string | null;
    if (target.entityKind === 'node') {
      const [node] = await tx.select({ title: BookNodeTable.title, kind: BookNodeTable.kind, seed: NodeContentTable.contentJson })
        .from(BookNodeTable).leftJoin(NodeContentTable, eq(BookNodeTable.id, NodeContentTable.nodeId))
        .where(and(eq(BookNodeTable.id, target.entityId), eq(BookNodeTable.projectId, target.projectId), isNull(BookNodeTable.deletedAt)));
      if (!node) return null;
      ({ title, seed } = node);
      kind = node.kind === 'drift' ? 'drift' : 'chapter';
    } else {
      const table = target.entityKind === 'element' ? BookElementTable
        : target.entityKind === 'category' ? ElementCategoryTable : StorylineTable;
      const [entity] = await tx.select({ name: table.name, contentJson: table.contentJson }).from(table)
        .where(and(eq(table.id, target.entityId), eq(table.projectId, target.projectId), isNull(table.deletedAt)));
      if (!entity) return null;
      title = entity.name;
      seed = entity.contentJson;
      kind = target.entityKind;
    }
    // The live CRDT is captured before yielding; an empty one is authoritative too.
    const doc = getLiveYDoc(docId);
    const live = doc ? yDocToProsemirrorJSON(doc, 'default') : null;
    const persisted = live ? null : (await readPersistedYjsDocuments(tx, [docId])).get(docId) ?? null;
    return { title, kind, seed, live, persisted };
  });
  if (!source) return null;
  let prose: unknown = source.live;
  if (!prose) {
    const json = source.persisted && (source.persisted.snapshot || source.persisted.updates.length)
      ? await hydrateProseJson(source.persisted.snapshot, source.persisted.updates)
      : source.seed ?? '{}';
    try { prose = JSON.parse(json); } catch { prose = {}; }
  }
  return proseJsonToShareDocument(prose, source.title, source.kind);
}

/** Hash of the copy as the service stores it (docs/share-links.md). */
export async function shareDocumentSha256(document: ShareDocument): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
