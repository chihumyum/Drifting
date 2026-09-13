import type { BookNode } from '../../domain/book-node';
import type { BookElement, BookElementCategory } from '../../domain/book-element';
import type { Storyline } from '../../domain/storyline';

export type SearchableEntityType = 'node' | 'storyline' | 'element' | 'category';
export type Field = 'title' | 'name' | 'summary' | 'body';

export interface Occurrence {
  field: Field;
  excerpt: string;
  matchStart: number; // index of the hit within `excerpt`
  matchLen: number;
}

export interface EntityGroup {
  entityType: SearchableEntityType;
  entityId: string;
  entityTitle: string;
  occurrences: Occurrence[];
  // Number of additional matches we found but did not include (per-entity cap).
  truncated: number;
}

export interface GlobalSearchEntities {
  bookNodes: readonly BookNode[];
  storylines: readonly Storyline[];
  bookElements: readonly BookElement[];
  bookElementCategories: readonly BookElementCategory[];
}
export interface SearchDocument {
  entityType: SearchableEntityType;
  entityId: string;
  entityTitle: string;
  fields: Array<{ field: Field; text: string }>;
}
const MAX_OCCURRENCES_PER_ENTITY = 30;
const EXCERPT_RADIUS = 28;

function extractTiptapText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: unknown; content?: unknown };
  if (n.type === 'text' && typeof n.text === 'string') return n.text;
  if (Array.isArray(n.content)) {
    const joiner = n.type === 'doc' || n.type === undefined ? '\n' : '';
    return (n.content as unknown[]).map(extractTiptapText).join(joiner);
  }
  return '';
}

function safeParse(json: string | null | undefined): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Find every occurrence of `q` in `text`, up to `cap` returned. The full count
// (including those past the cap) is returned in `total` so callers can show a
// "more …" tail.
function findOccurrences(
  text: string,
  q: string,
  field: Field,
  cap: number,
): { occurrences: Occurrence[]; total: number } {
  if (!text || !q) return { occurrences: [], total: 0 };
  const lower = text.toLowerCase();
  const lq = q.toLowerCase();
  const occurrences: Occurrence[] = [];
  let total = 0;
  let from = 0;
  while (true) {
    const i = lower.indexOf(lq, from);
    if (i < 0) break;
    total++;
    if (occurrences.length < cap) {
      const start = Math.max(0, i - EXCERPT_RADIUS);
      const end = Math.min(text.length, i + lq.length + EXCERPT_RADIUS);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < text.length ? '…' : '';
      const raw = prefix + text.slice(start, end) + suffix;
      const excerpt = raw.replace(/\s+/g, ' ').trim();
      const ms = excerpt.toLowerCase().indexOf(lq);
      if (ms >= 0) {
        occurrences.push({ field, excerpt, matchStart: ms, matchLen: q.length });
      }
    }
    from = i + Math.max(1, lq.length);
  }
  return { occurrences, total };
}

// Combine occurrences across an entity's searchable fields, respecting the
// per-entity cap. Returns null if nothing matched.
function buildGroup(
  entityType: SearchableEntityType,
  entityId: string,
  entityTitle: string,
  fields: Array<{ field: Field; text: string }>,
  q: string,
): EntityGroup | null {
  const occurrences: Occurrence[] = [];
  let total = 0;
  for (const f of fields) {
    const cap = Math.max(0, MAX_OCCURRENCES_PER_ENTITY - occurrences.length);
    const res = findOccurrences(f.text, q, f.field, cap);
    occurrences.push(...res.occurrences);
    total += res.total;
  }
  if (occurrences.length === 0) return null;
  return {
    entityType,
    entityId,
    entityTitle,
    occurrences,
    truncated: Math.max(0, total - occurrences.length),
  };
}

/** Cache only the current visible search session's body projections. SQLite/Yjs
 * remain authoritative; this index is discarded on close or authority change.
 * Node bodies retain the existing persisted JSON-cache search semantics. */
export function createGlobalSearchIndex() {
  let authority: string | null = null;
  let cache = new Map<string, { json: string; text: string }>();
  return {
    clear() {
      cache.clear();
      authority = null;
    },
    prepare(
      scope: string,
      entities: GlobalSearchEntities,
      nodeBodies: ReadonlyMap<string, string>,
      labels: { untitled: string; unnamed: string },
    ): SearchDocument[] {
      if (authority !== scope) {
        cache.clear();
        authority = scope;
      }
      const next = new Map<string, { json: string; text: string }>();
      const documents: SearchDocument[] = [];
      const body = (kind: SearchableEntityType, id: string, json: string | null | undefined) => {
        if (!json) return '';
        const key = JSON.stringify([kind, id]);
        const previous = cache.get(key);
        const value = previous?.json === json
          ? previous
          : { json, text: extractTiptapText(safeParse(json)) };
        next.set(key, value);
        return value.text;
      };
      for (const node of entities.bookNodes) {
        documents.push({ entityType: 'node', entityId: node.id, entityTitle: node.title || labels.untitled,
          fields: [
            { field: 'title', text: node.title || '' },
            { field: 'summary', text: node.summary || '' },
            { field: 'body', text: body('node', node.id, nodeBodies.get(node.id)) },
          ],
        });
      }
      for (const storyline of entities.storylines) {
        documents.push({ entityType: 'storyline', entityId: storyline.id, entityTitle: storyline.name || labels.untitled,
          fields: [
            { field: 'name', text: storyline.name || '' },
            { field: 'summary', text: storyline.summary || '' },
            { field: 'body', text: body('storyline', storyline.id, storyline.contentJson) },
          ],
        });
      }
      for (const element of entities.bookElements) {
        documents.push({ entityType: 'element', entityId: element.id, entityTitle: element.name || labels.unnamed,
          fields: [
            { field: 'name', text: element.name || '' },
            { field: 'summary', text: element.summary || '' },
            { field: 'body', text: body('element', element.id, element.contentJson) },
          ],
        });
      }
      for (const category of entities.bookElementCategories) {
        documents.push({ entityType: 'category', entityId: category.id, entityTitle: category.name || labels.unnamed,
          fields: [
            { field: 'name', text: category.name || '' },
            { field: 'body', text: body('category', category.id, category.contentJson) },
          ],
        });
      }
      // Deleted records and node bodies no longer returned by the query release
      // their text. The cache cannot grow with the history of visited entities.
      cache = next;
      return documents;
    },
  };
}

export function searchGlobalDocuments(documents: readonly SearchDocument[], query: string): EntityGroup[] {
  const q = query.trim(); if (!q) return [];
  return documents.flatMap(doc => {
    const group = buildGroup(doc.entityType, doc.entityId, doc.entityTitle, doc.fields, q);
    return group ? [group] : [];
  });
}
