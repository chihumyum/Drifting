/**
 * Project-wide prose corpus for search_prose.
 *
 * Yjs is authoritative even when the editor is closed; contentJson is only a
 * seed/cache. Searching the cache directly can miss a durable Agent/user edit
 * and return block ordinals that disagree with read_node — so every document
 * here is materialized from the Yjs truth (see getEntityContentJson).
 *
 * That materialization (hydrate + plain-text) and the ranker's NFKC/locale
 * normalization are the two expensive parts of a search over a whole
 * manuscript, and neither depends on the query. Both are cached here per
 * document, keyed by the doc's durable Yjs revision (plus the projection
 * row's updatedAt for docs that only have a seed body). A document with an
 * open editor is always rematerialized from the live Y.Doc and never cached:
 * its in-memory state can be ahead of the durable revision.
 *
 * Batch reads: node bodies come from ONE joined query (listByProject) and
 * revision stamps from ONE listRevisions query, instead of the historical
 * per-node findByNodeId N+1.
 */
import loglevel from 'loglevel';
import { useDataStore } from '../../store/data-store';
import { createBookContentRepository } from '../../sqlite-repo/content-repo';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import type { NodeContent } from '../../domain/node-content';
import { getEntityContentJson } from './chapter-prose';
import { getLiveYDoc } from '../yjs-doc-registry';
import { proseDocId, type ProseEntityType } from '../yjs-doc-id';
import { docToBlocks, docToPlainText } from './serialize';
import {
  normalizeAgentContextEvidenceText,
  type AgentContextEvidenceDocument,
  type AgentContextEvidenceField,
} from './runtime/context-evidence-retrieval';

const log = loglevel.getLogger('agent:prose-search');

export interface ProseSearchCorpusDeps {
  /** All content rows for the project's nodes, keyed by nodeId — one query. */
  loadNodeContents(projectId: string): Promise<Map<string, NodeContent>>;
  /** docId → durable Yjs revision. Null when unavailable: caching is bypassed
   *  entirely because entries could never be invalidated safely. */
  loadRevisions(): Promise<Map<string, number> | null>;
  /** The entity's CURRENT prose JSON (Yjs truth, cacheJson only as seed). */
  materialize(entityType: ProseEntityType, id: string, cacheJson: string): Promise<string>;
  hasLiveDoc(docId: string): boolean;
}

const defaultDeps: ProseSearchCorpusDeps = {
  loadNodeContents: async (projectId) => {
    const rows = await createBookContentRepository().listByProject(projectId);
    return new Map(rows.map((row) => [row.nodeId, row]));
  },
  loadRevisions: async () => {
    try {
      const rows = await createYjsRepository().listRevisions();
      return new Map(rows.map((row) => [row.docId, row.revision]));
    } catch (error) {
      log.debug('[prose-search] Yjs revisions unavailable; corpus cache bypassed', error);
      return null;
    }
  },
  materialize: (entityType, id, cacheJson) => getEntityContentJson(entityType, id, cacheJson),
  hasLiveDoc: (docId) => getLiveYDoc(docId) !== undefined,
};

// ---- revision-validated LRU of materialized + normalized fields ------------

interface CachedFields {
  validity: string;
  chars: number;
  fields: AgentContextEvidenceField[];
}

/** ~32MB worst case as UTF-16 (raw + normalized), dozens of full novels. */
const MAX_CACHED_CHARS = 8_000_000;

const fieldCache = new Map<string, CachedFields>();
let cachedChars = 0;

function cacheGet(docId: string, validity: string): AgentContextEvidenceField[] | null {
  const entry = fieldCache.get(docId);
  if (!entry || entry.validity !== validity) return null;
  // Map iteration order is insertion order; re-insert to mark as most recent.
  fieldCache.delete(docId);
  fieldCache.set(docId, entry);
  return entry.fields;
}

function cachePut(docId: string, validity: string, fields: AgentContextEvidenceField[]): void {
  const chars = fields.reduce(
    (total, field) => total + field.text.length + (field.normalized?.length ?? 0),
    0,
  );
  const existing = fieldCache.get(docId);
  if (existing) {
    cachedChars -= existing.chars;
    fieldCache.delete(docId);
  }
  if (chars > MAX_CACHED_CHARS) return;
  fieldCache.set(docId, { validity, chars, fields });
  cachedChars += chars;
  while (cachedChars > MAX_CACHED_CHARS) {
    const oldest = fieldCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = fieldCache.get(oldest);
    fieldCache.delete(oldest);
    cachedChars -= evicted?.chars ?? 0;
  }
}

export function clearProseSearchCorpusCache(): void {
  fieldCache.clear();
  cachedChars = 0;
}

