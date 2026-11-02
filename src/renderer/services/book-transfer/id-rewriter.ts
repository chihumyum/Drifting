// Fresh identities for an imported book (docs/book-transfer.md). Every row id
// in the package gets a new one; every other value that names one of those
// ids (foreign keys, order scopes, document ids, JSON columns, reducer
// registers, Yjs attributes and marks) is rewritten to match. Block ids inside
// prose are not identities and stay as they are.
import * as Y from 'yjs';

import { plotGridCellId, plotGridDocumentId } from '../../sqlite-repo/plot-grid-repo';
import type { CanonicalCborValue } from '../../sync/protocol';
import type { SnapshotTableRowsV1 } from '../../sync/checkpoint/types';

/** Ids the store derives from other ids; they follow their parts. */
const DERIVED_ID_TABLES = new Set(['plot_grid_document', 'plot_grid_cell']);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Shorter non-UUID ids are rewritten only where a value is exactly that id. */
const MIN_EMBEDDED_ID_LENGTH = 8;

export interface BookIdRewriter {
  /** Old id → new id for every rewritten identity. */
  readonly ids: ReadonlyMap<string, string>;
  string(value: string): string;
  value<T>(value: T): T;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function createBookIdRewriter(
  tables: readonly SnapshotTableRowsV1[],
  newId: () => string,
): BookIdRewriter {
  const ids = new Map<string, string>();
  for (const { table, rows } of tables) {
    if (DERIVED_ID_TABLES.has(table)) continue;
    for (const row of rows) {
      const id = row.id;
      if (typeof id !== 'string' || ids.has(id)) continue;
      ids.set(id, newId());
    }
  }
  const embedded = [...ids.keys()]
    .filter((id) => !UUID_EXACT.test(id) && id.length >= MIN_EMBEDDED_ID_LENGTH)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp);
  const embeddedPattern = embedded.length > 0 ? new RegExp(embedded.join('|'), 'gu') : null;

  function string(value: string): string {
    const exact = ids.get(value);
    if (exact !== undefined) return exact;
    // Content hashes never name an entity.
    if (value.startsWith('sha256:')) return value;
    let next = value.replace(UUID, (match) => ids.get(match) ?? match);
    if (embeddedPattern) next = next.replace(embeddedPattern, (match) => ids.get(match) ?? match);
    return next;
  }

  function value<T>(input: T): T {
    if (typeof input === 'string') return string(input) as T;
    if (Array.isArray(input)) return input.map((entry) => value(entry)) as T;
    if (input instanceof Uint8Array || input === null || typeof input !== 'object') return input;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      output[string(key)] = value(entry);
    }
    return output as T;
  }

  // Derived ids are rebuilt from their rewritten parts, so they stay valid
  // whatever shape the original ids had.
  const tableRows = (name: string) => tables.find((entry) => entry.table === name)?.rows ?? [];
  for (const row of tableRows('plot_grid_document')) {
    ids.set(String(row.id), plotGridDocumentId(string(String(row.node_id))));
  }
  for (const row of tableRows('plot_grid_cell')) {
    ids.set(
      String(row.id),
      plotGridCellId(
        string(String(row.document_id)),
        string(String(row.row_id)),
        string(String(row.column_id)),
      ),
    );
  }

  return { ids, string, value };
}

export function rewriteAuthoredTables(
  tables: readonly SnapshotTableRowsV1[],
  rewriter: BookIdRewriter,
): SnapshotTableRowsV1[] {
  return tables.map(({ table, rows }) => ({
    table,
    rows: rows.map((row) => rewriter.value(row) as Readonly<Record<string, CanonicalCborValue>>),
  }));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rewriteText(text: Y.XmlText, rewriter: BookIdRewriter): void {
  const delta = text.toDelta() as { insert?: unknown; attributes?: Record<string, unknown> }[];
  let offset = 0;
  for (const segment of delta) {
    const length = typeof segment.insert === 'string' ? segment.insert.length : 1;
    const attributes = segment.attributes ?? {};
    const nextAttributes = rewriter.value(attributes);
    if (typeof segment.insert === 'object' && segment.insert !== null) {
      const nextEmbed = rewriter.value(segment.insert);
      if (!sameValue(nextEmbed, segment.insert)) {
        text.delete(offset, 1);
        text.insertEmbed(offset, nextEmbed as object, nextAttributes);
        offset += length;
        continue;
      }
    }
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(attributes)) {
      if (!sameValue(attributes[key], nextAttributes[key])) changed[key] = nextAttributes[key];
    }
    if (Object.keys(changed).length > 0) text.format(offset, length, changed);
    offset += length;
  }
}

function rewriteChildren(parent: Y.XmlFragment | Y.XmlElement, rewriter: BookIdRewriter): void {
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) {
      rewriteText(child, rewriter);
    } else if (child instanceof Y.XmlElement) {
      const attributes = child.getAttributes() as Record<string, unknown>;
      for (const [key, current] of Object.entries(attributes)) {
        const next = rewriter.value(current);
        if (!sameValue(current, next)) child.setAttribute(key, next as string);
      }
      rewriteChildren(child, rewriter);
    }
  }
}

/** The full state of one prose document with every entity reference rewritten. */
export function rewriteYjsState(state: Uint8Array, rewriter: BookIdRewriter): Uint8Array {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, state, 'book-import:source');
    if (document.share.has('default')) {
      const fragment = document.getXmlFragment('default');
      document.transact(() => rewriteChildren(fragment, rewriter), 'book-import:rewrite');
    }
    return Y.encodeStateAsUpdate(document);
  } finally {
    document.destroy();
  }
}