/** Test/diagnostic visibility into cache pressure. */
export function proseSearchCorpusCacheStats(): { entries: number; chars: number } {
  return { entries: fieldCache.size, chars: cachedChars };
}

// ---- corpus assembly -------------------------------------------------------

function proseField(contentJson: string): AgentContextEvidenceField[] {
  const text = docToPlainText(contentJson);
  return [{ kind: 'prose', text, normalized: normalizeAgentContextEvidenceText(text) }];
}

function nodeFields(contentJson: string): AgentContextEvidenceField[] {
  return docToBlocks(contentJson).map((block, index) => ({
    kind: 'prose' as const,
    text: block.text,
    block: index + 1,
    normalized: normalizeAgentContextEvidenceText(block.text),
  }));
}

interface CorpusEntity {
  entityType: ProseEntityType;
  id: string;
  cacheJson: string;
  /** updatedAt of the projection/store row — cache validity for docs whose
   *  body is still a seed (no Yjs revision row yet). */
  projectionStamp: string;
  envelope: Omit<AgentContextEvidenceDocument, 'fields'>;
}

/**
 * Every prose evidence document of the project (elements, storylines,
 * categories, chapters/drifts) with ranker-ready normalized fields, reusing
 * cached materializations for documents whose revision has not changed.
 */
export async function collectProseSearchDocuments(
  projectId: string,
  deps: ProseSearchCorpusDeps = defaultDeps,
): Promise<AgentContextEvidenceDocument[]> {
  const s = useDataStore.getState();
  const entities: CorpusEntity[] = [];

  for (const e of s.bookElements) {
    if (e.projectId !== projectId) continue;
    entities.push({
      entityType: 'element',
      id: e.id,
      cacheJson: e.contentJson,
      projectionStamp: e.updatedAt,
      envelope: {
        evidenceId: `element-prose:${e.id}`,
        kind: 'element',
        title: e.name,
        updatedAt: e.updatedAt,
        revision: e.updatedAt,
      },
    });
  }
  for (const storyline of s.storylines) {
    if (storyline.projectId !== projectId) continue;
    entities.push({
      entityType: 'storyline',
      id: storyline.id,
      cacheJson: storyline.contentJson,
      projectionStamp: storyline.updatedAt,
      envelope: {
        evidenceId: `storyline-prose:${storyline.id}`,
        kind: 'storyline',
        title: storyline.name,
        updatedAt: storyline.updatedAt,
        revision: storyline.updatedAt,
        ordinal: storyline.orderKey,
      },
    });
  }
  for (const category of s.bookElementCategories) {
    if (category.projectId !== projectId) continue;
    entities.push({
      entityType: 'category',
      id: category.id,
      cacheJson: category.contentJson,
      projectionStamp: category.updatedAt,
      envelope: {
        evidenceId: `category-prose:${category.id}`,
        kind: 'category',
        title: category.name,
        updatedAt: category.updatedAt,
        revision: category.updatedAt,
      },
    });
  }

  const nodes = s.bookNodes.filter((n) => n.projectId === projectId);
  if (entities.length === 0 && nodes.length === 0) return [];

  const [contents, revisions] = await Promise.all([
    nodes.length > 0
      ? deps.loadNodeContents(projectId)
      : Promise.resolve(new Map<string, NodeContent>()),
    deps.loadRevisions(),
  ]);

  for (const n of nodes) {
    const content = contents.get(n.id);
    // Same rule as the historical per-node path: a node without a content row
    // has no prose body to search (even if an empty Yjs doc exists).
    if (!content) continue;
    entities.push({
      entityType: 'node',
      id: n.id,
      cacheJson: content.contentJson,
      projectionStamp: content.updatedAt ?? '',
      envelope: {
        evidenceId: `${n.kind}-prose:${n.id}`,
        kind: n.kind,
        title: n.title,
        updatedAt: n.updatedAt,
        revision: content.updatedAt ?? n.updatedAt,
        ordinal:
          n.kind === 'chapter' ? n.bookOrder : (n.narrativeOrder ?? Number.MAX_SAFE_INTEGER),
      },
    });
  }

  const documents: AgentContextEvidenceDocument[] = [];
  for (const entity of entities) {
    const docId = proseDocId(entity.entityType, entity.id);
    const validity =
      !deps.hasLiveDoc(docId) && revisions
        ? `r:${revisions.get(docId) ?? 'none'}|p:${entity.projectionStamp}`
        : null;
    let fields = validity ? cacheGet(docId, validity) : null;
    if (!fields) {
      const contentJson = await deps.materialize(entity.entityType, entity.id, entity.cacheJson);
      fields = entity.entityType === 'node' ? nodeFields(contentJson) : proseField(contentJson);
      if (validity) cachePut(docId, validity, fields);
    }
    documents.push({ ...entity.envelope, fields });
  }
  return documents;
}
